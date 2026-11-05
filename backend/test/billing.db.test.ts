import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { AuthProvider } from '../src/auth/provider.js';
import { DEFAULT_BILLING, type BillingConfig } from '../src/billing/plans.js';
import { addDaysUTC } from '../src/billing/dates.js';
import { startTrialIfMissing } from '../src/billing/state.js';
import { SUBSCRIPTION_REFERENCE_PATTERN } from '../src/billing/subscribe.js';
import { EventLogModel } from '../src/models/event-log.js';
import { MenuModel } from '../src/models/menu.js';
import { OrderModel } from '../src/models/order.js';
import { SellerModel } from '../src/models/seller.js';
import { SubscriptionModel } from '../src/models/subscription.js';
import { PaystackError } from '../src/payments/paystack.js';
import { lagosDay } from '../src/validation/day.js';
import { connectTestDb, disconnectTestDb, testDbUri } from './helpers/db.js';
import { bearer, fakeAuth } from './helpers/fake-auth.js';
import { fakePaystack } from './helpers/fake-paystack.js';

const LIMITS = { windowMs: 60_000, ordersPerWindow: 10_000, lookupsPerWindow: 10_000, paymentsPerWindow: 10_000 };
const DAY_MS = 86_400_000;
const DAY = lagosDay(new Date(Date.now() + 3 * DAY_MS));

// Emails "on the login account", per user id. The real Clerk lookup is never used.
const loginEmails: Record<string, string | null> = {};
const getEmail = vi.fn(async (userId: string) => loginEmails[userId] ?? null);
const auth: AuthProvider = { ...fakeAuth, getEmail };

const CONFIG: BillingConfig = { ...DEFAULT_BILLING, callbackUrl: 'https://choplistafrica.com/seller/subscription/done', shareUrlBase: 'https://choplistafrica.com/shop' };

let paystack = fakePaystack();
function buildApp(options: { paystack?: ReturnType<typeof fakePaystack> | null; billing?: BillingConfig } = {}) {
  return createApp({
    allowedOrigins: ['http://localhost:5173'],
    auth,
    paystack: options.paystack === undefined ? paystack : options.paystack,
    rateLimits: LIMITS,
    billing: options.billing ?? CONFIG,
  });
}
let app = buildApp();

let counter = 0;
const trialRunning = () => ({ trialStartedAt: new Date(Date.now() - DAY_MS), trialEndsAt: new Date(Date.now() + 6 * DAY_MS), verification: { status: 'not_started' as const } });
const trialOver = () => ({ trialStartedAt: new Date(Date.now() - 30 * DAY_MS), trialEndsAt: new Date(Date.now() - 23 * DAY_MS), verification: { status: 'not_started' as const } });

async function makeSeller(overrides: Record<string, unknown> = {}) {
  counter += 1;
  return SellerModel.create({
    clerkUserId: `user_b${counter}`,
    businessName: `Kitchen ${counter}`,
    slug: `kitchen-b${counter}`,
    phone: '+2348031234567',
    payment: { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Owner', bankCode: '058' },
    billing: trialRunning(),
    ...overrides,
  });
}

const asSeller = (clerkUserId: string) => ({ Authorization: bearer(clerkUserId) });

describe.skipIf(!testDbUri)('vendor billing on a real MongoDB', () => {
  beforeAll(async () => {
    await connectTestDb('billing');
  });
  afterAll(disconnectTestDb);
  beforeEach(async () => {
    paystack = fakePaystack();
    app = buildApp();
    getEmail.mockClear();
    for (const key of Object.keys(loginEmails)) delete loginEmails[key];
    await SubscriptionModel.deleteMany({});
    await EventLogModel.deleteMany({});
  });

  describe('the free trial', () => {
    it('starts when the profile is created, runs 7 days, and verification has not started', async () => {
      const before = Date.now();
      const res = await request(app)
        .put('/api/sellers/me')
        .set(asSeller('user_new_vendor'))
        .send({ businessName: 'Fresh Kitchen', phone: '0803 123 4567', payment: { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Fresh Owner' } });
      const after = Date.now();
      expect(res.status).toBe(201);

      const seller = await SellerModel.findOne({ clerkUserId: 'user_new_vendor' });
      const started = seller!.billing!.trialStartedAt.getTime();
      expect(started).toBeGreaterThanOrEqual(before);
      expect(started).toBeLessThanOrEqual(after);
      expect(seller!.billing!.trialEndsAt.getTime() - started).toBe(7 * DAY_MS);
      expect(seller!.billing!.verification).toMatchObject({ status: 'not_started' });

      const state = await request(app).get('/api/sellers/me/billing').set(asSeller('user_new_vendor'));
      expect(state.body).toMatchObject({ state: 'trial', canShareLink: true, subscription: null, accessEndsAt: null, verificationDue: false });
    });

    it('uses the configured trial length', async () => {
      const custom = buildApp({ billing: { ...CONFIG, trialDays: 14 } });
      await request(custom)
        .put('/api/sellers/me')
        .set(asSeller('user_long_trial'))
        .send({ businessName: 'Long Trial', phone: '0803 123 4567', payment: { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Owner' } });
      const seller = await SellerModel.findOne({ clerkUserId: 'user_long_trial' });
      expect(seller!.billing!.trialEndsAt.getTime() - seller!.billing!.trialStartedAt.getTime()).toBe(14 * DAY_MS);
    });

    it('updating the profile later does not restart the trial', async () => {
      const seller = await makeSeller();
      const before = (await SellerModel.findById(seller._id))!.billing!.trialStartedAt.getTime();
      await request(app)
        .put('/api/sellers/me')
        .set(asSeller(seller.clerkUserId))
        .send({ businessName: 'Renamed Kitchen', phone: '0803 123 4567', payment: { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Owner', bankCode: '058' } })
        .expect(200);
      expect((await SellerModel.findById(seller._id))!.billing!.trialStartedAt.getTime()).toBe(before);
    });

    it('never moves a trial that has begun, even if the caller did not know it had', async () => {
      const seller = await makeSeller();
      const original = (await SellerModel.findById(seller._id))!.billing!;
      await startTrialIfMissing(seller._id, CONFIG, new Date(Date.now() + 5 * DAY_MS));
      const after = (await SellerModel.findById(seller._id))!.billing!;
      expect(after.trialStartedAt.getTime()).toBe(original.trialStartedAt.getTime());
      expect(after.trialEndsAt.getTime()).toBe(original.trialEndsAt.getTime());
    });

    it('starts the trial for a seller who has none, at the time given and for the configured days', async () => {
      const legacy = await makeSeller({ billing: undefined });
      const at = new Date('2026-11-10T08:00:00.000Z');
      await startTrialIfMissing(legacy._id, { ...CONFIG, trialDays: 10 }, at);
      const stored = (await SellerModel.findById(legacy._id))!.billing!;
      expect(stored.trialStartedAt.toISOString()).toBe('2026-11-10T08:00:00.000Z');
      expect(stored.trialEndsAt.toISOString()).toBe('2026-11-20T08:00:00.000Z');
      expect(stored.verification!.status).toBe('not_started');
    });

    it('gives a seller from before billing a trial starting now, once, even when asked in parallel', async () => {
      const legacy = await makeSeller({ billing: undefined });
      expect((await SellerModel.findById(legacy._id))!.billing).toBeUndefined();

      const before = Date.now();
      const responses = await Promise.all(Array.from({ length: 8 }, () => request(app).get('/api/sellers/me/billing').set(asSeller(legacy.clerkUserId))));
      const after = Date.now();

      const starts = new Set(responses.map((r) => r.body.trialStartedAt as string));
      expect(starts.size).toBe(1);
      for (const r of responses) expect(r.body).toMatchObject({ state: 'trial', canShareLink: true });
      const stored = (await SellerModel.findById(legacy._id))!.billing!;
      expect(stored.trialStartedAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(stored.trialStartedAt.getTime()).toBeLessThanOrEqual(after);
      expect(stored.trialEndsAt.getTime()).toBe(addDaysUTC(stored.trialStartedAt, 7).getTime());

      // Asking again never moves it.
      const again = await request(app).get('/api/sellers/me/billing').set(asSeller(legacy.clerkUserId));
      expect(again.body.trialStartedAt).toBe(starts.values().next().value);
    });
  });

  describe('GET /api/sellers/me/billing', () => {
    it('needs a sign-in and a profile, and a suspended seller is refused', async () => {
      await request(app).get('/api/sellers/me/billing').expect(401);
      expect((await request(app).get('/api/sellers/me/billing').set(asSeller('user_nobody'))).body.error.code).toBe('PROFILE_REQUIRED');
      const suspended = await makeSeller({ status: 'suspended' });
      expect((await request(app).get('/api/sellers/me/billing').set(asSeller(suspended.clerkUserId))).body.error.code).toBe('ACCOUNT_SUSPENDED');
    });

    it('lists both plans, the quarterly one as the pending-confirmation placeholder', async () => {
      const seller = await makeSeller();
      const res = await request(app).get('/api/sellers/me/billing').set(asSeller(seller.clerkUserId));
      expect(res.body.plans).toEqual([
        { id: 'monthly', months: 1, priceNaira: 3000 },
        { id: 'quarterly', months: 3, priceNaira: 8000 },
      ]);
    });

    it('says expired, and verification due, once the trial is over with nothing bought', async () => {
      const seller = await makeSeller({ billing: trialOver() });
      const res = await request(app).get('/api/sellers/me/billing').set(asSeller(seller.clerkUserId));
      expect(res.body).toMatchObject({ state: 'expired', canShareLink: false, subscription: null, verificationDue: true });
    });

    it('never contains another seller\'s data, a Paystack code or the delivery/access secrets', async () => {
      const seller = await makeSeller({ paystackSubaccountCode: 'ACCT_secretcode' });
      const res = await request(app).get('/api/sellers/me/billing').set(asSeller(seller.clerkUserId));
      const text = JSON.stringify(res.body);
      expect(text).not.toMatch(/ACCT_|accessKey|deliveryCode|clerkUserId|sk_/);
    });
  });

  describe('GET /api/sellers/me/share (the endpoint that hands out the link)', () => {
    it('gives the link during the trial, built from the configured base', async () => {
      const seller = await makeSeller();
      const res = await request(app).get('/api/sellers/me/share').set(asSeller(seller.clerkUserId));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ slug: seller.slug, url: `https://choplistafrica.com/shop/${seller.slug}` });
    });

    it('returns the slug with url null when no share base is configured', async () => {
      const seller = await makeSeller();
      const bare = buildApp({ billing: { ...DEFAULT_BILLING } });
      const res = await request(bare).get('/api/sellers/me/share').set(asSeller(seller.clerkUserId));
      expect(res.body).toEqual({ slug: seller.slug, url: null });
    });

    it('refuses once the trial has ended with no subscription: 403 SHARING_NOT_ALLOWED', async () => {
      const seller = await makeSeller({ billing: trialOver() });
      const res = await request(app).get('/api/sellers/me/share').set(asSeller(seller.clerkUserId));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('SHARING_NOT_ALLOWED');
      expect(JSON.stringify(res.body)).not.toContain(seller.slug);
    });

    it('refuses once a paid subscription has expired', async () => {
      const seller = await makeSeller({ billing: trialOver() });
      await SubscriptionModel.create({
        sellerId: seller._id, plan: 'monthly', amountNaira: 3000, status: 'active', paystackReference: 'CLS-aaaaaaaaaaaaaaaaaaaaaaaa',
        paidAt: new Date(Date.now() - 40 * DAY_MS), startsAt: new Date(Date.now() - 40 * DAY_MS), expiresAt: new Date(Date.now() - 10 * DAY_MS), seq: 1,
      });
      expect((await request(app).get('/api/sellers/me/share').set(asSeller(seller.clerkUserId))).body.error.code).toBe('SHARING_NOT_ALLOWED');
      expect((await request(app).get('/api/sellers/me/billing').set(asSeller(seller.clerkUserId))).body).toMatchObject({ state: 'expired', canShareLink: false });
    });

    it('allows an expired-trial vendor with a live subscription', async () => {
      const seller = await makeSeller({ billing: trialOver() });
      await SubscriptionModel.create({
        sellerId: seller._id, plan: 'monthly', amountNaira: 3000, status: 'active', paystackReference: 'CLS-bbbbbbbbbbbbbbbbbbbbbbbb',
        paidAt: new Date(Date.now() - 2 * DAY_MS), startsAt: new Date(Date.now() - 2 * DAY_MS), expiresAt: new Date(Date.now() + 28 * DAY_MS), seq: 1,
      });
      expect((await request(app).get('/api/sellers/me/share').set(asSeller(seller.clerkUserId))).status).toBe(200);
    });

    it('does not count a pending, failed or review subscription as cover', async () => {
      const seller = await makeSeller({ billing: trialOver() });
      for (const [i, status] of (['pending', 'failed', 'needs_review'] as const).entries()) {
        await SubscriptionModel.create({ sellerId: seller._id, plan: 'monthly', amountNaira: 3000, status, paystackReference: `CLS-${String(i).repeat(24)}` });
      }
      expect((await request(app).get('/api/sellers/me/share').set(asSeller(seller.clerkUserId))).status).toBe(403);
    });

    it('needs a sign-in and a profile', async () => {
      await request(app).get('/api/sellers/me/share').expect(401);
      expect((await request(app).get('/api/sellers/me/share').set(asSeller('user_nobody'))).body.error.code).toBe('PROFILE_REQUIRED');
    });
  });

  describe('the restriction is soft: an expired vendor\'s link still works for customers', () => {
    it('keeps showing the menu, taking orders, and lets the vendor open a menu', async () => {
      const seller = await makeSeller({ billing: trialOver() });
      const menu = await MenuModel.create({
        sellerId: seller._id, title: 'Expired shop menu', status: 'open', openedAt: new Date(), cutoffAt: new Date(Date.now() + 2 * DAY_MS),
        areas: ['Yaba'], deliveryDays: [DAY], items: [{ name: 'Jollof rice', price: 3500, qtyTotal: 5, qtyRemaining: 5 }],
      });

      const shop = await request(app).get(`/api/public/menu/${seller.slug}`);
      expect(shop.status).toBe(200);
      expect(shop.body.menu).toMatchObject({ title: 'Expired shop menu', acceptingOrders: true });

      const placed = await request(app)
        .post('/api/public/orders')
        .send({
          menuId: menu._id.toString(),
          customer: { name: 'Ada Obi', phone: '0809 111 2222' },
          delivery: { area: 'yaba', address: '12 Herbert Macaulay Way, Yaba', day: DAY },
          lines: [{ itemId: menu.items[0]!._id.toString(), qty: 1 }],
        });
      expect(placed.status).toBe(201);
      expect(await OrderModel.countDocuments({ sellerId: seller._id })).toBe(1);

      // Opening a menu is not blocked either (a deliberate product decision).
      const draft = await MenuModel.create({
        sellerId: seller._id, title: 'Next week', status: 'draft', cutoffAt: new Date(Date.now() + 5 * DAY_MS),
        areas: ['Yaba'], deliveryDays: [DAY], items: [{ name: 'Beans', price: 1000, qtyTotal: 3, qtyRemaining: 3 }],
      });
      await MenuModel.updateOne({ _id: menu._id }, { $set: { status: 'closed' } });
      const opened = await request(app).post(`/api/menus/${draft._id}/open`).set(asSeller(seller.clerkUserId));
      expect(opened.status).toBe(200);
    });
  });

  describe('POST /api/sellers/me/billing/subscribe', () => {
    it('needs a sign-in and a profile, and a known plan', async () => {
      await request(app).post('/api/sellers/me/billing/subscribe').send({ plan: 'monthly' }).expect(401);
      expect((await request(app).post('/api/sellers/me/billing/subscribe').set(asSeller('user_nobody')).send({ plan: 'monthly' })).body.error.code).toBe('PROFILE_REQUIRED');
      const seller = await makeSeller();
      for (const body of [{}, { plan: 'yearly' }, { plan: 3000 }, { plan: 'MONTHLY' }]) {
        const res = await request(app).post('/api/sellers/me/billing/subscribe').set(asSeller(seller.clerkUserId)).send(body);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
      expect(paystack.initializeTransaction).not.toHaveBeenCalled();
      expect(await SubscriptionModel.countDocuments({})).toBe(0);
    });

    it('answers 503 PAYMENTS_UNAVAILABLE and records nothing when Paystack is not configured', async () => {
      const seller = await makeSeller();
      const off = buildApp({ paystack: null });
      const res = await request(off).post('/api/sellers/me/billing/subscribe').set(asSeller(seller.clerkUserId)).send({ plan: 'monthly' });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('PAYMENTS_UNAVAILABLE');
      expect(await SubscriptionModel.countDocuments({})).toBe(0);
    });

    it('starts a monthly payment to ChopList\'s own account: no subaccount, no split, no bearer', async () => {
      const seller = await makeSeller({ paystackSubaccountCode: 'ACCT_vendor', paymentsReady: true });
      const res = await request(app).post('/api/sellers/me/billing/subscribe').set(asSeller(seller.clerkUserId)).send({ plan: 'monthly' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ plan: 'monthly', amountNaira: 3000 });
      expect(res.body.reference).toMatch(SUBSCRIPTION_REFERENCE_PATTERN);
      expect(res.body.authorizationUrl).toBe(`https://checkout.paystack.com/${res.body.reference}`);

      expect(paystack.initializeTransaction).toHaveBeenCalledTimes(1);
      const sent = paystack.initializeTransaction.mock.calls[0]![0];
      expect(sent).toMatchObject({
        amountKobo: 300_000,
        reference: res.body.reference,
        callbackUrl: 'https://choplistafrica.com/seller/subscription/done',
        metadata: { type: 'subscription', plan: 'monthly', sellerId: seller._id.toString() },
      });
      // The vendor's own payout account must play no part: this money is ChopList's.
      expect(sent).not.toHaveProperty('subaccountCode');
      expect(sent).not.toHaveProperty('transactionChargeKobo');
      expect(sent).not.toHaveProperty('bearer');
      expect(JSON.stringify(sent)).not.toContain('ACCT_vendor');

      const row = await SubscriptionModel.findOne({ paystackReference: res.body.reference });
      expect(row).toMatchObject({ plan: 'monthly', amountNaira: 3000, status: 'pending' });
      expect(row!.startsAt).toBeUndefined();
      expect(row!.expiresAt).toBeUndefined();
      expect(row!.paidAt).toBeUndefined();
    });

    it('charges the quarterly price for the quarterly plan', async () => {
      const seller = await makeSeller();
      const res = await request(app).post('/api/sellers/me/billing/subscribe').set(asSeller(seller.clerkUserId)).send({ plan: 'quarterly' });
      expect(res.body).toMatchObject({ plan: 'quarterly', amountNaira: 8000 });
      expect(paystack.initializeTransaction.mock.calls[0]![0].amountKobo).toBe(800_000);
    });

    it('uses the prices from the configuration, frozen on the row', async () => {
      const seller = await makeSeller();
      const repriced = buildApp({ billing: { ...CONFIG, monthlyNaira: 3500, quarterlyNaira: 9500 } });
      const res = await request(repriced).post('/api/sellers/me/billing/subscribe').set(asSeller(seller.clerkUserId)).send({ plan: 'monthly' });
      expect(res.body.amountNaira).toBe(3500);
      expect(paystack.initializeTransaction.mock.calls[0]![0].amountKobo).toBe(350_000);
      expect((await SubscriptionModel.findOne({ paystackReference: res.body.reference }))!.amountNaira).toBe(3500);
    });

    it('does NOT activate anything: coming back from checkout is not payment', async () => {
      const seller = await makeSeller({ billing: trialOver() });
      const started = await request(app).post('/api/sellers/me/billing/subscribe').set(asSeller(seller.clerkUserId)).send({ plan: 'monthly' });
      const status = await request(app).get(`/api/sellers/me/billing/subscriptions/${started.body.reference}`).set(asSeller(seller.clerkUserId));
      expect(status.body).toMatchObject({ status: 'pending', startsAt: null, expiresAt: null, paidAt: null });
      expect(status.headers['cache-control']).toBe('no-store');
      expect((await request(app).get('/api/sellers/me/billing').set(asSeller(seller.clerkUserId))).body).toMatchObject({ state: 'expired', canShareLink: false });
      expect((await request(app).get('/api/sellers/me/share').set(asSeller(seller.clerkUserId))).status).toBe(403);
    });

    describe('which email Paystack is given', () => {
      it('prefers the email on the seller profile and does not ask the login provider', async () => {
        const seller = await makeSeller({ email: 'owner@kitchen.ng' });
        loginEmails[seller.clerkUserId] = 'login@account.ng';
        await request(app).post('/api/sellers/me/billing/subscribe').set(asSeller(seller.clerkUserId)).send({ plan: 'monthly' }).expect(200);
        expect(paystack.initializeTransaction.mock.calls[0]![0].email).toBe('owner@kitchen.ng');
        expect(getEmail).not.toHaveBeenCalled();
      });

      it('falls back to the email on the login account', async () => {
        const seller = await makeSeller();
        loginEmails[seller.clerkUserId] = 'Login@Account.ng';
        await request(app).post('/api/sellers/me/billing/subscribe').set(asSeller(seller.clerkUserId)).send({ plan: 'monthly' }).expect(200);
        expect(paystack.initializeTransaction.mock.calls[0]![0].email).toBe('login@account.ng');
        expect(getEmail).toHaveBeenCalledWith(seller.clerkUserId);
      });

      it('uses the placeholder only as a last resort', async () => {
        const seller = await makeSeller();
        await request(app).post('/api/sellers/me/billing/subscribe').set(asSeller(seller.clerkUserId)).send({ plan: 'monthly' }).expect(200);
        expect(paystack.initializeTransaction.mock.calls[0]![0].email).toBe(`${seller._id.toString()}@sellers.choplistafrica.com`);
      });

      it('does not let a broken login lookup, or a nonsense email, stop the payment', async () => {
        const seller = await makeSeller();
        getEmail.mockRejectedValueOnce(new Error('clerk is down'));
        await request(app).post('/api/sellers/me/billing/subscribe').set(asSeller(seller.clerkUserId)).send({ plan: 'monthly' }).expect(200);
        expect(paystack.initializeTransaction.mock.calls[0]![0].email).toMatch(/@sellers\.choplistafrica\.com$/);

        loginEmails[seller.clerkUserId] = 'not an email';
        await request(app).post('/api/sellers/me/billing/subscribe').set(asSeller(seller.clerkUserId)).send({ plan: 'monthly' }).expect(200);
        expect(paystack.initializeTransaction.mock.calls[1]![0].email).toMatch(/@sellers\.choplistafrica\.com$/);
      });
    });

    it('when Paystack fails: 503, no row, an event, and none of Paystack\'s wording or a key reaches the vendor', async () => {
      const seller = await makeSeller();
      paystack.initializeTransaction.mockRejectedValueOnce(new PaystackError('rejected', 'Invalid key sk_test_abcdef123456 supplied', 401));
      const res = await request(app).post('/api/sellers/me/billing/subscribe').set(asSeller(seller.clerkUserId)).send({ plan: 'monthly' });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('PAYMENTS_UNAVAILABLE');
      expect(JSON.stringify(res.body)).not.toMatch(/sk_test|Invalid key/);
      expect(await SubscriptionModel.countDocuments({})).toBe(0);

      const events = await EventLogModel.find({ type: 'subscription_start_failed' });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ level: 'error', code: 'PAYSTACK_REJECTED' });
      expect(JSON.stringify(events[0])).not.toContain('sk_test_abcdef123456');
    });
  });

  describe('subscription history', () => {
    it('lists only this vendor\'s attempts, newest first, and hides other vendors\' references', async () => {
      const mine = await makeSeller();
      const other = await makeSeller();
      const a = await request(app).post('/api/sellers/me/billing/subscribe').set(asSeller(mine.clerkUserId)).send({ plan: 'monthly' });
      const b = await request(app).post('/api/sellers/me/billing/subscribe').set(asSeller(mine.clerkUserId)).send({ plan: 'quarterly' });
      const theirs = await request(app).post('/api/sellers/me/billing/subscribe').set(asSeller(other.clerkUserId)).send({ plan: 'monthly' });

      const list = await request(app).get('/api/sellers/me/billing/subscriptions').set(asSeller(mine.clerkUserId));
      expect(list.body.subscriptions.map((s: { reference: string }) => s.reference)).toEqual([b.body.reference, a.body.reference]);

      for (const reference of [theirs.body.reference, 'CLS-ffffffffffffffffffffffff', 'nonsense', 'CLP-ffffffffffffffffffffffff']) {
        const res = await request(app).get(`/api/sellers/me/billing/subscriptions/${reference}`).set(asSeller(mine.clerkUserId));
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('SUBSCRIPTION_NOT_FOUND');
      }
      await request(app).get('/api/sellers/me/billing/subscriptions').expect(401);
    });
  });

  describe('indexes', () => {
    it('refuses a repeated Paystack reference and a second confirmed subscription in the same position', async () => {
      const seller = await makeSeller();
      const base = { sellerId: seller._id, plan: 'monthly', amountNaira: 3000 } as const;
      await SubscriptionModel.create({ ...base, status: 'pending', paystackReference: 'CLS-111111111111111111111111' });
      await expect(SubscriptionModel.create({ ...base, status: 'pending', paystackReference: 'CLS-111111111111111111111111' })).rejects.toMatchObject({ code: 11000 });

      const when = new Date();
      await SubscriptionModel.create({ ...base, status: 'active', paystackReference: 'CLS-222222222222222222222222', paidAt: when, startsAt: when, expiresAt: addDaysUTC(when, 30), seq: 1 });
      await expect(
        SubscriptionModel.create({ ...base, status: 'active', paystackReference: 'CLS-333333333333333333333333', paidAt: when, startsAt: when, expiresAt: addDaysUTC(when, 30), seq: 1 }),
      ).rejects.toMatchObject({ code: 11000 });
      // The same position is fine for a different vendor, and while not confirmed.
      const other = await makeSeller();
      await SubscriptionModel.create({ ...base, sellerId: other._id, status: 'active', paystackReference: 'CLS-444444444444444444444444', paidAt: when, startsAt: when, expiresAt: addDaysUTC(when, 30), seq: 1 });
      await SubscriptionModel.create({ ...base, status: 'failed', paystackReference: 'CLS-555555555555555555555555', seq: 1 });
    });
  });
});
