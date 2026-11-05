import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { EventLogModel } from '../src/models/event-log.js';
import { MenuModel } from '../src/models/menu.js';
import { OrderModel } from '../src/models/order.js';
import { PaymentModel } from '../src/models/payment.js';
import { SellerModel } from '../src/models/seller.js';
import { expireUnpaidOrders, startExpirySweep } from '../src/orders/expire.js';
import { connectTestDb, disconnectTestDb, testDbUri } from './helpers/db.js';
import { fakeAuth } from './helpers/fake-auth.js';
import { fakePaystack } from './helpers/fake-paystack.js';
import {
  ADMIN, HOUR_MS, LIMITS, SECRET, asAdmin, asSeller, backdate, customerStatus, deliverWebhook, makeMenu, makeSeller, paidOnline, paystackSays,
  placeOrder, startOnline, type Placed,
} from './helpers/flow.js';

let paystack = fakePaystack();
const buildApp = () => createApp({ allowedOrigins: ['http://localhost:5173'], auth: fakeAuth, paystack, paystackSecretKey: SECRET, adminClerkUserIds: [ADMIN], rateLimits: LIMITS });
let app = buildApp();

const HOURS = 48;
const sweep = (apply = true, hours = HOURS) => expireUnpaidOrders({ olderThanHours: hours, apply });

describe.skipIf(!testDbUri)('expiring unpaid orders, on a real MongoDB', () => {
  let seller: Awaited<ReturnType<typeof makeSeller>>;
  let menu: Awaited<ReturnType<typeof makeMenu>>;

  beforeAll(async () => {
    await connectTestDb('expire_orders');
  });
  afterAll(disconnectTestDb);
  beforeEach(async () => {
    paystack = fakePaystack();
    app = buildApp();
    await Promise.all([SellerModel.deleteMany({}), MenuModel.deleteMany({}), OrderModel.deleteMany({}), PaymentModel.deleteMany({}), EventLogModel.deleteMany({})]);
    seller = await makeSeller();
    menu = await makeMenu(seller._id);
  });

  const stock = async () => (await MenuModel.findById(menu._id))!.items[0]!.qtyRemaining;
  const statusOf = async (o: Placed) => (await OrderModel.findById(o.id))!.status;
  async function oldOrder(qty = 2, ageHours = HOURS + 1): Promise<Placed> {
    const o = await placeOrder(app, seller, menu, qty);
    await backdate('order', o.id, ageHours * HOUR_MS);
    return o;
  }

  describe('an order nobody paid for', () => {
    it('is cancelled after the set time, and its portions go back on sale', async () => {
      const o = await oldOrder(3);
      expect(await stock()).toBe(17);

      const result = await sweep();
      expect(result).toMatchObject({ candidates: 1, expired: 1, skipped: 0 });

      const order = (await OrderModel.findById(o.id))!;
      expect(order).toMatchObject({ status: 'cancelled', cancelReason: 'expired' });
      expect(order.cancelledAt).toBeInstanceOf(Date);
      expect(await stock()).toBe(20);
    });

    it('is left alone while it is younger than the set time', async () => {
      const young = await oldOrder(1, HOURS - 1);
      expect(await sweep()).toMatchObject({ candidates: 0, expired: 0 });
      expect(await statusOf(young)).toBe('pending');
      expect(await stock()).toBe(19);
    });

    it('the boundary is the set time itself', async () => {
      const justOver = await oldOrder(1, HOURS + 0.01);
      const justUnder = await oldOrder(1, HOURS - 0.01);
      await sweep();
      expect(await statusOf(justOver)).toBe('cancelled');
      expect(await statusOf(justUnder)).toBe('pending');
    });

    it('tells the seller why, and the customer why, with no refund', async () => {
      const o = await oldOrder();
      await sweep();
      const list = await request(app).get(`/api/menus/${menu._id}/orders`).set(asSeller(o));
      expect(list.body.orders[0]).toMatchObject({ status: 'cancelled', cancelReason: 'expired' });
      expect((await customerStatus(app, o)).body).toMatchObject({ orderStatus: 'cancelled', state: 'cancelled', cancelReason: 'expired', refund: null });
    });

    it('a seller\'s own cancel is not marked expired', async () => {
      const o = await placeOrder(app, seller, menu);
      await request(app).patch(`/api/orders/${o.ref}/cancel`).set(asSeller(o)).expect(200);
      expect((await OrderModel.findById(o.id))!.cancelReason).toBeUndefined();
      const list = await request(app).get(`/api/menus/${menu._id}/orders`).set(asSeller(o));
      expect(list.body.orders[0].cancelReason).toBeNull();
    });

    it('returns the portions once, however many times it runs or how many run together', async () => {
      await oldOrder(4);
      await Promise.all([sweep(), sweep(), sweep(), sweep()]);
      await sweep();
      expect(await stock()).toBe(20);
      expect(await OrderModel.countDocuments({ status: 'cancelled', cancelReason: 'expired' })).toBe(1);
    });

    it('writes one line in the event log with the count and no customer details', async () => {
      await oldOrder();
      await oldOrder();
      await sweep();
      const events = await EventLogModel.find({ type: 'orders_expired' });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ level: 'info', code: 'ORDERS_EXPIRED' });
      expect(events[0]!.meta).toMatchObject({ expired: 2, olderThanHours: HOURS });
      expect(JSON.stringify(events[0])).not.toMatch(/Ada|0809|Herbert/);
      await sweep();
      expect(await EventLogModel.countDocuments({ type: 'orders_expired' })).toBe(1);
    });

    it('an order from before the payment record existed can expire too', async () => {
      const o = await oldOrder(1);
      await OrderModel.collection.updateOne({ _id: o.id }, { $unset: { payment: '' } });
      await sweep();
      expect(await statusOf(o)).toBe('cancelled');
    });
  });

  describe('what it never touches', () => {
    it('an order the customer says they paid by transfer (the seller still has to look)', async () => {
      const o = await oldOrder();
      await request(app).post(`/api/public/orders/${o.ref}/report-paid`).set('X-Order-Key', o.key).expect(200);
      expect(await sweep()).toMatchObject({ candidates: 0, expired: 0 });
      expect(await statusOf(o)).toBe('pending');
    });

    it('an order that is paid, out for delivery, delivered or already cancelled', async () => {
      const paid = await oldOrder(1);
      await request(app).patch(`/api/orders/${paid.ref}/paid`).set(asSeller(paid)).expect(200);
      const out = await oldOrder(1);
      await request(app).patch(`/api/orders/${out.ref}/paid`).set(asSeller(out)).expect(200);
      await request(app).patch(`/api/orders/${out.ref}/out-for-delivery`).set(asSeller(out)).expect(200);
      const cancelled = await oldOrder(1);
      await request(app).patch(`/api/orders/${cancelled.ref}/cancel`).set(asSeller(cancelled)).expect(200);

      expect(await sweep()).toMatchObject({ candidates: 0, expired: 0 });
      expect([await statusOf(paid), await statusOf(out), await statusOf(cancelled)]).toEqual(['paid', 'out_for_delivery', 'cancelled']);
      expect((await OrderModel.findById(cancelled.id))!.cancelReason).toBeUndefined();
    });

    it('an order Paystack has been paid for', async () => {
      const o = await oldOrder();
      await paidOnline(app, paystack, o);
      await backdate('order', o.id, (HOURS + 1) * HOUR_MS);
      expect(await sweep()).toMatchObject({ expired: 0 });
      expect(await statusOf(o)).toBe('paid');
    });

    it('an order with money set aside for review', async () => {
      const o = await oldOrder();
      const reference = await startOnline(app, o);
      paystackSays(paystack, 'success', 100);
      await deliverWebhook(app, reference).expect(200);
      expect((await PaymentModel.findOne({ reference }))!.status).toBe('needs_review');
      expect(await sweep()).toMatchObject({ candidates: 1, expired: 0, skipped: 1 });
      expect(await statusOf(o)).toBe('pending');
    });

    it('an order a customer is paying for right now, but does expire one they abandoned long ago', async () => {
      const mid = await oldOrder();
      await startOnline(app, mid); // started just now
      const abandoned = await oldOrder();
      const ref = await startOnline(app, abandoned);
      await backdate('payment', (await PaymentModel.findOne({ reference: ref }))!._id, 3 * HOUR_MS);

      const result = await sweep();
      expect(result).toMatchObject({ candidates: 2, expired: 1, skipped: 1 });
      expect(await statusOf(mid)).toBe('pending');
      expect(await statusOf(abandoned)).toBe('cancelled');
    });

    it('nothing at all when expiry is switched off', async () => {
      const o = await oldOrder();
      expect(await sweep(true, 0)).toEqual({ candidates: 0, expired: 0, wouldExpire: 0, skipped: 0 });
      expect(await statusOf(o)).toBe('pending');
      expect(startExpirySweep(0)).toBeNull();
    });
  });

  describe('a payment that lands just after an order expired', () => {
    it('is set aside for refund, not lost: the webhook finds the order cancelled', async () => {
      const o = await oldOrder();
      const reference = await startOnline(app, o);
      await backdate('payment', (await PaymentModel.findOne({ reference }))!._id, 3 * HOUR_MS);
      await sweep();
      expect(await statusOf(o)).toBe('cancelled');

      paystackSays(paystack, 'success');
      await deliverWebhook(app, reference).expect(200);
      expect((await PaymentModel.findOne({ reference }))!.status).toBe('needs_review');
      expect(await statusOf(o)).toBe('cancelled');
      expect((await SellerModel.findById(seller._id))!.paidOrderCount).toBe(0);

      const refunds = await request(app).get('/api/admin/refunds').set(asAdmin);
      expect(refunds.body.refunds).toHaveLength(1);
      expect(refunds.body.refunds[0]).toMatchObject({ kind: 'money_held', orderRef: o.ref });
      expect((await customerStatus(app, o)).body).toMatchObject({ state: 'under_review', refund: { status: 'due' } });
    });
  });

  describe('a dry run', () => {
    it('counts what would happen and changes nothing', async () => {
      const o = await oldOrder(2);
      const result = await sweep(false);
      expect(result).toMatchObject({ candidates: 1, wouldExpire: 1, expired: 0, skipped: 0 });
      expect(await statusOf(o)).toBe('pending');
      expect(await stock()).toBe(18);
      expect(await EventLogModel.countDocuments({ type: 'orders_expired' })).toBe(0);
    });
  });

  describe('the sweep', () => {
    it('handles many orders and a large batch limit gracefully', async () => {
      for (let i = 0; i < 5; i += 1) await oldOrder(1);
      const result = await sweep();
      expect(result.expired).toBe(5);
      expect(await stock()).toBe(20);
    });
  });
});
