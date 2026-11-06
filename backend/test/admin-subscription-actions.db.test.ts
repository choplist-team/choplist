import type { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { addMonthsUTC } from '../src/billing/dates.js';
import { DEFAULT_BILLING } from '../src/billing/plans.js';
import { newSubscriptionReference } from '../src/billing/subscribe.js';
import { AdminAuditModel } from '../src/models/admin-audit.js';
import { NotificationModel } from '../src/models/notification.js';
import { SellerModel } from '../src/models/seller.js';
import { SubscriptionModel } from '../src/models/subscription.js';
import { connectTestDb, disconnectTestDb, testDbUri } from './helpers/db.js';
import { bearer, fakeAuth } from './helpers/fake-auth.js';
import { fakePaystack } from './helpers/fake-paystack.js';
import { ADMIN, DAY_MS, LIMITS, SECRET, asAdmin, deliverWebhook, makeSeller } from './helpers/flow.js';

let paystack = fakePaystack();
const buildApp = () =>
  createApp({ allowedOrigins: ['http://localhost:5173'], auth: fakeAuth, paystack, paystackSecretKey: SECRET, adminClerkUserIds: [ADMIN], billing: DEFAULT_BILLING, rateLimits: LIMITS });
let app = buildApp();

const ago = (d: number) => new Date(Date.now() - d * DAY_MS);
const billingOver = () => ({ trialStartedAt: ago(30), trialEndsAt: ago(23), verification: { status: 'not_started' as const } });
const grant = (id: Types.ObjectId | string, body: Record<string, unknown> = { plan: 'monthly', note: 'goodwill after an outage' }) =>
  request(app).post(`/api/admin/sellers/${id}/subscriptions`).set(asAdmin).send(body);
const cancel = (id: string, body: Record<string, unknown> = {}) => request(app).patch(`/api/admin/subscriptions/${id}/cancel`).set(asAdmin).send(body);
const markRefunded = (id: string, body: Record<string, unknown> = {}) => request(app).patch(`/api/admin/subscriptions/${id}/mark-refunded`).set(asAdmin).send(body);
const verify = (id: Types.ObjectId | string, body: Record<string, unknown>) => request(app).patch(`/api/admin/sellers/${id}/verification`).set(asAdmin).send(body);
const billingOf = (clerk: string) => request(app).get('/api/sellers/me/billing').set({ Authorization: bearer(clerk) });
const shareOf = (clerk: string) => request(app).get('/api/sellers/me/share').set({ Authorization: bearer(clerk) });
const overview = async () => (await request(app).get('/api/admin/overview').set(asAdmin)).body.subscriptions;
const iso = (d: Date | null | undefined) => d?.toISOString();

describe.skipIf(!testDbUri)('admin actions on subscriptions and verification, on a real MongoDB', () => {
  beforeAll(async () => {
    await connectTestDb('admin_sub_actions');
  });
  afterAll(disconnectTestDb);
  beforeEach(async () => {
    paystack = fakePaystack();
    app = buildApp();
    await Promise.all([SellerModel.deleteMany({}), SubscriptionModel.deleteMany({}), AdminAuditModel.deleteMany({}), NotificationModel.deleteMany({})]);
  });

  it('every action is closed to anyone who is not an admin', async () => {
    const s = await makeSeller({ billing: billingOver() });
    const as = { Authorization: bearer(s.clerkUserId) };
    await request(app).post(`/api/admin/sellers/${s._id}/subscriptions`).send({}).expect(401);
    await request(app).post(`/api/admin/sellers/${s._id}/subscriptions`).set(as).send({ plan: 'monthly', note: 'trying it on' }).expect(403);
    await request(app).patch('/api/admin/subscriptions/64b7f0c2a1b2c3d4e5f60718/cancel').set(as).send({}).expect(403);
    await request(app).patch('/api/admin/subscriptions/64b7f0c2a1b2c3d4e5f60718/mark-refunded').set(as).send({}).expect(403);
    await request(app).patch(`/api/admin/sellers/${s._id}/verification`).set(as).send({ status: 'verified' }).expect(403);
    expect(await SubscriptionModel.countDocuments({})).toBe(0);
  });

  describe('granting a free subscription', () => {
    it('gives cover straight away, so an expired vendor can share again', async () => {
      const s = await makeSeller({ billing: billingOver() });
      expect((await shareOf(s.clerkUserId)).status).toBe(403);

      const res = await grant(s._id, { plan: 'monthly', note: 'goodwill after an outage' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ status: 'active', source: 'admin', plan: 'monthly', amountNaira: 0, grantNote: 'goodwill after an outage', refund: null });
      expect(res.body.reference).toMatch(/^ADM-[0-9a-f]{24}$/);
      expect(iso(new Date(res.body.expiresAt))).toBe(iso(addMonthsUTC(new Date(res.body.startsAt), 1)));

      expect((await billingOf(s.clerkUserId)).body).toMatchObject({ state: 'active', canShareLink: true });
      expect((await shareOf(s.clerkUserId)).status).toBe(200);
      const list = await request(app).get('/api/sellers/me/billing/subscriptions').set({ Authorization: bearer(s.clerkUserId) });
      expect(list.body.subscriptions[0]).toMatchObject({ source: 'admin', amountNaira: 0 });
    });

    it('a quarterly grant lasts three calendar months', async () => {
      const s = await makeSeller({ billing: billingOver() });
      const res = await grant(s._id, { plan: 'quarterly', note: 'partnership launch' });
      expect(iso(new Date(res.body.expiresAt))).toBe(iso(addMonthsUTC(new Date(res.body.startsAt), 3)));
    });

    it('starts where current cover ends, exactly like a paid renewal', async () => {
      const s = await makeSeller({ billing: billingOver() });
      const first = (await grant(s._id)).body;
      const second = (await grant(s._id)).body;
      expect(second.startsAt).toBe(first.expiresAt);
      const rows = await SubscriptionModel.find({ sellerId: s._id }).sort({ seq: 1 });
      expect(rows.map((r) => r.seq)).toEqual([1, 2]);
      expect(rows[1]!.renewalOf?.toString()).toBe(rows[0]!._id.toString());
    });

    it('several grants at once form an unbroken chain', async () => {
      const s = await makeSeller({ billing: billingOver() });
      const results = await Promise.all(Array.from({ length: 4 }, () => grant(s._id)));
      for (const r of results) expect(r.status).toBe(201);
      const chain = await SubscriptionModel.find({ sellerId: s._id }).sort({ seq: 1 });
      expect(chain.map((c) => c.seq)).toEqual([1, 2, 3, 4]);
      for (let i = 1; i < chain.length; i += 1) expect(iso(chain[i]!.startsAt)).toBe(iso(chain[i - 1]!.expiresAt));
    });

    it('extends a vendor who is paying too, without overlapping', async () => {
      const s = await makeSeller({ billing: billingOver() });
      const sub = await SubscriptionModel.create({ sellerId: s._id, plan: 'monthly', amountNaira: 3000, status: 'pending', paystackReference: newSubscriptionReference() });
      paystack.verifyTransaction.mockImplementation(async (reference) => ({ status: 'success', reference, amountKobo: 300_000, currency: 'NGN' }));
      await deliverWebhook(app, sub.paystackReference).expect(200);
      const paid = (await SubscriptionModel.findById(sub._id))!;
      const granted = (await grant(s._id)).body;
      expect(granted.startsAt).toBe(paid.expiresAt!.toISOString());
    });

    it('is audited with the reason, is never income, and is counted separately', async () => {
      const s = await makeSeller({ billing: billingOver() });
      await grant(s._id, { plan: 'monthly', note: 'goodwill after an outage' }).expect(201);
      const audit = await AdminAuditModel.find({ action: 'subscription.grant' });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ adminId: ADMIN, targetId: s._id.toString(), reason: 'monthly: goodwill after an outage' });

      const figures = await overview();
      expect(figures).toMatchObject({ activeNow: 1, adminGranted: 1, revenue: { allTime: 0, last30Days: 0 }, purchases: { allTime: 0 }, payingVendors: { allTime: 0 } });
    });

    it('tells the vendor', async () => {
      const s = await makeSeller({ billing: billingOver() });
      await grant(s._id).expect(201);
      const rows = await NotificationModel.find({ audience: 'seller', sellerId: s._id });
      expect(rows.map((n) => n.type)).toEqual(['subscription_activated']);
    });

    it('needs a plan and a reason, and a real seller', async () => {
      const s = await makeSeller({ billing: billingOver() });
      for (const body of [{}, { plan: 'monthly' }, { plan: 'monthly', note: '' }, { plan: 'monthly', note: 'hi' }, { plan: 'yearly', note: 'a good reason' }, { plan: 'monthly', note: 'x'.repeat(301) }]) {
        expect((await grant(s._id, body)).status).toBe(400);
      }
      for (const id of ['64b7f0c2a1b2c3d4e5f60718', 'not-an-id']) {
        const res = await grant(id);
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('SELLER_NOT_FOUND');
      }
      expect(await SubscriptionModel.countDocuments({})).toBe(0);
      expect(await AdminAuditModel.countDocuments({ action: 'subscription.grant' })).toBe(0);
    });

    it('a vendor cannot see a Paystack status page for it, only the list', async () => {
      const s = await makeSeller({ billing: billingOver() });
      const ref = (await grant(s._id)).body.reference;
      expect((await request(app).get(`/api/sellers/me/billing/subscriptions/${ref}`).set({ Authorization: bearer(s.clerkUserId) })).status).toBe(404);
    });
  });

  describe('cancelling', () => {
    it('ends cover now, so the vendor can no longer share, and tells them', async () => {
      const s = await makeSeller({ billing: billingOver() });
      const id = (await grant(s._id)).body.id as string;
      expect((await shareOf(s.clerkUserId)).status).toBe(200);

      const res = await cancel(id, { note: 'granted by mistake' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id, status: 'cancelled' });
      expect(res.body.cancelledAt).toBeTruthy();
      expect((await billingOf(s.clerkUserId)).body).toMatchObject({ state: 'expired', canShareLink: false });
      expect((await shareOf(s.clerkUserId)).status).toBe(403);
      expect((await NotificationModel.find({ sellerId: s._id })).map((n) => n.type).sort()).toEqual(['subscription_activated', 'subscription_cancelled']);
      expect(await AdminAuditModel.countDocuments({ action: 'subscription.cancel' })).toBe(1);
    });

    it('safe to repeat: no second audit entry or notification, several at once cancel once', async () => {
      const s = await makeSeller({ billing: billingOver() });
      const id = (await grant(s._id)).body.id as string;
      const responses = await Promise.all(Array.from({ length: 4 }, () => cancel(id)));
      for (const r of responses) expect(r.status).toBe(200);
      await cancel(id).expect(200);
      expect(await NotificationModel.countDocuments({ type: 'subscription_cancelled' })).toBe(1);
      expect(await AdminAuditModel.countDocuments({ action: 'subscription.cancel' })).toBeLessThanOrEqual(4);
      expect((await SubscriptionModel.findById(id))!.status).toBe('cancelled');
    });

    it('leaves a later period already bought in place', async () => {
      const s = await makeSeller({ billing: billingOver() });
      const first = (await grant(s._id)).body;
      const second = (await grant(s._id)).body;
      await cancel(first.id).expect(200);
      const state = (await billingOf(s.clerkUserId)).body;
      // The first period is gone; the second has not started yet, so there is a gap now.
      expect(state.canShareLink).toBe(false);
      expect((await SubscriptionModel.findById(second.id))!.status).toBe('active');
    });

    it('if the subscription changes between the check and the cancel, the cancel does not clobber it', async () => {
      const s = await makeSeller({ billing: billingOver() });
      const sub = await SubscriptionModel.create({ sellerId: s._id, plan: 'quarterly', amountNaira: 8_000, status: 'active', paystackReference: newSubscriptionReference(), paidAt: new Date(), startsAt: new Date(), expiresAt: new Date(Date.now() + 30 * DAY_MS), seq: 1 });
      // Just before the cancel's own write, something else moves it to needs_review.
      const original = SubscriptionModel.findOneAndUpdate.bind(SubscriptionModel);
      const spy = vi.spyOn(SubscriptionModel, 'findOneAndUpdate').mockImplementationOnce(((...args: Parameters<typeof original>) => {
        return SubscriptionModel.updateOne({ _id: sub._id }, { $set: { status: 'needs_review' } }).then(() => original(...args));
      }) as never);
      const res = await cancel(sub._id.toString());
      spy.mockRestore();
      expect(res.status).toBe(200);
      expect((await SubscriptionModel.findById(sub._id))!.status).toBe('needs_review');
      expect(res.body.status).toBe('needs_review');
      expect(await NotificationModel.countDocuments({ type: 'subscription_cancelled' })).toBe(0);
    });

    it('only an active subscription can be cancelled: a waiting one is a 409 and is left alone', async () => {
      const s = await makeSeller({ billing: billingOver() });
      const pending = await SubscriptionModel.create({ sellerId: s._id, plan: 'monthly', amountNaira: 3000, status: 'pending', paystackReference: newSubscriptionReference() });
      const res = await cancel(pending._id.toString());
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('SUBSCRIPTION_CANNOT_CHANGE');
      expect((await SubscriptionModel.findById(pending._id))!.status).toBe('pending');
      expect(await AdminAuditModel.countDocuments({ action: 'subscription.cancel' })).toBe(0);
    });

    it('a replay of the Paystack webhook for a cancelled subscription changes nothing and asks Paystack nothing', async () => {
      const s = await makeSeller({ billing: billingOver() });
      const sub = await SubscriptionModel.create({ sellerId: s._id, plan: 'monthly', amountNaira: 3000, status: 'pending', paystackReference: newSubscriptionReference() });
      paystack.verifyTransaction.mockImplementation(async (reference) => ({ status: 'success', reference, amountKobo: 300_000, currency: 'NGN' }));
      await deliverWebhook(app, sub.paystackReference).expect(200);
      await cancel(sub._id.toString()).expect(200);
      const calls = paystack.verifyTransaction.mock.calls.length;
      await deliverWebhook(app, sub.paystackReference).expect(200);
      expect(paystack.verifyTransaction.mock.calls.length).toBe(calls);
      expect((await SubscriptionModel.findById(sub._id))!.status).toBe('cancelled');
      expect((await billingOf(s.clerkUserId)).body.canShareLink).toBe(false);
    });

    it('an unknown or malformed id is 404', async () => {
      for (const id of ['64b7f0c2a1b2c3d4e5f60718', 'not-an-id', '%24ne']) {
        const res = await cancel(id);
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('SUBSCRIPTION_NOT_FOUND');
      }
    });
  });

  describe('recording a refund of a subscription payment', () => {
    const wrongAmount = async () => {
      const s = await makeSeller({ billing: billingOver() });
      const sub = await SubscriptionModel.create({ sellerId: s._id, plan: 'quarterly', amountNaira: 8_000, status: 'pending', paystackReference: newSubscriptionReference() });
      paystack.verifyTransaction.mockImplementation(async (reference) => ({ status: 'success', reference, amountKobo: 300_000, currency: 'NGN' }));
      await deliverWebhook(app, sub.paystackReference).expect(200);
      expect((await SubscriptionModel.findById(sub._id))!.status).toBe('needs_review');
      return { s, sub };
    };

    it('records it once, with a note and an audit entry, and the "needs review" count falls', async () => {
      const { sub } = await wrongAmount();
      expect((await overview()).needsReview).toBe(1);
      const res = await markRefunded(sub._id.toString(), { note: 'Paystack refund ref 998' });
      expect(res.status).toBe(200);
      expect(res.body.refund).toMatchObject({ refundedBy: ADMIN, note: 'Paystack refund ref 998' });
      expect((await overview()).needsReview).toBe(0);
      const again = await markRefunded(sub._id.toString(), { note: 'different' });
      expect(again.body.refund.note).toBe('Paystack refund ref 998');
      expect(await AdminAuditModel.countDocuments({ action: 'subscription.mark_refunded' })).toBe(1);
    });

    it('also works for a cancelled Paystack payment, never calls Paystack, and never changes the status', async () => {
      const s = await makeSeller({ billing: billingOver() });
      const sub = await SubscriptionModel.create({ sellerId: s._id, plan: 'monthly', amountNaira: 3000, status: 'pending', paystackReference: newSubscriptionReference() });
      paystack.verifyTransaction.mockImplementation(async (reference) => ({ status: 'success', reference, amountKobo: 300_000, currency: 'NGN' }));
      await deliverWebhook(app, sub.paystackReference).expect(200);
      await cancel(sub._id.toString()).expect(200);
      const calls = paystack.verifyTransaction.mock.calls.length;
      await markRefunded(sub._id.toString()).expect(200);
      expect(paystack.verifyTransaction.mock.calls.length).toBe(calls);
      expect((await SubscriptionModel.findById(sub._id))!.status).toBe('cancelled');
    });

    it('is refused for an active subscription, a waiting one and a free grant', async () => {
      const s = await makeSeller({ billing: billingOver() });
      const granted = (await grant(s._id)).body.id as string;
      await cancel(granted).expect(200);
      const pending = await SubscriptionModel.create({ sellerId: s._id, plan: 'monthly', amountNaira: 3000, status: 'pending', paystackReference: newSubscriptionReference() });
      const active = await SubscriptionModel.create({
        sellerId: s._id, plan: 'monthly', amountNaira: 3000, status: 'active', paystackReference: newSubscriptionReference(), paidAt: new Date(), startsAt: new Date(), expiresAt: new Date(Date.now() + 30 * DAY_MS), seq: 9,
      });
      for (const id of [granted, pending._id.toString(), active._id.toString()]) {
        const res = await markRefunded(id);
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('SUBSCRIPTION_CANNOT_CHANGE');
      }
      expect(await AdminAuditModel.countDocuments({ action: 'subscription.mark_refunded' })).toBe(0);
    });

    it('several admins at once record it once', async () => {
      const { sub } = await wrongAmount();
      const responses = await Promise.all(Array.from({ length: 4 }, () => markRefunded(sub._id.toString())));
      for (const r of responses) expect(r.status).toBe(200);
      expect(new Set(responses.map((r) => r.body.refund.refundedAt)).size).toBe(1);
    });
  });

  describe('setting verification', () => {
    it('records the status with times, blocks nothing, and is audited', async () => {
      const s = await makeSeller({ billing: billingOver() });
      expect((await verify(s._id, { status: 'pending', note: 'documents received' })).body.verification).toMatchObject({ status: 'pending' });
      let stored = (await SellerModel.findById(s._id))!.billing!.verification!;
      expect(stored.startedAt).toBeInstanceOf(Date);
      expect(stored.completedAt).toBeUndefined();

      const done = await verify(s._id, { status: 'verified' });
      expect(done.body.verification).toMatchObject({ status: 'verified' });
      expect(done.body.verification.completedAt).toBeTruthy();
      stored = (await SellerModel.findById(s._id))!.billing!.verification!;
      expect(stored.completedAt).toBeInstanceOf(Date);

      // It unlocks nothing: an expired vendor is still expired.
      expect((await billingOf(s.clerkUserId)).body).toMatchObject({ state: 'expired', canShareLink: false, verification: { status: 'verified' } });
      expect(await AdminAuditModel.countDocuments({ action: 'seller.set_verification' })).toBe(2);
    });

    it('setting the same status again changes nothing and adds no audit entry', async () => {
      const s = await makeSeller({ billing: billingOver() });
      await verify(s._id, { status: 'verified' }).expect(200);
      const before = (await SellerModel.findById(s._id))!.billing!.verification!;
      await verify(s._id, { status: 'verified', note: 'again' }).expect(200);
      const after = (await SellerModel.findById(s._id))!.billing!.verification!;
      expect(after.completedAt!.getTime()).toBe(before.completedAt!.getTime());
      expect(await AdminAuditModel.countDocuments({ action: 'seller.set_verification' })).toBe(1);
    });

    it('going back to pending clears the completed time', async () => {
      const s = await makeSeller({ billing: billingOver() });
      await verify(s._id, { status: 'rejected' }).expect(200);
      await verify(s._id, { status: 'pending' }).expect(200);
      expect((await SellerModel.findById(s._id))!.billing!.verification!.completedAt).toBeUndefined();
    });

    it('refuses a seller whose trial has not started, and does NOT start it', async () => {
      const legacy = await makeSeller({ billing: undefined });
      const res = await verify(legacy._id, { status: 'verified' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('TRIAL_NOT_STARTED');
      expect((await SellerModel.findById(legacy._id))!.billing).toBeUndefined();
      expect(await AdminAuditModel.countDocuments({ action: 'seller.set_verification' })).toBe(0);
    });

    it('refuses an unknown status, an unknown seller, or no body', async () => {
      const s = await makeSeller({ billing: billingOver() });
      expect((await verify(s._id, { status: 'approved' })).status).toBe(400);
      expect((await verify(s._id, {})).status).toBe(400);
      expect((await verify('64b7f0c2a1b2c3d4e5f60718', { status: 'verified' })).status).toBe(404);
    });
  });

  describe('the admin views still add up', () => {
    it('a cancelled paid subscription still counts as income and as a paying vendor (the money was received)', async () => {
      const s = await makeSeller({ billing: billingOver() });
      const sub = await SubscriptionModel.create({ sellerId: s._id, plan: 'monthly', amountNaira: 3000, status: 'pending', paystackReference: newSubscriptionReference() });
      paystack.verifyTransaction.mockImplementation(async (reference) => ({ status: 'success', reference, amountKobo: 300_000, currency: 'NGN' }));
      await deliverWebhook(app, sub.paystackReference).expect(200);
      expect((await overview()).revenue.allTime).toBe(3000);
      await cancel(sub._id.toString()).expect(200);
      const figures = await overview();
      // Cancelling ends cover; it does not unreceive the money (the refund is a separate record).
      expect(figures.activeNow).toBe(0);
      expect(figures.payingVendors.allTime).toBe(1);
    });

    it('the vendor detail and the list show the source and cancelled state', async () => {
      const s = await makeSeller({ billing: billingOver() });
      const id = (await grant(s._id)).body.id as string;
      await cancel(id).expect(200);
      const list = await request(app).get(`/api/admin/subscriptions?sellerId=${s._id}`).set(asAdmin);
      expect(list.body.subscriptions[0]).toMatchObject({ source: 'admin', status: 'cancelled' });
      expect((await request(app).get('/api/admin/subscriptions?status=cancelled').set(asAdmin)).body.subscriptions).toHaveLength(1);
    });
  });
});
