import type { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { DEFAULT_BILLING } from '../src/billing/plans.js';
import { REMINDER_DAYS, notifyExpiringSubscriptions } from '../src/billing/reminders.js';
import { newSubscriptionReference } from '../src/billing/subscribe.js';
import { runMaintenance, startMaintenance } from '../src/jobs.js';
import { EventLogModel } from '../src/models/event-log.js';
import { MenuModel } from '../src/models/menu.js';
import { NotificationModel } from '../src/models/notification.js';
import { OrderModel } from '../src/models/order.js';
import { PaymentModel } from '../src/models/payment.js';
import { SellerModel } from '../src/models/seller.js';
import { SubscriptionModel } from '../src/models/subscription.js';
import { PaystackError } from '../src/payments/paystack.js';
import { STALE_GAPS_MS, STALE_MAX_CHECKS, STALE_PAYMENT_WINDOW_MS, reconcileStalePayments, reconcileStaleSubscriptions } from '../src/payments/reconcile-stale.js';
import { connectTestDb, disconnectTestDb, testDbUri } from './helpers/db.js';
import { fakeAuth } from './helpers/fake-auth.js';
import { fakePaystack } from './helpers/fake-paystack.js';
import { ADMIN, DAY_MS, HOUR_MS, LIMITS, SECRET, backdate, makeMenu, makeSeller, paystackSays, placeOrder, startOnline } from './helpers/flow.js';

let paystack = fakePaystack();
const buildApp = () => createApp({ allowedOrigins: ['http://localhost:5173'], auth: fakeAuth, paystack, paystackSecretKey: SECRET, adminClerkUserIds: [ADMIN], billing: DEFAULT_BILLING, rateLimits: LIMITS });
let app = buildApp();

const MIN = 60_000;
// A fixed starting point, so every moment below is exact.
const T0 = new Date('2026-11-10T00:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

describe.skipIf(!testDbUri)('background upkeep, on a real MongoDB', () => {
  let seller: Awaited<ReturnType<typeof makeSeller>>;
  let menu: Awaited<ReturnType<typeof makeMenu>>;

  beforeAll(async () => {
    await connectTestDb('maintenance');
  });
  afterAll(disconnectTestDb);
  beforeEach(async () => {
    paystack = fakePaystack();
    app = buildApp();
    await Promise.all([
      SellerModel.deleteMany({}), MenuModel.deleteMany({}), OrderModel.deleteMany({}), PaymentModel.deleteMany({}),
      SubscriptionModel.deleteMany({}), NotificationModel.deleteMany({}), EventLogModel.deleteMany({}),
    ]);
    seller = await makeSeller();
    menu = await makeMenu(seller._id);
  });

  // A payment that was started at T0, whatever the real clock says.
  async function startedAtT0() {
    const o = await placeOrder(app, seller, menu, 1);
    const reference = await startOnline(app, o);
    await PaymentModel.collection.updateOne({ reference }, { $set: { createdAt: T0 } });
    return { o, reference };
  }
  const verifyCalls = () => paystack.verifyTransaction.mock.calls.length;

  describe('re-checking waiting payments nobody is looking at', () => {
    it('confirms a payment whose message was lost, with no one checking its status', async () => {
      const { o, reference } = await startedAtT0();
      paystackSays(paystack, 'success');
      const result = await reconcileStalePayments(paystack, at(2 * MIN));
      expect(result).toEqual({ checked: 1, applied: 1 });
      expect((await OrderModel.findById(o.id))!.status).toBe('paid');
      expect((await PaymentModel.findOne({ reference }))!.status).toBe('succeeded');
      expect((await SellerModel.findById(seller._id))!.paidOrderCount).toBe(1);
    });

    it('leaves a payment alone until it is old enough, and when Paystack says it is not paid', async () => {
      const { o } = await startedAtT0();
      paystackSays(paystack, 'success');
      expect(await reconcileStalePayments(paystack, at(5_000))).toEqual({ checked: 0, applied: 0 });
      expect(verifyCalls()).toBe(0);

      paystackSays(paystack, 'abandoned');
      const result = await reconcileStalePayments(paystack, at(2 * MIN));
      expect(result).toEqual({ checked: 1, applied: 0 });
      expect((await OrderModel.findById(o.id))!.status).toBe('pending');
      expect(await EventLogModel.countDocuments({})).toBe(0);
    });

    it('asks at growing gaps and then stops: six calls at most, however long the sweep runs', async () => {
      const { reference } = await startedAtT0();
      paystackSays(paystack, 'abandoned');
      let now = 2 * MIN;
      const asked: number[] = [];
      for (let i = 0; i < 100; i += 1) {
        const before = verifyCalls();
        await reconcileStalePayments(paystack, at(now));
        if (verifyCalls() > before) asked.push(now);
        now += 15 * MIN; // a sweep every 15 minutes for 25 hours
      }
      expect(asked.length).toBe(STALE_MAX_CHECKS);
      expect(STALE_MAX_CHECKS).toBe(6);
      // The first ask is as soon as it is old enough; each later gap is at least the schedule's.
      expect(asked[0]).toBe(2 * MIN);
      for (let i = 1; i < asked.length; i += 1) expect(asked[i]! - asked[i - 1]!).toBeGreaterThanOrEqual(STALE_GAPS_MS[i - 1]!);
      expect((await PaymentModel.findOne({ reference }))!.checkCount).toBe(STALE_MAX_CHECKS);
    });

    it('does not ask about a payment too soon after the last ask', async () => {
      await startedAtT0();
      paystackSays(paystack, 'abandoned');
      await reconcileStalePayments(paystack, at(2 * MIN));
      await reconcileStalePayments(paystack, at(2 * MIN + 14 * MIN));
      expect(verifyCalls()).toBe(1);
      await reconcileStalePayments(paystack, at(2 * MIN + 15 * MIN));
      expect(verifyCalls()).toBe(2);
    });

    it('a check made by someone looking at the status counts, so it is not asked again straight away', async () => {
      const { reference } = await startedAtT0();
      paystackSays(paystack, 'abandoned');
      await PaymentModel.updateOne({ reference }, { $set: { lastCheckedAt: at(2 * MIN), checkCount: 1 } });
      await reconcileStalePayments(paystack, at(5 * MIN));
      expect(verifyCalls()).toBe(0);
    });

    it('ignores payments older than two days, and ones already settled', async () => {
      const { o } = await startedAtT0();
      paystackSays(paystack, 'success');
      expect(await reconcileStalePayments(paystack, at(STALE_PAYMENT_WINDOW_MS + MIN))).toEqual({ checked: 0, applied: 0 });
      expect((await OrderModel.findById(o.id))!.status).toBe('pending');

      await reconcileStalePayments(paystack, at(2 * MIN));
      const calls = verifyCalls();
      await reconcileStalePayments(paystack, at(HOUR_MS * 20));
      expect(verifyCalls()).toBe(calls);
    });

    it('two sweeps at once ask about a payment once', async () => {
      await startedAtT0();
      paystackSays(paystack, 'abandoned');
      await Promise.all(Array.from({ length: 6 }, () => reconcileStalePayments(paystack, at(2 * MIN))));
      expect(verifyCalls()).toBe(1);
    });

    it('is capped per sweep so a backlog cannot flood Paystack', async () => {
      await MenuModel.updateOne({ _id: menu._id }, { $set: { 'items.0.qtyTotal': 500, 'items.0.qtyRemaining': 500 } });
      for (let i = 0; i < 60; i += 1) {
        const o = await placeOrder(app, seller, menu, 1);
        const reference = await startOnline(app, o);
        await PaymentModel.collection.updateOne({ reference }, { $set: { createdAt: T0 } });
      }
      paystackSays(paystack, 'abandoned');
      const result = await reconcileStalePayments(paystack, at(2 * MIN));
      expect(result.checked).toBe(50);
      expect(verifyCalls()).toBe(50);
      expect((await reconcileStalePayments(paystack, at(3 * MIN))).checked).toBe(10);
    }, 60_000);

    it('does nothing without a Paystack key, and a Paystack outage is survived', async () => {
      await startedAtT0();
      expect(await reconcileStalePayments(null, at(2 * MIN))).toEqual({ checked: 0, applied: 0 });
      const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
      paystack.verifyTransaction.mockRejectedValue(new PaystackError('unavailable', 'timeout'));
      await expect(reconcileStalePayments(paystack, at(2 * MIN))).resolves.toEqual({ checked: 1, applied: 0 });
      quiet.mockRestore();
    });
  });

  describe('re-checking waiting subscription payments', () => {
    const vendorWithPending = async () => {
      const vendor = await makeSeller({ billing: { trialStartedAt: new Date(T0.getTime() - 30 * DAY_MS), trialEndsAt: new Date(T0.getTime() - 23 * DAY_MS), verification: { status: 'not_started' as const } } });
      const sub = await SubscriptionModel.create({ sellerId: vendor._id, plan: 'monthly', amountNaira: 3000, status: 'pending', paystackReference: newSubscriptionReference() });
      await SubscriptionModel.collection.updateOne({ _id: sub._id }, { $set: { createdAt: T0 } });
      return { vendor, sub };
    };
    const subPaid = () => paystack.verifyTransaction.mockImplementation(async (reference) => ({ status: 'success', reference, amountKobo: 300_000, currency: 'NGN' }));

    it('activates one whose message was lost, with nobody checking', async () => {
      const { sub } = await vendorWithPending();
      subPaid();
      expect(await reconcileStaleSubscriptions(paystack, at(2 * MIN))).toEqual({ checked: 1, applied: 1 });
      expect((await SubscriptionModel.findById(sub._id))!.status).toBe('active');
    });

    it('backs off like payments, six calls at most', async () => {
      await vendorWithPending();
      paystack.verifyTransaction.mockImplementation(async (reference) => ({ status: 'pending', reference, amountKobo: 300_000, currency: 'NGN' }));
      for (let i = 0; i < 100; i += 1) await reconcileStaleSubscriptions(paystack, at(2 * MIN + i * 15 * MIN));
      expect(verifyCalls()).toBe(STALE_MAX_CHECKS);
    });

    it('never touches a free grant or a settled subscription', async () => {
      const { sub } = await vendorWithPending();
      await SubscriptionModel.updateOne({ _id: sub._id }, { $set: { status: 'needs_review' } });
      await SubscriptionModel.create({ sellerId: seller._id, plan: 'monthly', amountNaira: 0, status: 'active', source: 'admin', paystackReference: 'ADM-aaaaaaaaaaaaaaaaaaaaaaaa', paidAt: T0, startsAt: T0, expiresAt: at(30 * DAY_MS), seq: 1 });
      subPaid();
      expect(await reconcileStaleSubscriptions(paystack, at(2 * MIN))).toEqual({ checked: 0, applied: 0 });
    });

    it('two sweeps at once ask once', async () => {
      await vendorWithPending();
      paystack.verifyTransaction.mockImplementation(async (reference) => ({ status: 'pending', reference, amountKobo: 300_000, currency: 'NGN' }));
      await Promise.all(Array.from({ length: 6 }, () => reconcileStaleSubscriptions(paystack, at(2 * MIN))));
      expect(verifyCalls()).toBe(1);
    });
  });

  describe('subscription reminders', () => {
    const active = (sellerId: Types.ObjectId, endsIn: number, seq = 1, source: 'paystack' | 'admin' = 'paystack') =>
      SubscriptionModel.create({
        sellerId, plan: 'monthly', amountNaira: source === 'admin' ? 0 : 3000, status: 'active', source,
        paystackReference: source === 'admin' ? `ADM-${String(seq).padStart(24, 'a')}` : newSubscriptionReference(),
        paidAt: T0, startsAt: T0, expiresAt: at(endsIn), seq,
      });

    it('warns a vendor whose cover ends within three days, once however often it runs', async () => {
      await active(seller._id, (REMINDER_DAYS - 1) * DAY_MS);
      for (let i = 0; i < 5; i += 1) await notifyExpiringSubscriptions(at(i * 15 * MIN));
      const rows = await NotificationModel.find({ sellerId: seller._id });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ type: 'subscription_expiring' });
      expect(rows[0]!.message).toMatch(/Renew/);
    });

    it('does not warn early, after it has ended, or for a vendor who has bought a later period', async () => {
      const early = await makeSeller();
      await active(early._id, 10 * DAY_MS);
      const ended = await makeSeller();
      await active(ended._id, -DAY_MS);
      const renewed = await makeSeller();
      await active(renewed._id, DAY_MS, 1);
      await active(renewed._id, 30 * DAY_MS, 2);
      expect(await notifyExpiringSubscriptions(T0)).toBe(0);
      expect(await NotificationModel.countDocuments({})).toBe(0);
    });

    it('warns again about the new end date after a renewal, not before', async () => {
      await active(seller._id, DAY_MS, 1);
      await notifyExpiringSubscriptions(T0);
      expect(await NotificationModel.countDocuments({})).toBe(1);
      await active(seller._id, 31 * DAY_MS, 2);
      await notifyExpiringSubscriptions(at(DAY_MS));
      expect(await NotificationModel.countDocuments({})).toBe(1);
      await notifyExpiringSubscriptions(at(29 * DAY_MS));
      expect(await NotificationModel.countDocuments({})).toBe(2);
    });

    it('covers free grants too, and each vendor only hears about themselves', async () => {
      const other = await makeSeller();
      await active(seller._id, DAY_MS, 1, 'admin');
      await active(other._id, 2 * DAY_MS, 1);
      expect(await notifyExpiringSubscriptions(T0)).toBe(2);
      expect(await NotificationModel.countDocuments({ sellerId: seller._id })).toBe(1);
      expect(await NotificationModel.countDocuments({ sellerId: other._id })).toBe(1);
    });

    it('ignores a cancelled subscription', async () => {
      const sub = await active(seller._id, DAY_MS);
      await SubscriptionModel.updateOne({ _id: sub._id }, { $set: { status: 'cancelled' } });
      expect(await notifyExpiringSubscriptions(T0)).toBe(0);
    });
  });

  describe('the runner', () => {
    it('does all of it in one go', async () => {
      // An unpaid old order, a lost payment, and a subscription about to end.
      const old = await placeOrder(app, seller, menu, 1);
      await backdate('order', old.id, 60 * HOUR_MS);
      const { o } = await (async () => {
        const order = await placeOrder(app, seller, menu, 1);
        const reference = await startOnline(app, order);
        await backdate('payment', (await PaymentModel.findOne({ reference }))!._id, 5 * MIN);
        return { o: order };
      })();
      paystackSays(paystack, 'success');
      await SubscriptionModel.create({
        sellerId: seller._id, plan: 'monthly', amountNaira: 3000, status: 'active', paystackReference: newSubscriptionReference(),
        paidAt: new Date(), startsAt: new Date(), expiresAt: new Date(Date.now() + DAY_MS), seq: 1,
      });

      const result = await runMaintenance({ orderExpiryHours: 48, paystack });
      expect(result.expiry).toMatchObject({ expired: 1 });
      expect(result.stalePayments).toMatchObject({ checked: 1, applied: 1 });
      expect(result.reminders).toBe(1);
      expect((await OrderModel.findById(old.id))!.status).toBe('cancelled');
      expect((await OrderModel.findById(o.id))!.status).toBe('paid');
    });

    it('expiry off skips only the expiry', async () => {
      const old = await placeOrder(app, seller, menu, 1);
      await backdate('order', old.id, 60 * HOUR_MS);
      const result = await runMaintenance({ orderExpiryHours: 0, paystack });
      expect(result.expiry).toBeNull();
      expect(result.reminders).toBe(0);
      expect((await OrderModel.findById(old.id))!.status).toBe('pending');
    });

    it('one step failing never stops the others', async () => {
      const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
      const old = await placeOrder(app, seller, menu, 1);
      await backdate('order', old.id, 60 * HOUR_MS);
      const spy = vi.spyOn(PaymentModel, 'find').mockImplementation((() => {
        throw new Error('database hiccup');
      }) as never);
      const result = await runMaintenance({ orderExpiryHours: 48, paystack });
      spy.mockRestore();
      quiet.mockRestore();
      expect(result.stalePayments).toBeNull();
      expect(result.expiry).toMatchObject({ expired: 1 });
      expect(result.reminders).toBe(0);
    });

    it('runs without a Paystack key (bank-transfer-only deployments)', async () => {
      const result = await runMaintenance({ orderExpiryHours: 48, paystack: null });
      expect(result.stalePayments).toEqual({ checked: 0, applied: 0 });
      expect(result.staleSubscriptions).toEqual({ checked: 0, applied: 0 });
    });

    it('the timer can be started and stopped without keeping the process alive', () => {
      const timer = startMaintenance({ orderExpiryHours: 48, paystack: null }, 10_000_000);
      expect(typeof timer.stop).toBe('function');
      timer.stop();
    });
  });
});
