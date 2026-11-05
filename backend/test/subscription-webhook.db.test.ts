import { createHmac } from 'node:crypto';
import type { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { addMonthsUTC } from '../src/billing/dates.js';
import { DEFAULT_BILLING } from '../src/billing/plans.js';
import { newSubscriptionReference } from '../src/billing/subscribe.js';
import { processSubscriptionCharge } from '../src/billing/webhook.js';
import { EventLogModel } from '../src/models/event-log.js';
import { SellerModel } from '../src/models/seller.js';
import { SubscriptionModel, type SubscriptionPlan } from '../src/models/subscription.js';
import { PaystackError } from '../src/payments/paystack.js';
import { connectTestDb, disconnectTestDb, testDbUri } from './helpers/db.js';
import { bearer, fakeAuth } from './helpers/fake-auth.js';
import { fakePaystack } from './helpers/fake-paystack.js';

// Obviously fake. The real key is never needed or used by any test.
const SECRET = 'sk_test_not_a_real_key_for_tests';
const LIMITS = { windowMs: 60_000, ordersPerWindow: 10_000, lookupsPerWindow: 10_000, paymentsPerWindow: 10_000 };
const URL_PATH = '/api/webhooks/paystack';
const DAY_MS = 86_400_000;

let paystack = fakePaystack();
let app = buildApp();

function buildApp() {
  return createApp({ allowedOrigins: ['http://localhost:5173'], auth: fakeAuth, paystack, paystackSecretKey: SECRET, billing: DEFAULT_BILLING, rateLimits: LIMITS });
}

const sign = (body: string) => createHmac('sha512', SECRET).update(body).digest('hex');
const chargeSuccess = (reference: string) => JSON.stringify({ event: 'charge.success', data: { reference, status: 'success', amount: 1 } });

function deliver(body: string, signature: string | null = sign(body)) {
  const req = request(app).post(URL_PATH).set('Content-Type', 'application/json');
  return (signature === null ? req : req.set('x-paystack-signature', signature)).send(body);
}

let counter = 0;
async function makeSeller(billing: 'trial' | 'over' = 'trial') {
  counter += 1;
  const now = Date.now();
  return SellerModel.create({
    clerkUserId: `user_w${counter}`,
    businessName: `Kitchen ${counter}`,
    slug: `kitchen-w${counter}`,
    phone: '+2348031234567',
    payment: { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Owner', bankCode: '058' },
    billing:
      billing === 'trial'
        ? { trialStartedAt: new Date(now - DAY_MS), trialEndsAt: new Date(now + 6 * DAY_MS), verification: { status: 'not_started' as const } }
        : { trialStartedAt: new Date(now - 30 * DAY_MS), trialEndsAt: new Date(now - 23 * DAY_MS), verification: { status: 'not_started' as const } },
  });
}

// A subscription the vendor has started but Paystack has not confirmed.
async function startedSubscription(sellerId: Types.ObjectId, plan: SubscriptionPlan = 'monthly') {
  return SubscriptionModel.create({
    sellerId,
    plan,
    amountNaira: plan === 'monthly' ? 3000 : 11_000,
    status: 'pending',
    paystackReference: newSubscriptionReference(),
  });
}

// Paystack reports a successful payment of exactly what we asked for.
function paystackConfirmsWhatWasAsked() {
  paystack.verifyTransaction.mockImplementation(async (reference) => {
    const row = await SubscriptionModel.findOne({ paystackReference: reference });
    return { status: 'success', reference, amountKobo: (row?.amountNaira ?? 0) * 100, currency: 'NGN' };
  });
}

const events = () => EventLogModel.find({ type: 'subscription_webhook_issue' }).sort({ createdAt: 1 });
const reload = (id: Types.ObjectId) => SubscriptionModel.findById(id);
const iso = (d: Date | undefined | null) => d?.toISOString();

describe.skipIf(!testDbUri)('the subscription webhook on a real MongoDB', () => {
  beforeAll(async () => {
    await connectTestDb('subscription_webhook');
  });
  afterAll(disconnectTestDb);
  beforeEach(async () => {
    paystack = fakePaystack();
    app = buildApp();
    await SubscriptionModel.deleteMany({});
    await EventLogModel.deleteMany({});
  });

  describe('who may call it', () => {
    it('refuses a missing, wrong or reformatted signature and activates nothing', async () => {
      const seller = await makeSeller('over');
      const sub = await startedSubscription(seller._id);
      paystackConfirmsWhatWasAsked();
      const body = chargeSuccess(sub.paystackReference);

      expect((await deliver(body, null)).status).toBe(401);
      expect((await deliver(body, 'f'.repeat(128))).status).toBe(401);
      expect((await deliver(body, sign(body + ' '))).status).toBe(401);
      expect((await deliver(body, createHmac('sha512', 'sk_test_some_other_key').update(body).digest('hex'))).status).toBe(401);

      expect((await reload(sub._id))!.status).toBe('pending');
      expect(paystack.verifyTransaction).not.toHaveBeenCalled();
    });
  });

  describe('activation', () => {
    it('activates only after the signed webhook AND Paystack\'s own confirmation, with dates from the server clock', async () => {
      const seller = await makeSeller('over');
      const sub = await startedSubscription(seller._id, 'monthly');
      paystackConfirmsWhatWasAsked();

      // Before anything arrives: not covered.
      expect((await request(app).get('/api/sellers/me/billing').set({ Authorization: bearer(seller.clerkUserId) })).body).toMatchObject({ state: 'expired', canShareLink: false });

      const before = Date.now();
      const res = await deliver(chargeSuccess(sub.paystackReference));
      const after = Date.now();
      expect(res.status).toBe(200);

      // The webhook body only named the payment; the truth came from Paystack.
      expect(paystack.verifyTransaction).toHaveBeenCalledTimes(1);
      expect(paystack.verifyTransaction).toHaveBeenCalledWith(sub.paystackReference);

      const row = (await reload(sub._id))!;
      expect(row.status).toBe('active');
      expect(row.seq).toBe(1);
      expect(row.renewalOf).toBeUndefined();
      expect(row.paidAt!.getTime()).toBeGreaterThanOrEqual(before);
      expect(row.paidAt!.getTime()).toBeLessThanOrEqual(after);
      // The first subscription starts the moment it is confirmed.
      expect(iso(row.startsAt)).toBe(iso(row.paidAt));
      expect(iso(row.expiresAt)).toBe(iso(addMonthsUTC(row.startsAt!, 1)));

      const state = await request(app).get('/api/sellers/me/billing').set({ Authorization: bearer(seller.clerkUserId) });
      expect(state.body).toMatchObject({ state: 'active', canShareLink: true, subscription: { id: sub._id.toString(), plan: 'monthly' } });
      expect(state.body.accessEndsAt).toBe(iso(row.expiresAt));
      expect((await request(app).get('/api/sellers/me/share').set({ Authorization: bearer(seller.clerkUserId) })).status).toBe(200);
    });

    it('a quarterly plan lasts three calendar months', async () => {
      const seller = await makeSeller('over');
      const sub = await startedSubscription(seller._id, 'quarterly');
      paystackConfirmsWhatWasAsked();
      await deliver(chargeSuccess(sub.paystackReference)).expect(200);
      const row = (await reload(sub._id))!;
      expect(iso(row.expiresAt)).toBe(iso(addMonthsUTC(row.startsAt!, 3)));
    });

    it('works out calendar months on the confirmed date, in UTC', async () => {
      const seller = await makeSeller('over');
      const a = await startedSubscription(seller._id, 'monthly');
      paystackConfirmsWhatWasAsked();
      await processSubscriptionCharge(a.paystackReference, paystack, () => new Date('2026-01-31T09:00:00.000Z'));
      expect(iso((await reload(a._id))!.expiresAt)).toBe('2026-02-28T09:00:00.000Z');

      const other = await makeSeller('over');
      const q = await startedSubscription(other._id, 'quarterly');
      await processSubscriptionCharge(q.paystackReference, paystack, () => new Date('2026-11-30T23:00:00.000Z'));
      expect(iso((await reload(q._id))!.expiresAt)).toBe('2027-02-28T23:00:00.000Z');
    });

    it('answers 200 for an event it does not act on, without asking Paystack', async () => {
      const seller = await makeSeller('over');
      const sub = await startedSubscription(seller._id);
      for (const body of [
        JSON.stringify({ event: 'charge.failed', data: { reference: sub.paystackReference } }),
        JSON.stringify({ event: 'transfer.success', data: { reference: sub.paystackReference } }),
        JSON.stringify({ event: 'charge.success', data: {} }),
        JSON.stringify({ event: 'charge.success' }),
        'not json at all',
      ]) {
        expect((await deliver(body)).status).toBe(200);
      }
      expect(paystack.verifyTransaction).not.toHaveBeenCalled();
      expect((await reload(sub._id))!.status).toBe('pending');
    });
  });

  describe('replays and simultaneous deliveries change nothing twice', () => {
    it('a repeated delivery is acknowledged, does no work, and leaves the dates alone', async () => {
      const seller = await makeSeller('over');
      const sub = await startedSubscription(seller._id);
      paystackConfirmsWhatWasAsked();
      await deliver(chargeSuccess(sub.paystackReference)).expect(200);
      const first = (await reload(sub._id))!;

      for (let i = 0; i < 3; i += 1) await deliver(chargeSuccess(sub.paystackReference)).expect(200);

      const again = (await reload(sub._id))!;
      expect(iso(again.startsAt)).toBe(iso(first.startsAt));
      expect(iso(again.expiresAt)).toBe(iso(first.expiresAt));
      expect(iso(again.paidAt)).toBe(iso(first.paidAt));
      expect(await SubscriptionModel.countDocuments({ sellerId: seller._id, status: 'active' })).toBe(1);
      // Already counted: it did not even ask Paystack again.
      expect(paystack.verifyTransaction).toHaveBeenCalledTimes(1);
      expect(await events()).toHaveLength(0);
    });

    it('deliveries that all pass the checks before any one claims it still activate it exactly once', async () => {
      // A barrier inside Paystack's confirmation holds every delivery until all five
      // have read the subscription as pending and asked Paystack, so they genuinely
      // race for the single conditional write that activates it.
      const seller = await makeSeller('over');
      const sub = await startedSubscription(seller._id, 'monthly');
      const DELIVERIES = 5;
      let arrived = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      paystack.verifyTransaction.mockImplementation(async (reference) => {
        arrived += 1;
        if (arrived === DELIVERIES) release();
        await gate;
        return { status: 'success', reference, amountKobo: 300_000, currency: 'NGN' };
      });

      const T = new Date('2026-11-05T10:00:00.000Z');
      const results = await Promise.all(Array.from({ length: DELIVERIES }, () => processSubscriptionCharge(sub.paystackReference, paystack, () => T)));

      expect(arrived).toBe(DELIVERIES);
      expect(results.filter((r) => r === 'activated')).toHaveLength(1);
      expect(results.filter((r) => r === 'already_processed')).toHaveLength(DELIVERIES - 1);

      const rows = await SubscriptionModel.find({ sellerId: seller._id });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'active', seq: 1 });
      expect(rows[0]!.renewalOf).toBeUndefined();
      // Not pushed back by a second claim extending it from its own expiry.
      expect(iso(rows[0]!.startsAt)).toBe('2026-11-05T10:00:00.000Z');
      expect(iso(rows[0]!.expiresAt)).toBe('2026-12-05T10:00:00.000Z');
    });

    it('ten deliveries at the same instant activate it once', async () => {
      const seller = await makeSeller('over');
      const sub = await startedSubscription(seller._id);
      paystackConfirmsWhatWasAsked();
      const responses = await Promise.all(Array.from({ length: 10 }, () => deliver(chargeSuccess(sub.paystackReference))));
      for (const r of responses) expect(r.status).toBe(200);

      const rows = await SubscriptionModel.find({ sellerId: seller._id });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'active', seq: 1 });
      expect(iso(rows[0]!.expiresAt)).toBe(iso(addMonthsUTC(rows[0]!.startsAt!, 1)));
    });
  });

  describe('a payment that is not what was asked for is never activated', () => {
    it('a different amount: set aside for a human, not active, and an error event', async () => {
      const seller = await makeSeller('over');
      const sub = await startedSubscription(seller._id, 'quarterly');
      paystack.verifyTransaction.mockImplementation(async (reference) => ({ status: 'success', reference, amountKobo: 300_000, currency: 'NGN' }));

      expect((await deliver(chargeSuccess(sub.paystackReference))).status).toBe(200);
      expect((await reload(sub._id))!).toMatchObject({ status: 'needs_review' });
      expect((await reload(sub._id))!.startsAt).toBeUndefined();
      expect((await reload(sub._id))!.expiresAt).toBeUndefined();

      const logged = await events();
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({ level: 'error', code: 'AMOUNT_MISMATCH', sellerId: seller._id });
      expect(logged[0]!.meta).toMatchObject({ expectedKobo: 1_100_000, receivedKobo: 300_000, reference: sub.paystackReference });

      // A repeat of the same webhook does not revive it.
      await deliver(chargeSuccess(sub.paystackReference)).expect(200);
      expect((await reload(sub._id))!.status).toBe('needs_review');
      expect(await events()).toHaveLength(1);
      expect((await request(app).get('/api/sellers/me/billing').set({ Authorization: bearer(seller.clerkUserId) })).body.canShareLink).toBe(false);
    });

    it('one kobo off, and the right number in the wrong currency, are both refused', async () => {
      for (const [amountKobo, currency] of [[299_999, 'NGN'], [300_001, 'NGN'], [300_000, 'USD'], [3000, 'NGN']] as const) {
        const seller = await makeSeller('over');
        const sub = await startedSubscription(seller._id, 'monthly');
        paystack.verifyTransaction.mockImplementation(async (reference) => ({ status: 'success', reference, amountKobo, currency }));
        await deliver(chargeSuccess(sub.paystackReference)).expect(200);
        expect((await reload(sub._id))!.status).toBe('needs_review');
      }
    });

    it('a confirmation for a different reference than the one asked about is not accepted', async () => {
      const seller = await makeSeller('over');
      const sub = await startedSubscription(seller._id);
      paystack.verifyTransaction.mockImplementation(async () => ({ status: 'success', reference: 'CLS-ffffffffffffffffffffffff', amountKobo: 300_000, currency: 'NGN' }));
      await deliver(chargeSuccess(sub.paystackReference)).expect(200);
      expect((await reload(sub._id))!.status).toBe('pending');
      expect((await events())[0]).toMatchObject({ code: 'NOT_CONFIRMED' });
    });

    it('a failed charge is recorded as failed, never activates, and a later success on the same reference still does', async () => {
      const seller = await makeSeller('over');
      const sub = await startedSubscription(seller._id);
      paystack.verifyTransaction.mockImplementation(async (reference) => ({ status: 'failed', reference, amountKobo: 300_000, currency: 'NGN' }));
      await deliver(chargeSuccess(sub.paystackReference)).expect(200);
      expect((await reload(sub._id))!.status).toBe('failed');
      expect((await events())[0]).toMatchObject({ level: 'warn', code: 'NOT_CONFIRMED' });
      expect((await request(app).get('/api/sellers/me/billing').set({ Authorization: bearer(seller.clerkUserId) })).body.canShareLink).toBe(false);

      paystackConfirmsWhatWasAsked();
      await deliver(chargeSuccess(sub.paystackReference)).expect(200);
      expect((await reload(sub._id))!.status).toBe('active');
    });

    it('an abandoned or pending charge leaves the subscription pending', async () => {
      const seller = await makeSeller('over');
      const sub = await startedSubscription(seller._id);
      for (const status of ['abandoned', 'ongoing', 'pending']) {
        paystack.verifyTransaction.mockImplementation(async (reference) => ({ status, reference, amountKobo: 300_000, currency: 'NGN' }));
        await deliver(chargeSuccess(sub.paystackReference)).expect(200);
        expect((await reload(sub._id))!.status).toBe('pending');
      }
    });

    it('a reference Paystack does not recognise is not activated', async () => {
      const seller = await makeSeller('over');
      const sub = await startedSubscription(seller._id);
      paystack.verifyTransaction.mockRejectedValue(new PaystackError('rejected', 'Transaction reference not found', 404));
      await deliver(chargeSuccess(sub.paystackReference)).expect(200);
      expect((await reload(sub._id))!.status).toBe('pending');
      expect((await events())[0]).toMatchObject({ code: 'NOT_CONFIRMED' });
    });

    it('a reference we never issued is acknowledged, logged, and Paystack is not asked about it', async () => {
      await deliver(chargeSuccess('CLS-0123456789abcdef01234567')).expect(200);
      expect(paystack.verifyTransaction).not.toHaveBeenCalled();
      expect(await SubscriptionModel.countDocuments({})).toBe(0);
      expect((await events())[0]).toMatchObject({ level: 'warn', code: 'UNKNOWN_REFERENCE' });
    });

    it('a reference of the wrong shape never reaches the database', async () => {
      for (const reference of ['CLS-short', 'CLS-' + 'g'.repeat(24), 'cls-' + 'a'.repeat(24), 'CLS-' + 'a'.repeat(25), { $ne: null }]) {
        await deliver(JSON.stringify({ event: 'charge.success', data: { reference } })).expect(200);
      }
      expect(paystack.verifyTransaction).not.toHaveBeenCalled();
      expect(await events()).toHaveLength(0);
    });
  });

  describe('Paystack unreachable', () => {
    it('answers 503 so Paystack resends, changes nothing, and works when Paystack is back', async () => {
      const seller = await makeSeller('over');
      const sub = await startedSubscription(seller._id);
      paystack.verifyTransaction.mockRejectedValue(new PaystackError('unavailable', 'timeout'));
      const down = await deliver(chargeSuccess(sub.paystackReference));
      expect(down.status).toBe(503);
      expect(down.body.error.code).toBe('PAYMENTS_UNAVAILABLE');
      expect((await reload(sub._id))!.status).toBe('pending');
      expect(await EventLogModel.countDocuments({ type: 'payment_webhook_issue', code: 'VERIFY_FAILED' })).toBe(1);

      paystackConfirmsWhatWasAsked();
      await deliver(chargeSuccess(sub.paystackReference)).expect(200);
      expect((await reload(sub._id))!.status).toBe('active');
    });
  });

  describe('the two kinds of payment never mix', () => {
    it('an ORDER reference that claims to be a subscription in its metadata is handled as an order payment', async () => {
      const seller = await makeSeller('over');
      const sub = await startedSubscription(seller._id);
      const orderShaped = 'CLP-' + 'a'.repeat(24);
      await deliver(JSON.stringify({ event: 'charge.success', data: { reference: orderShaped, metadata: { type: 'subscription', sellerId: seller._id.toString() } } })).expect(200);
      expect(await EventLogModel.countDocuments({ type: 'payment_webhook_issue', code: 'UNKNOWN_REFERENCE' })).toBe(1);
      expect(await events()).toHaveLength(0);
      expect((await reload(sub._id))!.status).toBe('pending');
    });

    it('a subscription reference that claims to be an order in its metadata is still a subscription', async () => {
      const seller = await makeSeller('over');
      const sub = await startedSubscription(seller._id);
      paystackConfirmsWhatWasAsked();
      await deliver(JSON.stringify({ event: 'charge.success', data: { reference: sub.paystackReference, metadata: { type: 'order', orderRef: 'CL-ABCDE' } } })).expect(200);
      expect((await reload(sub._id))!.status).toBe('active');
      expect(await EventLogModel.countDocuments({ type: 'payment_webhook_issue' })).toBe(0);
    });

    it('activating one vendor\'s subscription does not touch another vendor', async () => {
      const a = await makeSeller('over');
      const b = await makeSeller('over');
      const subA = await startedSubscription(a._id);
      const subB = await startedSubscription(b._id);
      paystackConfirmsWhatWasAsked();
      await deliver(chargeSuccess(subA.paystackReference)).expect(200);
      expect((await reload(subB._id))!.status).toBe('pending');
      expect((await request(app).get('/api/sellers/me/billing').set({ Authorization: bearer(b.clerkUserId) })).body).toMatchObject({ state: 'expired', canShareLink: false });
      expect((await request(app).get('/api/sellers/me/billing').set({ Authorization: bearer(a.clerkUserId) })).body).toMatchObject({ state: 'active', canShareLink: true });
    });
  });

  describe('renewal: where the next subscription starts', () => {
    it('paying before expiry extends from the CURRENT EXPIRY, not from now', async () => {
      const seller = await makeSeller('over');
      paystackConfirmsWhatWasAsked();
      const first = await startedSubscription(seller._id, 'monthly');
      await processSubscriptionCharge(first.paystackReference, paystack, () => new Date('2026-11-05T10:00:00.000Z'));
      const a = (await reload(first._id))!;
      expect(iso(a.startsAt)).toBe('2026-11-05T10:00:00.000Z');
      expect(iso(a.expiresAt)).toBe('2026-12-05T10:00:00.000Z');

      // 15 days in, with 15 left, the vendor renews early.
      const second = await startedSubscription(seller._id, 'monthly');
      await processSubscriptionCharge(second.paystackReference, paystack, () => new Date('2026-11-20T10:00:00.000Z'));
      const b = (await reload(second._id))!;
      expect(iso(b.startsAt)).toBe('2026-12-05T10:00:00.000Z');
      expect(iso(b.expiresAt)).toBe('2027-01-05T10:00:00.000Z');
      expect(b.seq).toBe(2);
      expect(b.renewalOf?.toString()).toBe(first._id.toString());

      // And a quarterly bought after that follows the second.
      const third = await startedSubscription(seller._id, 'quarterly');
      await processSubscriptionCharge(third.paystackReference, paystack, () => new Date('2026-11-25T10:00:00.000Z'));
      const c = (await reload(third._id))!;
      expect(iso(c.startsAt)).toBe('2027-01-05T10:00:00.000Z');
      expect(iso(c.expiresAt)).toBe('2027-04-05T10:00:00.000Z');
      expect(c.renewalOf?.toString()).toBe(second._id.toString());

      // Cover is unbroken across the seams and ends at the last expiry.
      const state = await request(app).get('/api/sellers/me/billing').set({ Authorization: bearer(seller.clerkUserId) });
      expect(state.body.accessEndsAt).toBe('2027-04-05T10:00:00.000Z');
    });

    it('paying after it lapsed starts from the payment, and the gap is not given back', async () => {
      const seller = await makeSeller('over');
      paystackConfirmsWhatWasAsked();
      const first = await startedSubscription(seller._id, 'monthly');
      await processSubscriptionCharge(first.paystackReference, paystack, () => new Date('2026-11-05T10:00:00.000Z'));

      const late = await startedSubscription(seller._id, 'monthly');
      await processSubscriptionCharge(late.paystackReference, paystack, () => new Date('2027-02-01T08:00:00.000Z'));
      const row = (await reload(late._id))!;
      expect(iso(row.startsAt)).toBe('2027-02-01T08:00:00.000Z');
      expect(iso(row.expiresAt)).toBe('2027-03-01T08:00:00.000Z');
      expect(row.seq).toBe(2);
      expect(row.renewalOf?.toString()).toBe(first._id.toString());
    });

    it('paying at the exact instant the previous one expires starts there, with no gap and no overlap', async () => {
      const seller = await makeSeller('over');
      paystackConfirmsWhatWasAsked();
      const first = await startedSubscription(seller._id, 'monthly');
      await processSubscriptionCharge(first.paystackReference, paystack, () => new Date('2026-11-05T10:00:00.000Z'));
      const next = await startedSubscription(seller._id, 'monthly');
      await processSubscriptionCharge(next.paystackReference, paystack, () => new Date('2026-12-05T10:00:00.000Z'));
      expect(iso((await reload(next._id))!.startsAt)).toBe('2026-12-05T10:00:00.000Z');
    });

    it('a failed or reviewed subscription never counts as the one to extend from', async () => {
      const seller = await makeSeller('over');
      paystackConfirmsWhatWasAsked();
      await SubscriptionModel.create({
        sellerId: seller._id, plan: 'quarterly', amountNaira: 11_000, status: 'needs_review', paystackReference: newSubscriptionReference(),
        startsAt: new Date('2030-01-01T00:00:00.000Z'), expiresAt: new Date('2030-04-01T00:00:00.000Z'),
      });
      const sub = await startedSubscription(seller._id, 'monthly');
      await processSubscriptionCharge(sub.paystackReference, paystack, () => new Date('2026-11-05T10:00:00.000Z'));
      const row = (await reload(sub._id))!;
      expect(iso(row.startsAt)).toBe('2026-11-05T10:00:00.000Z');
      expect(row.seq).toBe(1);
      expect(row.renewalOf).toBeUndefined();
    });

    it('two payments confirmed at the same instant take turns: no overlap, no shared start', async () => {
      paystackConfirmsWhatWasAsked();
      const T = new Date('2026-11-05T10:00:00.000Z');
      for (let round = 0; round < 10; round += 1) {
        const seller = await makeSeller('over');
        const a = await startedSubscription(seller._id, 'monthly');
        const b = await startedSubscription(seller._id, 'quarterly');
        const [ra, rb] = await Promise.all([
          processSubscriptionCharge(a.paystackReference, paystack, () => T),
          processSubscriptionCharge(b.paystackReference, paystack, () => T),
        ]);
        expect([ra, rb]).toEqual(['activated', 'activated']);

        const chain = (await SubscriptionModel.find({ sellerId: seller._id, status: 'active' }).sort({ seq: 1 })).map((s) => ({ seq: s.seq, startsAt: iso(s.startsAt), expiresAt: iso(s.expiresAt) }));
        expect(chain.map((c) => c.seq)).toEqual([1, 2]);
        expect(chain[0]!.startsAt).toBe(iso(T));
        // The second starts exactly where the first ends.
        expect(chain[1]!.startsAt).toBe(chain[0]!.expiresAt);
      }
    });

    it('four at once still form one unbroken chain', async () => {
      paystackConfirmsWhatWasAsked();
      const T = new Date('2026-11-05T10:00:00.000Z');
      const seller = await makeSeller('over');
      const subs = await Promise.all(Array.from({ length: 4 }, () => startedSubscription(seller._id, 'monthly')));
      const results = await Promise.all(subs.map((s) => processSubscriptionCharge(s.paystackReference, paystack, () => T)));
      expect(results).toEqual(['activated', 'activated', 'activated', 'activated']);

      const chain = await SubscriptionModel.find({ sellerId: seller._id, status: 'active' }).sort({ seq: 1 });
      expect(chain.map((c) => c.seq)).toEqual([1, 2, 3, 4]);
      for (let i = 1; i < chain.length; i += 1) expect(iso(chain[i]!.startsAt)).toBe(iso(chain[i - 1]!.expiresAt));
      expect(iso(chain[3]!.expiresAt)).toBe('2027-03-05T10:00:00.000Z');
    });
  });

  describe('what is written to the log', () => {
    it('holds references and amounts, never the key or the vendor\'s contact details', async () => {
      const seller = await makeSeller('over');
      const sub = await startedSubscription(seller._id, 'quarterly');
      paystack.verifyTransaction.mockImplementation(async (reference) => ({ status: 'success', reference, amountKobo: 100, currency: 'NGN' }));
      await deliver(chargeSuccess(sub.paystackReference)).expect(200);
      const text = JSON.stringify(await EventLogModel.find({}));
      expect(text).not.toContain(SECRET);
      expect(text).not.toMatch(/sk_test|2348031234567|0123456789|Owner/);
    });
  });
});
