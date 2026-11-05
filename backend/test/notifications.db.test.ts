import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { DEFAULT_BILLING } from '../src/billing/plans.js';
import { newSubscriptionReference } from '../src/billing/subscribe.js';
import { MenuModel } from '../src/models/menu.js';
import { NotificationModel } from '../src/models/notification.js';
import { OrderModel } from '../src/models/order.js';
import { PaymentModel } from '../src/models/payment.js';
import { PaymentQueryModel } from '../src/models/payment-query.js';
import { SellerModel } from '../src/models/seller.js';
import { SubscriptionModel } from '../src/models/subscription.js';
import { notify } from '../src/notifications/service.js';
import { connectTestDb, disconnectTestDb, testDbUri } from './helpers/db.js';
import { bearer, fakeAuth } from './helpers/fake-auth.js';
import { fakePaystack } from './helpers/fake-paystack.js';
import {
  ADMIN, LIMITS, SECRET, asAdmin, asSeller, cancelAsSeller, deliverWebhook, makeMenu, makeSeller, paidOnline, paystackSays, placeOrder, startOnline,
} from './helpers/flow.js';

let paystack = fakePaystack();
const buildApp = () =>
  createApp({ allowedOrigins: ['http://localhost:5173'], auth: fakeAuth, paystack, paystackSecretKey: SECRET, adminClerkUserIds: [ADMIN], billing: DEFAULT_BILLING, rateLimits: LIMITS });
let app = buildApp();

const sellerFeed = (clerk: string, query = '') => request(app).get(`/api/sellers/me/notifications${query}`).set({ Authorization: bearer(clerk) });
const adminFeed = (query = '') => request(app).get(`/api/admin/notifications${query}`).set(asAdmin);
const forSeller = (id: unknown) => NotificationModel.find({ audience: 'seller', sellerId: id as never }).sort({ createdAt: 1 });
const adminRows = () => NotificationModel.find({ audience: 'admin' }).sort({ createdAt: 1 });

describe.skipIf(!testDbUri)('notifications, on a real MongoDB', () => {
  let seller: Awaited<ReturnType<typeof makeSeller>>;
  let menu: Awaited<ReturnType<typeof makeMenu>>;

  beforeAll(async () => {
    await connectTestDb('notifications');
  });
  afterAll(disconnectTestDb);
  beforeEach(async () => {
    paystack = fakePaystack();
    app = buildApp();
    await Promise.all([
      SellerModel.deleteMany({}), MenuModel.deleteMany({}), OrderModel.deleteMany({}), PaymentModel.deleteMany({}),
      PaymentQueryModel.deleteMany({}), NotificationModel.deleteMany({}), SubscriptionModel.deleteMany({}),
    ]);
    seller = await makeSeller();
    menu = await makeMenu(seller._id);
  });

  describe('the service', () => {
    it('stores the same thing once, however many times it is told', async () => {
      const input = { audience: 'admin' as const, type: 'refund_due' as const, message: 'x', dedupeKey: 'same-key' };
      await Promise.all([notify(input), notify(input), notify(input)]);
      await notify(input);
      expect(await NotificationModel.countDocuments({})).toBe(1);
    });

    it('never throws, even if the database refuses', async () => {
      const spy = vi.spyOn(NotificationModel, 'create').mockRejectedValue(new Error('database is down'));
      const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(notify({ audience: 'admin', type: 'refund_due', message: 'x', dedupeKey: 'k' })).resolves.toBeUndefined();
      spy.mockRestore();
      quiet.mockRestore();
    });
  });

  describe('a seller\'s own feed', () => {
    it('needs a sign-in and a profile, and a suspended seller is refused', async () => {
      await request(app).get('/api/sellers/me/notifications').expect(401);
      expect((await sellerFeed('user_nobody')).body.error.code).toBe('PROFILE_REQUIRED');
      const suspended = await makeSeller({ status: 'suspended' });
      expect((await sellerFeed(suspended.clerkUserId)).body.error.code).toBe('ACCOUNT_SUSPENDED');
    });

    it('is empty at first, newest first once there is something, never cached', async () => {
      expect((await sellerFeed(seller.clerkUserId)).body).toEqual({ notifications: [], unreadCount: 0 });
      const a = await placeOrder(app, seller, menu, 1);
      const b = await placeOrder(app, seller, menu, 1);
      await request(app).post(`/api/public/orders/${a.ref}/report-paid`).set('X-Order-Key', a.key).expect(200);
      await request(app).post(`/api/public/orders/${b.ref}/report-paid`).set('X-Order-Key', b.key).expect(200);
      const res = await sellerFeed(seller.clerkUserId);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.unreadCount).toBe(2);
      expect(res.body.notifications.map((n: { orderRef: string }) => n.orderRef)).toEqual([b.ref, a.ref]);
      expect(res.body.notifications[0]).toMatchObject({ type: 'customer_reported_paid', read: false });
      expect(Object.keys(res.body.notifications[0]).sort()).toEqual(['createdAt', 'id', 'message', 'orderRef', 'read', 'type']);
    });

    it('marks some or all as read, safely repeatable, and filters unread', async () => {
      const orders = [await placeOrder(app, seller, menu, 1), await placeOrder(app, seller, menu, 1), await placeOrder(app, seller, menu, 1)];
      for (const o of orders) await request(app).post(`/api/public/orders/${o.ref}/report-paid`).set('X-Order-Key', o.key).expect(200);
      const feed = (await sellerFeed(seller.clerkUserId)).body.notifications as { id: string }[];

      const some = await request(app).post('/api/sellers/me/notifications/read').set(asSeller(orders[0]!)).send({ ids: [feed[0]!.id] });
      expect(some.body).toEqual({ marked: 1, unreadCount: 2 });
      expect((await request(app).post('/api/sellers/me/notifications/read').set(asSeller(orders[0]!)).send({ ids: [feed[0]!.id] })).body.marked).toBe(0);
      expect((await sellerFeed(seller.clerkUserId, '?unread=true')).body.notifications).toHaveLength(2);

      const all = await request(app).post('/api/sellers/me/notifications/read').set(asSeller(orders[0]!)).send({ all: true });
      expect(all.body).toEqual({ marked: 2, unreadCount: 0 });
      expect((await sellerFeed(seller.clerkUserId, '?unread=true')).body.notifications).toHaveLength(0);
      expect((await sellerFeed(seller.clerkUserId)).body.notifications).toHaveLength(3);
    });

    it('refuses an empty or malformed read request', async () => {
      const o = await placeOrder(app, seller, menu, 1);
      for (const body of [{}, { ids: [] }, { ids: ['nope'] }, { all: false }]) {
        const res = await request(app).post('/api/sellers/me/notifications/read').set(asSeller(o)).send(body);
        expect(res.status).toBe(400);
      }
    });

    it('a seller sees and changes only their own, and cannot reach the admin inbox', async () => {
      const mine = await placeOrder(app, seller, menu, 1);
      await request(app).post(`/api/public/orders/${mine.ref}/report-paid`).set('X-Order-Key', mine.key).expect(200);
      const other = await makeSeller();
      const otherMenu = await makeMenu(other._id);
      const theirs = await placeOrder(app, other, otherMenu, 1);
      await request(app).post(`/api/public/orders/${theirs.ref}/report-paid`).set('X-Order-Key', theirs.key).expect(200);
      await request(app).post(`/api/orders/${mine.ref}/payment-query`).set(asSeller(mine)).send({ reason: 'other', message: 'seller side problem' }).expect(201);

      const theirIds = ((await sellerFeed(other.clerkUserId)).body.notifications as { id: string }[]).map((n) => n.id);
      expect((await sellerFeed(seller.clerkUserId)).body.notifications.every((n: { orderRef: string }) => n.orderRef === mine.ref)).toBe(true);

      // Sending someone else's ids, or an admin-inbox id, changes nothing.
      const adminIds = (await adminRows()).map((n) => n._id.toString());
      const attack = await request(app).post('/api/sellers/me/notifications/read').set(asSeller(mine)).send({ ids: [...theirIds, ...adminIds] });
      expect(attack.body.marked).toBe(0);
      expect(await NotificationModel.countDocuments({ readAt: { $exists: true } })).toBe(0);
      await request(app).get('/api/admin/notifications').set('Authorization', bearer(seller.clerkUserId)).expect(403);
    });
  });

  describe('what tells a seller', () => {
    it('an online payment, once, even if Paystack tells us three times', async () => {
      const o = await placeOrder(app, seller, menu);
      const reference = await paidOnline(app, paystack, o);
      await deliverWebhook(app, reference).expect(200);
      await deliverWebhook(app, reference).expect(200);
      const rows = await forSeller(seller._id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ type: 'order_paid_online', orderRef: o.ref });
      expect(rows[0]!.message).toContain('₦7,500');
    });

    it('a customer saying they paid by transfer, once however often they tap', async () => {
      const o = await placeOrder(app, seller, menu);
      await Promise.all(Array.from({ length: 4 }, () => request(app).post(`/api/public/orders/${o.ref}/report-paid`).set('X-Order-Key', o.key)));
      const rows = await forSeller(seller._id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ type: 'customer_reported_paid', orderRef: o.ref });
      expect(rows[0]!.message).toMatch(/mark it paid/);
    });

    it('a payment problem a customer raised, but not the seller\'s own', async () => {
      const o = await placeOrder(app, seller, menu);
      await request(app).post(`/api/public/orders/${o.ref}/payment-query`).set('X-Order-Key', o.key).send({ reason: 'paid_twice', message: 'I was charged two times' }).expect(201);
      expect((await forSeller(seller._id)).map((n) => n.type)).toEqual(['payment_query_raised']);

      const p = await placeOrder(app, seller, menu);
      await request(app).post(`/api/orders/${p.ref}/payment-query`).set(asSeller(p)).send({ reason: 'other', message: 'my own report here' }).expect(201);
      expect(await forSeller(seller._id)).toHaveLength(1);
    });

    it('ChopList\'s reply to a payment problem, once', async () => {
      const o = await placeOrder(app, seller, menu);
      const made = await request(app).post(`/api/public/orders/${o.ref}/payment-query`).set('X-Order-Key', o.key).send({ reason: 'other', message: 'something is wrong' });
      const resolve = () => request(app).patch(`/api/admin/payment-queries/${made.body.id}/resolve`).set(asAdmin).send({ note: 'Fixed it' });
      await Promise.all([resolve(), resolve(), resolve()]);
      const rows = (await forSeller(seller._id)).filter((n) => n.type === 'payment_query_resolved');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.message).toContain('Fixed it');
    });

    it('a subscription that became active, whether Paystack or an admin made it so', async () => {
      const vendor = await makeSeller({ billing: { trialStartedAt: new Date(Date.now() - 30 * 86_400_000), trialEndsAt: new Date(Date.now() - 23 * 86_400_000), verification: { status: 'not_started' as const } } });
      const sub = await SubscriptionModel.create({ sellerId: vendor._id, plan: 'monthly', amountNaira: 3000, status: 'pending', paystackReference: newSubscriptionReference() });
      paystack.verifyTransaction.mockImplementation(async (reference) => ({ status: 'success', reference, amountKobo: 300_000, currency: 'NGN' }));
      await deliverWebhook(app, sub.paystackReference).expect(200);
      await deliverWebhook(app, sub.paystackReference).expect(200);
      expect((await forSeller(vendor._id)).map((n) => n.type)).toEqual(['subscription_activated']);

      await request(app).post(`/api/admin/sellers/${vendor._id}/subscriptions`).set(asAdmin).send({ plan: 'monthly', note: 'goodwill after an outage' }).expect(201);
      expect((await forSeller(vendor._id)).map((n) => n.type)).toEqual(['subscription_activated', 'subscription_activated']);
    });
  });

  describe('what tells ChopList\'s admins', () => {
    it('a seller cancelling an order that was paid online (a refund is due), but not an unpaid one', async () => {
      const unpaid = await placeOrder(app, seller, menu, 1);
      await cancelAsSeller(app, unpaid).expect(200);
      expect(await adminRows()).toHaveLength(0);

      const paid = await placeOrder(app, seller, menu, 1);
      await paidOnline(app, paystack, paid);
      await cancelAsSeller(app, paid).expect(200);
      await cancelAsSeller(app, paid).expect(200);
      const rows = await adminRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ type: 'refund_due', orderRef: paid.ref });
      expect(rows[0]!.message).toMatch(/needs a refund/);
    });

    it('money that arrived but could not be applied (wrong amount, cancelled first, paid twice)', async () => {
      const wrong = await placeOrder(app, seller, menu, 1);
      const wrongRef = await startOnline(app, wrong);
      paystackSays(paystack, 'success', 100);
      await deliverWebhook(app, wrongRef).expect(200);
      await deliverWebhook(app, wrongRef).expect(200);

      const late = await placeOrder(app, seller, menu, 1);
      const lateRef = await startOnline(app, late);
      await cancelAsSeller(app, late).expect(200);
      paystackSays(paystack, 'success');
      await deliverWebhook(app, lateRef).expect(200);

      const rows = (await adminRows()).filter((n) => n.type === 'payment_needs_review');
      expect(rows.map((n) => n.orderRef).sort()).toEqual([wrong.ref, late.ref].sort());
    });

    it('does NOT alert admins about harmless Paystack events: a failed or unfinished charge, or a payment we have no record of', async () => {
      const o = await placeOrder(app, seller, menu, 1);
      const reference = await startOnline(app, o);
      for (const status of ['failed', 'abandoned', 'pending']) {
        paystackSays(paystack, status);
        await deliverWebhook(app, reference).expect(200);
      }
      await deliverWebhook(app, 'CLP-0123456789abcdef01234567').expect(200);
      expect(await adminRows()).toHaveLength(0);
      expect((await OrderModel.findById(o.id))!.status).toBe('pending');
    });

    it('a payment problem raised by anyone, and a subscription payment that could not be activated', async () => {
      const o = await placeOrder(app, seller, menu, 1);
      await request(app).post(`/api/public/orders/${o.ref}/payment-query`).set('X-Order-Key', o.key).send({ reason: 'other', message: 'something is wrong' }).expect(201);
      await request(app).post(`/api/orders/${o.ref}/payment-query`).set(asSeller(o)).send({ reason: 'other', message: 'the seller side' }).expect(201);

      const vendor = await makeSeller();
      const sub = await SubscriptionModel.create({ sellerId: vendor._id, plan: 'quarterly', amountNaira: 11_000, status: 'pending', paystackReference: newSubscriptionReference() });
      paystack.verifyTransaction.mockImplementation(async (reference) => ({ status: 'success', reference, amountKobo: 300_000, currency: 'NGN' }));
      await deliverWebhook(app, sub.paystackReference).expect(200);
      await deliverWebhook(app, sub.paystackReference).expect(200);

      const types = (await adminRows()).map((n) => n.type);
      expect(types.filter((t) => t === 'payment_query_raised')).toHaveLength(2);
      expect(types.filter((t) => t === 'subscription_needs_review')).toHaveLength(1);
    });

    it('reaches the admin inbox with an unread count that falls as they read', async () => {
      const paid = await placeOrder(app, seller, menu, 1);
      await paidOnline(app, paystack, paid);
      await cancelAsSeller(app, paid).expect(200);
      const q = await placeOrder(app, seller, menu, 1);
      await request(app).post(`/api/public/orders/${q.ref}/payment-query`).set('X-Order-Key', q.key).send({ reason: 'other', message: 'something is wrong' }).expect(201);

      const inbox = await adminFeed();
      expect(inbox.status).toBe(200);
      expect(inbox.body.unreadCount).toBe(2);
      expect(inbox.body.notifications.map((n: { type: string }) => n.type).sort()).toEqual(['payment_query_raised', 'refund_due']);

      const one = inbox.body.notifications[0].id as string;
      const marked = await request(app).post('/api/admin/notifications/read').set(asAdmin).send({ ids: [one] });
      expect(marked.body).toEqual({ marked: 1, unreadCount: 1 });
      expect((await adminFeed('?unread=true')).body.notifications).toHaveLength(1);
      await request(app).get('/api/admin/notifications').expect(401);
    });
  });

  describe('what they must never contain or cause', () => {
    it('has no customer name, phone, address, key or delivery code in any message', async () => {
      const o = await placeOrder(app, seller, menu);
      const reference = await paidOnline(app, paystack, o);
      await request(app).post(`/api/public/orders/${o.ref}/payment-query`).set('X-Order-Key', o.key).send({ reason: 'paid_twice', message: 'my number is 08091112222' }).expect(201);
      await cancelAsSeller(app, o).expect(200);
      void reference;
      const text = JSON.stringify(await NotificationModel.find({}));
      expect(text).not.toMatch(/Ada Obi|0809|2348091112222|Herbert Macaulay|accessKey|deliveryCode|ACCT_|sk_test|my number is/);
    });

    it('a failure to save one never breaks a payment, a report or a cancel', async () => {
      const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
      const spy = vi.spyOn(NotificationModel, 'create').mockRejectedValue(new Error('database is down'));
      const o = await placeOrder(app, seller, menu);
      const reference = await startOnline(app, o);
      paystackSays(paystack, 'success');
      await deliverWebhook(app, reference).expect(200);
      expect((await OrderModel.findById(o.id))!.status).toBe('paid');
      expect((await SellerModel.findById(seller._id))!.paidOrderCount).toBe(1);

      const p = await placeOrder(app, seller, menu, 1);
      await request(app).post(`/api/public/orders/${p.ref}/report-paid`).set('X-Order-Key', p.key).expect(200);
      await cancelAsSeller(app, o).expect(200);
      spy.mockRestore();
      quiet.mockRestore();
      expect(await NotificationModel.countDocuments({})).toBe(0);
    });
  });
});
