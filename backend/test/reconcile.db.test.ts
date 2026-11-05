import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { DEFAULT_BILLING } from '../src/billing/plans.js';
import { newSubscriptionReference } from '../src/billing/subscribe.js';
import { EventLogModel } from '../src/models/event-log.js';
import { MenuModel } from '../src/models/menu.js';
import { OrderModel } from '../src/models/order.js';
import { OrderPaymentEventModel } from '../src/models/order-payment-event.js';
import { PaymentModel } from '../src/models/payment.js';
import { SellerModel } from '../src/models/seller.js';
import { SubscriptionModel } from '../src/models/subscription.js';
import { PaystackError } from '../src/payments/paystack.js';
import { RECONCILE_INTERVAL_MS, RECONCILE_MIN_AGE_MS } from '../src/payments/reconcile.js';
import { connectTestDb, disconnectTestDb, testDbUri } from './helpers/db.js';
import { bearer, fakeAuth } from './helpers/fake-auth.js';
import { fakePaystack } from './helpers/fake-paystack.js';
import {
  ADMIN, LIMITS, SECRET, backdate, customerStatus, deliverWebhook, makeMenu, makeSeller, paystackSays, placeOrder, startOnline, type Placed,
} from './helpers/flow.js';

let paystack = fakePaystack();
const buildApp = (withPaystack = true) =>
  createApp({
    allowedOrigins: ['http://localhost:5173'], auth: fakeAuth, paystack: withPaystack ? paystack : null, paystackSecretKey: SECRET,
    adminClerkUserIds: [ADMIN], billing: DEFAULT_BILLING, rateLimits: LIMITS,
  });
let app = buildApp();

const OLD_ENOUGH = RECONCILE_MIN_AGE_MS + 5_000;

describe.skipIf(!testDbUri)('the lost-webhook fallback, on a real MongoDB', () => {
  let seller: Awaited<ReturnType<typeof makeSeller>>;
  let menu: Awaited<ReturnType<typeof makeMenu>>;

  beforeAll(async () => {
    await connectTestDb('reconcile');
  });
  afterAll(disconnectTestDb);
  beforeEach(async () => {
    paystack = fakePaystack();
    app = buildApp();
    await Promise.all([
      SellerModel.deleteMany({}), MenuModel.deleteMany({}), OrderModel.deleteMany({}), PaymentModel.deleteMany({}),
      OrderPaymentEventModel.deleteMany({}), EventLogModel.deleteMany({}), SubscriptionModel.deleteMany({}),
    ]);
    seller = await makeSeller();
    menu = await makeMenu(seller._id);
  });

  async function waiting(age = OLD_ENOUGH): Promise<{ o: Placed; reference: string }> {
    const o = await placeOrder(app, seller, menu);
    const reference = await startOnline(app, o);
    await backdate('payment', (await PaymentModel.findOne({ reference }))!._id, age);
    return { o, reference };
  }
  const verifyCalls = () => paystack.verifyTransaction.mock.calls.length;

  describe('an order payment whose webhook never arrived', () => {
    it('is confirmed by asking Paystack when the customer checks the status, exactly as the webhook would', async () => {
      const { o, reference } = await waiting();
      paystackSays(paystack, 'success');

      // The webhook was never delivered. The customer's page just polls.
      const res = await customerStatus(app, o);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ state: 'paid', paid: true, orderStatus: 'paid', paymentMethod: 'paystack', payment: { status: 'confirmed', confirmedBy: 'paystack' } });

      const order = (await OrderModel.findById(o.id))!;
      expect(order).toMatchObject({ status: 'paid', paymentMethod: 'paystack' });
      expect((await PaymentModel.findOne({ reference }))!.status).toBe('succeeded');
      expect((await SellerModel.findById(seller._id))!.paidOrderCount).toBe(1);
      expect(await OrderPaymentEventModel.countDocuments({ orderId: o.id })).toBe(1);
    });

    it('the seller sees it paid too, with no click from anyone', async () => {
      const { o } = await waiting();
      paystackSays(paystack, 'success');
      await customerStatus(app, o).expect(200);
      const list = await request(app).get(`/api/menus/${menu._id}/orders`).set({ Authorization: bearer(o.sellerClerk) });
      expect(list.body.orders[0]).toMatchObject({ status: 'paid', paymentMethod: 'paystack', payment: { status: 'confirmed', confirmedBy: 'paystack' } });
    });

    it('a late webhook after the fallback has already paid it changes nothing and counts nothing twice', async () => {
      const { o, reference } = await waiting();
      paystackSays(paystack, 'success');
      await customerStatus(app, o).expect(200);
      await deliverWebhook(app, reference).expect(200);
      await deliverWebhook(app, reference).expect(200);
      expect((await SellerModel.findById(seller._id))!.paidOrderCount).toBe(1);
      expect(await OrderPaymentEventModel.countDocuments({ orderId: o.id })).toBe(1);
    });

    it('a poll and the webhook at the same moment pay it once', async () => {
      const { o, reference } = await waiting();
      paystackSays(paystack, 'success');
      const results = await Promise.all([customerStatus(app, o), deliverWebhook(app, reference), customerStatus(app, o), deliverWebhook(app, reference)]);
      for (const r of results) expect(r.status).toBe(200);
      expect((await SellerModel.findById(seller._id))!.paidOrderCount).toBe(1);
      expect(await OrderPaymentEventModel.countDocuments({ orderId: o.id })).toBe(1);
      expect((await OrderModel.findById(o.id))!.status).toBe('paid');
    });

    it('still checks the amount: a wrong one is set aside, not paid', async () => {
      const { o, reference } = await waiting();
      paystackSays(paystack, 'success', 100);
      const res = await customerStatus(app, o);
      expect(res.body).toMatchObject({ paid: false, orderStatus: 'pending' });
      expect((await PaymentModel.findOne({ reference }))!.status).toBe('needs_review');
      expect((await OrderModel.findById(o.id))!.status).toBe('pending');
    });
  });

  describe('it does not spend Paystack calls without reason', () => {
    it('leaves a payment alone until it is old enough (the webhook is usually quicker)', async () => {
      const { o } = await waiting(1_000);
      paystackSays(paystack, 'success');
      const before = verifyCalls();
      const res = await customerStatus(app, o);
      expect(verifyCalls()).toBe(before);
      expect(res.body).toMatchObject({ state: 'awaiting_payment', paid: false });
    });

    it('asks about one payment at most once per interval, however often the page polls', async () => {
      const { o } = await waiting();
      paystackSays(paystack, 'pending');
      const before = verifyCalls();
      for (let i = 0; i < 6; i += 1) await customerStatus(app, o).expect(200);
      expect(verifyCalls() - before).toBe(1);
    });

    it('asks again once the interval has passed', async () => {
      const { o, reference } = await waiting();
      paystackSays(paystack, 'pending');
      await customerStatus(app, o).expect(200);
      const before = verifyCalls();
      await PaymentModel.updateOne({ reference }, { $set: { lastCheckedAt: new Date(Date.now() - RECONCILE_INTERVAL_MS - 1_000) } });
      await customerStatus(app, o).expect(200);
      expect(verifyCalls() - before).toBe(1);
    });

    it('twenty polls at the same instant ask Paystack once', async () => {
      const { o } = await waiting();
      paystackSays(paystack, 'pending');
      const before = verifyCalls();
      const responses = await Promise.all(Array.from({ length: 20 }, () => customerStatus(app, o)));
      for (const r of responses) expect(r.status).toBe(200);
      expect(verifyCalls() - before).toBe(1);
    });

    it('never asks about an order that is already paid by transfer or was never started online', async () => {
      const paid = await placeOrder(app, seller, menu);
      await request(app).patch(`/api/orders/${paid.ref}/paid`).set({ Authorization: bearer(paid.sellerClerk) }).expect(200);
      const notStarted = await placeOrder(app, seller, menu);
      paystackSays(paystack, 'success');
      const before = verifyCalls();
      for (const order of [paid, notStarted]) await customerStatus(app, order).expect(200);
      expect(verifyCalls()).toBe(before);
    });

    it('does ask about a payment on an order that was cancelled meanwhile, so money that did arrive is set aside for refund', async () => {
      const { o, reference } = await waiting();
      await request(app).patch(`/api/orders/${o.ref}/cancel`).set({ Authorization: bearer(o.sellerClerk) }).expect(200);
      paystackSays(paystack, 'success');
      const res = await customerStatus(app, o);
      expect((await PaymentModel.findOne({ reference }))!.status).toBe('needs_review');
      expect((await OrderModel.findById(o.id))!.status).toBe('cancelled');
      expect(res.body).toMatchObject({ state: 'under_review', refund: { status: 'due' } });
    });

    it('does nothing when Paystack is not configured', async () => {
      const { o } = await waiting();
      app = buildApp(false);
      paystackSays(paystack, 'success');
      const res = await customerStatus(app, o);
      expect(res.status).toBe(200);
      expect(res.body.paid).toBe(false);
      expect(verifyCalls()).toBe(0);
    });

    it('a status poll needs the order key, and a wrong one asks Paystack nothing', async () => {
      const { o } = await waiting();
      paystackSays(paystack, 'success');
      const res = await request(app).get(`/api/public/orders/${o.ref}/payment-status`).set('X-Order-Key', 'wrong');
      expect(res.status).toBe(404);
      expect(verifyCalls()).toBe(0);
    });
  });

  describe('when Paystack does not say it succeeded', () => {
    it.each(['pending', 'abandoned', 'ongoing', 'failed'])('"%s" leaves the order waiting and writes nothing to the event log', async (status) => {
      const { o } = await waiting();
      paystackSays(paystack, status);
      const res = await customerStatus(app, o);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ state: 'awaiting_payment', paid: false });
      expect(await EventLogModel.countDocuments({})).toBe(0);
      expect((await OrderModel.findById(o.id))!.status).toBe('pending');
    });

    it('a Paystack outage never breaks the status page; the order simply stays waiting', async () => {
      const { o } = await waiting();
      paystack.verifyTransaction.mockRejectedValue(new PaystackError('unavailable', 'timeout'));
      const res = await customerStatus(app, o);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ state: 'awaiting_payment', paid: false });
    });

    it('it works the next time Paystack is back', async () => {
      const { o, reference } = await waiting();
      paystack.verifyTransaction.mockRejectedValue(new PaystackError('unavailable', 'timeout'));
      await customerStatus(app, o).expect(200);
      await PaymentModel.updateOne({ reference }, { $set: { lastCheckedAt: new Date(Date.now() - RECONCILE_INTERVAL_MS - 1_000) } });
      paystackSays(paystack, 'success');
      expect((await customerStatus(app, o)).body).toMatchObject({ state: 'paid', paid: true });
    });

    it('a Paystack answer for a different reference is not accepted', async () => {
      const { o } = await waiting();
      paystack.verifyTransaction.mockImplementation(async () => ({ status: 'success', reference: 'CLP-ffffffffffffffffffffffff', amountKobo: 771_600, currency: 'NGN' }));
      const res = await customerStatus(app, o);
      expect(res.body.paid).toBe(false);
      expect((await OrderModel.findById(o.id))!.status).toBe('pending');
    });
  });

  describe('one attempt failing does not stop the others being checked', () => {
    it('still confirms the older attempt when asking about the newer one fails', async () => {
      const o = await placeOrder(app, seller, menu);
      const older = await startOnline(app, o);
      const newer = await startOnline(app, o);
      for (const ref of [older, newer]) await backdate('payment', (await PaymentModel.findOne({ reference: ref }))!._id, OLD_ENOUGH);
      paystack.verifyTransaction.mockImplementation(async (reference) => {
        if (reference === newer) throw new PaystackError('unavailable', 'timeout');
        return { status: 'success', reference, amountKobo: 771_600, currency: 'NGN' };
      });
      const res = await customerStatus(app, o);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ state: 'paid', paid: true });
      expect((await PaymentModel.findOne({ reference: older }))!.status).toBe('succeeded');
    });
  });

  describe('a customer who tried twice', () => {
    it('is confirmed by whichever attempt Paystack says succeeded', async () => {
      const o = await placeOrder(app, seller, menu);
      const first = await startOnline(app, o);
      const second = await startOnline(app, o);
      for (const ref of [first, second]) await backdate('payment', (await PaymentModel.findOne({ reference: ref }))!._id, OLD_ENOUGH);
      paystack.verifyTransaction.mockImplementation(async (reference) => ({
        status: reference === first ? 'abandoned' : 'success', reference, amountKobo: 771_600, currency: 'NGN',
      }));
      const res = await customerStatus(app, o);
      expect(res.body).toMatchObject({ state: 'paid', paid: true });
      expect((await PaymentModel.findOne({ reference: second }))!.status).toBe('succeeded');
      expect((await PaymentModel.findOne({ reference: first }))!.status).toBe('initialized');
    });
  });

  describe('a vendor\'s subscription whose webhook never arrived', () => {
    async function pendingSubscription(age = OLD_ENOUGH) {
      const vendor = await makeSeller({
        billing: { trialStartedAt: new Date(Date.now() - 30 * 86_400_000), trialEndsAt: new Date(Date.now() - 23 * 86_400_000), verification: { status: 'not_started' as const } },
      });
      const sub = await SubscriptionModel.create({ sellerId: vendor._id, plan: 'monthly', amountNaira: 3000, status: 'pending', paystackReference: newSubscriptionReference() });
      await backdate('subscription', sub._id, age);
      return { vendor, sub };
    }
    const poll = (v: { clerkUserId: string }, reference: string) =>
      request(app).get(`/api/sellers/me/billing/subscriptions/${reference}`).set({ Authorization: bearer(v.clerkUserId) });
    const confirms = () => paystack.verifyTransaction.mockImplementation(async (reference) => ({ status: 'success', reference, amountKobo: 300_000, currency: 'NGN' }));

    it('is activated by asking Paystack when the vendor checks, and the share button works again', async () => {
      const { vendor, sub } = await pendingSubscription();
      confirms();
      const res = await poll(vendor, sub.paystackReference);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'active', plan: 'monthly' });
      expect(res.body.startsAt).toBeTruthy();
      expect(res.body.expiresAt).toBeTruthy();
      expect((await request(app).get('/api/sellers/me/share').set({ Authorization: bearer(vendor.clerkUserId) })).status).toBe(200);
    });

    it('a late webhook afterwards changes nothing', async () => {
      const { vendor, sub } = await pendingSubscription();
      confirms();
      const first = (await poll(vendor, sub.paystackReference)).body;
      await deliverWebhook(app, sub.paystackReference).expect(200);
      const again = (await poll(vendor, sub.paystackReference)).body;
      expect(again.expiresAt).toBe(first.expiresAt);
      expect(await SubscriptionModel.countDocuments({ sellerId: vendor._id, status: 'active' })).toBe(1);
    });

    it('a wrong amount is set aside, not activated', async () => {
      const { vendor, sub } = await pendingSubscription();
      paystack.verifyTransaction.mockImplementation(async (reference) => ({ status: 'success', reference, amountKobo: 100, currency: 'NGN' }));
      const res = await poll(vendor, sub.paystackReference);
      expect(res.body.status).toBe('needs_review');
    });

    it('waits until it is old enough and asks at most once per interval', async () => {
      const young = await pendingSubscription(1_000);
      confirms();
      await poll(young.vendor, young.sub.paystackReference).expect(200);
      expect(verifyCalls()).toBe(0);

      const { vendor, sub } = await pendingSubscription();
      paystack.verifyTransaction.mockImplementation(async (reference) => ({ status: 'pending', reference, amountKobo: 300_000, currency: 'NGN' }));
      for (let i = 0; i < 5; i += 1) await poll(vendor, sub.paystackReference).expect(200);
      expect(verifyCalls()).toBe(1);
    });

    it('twenty polls at once ask Paystack once, and an outage does not break the page', async () => {
      const { vendor, sub } = await pendingSubscription();
      paystack.verifyTransaction.mockRejectedValue(new PaystackError('unavailable', 'timeout'));
      const responses = await Promise.all(Array.from({ length: 20 }, () => poll(vendor, sub.paystackReference)));
      for (const r of responses) expect(r.status).toBe(200);
      expect(verifyCalls()).toBe(1);
      expect(responses[0]!.body.status).toBe('pending');
    });

    it('another vendor\'s reference still cannot be read, and asks Paystack nothing', async () => {
      const { sub } = await pendingSubscription();
      const stranger = await makeSeller();
      confirms();
      const res = await poll(stranger, sub.paystackReference);
      expect(res.status).toBe(404);
      expect(verifyCalls()).toBe(0);
      expect((await SubscriptionModel.findById(sub._id))!.status).toBe('pending');
    });
  });
});
