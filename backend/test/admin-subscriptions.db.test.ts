import type { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { SellerModel } from '../src/models/seller.js';
import { SubscriptionModel } from '../src/models/subscription.js';
import { connectTestDb, disconnectTestDb, testDbUri } from './helpers/db.js';
import { bearer, fakeAuth } from './helpers/fake-auth.js';
import { ADMIN, DAY_MS, LIMITS, asAdmin } from './helpers/flow.js';

const app = createApp({ allowedOrigins: ['http://localhost:5173'], auth: fakeAuth, adminClerkUserIds: [ADMIN], rateLimits: LIMITS });
const payment = { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Owner' };
const ago = (days: number) => new Date(Date.now() - days * DAY_MS);
const ahead = (days: number) => new Date(Date.now() + days * DAY_MS);

let n = 0;
const billing = (startedDaysAgo: number) => ({
  trialStartedAt: ago(startedDaysAgo), trialEndsAt: ahead(7 - startedDaysAgo), verification: { status: 'not_started' as const },
});
async function seller(extra: Record<string, unknown> = {}) {
  n += 1;
  return SellerModel.create({ clerkUserId: `user_as${n}`, businessName: `Sub Kitchen ${n}`, slug: `sub-kitchen-${n}`, phone: '+2348031234567', payment, ...extra });
}
let refN = 0;
const sub = (sellerId: Types.ObjectId, o: { plan?: 'monthly' | 'quarterly'; amount?: number; status?: 'pending' | 'active' | 'failed' | 'needs_review'; paidDaysAgo?: number; startsDaysAgo?: number; endsInDays?: number; seq?: number }) => {
  refN += 1;
  const status = o.status ?? 'active';
  return SubscriptionModel.create({
    sellerId, plan: o.plan ?? 'monthly', amountNaira: o.amount ?? 3000, status, paystackReference: `CLS-${String(refN).padStart(24, '0')}`,
    ...(status === 'active'
      ? { paidAt: ago(o.paidDaysAgo ?? 1), startsAt: ago(o.startsDaysAgo ?? o.paidDaysAgo ?? 1), expiresAt: ahead(o.endsInDays ?? 29), seq: o.seq ?? 1 }
      : {}),
  });
};

const overview = async () => (await request(app).get('/api/admin/overview').set(asAdmin)).body.subscriptions;

describe.skipIf(!testDbUri)('admin view of subscriptions, on a real MongoDB', () => {
  beforeAll(async () => {
    await connectTestDb('admin_subscriptions');
  });
  afterAll(disconnectTestDb);
  beforeEach(async () => {
    await Promise.all([SellerModel.deleteMany({}), SubscriptionModel.deleteMany({})]);
  });

  it('is closed to anyone who is not an admin', async () => {
    const s = await seller({ billing: billing(1) });
    await request(app).get('/api/admin/subscriptions').expect(401);
    await request(app).get('/api/admin/subscriptions').set('Authorization', bearer(s.clerkUserId)).expect(403);
  });

  describe('the overview', () => {
    it('is all zeros, not an error, with no sellers or subscriptions', async () => {
      expect(await overview()).toMatchObject({
        activeNow: 0, onTrial: 0, expired: 0, notStarted: 0, expiringIn7Days: 0, needsReview: 0,
        revenue: { allTime: 0, last30Days: 0 }, purchases: { allTime: 0, last30Days: 0, monthly: 0, quarterly: 0 },
      });
    });

    it('sorts every vendor into one state, using the same dates the vendor sees', async () => {
      await seller({ billing: billing(2) }); // on trial
      await seller({ billing: billing(5) }); // on trial
      await seller({ billing: billing(20) }); // expired, never paid
      const lapsed = await seller({ billing: billing(60) }); // expired: paid once, long over
      await sub(lapsed._id, { paidDaysAgo: 50, startsDaysAgo: 50, endsInDays: -20 });
      const paying = await seller({ billing: billing(40) }); // active
      await sub(paying._id, { paidDaysAgo: 3, endsInDays: 27 });
      const duringTrial = await seller({ billing: billing(2) }); // paid during the trial: active, not "on trial"
      await sub(duringTrial._id, { paidDaysAgo: 1, endsInDays: 29 });
      await seller(); // from before billing existed

      expect(await overview()).toMatchObject({ activeNow: 2, onTrial: 2, expired: 2, notStarted: 1 });
    });

    it('counts a vendor with two subscriptions queued once', async () => {
      const s = await seller({ billing: billing(40) });
      await sub(s._id, { paidDaysAgo: 10, startsDaysAgo: 10, endsInDays: 20, seq: 1 });
      await sub(s._id, { plan: 'quarterly', amount: 8_000, paidDaysAgo: 5, startsDaysAgo: -20, endsInDays: 110, seq: 2 });
      expect((await overview()).activeNow).toBe(1);
    });

    it('does not count a subscription that starts in the future as covering yet', async () => {
      const s = await seller({ billing: billing(40) });
      await sub(s._id, { paidDaysAgo: 1, startsDaysAgo: -5, endsInDays: 35 });
      expect(await overview()).toMatchObject({ activeNow: 0, expired: 1 });
    });

    it('adds up income from confirmed subscriptions only, and splits it by plan and by period', async () => {
      const a = await seller({ billing: billing(40) });
      const b = await seller({ billing: billing(40) });
      await sub(a._id, { amount: 3000, paidDaysAgo: 3 });
      await sub(a._id, { plan: 'quarterly', amount: 8_000, paidDaysAgo: 2, seq: 2 });
      await sub(b._id, { amount: 3000, paidDaysAgo: 45, endsInDays: -15 }); // outside the last 30 days
      // None of these is income.
      await sub(b._id, { status: 'pending' });
      await sub(b._id, { status: 'failed' });
      await sub(b._id, { status: 'needs_review', amount: 8_000 });

      const result = await overview();
      expect(result.revenue).toEqual({ allTime: 14_000, last30Days: 11_000 });
      expect(result.purchases).toEqual({ allTime: 3, last30Days: 2, monthly: 2, quarterly: 1 });
      expect(result.needsReview).toBe(1);
    });

    it('finds vendors whose paid cover ends within a week and who bought nothing later', async () => {
      const soon = await seller({ billing: billing(40) });
      await sub(soon._id, { paidDaysAgo: 25, startsDaysAgo: 25, endsInDays: 3 });
      const renewed = await seller({ billing: billing(40) });
      await sub(renewed._id, { paidDaysAgo: 25, startsDaysAgo: 25, endsInDays: 3, seq: 1 });
      await sub(renewed._id, { paidDaysAgo: 2, startsDaysAgo: -3, endsInDays: 27, seq: 2 });
      const later = await seller({ billing: billing(40) });
      await sub(later._id, { paidDaysAgo: 5, endsInDays: 25 });
      expect((await overview()).expiringIn7Days).toBe(1);
    });

    it('carries definitions for every figure', async () => {
      const result = await overview();
      for (const key of ['activeNow', 'onTrial', 'expired', 'notStarted', 'expiringIn7Days', 'revenue', 'purchases', 'needsReview']) {
        expect(typeof result.definitions[key]).toBe('string');
      }
    });

    it('contains no vendor details', async () => {
      const s = await seller({ billing: billing(40), email: 'private@kitchen.ng' });
      await sub(s._id, {});
      expect(JSON.stringify(await overview())).not.toMatch(/private@|Sub Kitchen|0123456789|2348031234567|CLS-/);
    });
  });

  describe('the list', () => {
    it('lists attempts newest first with the vendor, and filters by status, plan and vendor', async () => {
      const a = await seller({ billing: billing(40) });
      const b = await seller({ billing: billing(40) });
      const first = await sub(a._id, { paidDaysAgo: 30, endsInDays: 0 });
      await sub(a._id, { plan: 'quarterly', amount: 8_000, paidDaysAgo: 2, seq: 2 });
      const pending = await sub(b._id, { status: 'pending' });

      const all = await request(app).get('/api/admin/subscriptions').set(asAdmin);
      expect(all.status).toBe(200);
      expect(all.body.pagination).toMatchObject({ total: 3 });
      expect(all.body.subscriptions[0]).toMatchObject({ id: pending._id.toString(), status: 'pending', seller: { id: b._id.toString(), businessName: b.businessName, slug: b.slug } });
      expect(all.body.subscriptions.at(-1).id).toBe(first._id.toString());
      expect(all.body.subscriptions[0]).toMatchObject({ refunded: false, cancelledAt: null });

      const get = (q: string) => request(app).get(`/api/admin/subscriptions${q}`).set(asAdmin);
      expect((await get('?status=pending')).body.subscriptions).toHaveLength(1);
      expect((await get('?plan=quarterly')).body.subscriptions).toHaveLength(1);
      expect((await get(`?sellerId=${a._id}`)).body.subscriptions).toHaveLength(2);
      expect((await get('?limit=2&page=2')).body.subscriptions).toHaveLength(1);
      expect((await get('?status=expired')).status).toBe(400);
      expect((await get('?plan=yearly')).status).toBe(400);
      expect((await get('?sellerId=nope')).status).toBe(400);
    });

    it('shows amounts and dates but no bank, phone or email', async () => {
      const s = await seller({ billing: billing(40), email: 'private@kitchen.ng' });
      await sub(s._id, {});
      const text = JSON.stringify((await request(app).get('/api/admin/subscriptions').set(asAdmin)).body);
      expect(text).not.toMatch(/private@|0123456789|2348031234567|accountName|clerkUserId/);
    });
  });

  describe('one vendor\'s detail', () => {
    const detail = async (id: Types.ObjectId) => (await request(app).get(`/api/admin/sellers/${id}`).set(asAdmin)).body;

    it('shows their state, trial, current subscription and how long cover lasts', async () => {
      const s = await seller({ billing: billing(40) });
      const current = await sub(s._id, { paidDaysAgo: 5, endsInDays: 25, seq: 1 });
      await sub(s._id, { plan: 'quarterly', amount: 8_000, paidDaysAgo: 2, startsDaysAgo: -25, endsInDays: 115, seq: 2 });

      const body = await detail(s._id);
      expect(body.billing).toMatchObject({ state: 'active', canShareLink: true, subscription: { id: current._id.toString(), plan: 'monthly' }, verification: { status: 'not_started' } });
      expect(new Date(body.billing.accessEndsAt).getTime()).toBeGreaterThan(Date.now() + 100 * DAY_MS);
      expect(body.billing.plans).toBeUndefined();
    });

    it('shows an expired vendor as expired and unable to share', async () => {
      const s = await seller({ billing: billing(30) });
      expect((await detail(s._id)).billing).toMatchObject({ state: 'expired', canShareLink: false, subscription: null, verificationDue: true });
    });

    it('LOOKING at a vendor from before billing never starts their trial', async () => {
      const legacy = await seller();
      const body = await detail(legacy._id);
      expect(body.billing).toMatchObject({ state: null, canShareLink: null, trialStartedAt: null });
      expect((await SellerModel.findById(legacy._id))!.billing).toBeUndefined();
    });
  });
});
