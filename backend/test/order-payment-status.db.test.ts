import { createHmac } from 'node:crypto';
import type { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { AdminAuditModel } from '../src/models/admin-audit.js';
import { MenuModel } from '../src/models/menu.js';
import { OrderModel } from '../src/models/order.js';
import { OrderPaymentEventModel } from '../src/models/order-payment-event.js';
import { PaymentModel } from '../src/models/payment.js';
import { PaymentQueryModel } from '../src/models/payment-query.js';
import { SellerModel } from '../src/models/seller.js';
import { lagosDay } from '../src/validation/day.js';
import { connectTestDb, disconnectTestDb, testDbUri } from './helpers/db.js';
import { bearer, fakeAuth } from './helpers/fake-auth.js';
import { fakePaystack } from './helpers/fake-paystack.js';

const SECRET = 'sk_test_not_a_real_key_for_tests';
const ADMIN = 'user_admin1';
const LIMITS = { windowMs: 60_000, ordersPerWindow: 10_000, lookupsPerWindow: 10_000, paymentsPerWindow: 10_000, reportsPerWindow: 10_000 };
const DAY = lagosDay(new Date(Date.now() + 3 * 86_400_000));

let paystack = fakePaystack();
const buildApp = (rateLimits = LIMITS) =>
  createApp({ allowedOrigins: ['http://localhost:5173'], auth: fakeAuth, paystack, paystackSecretKey: SECRET, adminClerkUserIds: [ADMIN], rateLimits });
let app = buildApp();

let n = 0;
async function makeSeller() {
  n += 1;
  return SellerModel.create({
    clerkUserId: `user_o${n}`, businessName: `Kitchen ${n}`, slug: `kitchen-o${n}`, phone: '+2348031234567',
    payment: { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Owner', bankCode: '058' },
    paymentsReady: true, paystackSubaccountCode: `ACCT_o${n}`,
  });
}
const makeMenu = (sellerId: Types.ObjectId) =>
  MenuModel.create({
    sellerId, title: 'Week menu', status: 'open', openedAt: new Date(), cutoffAt: new Date(Date.now() + 2 * 86_400_000),
    areas: ['Yaba'], deliveryDays: [DAY], items: [{ name: 'Jollof rice', price: 3750, qtyTotal: 20, qtyRemaining: 20 }],
  });

type Placed = { id: string; ref: string; key: string; sellerClerk: string; sellerId: Types.ObjectId; menuId: Types.ObjectId };
async function placeOrder(seller: Awaited<ReturnType<typeof makeSeller>>, menu: Awaited<ReturnType<typeof makeMenu>>, qty = 2): Promise<Placed> {
  const res = await request(app).post('/api/public/orders').send({
    menuId: menu._id.toString(),
    customer: { name: 'Ada Obi', phone: '0809 111 2222' },
    delivery: { area: 'yaba', address: '12 Herbert Macaulay Way, Yaba', day: DAY },
    lines: [{ itemId: menu.items[0]!._id.toString(), qty }],
  });
  if (res.status !== 201) throw new Error(`order failed: ${res.status} ${JSON.stringify(res.body)}`);
  const order = (await OrderModel.findOne({ ref: res.body.order.ref }))!;
  return { id: order._id.toString(), ref: order.ref, key: res.body.accessKey, sellerClerk: seller.clerkUserId, sellerId: seller._id, menuId: menu._id };
}

const asSeller = (o: Placed) => ({ Authorization: bearer(o.sellerClerk) });
const report = (o: Placed, key: string | null = o.key) => {
  const req = request(app).post(`/api/public/orders/${o.ref}/report-paid`);
  return key === null ? req : req.set('X-Order-Key', key);
};
const customerStatus = (o: Placed) => request(app).get(`/api/public/orders/${o.ref}/payment-status`).set('X-Order-Key', o.key);
const sellerConfirms = (o: Placed) => request(app).patch(`/api/orders/${o.ref}/paid`).set(asSeller(o));
const history = (o: Placed) => OrderPaymentEventModel.find({ orderId: o.id }).sort({ at: 1, _id: 1 });

// ---- Paystack ----
const sign = (body: string) => createHmac('sha512', SECRET).update(body).digest('hex');
async function startOnline(o: Placed) {
  const res = await request(app).post(`/api/public/orders/${o.ref}/pay`).set('X-Order-Key', o.key);
  if (res.status !== 200) throw new Error(`pay failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.reference as string;
}
// Paystack reports `status` for the reference, with exactly the amount we asked for.
function paystackSays(status: string, amountKobo?: number) {
  paystack.verifyTransaction.mockImplementation(async (reference) => {
    const row = await PaymentModel.findOne({ reference });
    return { status, reference, amountKobo: amountKobo ?? row!.amountKobo, currency: 'NGN' };
  });
}
function deliver(reference: string) {
  const body = JSON.stringify({ event: 'charge.success', data: { reference } });
  return request(app).post('/api/webhooks/paystack').set('Content-Type', 'application/json').set('x-paystack-signature', sign(body)).send(body);
}

const plain = (doc: unknown) => JSON.parse(JSON.stringify(doc));

describe.skipIf(!testDbUri)('order payment state on a real MongoDB', () => {
  let seller: Awaited<ReturnType<typeof makeSeller>>;
  let menu: Awaited<ReturnType<typeof makeMenu>>;

  beforeAll(async () => {
    await connectTestDb('order_payment_status');
  });
  afterAll(disconnectTestDb);
  beforeEach(async () => {
    paystack = fakePaystack();
    app = buildApp();
    await Promise.all([
      SellerModel.deleteMany({}), MenuModel.deleteMany({}), OrderModel.deleteMany({}), PaymentModel.deleteMany({}),
      OrderPaymentEventModel.deleteMany({}), PaymentQueryModel.deleteMany({}), AdminAuditModel.deleteMany({}),
    ]);
    seller = await makeSeller();
    menu = await makeMenu(seller._id);
  });

  describe('a new order', () => {
    it('starts unpaid, and every view says so', async () => {
      const o = await placeOrder(seller, menu);
      const unpaid = { status: 'unpaid', reportedAt: null, confirmedAt: null, confirmedBy: null };
      expect((await customerStatus(o)).body.payment).toEqual(unpaid);
      const lookup = await request(app).get(`/api/public/orders/${o.ref}`).query({ phoneLast4: '2222' });
      expect(lookup.body.order.payment).toEqual(unpaid);
      const list = await request(app).get(`/api/menus/${menu._id}/orders`).set(asSeller(o));
      expect(list.body.orders[0].payment).toEqual(unpaid);
      expect(await history(o)).toHaveLength(0);
    });
  });

  describe('POST /api/public/orders/:ref/report-paid (bank transfer: "I\'ve paid")', () => {
    it('answers the same 404 for a missing key, a wrong key and another order\'s key', async () => {
      const a = await placeOrder(seller, menu);
      const b = await placeOrder(seller, menu);
      for (const res of [await report(a, null), await report(a, 'wrong-key'), await report(a, b.key), await request(app).post('/api/public/orders/CL-ZZZZZ/report-paid').set('X-Order-Key', a.key)]) {
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('ORDER_NOT_FOUND');
      }
      expect((await OrderModel.findById(a.id))!.payment!.status).toBe('unpaid');
      expect(await history(a)).toHaveLength(0);
    });

    it('records the claim with a time and the source, but the order is NOT paid and nothing is confirmed', async () => {
      const o = await placeOrder(seller, menu);
      const before = Date.now();
      const res = await report(o);
      const after = Date.now();

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toMatchObject({ ref: o.ref, orderStatus: 'pending', paid: false, payment: { status: 'customer_reported', confirmedAt: null, confirmedBy: null } });
      const reportedAt = new Date(res.body.payment.reportedAt).getTime();
      expect(reportedAt).toBeGreaterThanOrEqual(before);
      expect(reportedAt).toBeLessThanOrEqual(after);

      const stored = (await OrderModel.findById(o.id))!;
      expect(stored).toMatchObject({ status: 'pending', paymentMethod: 'transfer' });
      expect(stored.paidAt).toBeUndefined();
      expect(stored.payment).toMatchObject({ status: 'customer_reported' });

      const events = await history(o);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ orderRef: o.ref, from: 'unpaid', to: 'customer_reported', source: 'customer', eventId: `customer_reported:${o.id}` });
    });

    it('is what the seller sees: "the customer says paid", not paid, still theirs to confirm', async () => {
      const o = await placeOrder(seller, menu);
      await report(o);
      const list = await request(app).get(`/api/menus/${menu._id}/orders`).set(asSeller(o));
      expect(list.body.orders[0]).toMatchObject({ status: 'pending', paidAt: null, payment: { status: 'customer_reported', confirmedBy: null } });
    });

    it('does not unlock anything: an order that is only reported cannot go out for delivery', async () => {
      const o = await placeOrder(seller, menu);
      await report(o);
      const out = await request(app).patch(`/api/orders/${o.ref}/out-for-delivery`).set(asSeller(o));
      expect(out.status).toBe(409);
      expect(out.body.error.code).toBe('ORDER_NOT_PAID');
    });

    it('pressed twice, or five times at once, it reports once and keeps the first time', async () => {
      const o = await placeOrder(seller, menu);
      const first = await report(o);
      const again = await report(o);
      expect(again.status).toBe(200);
      expect(again.body.payment.reportedAt).toBe(first.body.payment.reportedAt);

      const p = await placeOrder(seller, menu);
      const responses = await Promise.all(Array.from({ length: 5 }, () => report(p)));
      for (const r of responses) expect(r.status).toBe(200);
      expect(new Set(responses.map((r) => r.body.payment.reportedAt)).size).toBe(1);
      expect(await history(p)).toHaveLength(1);
      expect(await history(o)).toHaveLength(1);
    });

    it('a cancelled order cannot be reported: 409 ORDER_CANCELLED, nothing changes', async () => {
      const o = await placeOrder(seller, menu);
      await request(app).patch(`/api/orders/${o.ref}/cancel`).set(asSeller(o)).expect(200);
      const res = await report(o);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ORDER_CANCELLED');
      expect((await OrderModel.findById(o.id))!.payment!.status).toBe('unpaid');
      expect(await history(o)).toHaveLength(0);
    });

    it('an order the seller already confirmed is answered as paid and nothing is added', async () => {
      const o = await placeOrder(seller, menu);
      await sellerConfirms(o).expect(200);
      const res = await report(o);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ orderStatus: 'paid', paid: true, payment: { status: 'confirmed', confirmedBy: 'seller' } });
      expect((await history(o)).map((e) => e.to)).toEqual(['confirmed']);
    });

    it('one order\'s report never touches another order', async () => {
      const a = await placeOrder(seller, menu);
      const b = await placeOrder(seller, menu);
      await report(a);
      expect((await OrderModel.findById(b.id))!.payment!.status).toBe('unpaid');
    });
  });

  describe('the seller confirms a bank transfer (PATCH /api/orders/:ref/paid)', () => {
    it('marks it paid, confirmed by the seller, in one step, and keeps the customer\'s earlier "I\'ve paid"', async () => {
      const o = await placeOrder(seller, menu);
      const reported = await report(o);
      const before = Date.now();
      const res = await sellerConfirms(o);
      const after = Date.now();

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'paid', paymentMethod: 'transfer', payment: { status: 'confirmed', confirmedBy: 'seller', reportedAt: reported.body.payment.reportedAt } });
      const confirmedAt = new Date(res.body.payment.confirmedAt).getTime();
      expect(confirmedAt).toBeGreaterThanOrEqual(before);
      expect(confirmedAt).toBeLessThanOrEqual(after);
      expect(res.body.paidAt).toBe(res.body.payment.confirmedAt);

      // What is STORED, not just what is shown (the view fills gaps for old orders, so
      // it could hide a write that never happened).
      const stored = (await OrderModel.findById(o.id).lean())!;
      expect(stored.payment).toMatchObject({ status: 'confirmed', confirmedBy: 'seller' });
      expect(stored.payment!.confirmedAt).toEqual(stored.paidAt);
      expect(stored.payment!.reportedAt).toBeTruthy();

      expect((await history(o)).map((e) => [e.from, e.to, e.source])).toEqual([
        ['unpaid', 'customer_reported', 'customer'],
        ['customer_reported', 'confirmed', 'seller'],
      ]);
    });

    it('works without any customer report, and the customer\'s views then show Paid', async () => {
      const o = await placeOrder(seller, menu);
      await sellerConfirms(o).expect(200);
      expect((await history(o)).map((e) => [e.from, e.to])).toEqual([['unpaid', 'confirmed']]);
      expect((await customerStatus(o)).body).toMatchObject({ state: 'paid', paid: true, payment: { status: 'confirmed', confirmedBy: 'seller' } });
      const lookup = await request(app).get(`/api/public/orders/${o.ref}`).query({ phoneLast4: '2222' });
      expect(lookup.body.order).toMatchObject({ status: 'paid', payment: { status: 'confirmed' } });
    });

    it('marking it paid again changes nothing: same time, no second history entry', async () => {
      const o = await placeOrder(seller, menu);
      const first = await sellerConfirms(o);
      const second = await sellerConfirms(o);
      expect(second.body.paidAt).toBe(first.body.paidAt);
      expect(second.body.payment).toEqual(first.body.payment);
      expect(await history(o)).toHaveLength(1);
    });

    it('two simultaneous confirmations confirm once', async () => {
      const o = await placeOrder(seller, menu);
      const responses = await Promise.all(Array.from({ length: 5 }, () => sellerConfirms(o)));
      for (const r of responses) expect(r.status).toBe(200);
      expect(new Set(responses.map((r) => r.body.paidAt)).size).toBe(1);
      expect(await history(o)).toHaveLength(1);
    });

    it('a cancelled order still cannot be marked paid, and nothing is recorded', async () => {
      const o = await placeOrder(seller, menu);
      await request(app).patch(`/api/orders/${o.ref}/cancel`).set(asSeller(o)).expect(200);
      const res = await sellerConfirms(o);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ORDER_CANCELLED');
      expect(await history(o)).toHaveLength(0);
    });

    it('another seller cannot confirm this order', async () => {
      const o = await placeOrder(seller, menu);
      const other = await makeSeller();
      const res = await request(app).patch(`/api/orders/${o.ref}/paid`).set({ Authorization: bearer(other.clerkUserId) });
      expect(res.status).toBe(404);
      expect((await OrderModel.findById(o.id))!.status).toBe('pending');
    });
  });

  describe('Paystack confirms an online payment', () => {
    it('marks the order Paid on the customer\'s view AND the seller\'s view, with no click from anyone', async () => {
      const o = await placeOrder(seller, menu);
      const reference = await startOnline(o);

      // Paying has been started, not confirmed: nothing is paid yet.
      expect((await customerStatus(o)).body).toMatchObject({ state: 'awaiting_payment', paid: false, payment: { status: 'unpaid' } });

      paystackSays('success');
      const before = Date.now();
      await deliver(reference).expect(200);
      const after = Date.now();

      const customer = (await customerStatus(o)).body;
      expect(customer).toMatchObject({ state: 'paid', paid: true, orderStatus: 'paid', paymentMethod: 'paystack', payment: { status: 'confirmed', confirmedBy: 'paystack' } });
      const confirmedAt = new Date(customer.payment.confirmedAt).getTime();
      expect(confirmedAt).toBeGreaterThanOrEqual(before);
      expect(confirmedAt).toBeLessThanOrEqual(after);

      const lookup = await request(app).get(`/api/public/orders/${o.ref}`).query({ phoneLast4: '2222' });
      expect(lookup.body.order).toMatchObject({ status: 'paid', payment: { status: 'confirmed', confirmedBy: 'paystack' } });

      const list = await request(app).get(`/api/menus/${menu._id}/orders`).set(asSeller(o));
      expect(list.body.orders[0]).toMatchObject({ status: 'paid', paymentMethod: 'paystack', payment: { status: 'confirmed', confirmedBy: 'paystack' } });

      // Stored, not just shown.
      const stored = (await OrderModel.findById(o.id).lean())!;
      expect(stored.payment).toMatchObject({ status: 'confirmed', confirmedBy: 'paystack' });
      expect(stored.payment!.confirmedAt).toEqual(stored.paidAt);

      const events = await history(o);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ from: 'unpaid', to: 'confirmed', source: 'paystack', eventId: `paystack:${reference}` });
    });

    it('coming back from checkout is not payment: nothing is confirmed until Paystack says so', async () => {
      const o = await placeOrder(seller, menu);
      await startOnline(o);
      for (let i = 0; i < 3; i += 1) {
        const status = await customerStatus(o);
        expect(status.body).toMatchObject({ paid: false, payment: { status: 'unpaid' } });
      }
      expect((await OrderModel.findById(o.id))!.status).toBe('pending');
      expect(await history(o)).toHaveLength(0);
    });

    it('a customer who said they paid by transfer and then paid online keeps the claim, and the history shows both', async () => {
      const o = await placeOrder(seller, menu);
      const reported = await report(o);
      const reference = await startOnline(o);
      paystackSays('success');
      await deliver(reference).expect(200);

      const view = (await customerStatus(o)).body.payment;
      expect(view).toMatchObject({ status: 'confirmed', confirmedBy: 'paystack', reportedAt: reported.body.payment.reportedAt });
      expect((await history(o)).map((e) => [e.from, e.to, e.source])).toEqual([
        ['unpaid', 'customer_reported', 'customer'],
        ['customer_reported', 'confirmed', 'paystack'],
      ]);
    });

    it('a retried webhook creates no second paid event and no second count', async () => {
      const o = await placeOrder(seller, menu);
      const reference = await startOnline(o);
      paystackSays('success');
      await deliver(reference).expect(200);
      const first = (await customerStatus(o)).body.payment;

      for (let i = 0; i < 3; i += 1) await deliver(reference).expect(200);

      expect(await history(o)).toHaveLength(1);
      expect((await customerStatus(o)).body.payment).toEqual(first);
      expect((await SellerModel.findById(seller._id))!.paidOrderCount).toBe(1);
    });

    it('six deliveries at once still make one event and one count', async () => {
      const o = await placeOrder(seller, menu);
      const reference = await startOnline(o);
      paystackSays('success');
      const responses = await Promise.all(Array.from({ length: 6 }, () => deliver(reference)));
      for (const r of responses) expect(r.status).toBe(200);
      expect(await history(o)).toHaveLength(1);
      expect((await SellerModel.findById(seller._id))!.paidOrderCount).toBe(1);
    });

    it('if the history entry was lost after the order was paid, the next delivery writes it, without counting again', async () => {
      const o = await placeOrder(seller, menu);
      const reference = await startOnline(o);
      paystackSays('success');
      await deliver(reference).expect(200);
      await OrderPaymentEventModel.deleteMany({ orderId: o.id });

      await deliver(reference).expect(200);
      const events = await history(o);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ to: 'confirmed', source: 'paystack', eventId: `paystack:${reference}` });
      expect((await SellerModel.findById(seller._id))!.paidOrderCount).toBe(1);
    });

    describe('a payment that fails or is wrong', () => {
      it('a failed charge: the order stays pending and its payment says failed, in every view, with one history entry', async () => {
        const o = await placeOrder(seller, menu);
        const reference = await startOnline(o);
        paystackSays('failed');
        await deliver(reference).expect(200);
        await deliver(reference).expect(200);

        const stored = (await OrderModel.findById(o.id))!;
        expect(stored.status).toBe('pending');
        expect(stored.paidAt).toBeUndefined();
        expect((await customerStatus(o)).body).toMatchObject({ paid: false, state: 'awaiting_payment', payment: { status: 'failed', confirmedAt: null } });
        const list = await request(app).get(`/api/menus/${menu._id}/orders`).set(asSeller(o));
        expect(list.body.orders[0]).toMatchObject({ status: 'pending', payment: { status: 'failed' } });
        const events = await history(o);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ from: 'unpaid', to: 'failed', source: 'paystack', eventId: `paystack_failed:${reference}` });
        expect((await SellerModel.findById(seller._id))!.paidOrderCount).toBe(0);
      });

      it('a failure does not erase the customer\'s "I\'ve paid" by transfer', async () => {
        const o = await placeOrder(seller, menu);
        await report(o);
        const reference = await startOnline(o);
        paystackSays('failed');
        await deliver(reference).expect(200);
        expect((await customerStatus(o)).body.payment.status).toBe('customer_reported');
        expect(await history(o)).toHaveLength(1);
      });

      it('a customer whose card failed can try again and be confirmed, and the history tells the story', async () => {
        const o = await placeOrder(seller, menu);
        const first = await startOnline(o);
        paystackSays('failed');
        await deliver(first).expect(200);

        const second = await startOnline(o);
        paystackSays('success');
        await deliver(second).expect(200);

        expect((await customerStatus(o)).body).toMatchObject({ state: 'paid', payment: { status: 'confirmed', confirmedBy: 'paystack' } });
        expect((await history(o)).map((e) => [e.from, e.to])).toEqual([['unpaid', 'failed'], ['failed', 'confirmed']]);
      });

      it('a wrong amount confirms nothing: the order is not paid and the payment record is untouched', async () => {
        const o = await placeOrder(seller, menu);
        const reference = await startOnline(o);
        paystackSays('success', 100);
        await deliver(reference).expect(200);
        expect((await OrderModel.findById(o.id))!.status).toBe('pending');
        expect((await customerStatus(o)).body.payment.status).toBe('unpaid');
        expect(await history(o)).toHaveLength(0);
      });

      it('money for an order cancelled in the meantime is set aside, and the order\'s payment record is not confirmed', async () => {
        const o = await placeOrder(seller, menu);
        const reference = await startOnline(o);
        await request(app).patch(`/api/orders/${o.ref}/cancel`).set(asSeller(o)).expect(200);
        paystackSays('success');
        await deliver(reference).expect(200);

        const stored = (await OrderModel.findById(o.id))!;
        expect(stored.status).toBe('cancelled');
        expect(stored.payment!.status).toBe('unpaid');
        expect((await PaymentModel.findOne({ reference }))!.status).toBe('needs_review');
        expect(await history(o)).toHaveLength(0);
        expect((await SellerModel.findById(seller._id))!.paidOrderCount).toBe(0);
      });
    });
  });

  describe('cancelling is exactly as before (the open question: money after a cancellation)', () => {
    it('cancelling a Paystack-paid order still works, returns the stock, and touches nothing about the money', async () => {
      const o = await placeOrder(seller, menu, 3);
      const reference = await startOnline(o);
      paystackSays('success');
      await deliver(reference).expect(200);
      const stockBefore = (await MenuModel.findById(menu._id))!.items[0]!.qtyRemaining;
      const orderBefore = plain((await OrderModel.findById(o.id).lean())!);
      const paymentBefore = plain((await PaymentModel.findOne({ reference }).lean())!);
      const eventsBefore = (await history(o)).length;

      const res = await request(app).patch(`/api/orders/${o.ref}/cancel`).set(asSeller(o));
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('cancelled');

      // Only the order's status and cancelledAt moved. Nothing about the payment did.
      const orderAfter = plain((await OrderModel.findById(o.id).lean())!);
      const { status: _s, cancelledAt: _c, updatedAt: _u, ...afterRest } = orderAfter;
      const { status: _s2, updatedAt: _u2, ...beforeRest } = orderBefore;
      expect(afterRest).toEqual(beforeRest);
      expect(orderAfter.status).toBe('cancelled');
      expect(plain((await PaymentModel.findOne({ reference }).lean())!)).toEqual(paymentBefore);
      expect((await history(o)).length).toBe(eventsBefore);
      expect((await MenuModel.findById(menu._id))!.items[0]!.qtyRemaining).toBe(stockBefore + 3);

      // The money was confirmed and the order is cancelled: the views say both, honestly.
      expect((await customerStatus(o)).body).toMatchObject({ orderStatus: 'cancelled', payment: { status: 'confirmed', confirmedBy: 'paystack' } });
    });

    it('cancelling a pending order keeps a customer\'s "I\'ve paid" on record and changes nothing else about payment', async () => {
      const o = await placeOrder(seller, menu);
      await report(o);
      const eventsBefore = (await history(o)).length;
      await request(app).patch(`/api/orders/${o.ref}/cancel`).set(asSeller(o)).expect(200);
      const stored = (await OrderModel.findById(o.id))!;
      expect(stored.status).toBe('cancelled');
      expect(stored.payment!.status).toBe('customer_reported');
      expect((await history(o)).length).toBe(eventsBefore);
    });

    it('cancelling twice is still a no-op', async () => {
      const o = await placeOrder(seller, menu, 2);
      await request(app).patch(`/api/orders/${o.ref}/cancel`).set(asSeller(o)).expect(200);
      const stock = (await MenuModel.findById(menu._id))!.items[0]!.qtyRemaining;
      await request(app).patch(`/api/orders/${o.ref}/cancel`).set(asSeller(o)).expect(200);
      expect((await MenuModel.findById(menu._id))!.items[0]!.qtyRemaining).toBe(stock);
    });
  });

  describe('orders from before this field existed', () => {
    const raw = (ref: string, extra: Record<string, unknown>) => ({
      ref, sellerId: seller._id, menuId: menu._id,
      customer: { name: 'Old Customer', phone: '+2348091112222' },
      delivery: { area: 'Yaba', address: '1 Old Road', day: DAY },
      lines: [{ itemId: menu.items[0]!._id, name: 'Jollof rice', unitPrice: 3750, qty: 1 }], total: 3750,
      deliveryCodeAttempts: 0, deliveryCodeResets: 0, possibleDuplicate: false, createdAt: new Date(), updatedAt: new Date(), ...extra,
    });

    it('read as the right thing, without a migration', async () => {
      const when = new Date('2026-10-01T10:00:00.000Z');
      await OrderModel.collection.insertMany([
        raw('CL-AAAAA', { status: 'pending' }),
        raw('CL-BBBBB', { status: 'paid', paidAt: when }),
        raw('CL-CCCCC', { status: 'delivered', paidAt: when, paymentMethod: 'paystack' }),
        raw('CL-DDDDD', { status: 'cancelled', cancelledAt: when }),
        raw('CL-EEEEE', { status: 'cancelled', paidAt: when, cancelledAt: when }),
      ]);
      const list = await request(app).get(`/api/menus/${menu._id}/orders`).set({ Authorization: bearer(seller.clerkUserId) });
      const byRef = Object.fromEntries(list.body.orders.map((x: { ref: string; payment: unknown }) => [x.ref, x.payment]));
      expect(byRef['CL-AAAAA']).toEqual({ status: 'unpaid', reportedAt: null, confirmedAt: null, confirmedBy: null });
      expect(byRef['CL-BBBBB']).toEqual({ status: 'confirmed', reportedAt: null, confirmedAt: when.toISOString(), confirmedBy: 'seller' });
      expect(byRef['CL-CCCCC']).toMatchObject({ status: 'confirmed', confirmedBy: 'paystack' });
      expect(byRef['CL-DDDDD']).toMatchObject({ status: 'unpaid' });
      expect(byRef['CL-EEEEE']).toMatchObject({ status: 'confirmed' });
    });

    it('an old pending order can still be reported and then confirmed', async () => {
      await OrderModel.collection.insertOne({ ...raw('CL-FFFFF', { status: 'pending' }) });
      const old = (await OrderModel.findOne({ ref: 'CL-FFFFF' }))!;
      // No access key on an old order, so only the seller's side applies.
      const res = await request(app).patch('/api/orders/CL-FFFFF/paid').set({ Authorization: bearer(seller.clerkUserId) });
      expect(res.body).toMatchObject({ status: 'paid', payment: { status: 'confirmed', confirmedBy: 'seller' } });
      expect((await OrderPaymentEventModel.find({ orderId: old._id })).map((e) => [e.from, e.to])).toEqual([['unpaid', 'confirmed']]);
    });

    it('an order whose status says paid is never shown as unpaid, whatever the stored record says', async () => {
      await OrderModel.collection.insertOne(raw('CL-GGGGG', { status: 'paid', paidAt: new Date(), payment: { status: 'unpaid' } }));
      const list = await request(app).get(`/api/menus/${menu._id}/orders`).set({ Authorization: bearer(seller.clerkUserId) });
      expect(list.body.orders.find((x: { ref: string }) => x.ref === 'CL-GGGGG').payment.status).toBe('confirmed');
    });
  });

  describe('payment queries', () => {
    const raise = (o: Placed, body: Record<string, unknown> = { reason: 'payment_not_reflected', message: 'I paid by transfer an hour ago' }, key: string | null = o.key) => {
      const req = request(app).post(`/api/public/orders/${o.ref}/payment-query`);
      return (key === null ? req : req.set('X-Order-Key', key)).send(body);
    };
    const sellerRaise = (o: Placed, body: Record<string, unknown> = { reason: 'payment_not_received', message: 'The customer says they paid but I see nothing' }, as = o.sellerClerk) =>
      request(app).post(`/api/orders/${o.ref}/payment-query`).set({ Authorization: bearer(as) }).send(body);
    const adminGet = (path: string) => request(app).get(path).set('Authorization', bearer(ADMIN));
    const adminResolve = (id: string, body: Record<string, unknown> = {}) => request(app).patch(`/api/admin/payment-queries/${id}/resolve`).set('Authorization', bearer(ADMIN)).send(body);

    it('a customer raises one with their order key', async () => {
      const o = await placeOrder(seller, menu);
      const res = await raise(o);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ orderRef: o.ref, raisedBy: 'customer', reason: 'payment_not_reflected', status: 'open' });
      expect(JSON.stringify(res.body)).not.toMatch(/accessKey|resolvedBy|sellerId/);
      expect(await PaymentQueryModel.countDocuments({ orderRef: o.ref, raisedBy: 'customer' })).toBe(1);
    });

    it('needs the order key: a missing, wrong or another order\'s key is the same 404', async () => {
      const a = await placeOrder(seller, menu);
      const b = await placeOrder(seller, menu);
      for (const res of [await raise(a, undefined, null), await raise(a, undefined, 'nope'), await raise(a, undefined, b.key)]) {
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('ORDER_NOT_FOUND');
      }
      expect(await PaymentQueryModel.countDocuments({})).toBe(0);
    });

    it('refuses an unknown reason or a message that is too short or too long', async () => {
      const o = await placeOrder(seller, menu);
      for (const body of [{}, { reason: 'because', message: 'a long enough message' }, { reason: 'other', message: 'hi' }, { reason: 'other', message: 'x'.repeat(501) }, { reason: 'other' }]) {
        const res = await raise(o, body);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
      expect(await PaymentQueryModel.countDocuments({})).toBe(0);
    });

    it('one open query per order per person: asking again is 409 QUERY_ALREADY_OPEN, even at the same instant', async () => {
      const o = await placeOrder(seller, menu);
      await raise(o).expect(201);
      const again = await raise(o);
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('QUERY_ALREADY_OPEN');

      const p = await placeOrder(seller, menu);
      const results = await Promise.all(Array.from({ length: 5 }, () => raise(p)));
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(4);
      expect(await PaymentQueryModel.countDocuments({ orderRef: p.ref })).toBe(1);
    });

    it('a seller raises one on their OWN order, separately from the customer; another seller\'s order is a 404', async () => {
      const o = await placeOrder(seller, menu);
      await raise(o).expect(201);
      const res = await sellerRaise(o);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ raisedBy: 'seller', reason: 'payment_not_received' });
      expect(await PaymentQueryModel.countDocuments({ orderRef: o.ref })).toBe(2);

      const other = await makeSeller();
      const stranger = await sellerRaise(o, undefined, other.clerkUserId);
      expect(stranger.status).toBe(404);
      expect(stranger.body.error.code).toBe('ORDER_NOT_FOUND');
      await request(app).post(`/api/orders/${o.ref}/payment-query`).send({ reason: 'other', message: 'no sign in' }).expect(401);
    });

    it('records a problem and changes nothing: not the order, not the money, no payment history', async () => {
      const o = await placeOrder(seller, menu);
      const before = plain((await OrderModel.findById(o.id).lean())!);
      await raise(o).expect(201);
      await sellerRaise(o).expect(201);
      expect(plain((await OrderModel.findById(o.id).lean())!)).toEqual(before);
      expect(await history(o)).toHaveLength(0);
    });

    it('the customer route is strictly rate limited', async () => {
      app = buildApp({ ...LIMITS, reportsPerWindow: 2 });
      const o = await placeOrder(seller, menu);
      await raise(o).expect(201);
      await raise(o).expect(409);
      const third = await raise(o);
      expect(third.status).toBe(429);
      expect(third.body.error.code).toBe('RATE_LIMITED');
    });

    describe('what an admin sees and does', () => {
      it('is closed to anyone who is not an admin', async () => {
        await request(app).get('/api/admin/payment-queries').expect(401);
        await request(app).get('/api/admin/payment-queries').set('Authorization', bearer(seller.clerkUserId)).expect(403);
        await request(app).patch('/api/admin/payment-queries/64b7f0c2a1b2c3d4e5f60718/resolve').set('Authorization', bearer(seller.clerkUserId)).send({}).expect(403);
      });

      it('lists open queries first with the seller and the order as it stands now, and never the customer\'s details', async () => {
        const paid = await placeOrder(seller, menu);
        await sellerConfirms(paid).expect(200);
        const unpaid = await placeOrder(seller, menu);
        // The OPEN one is raised first (older) and the resolved one second (newer), so
        // "open first" and "newest first" give different orders and the test can tell.
        const q2 = await raise(unpaid);
        const q1 = await raise(paid, { reason: 'paid_twice', message: 'I was charged two times' });
        await adminResolve(q1.body.id, { note: 'refunded the second charge' }).expect(200);

        const res = await adminGet('/api/admin/payment-queries');
        expect(res.status).toBe(200);
        expect(res.body.openCount).toBe(1);
        expect(res.body.pagination).toMatchObject({ total: 2 });
        expect(res.body.queries.map((q: { id: string }) => q.id)).toEqual([q2.body.id, q1.body.id]);
        expect(res.body.queries[0]).toMatchObject({
          status: 'open', orderRef: unpaid.ref, raisedBy: 'customer', reason: 'payment_not_reflected',
          seller: { id: seller._id.toString(), businessName: seller.businessName, slug: seller.slug },
          order: { status: 'pending', total: 7500, paymentMethod: 'transfer', payment: { status: 'unpaid' } },
          resolvedBy: null, resolutionNote: null,
        });
        expect(res.body.queries[1]).toMatchObject({ status: 'resolved', resolvedBy: ADMIN, resolutionNote: 'refunded the second charge', order: { status: 'paid', payment: { status: 'confirmed' } } });

        const text = JSON.stringify(res.body);
        expect(text).not.toMatch(/Ada Obi|0809|2348091112222|Herbert Macaulay|accessKey|deliveryCode|ACCT_/);
      });

      it('filters by status and pages', async () => {
        for (let i = 0; i < 3; i += 1) await raise(await placeOrder(seller, menu));
        const all = await adminGet('/api/admin/payment-queries?limit=2&page=2');
        expect(all.body.queries).toHaveLength(1);
        expect(all.body.pagination).toMatchObject({ total: 3 });
        expect((await adminGet('/api/admin/payment-queries?status=resolved')).body.queries).toHaveLength(0);
        expect((await adminGet('/api/admin/payment-queries?status=open')).body.queries).toHaveLength(3);
        expect((await adminGet('/api/admin/payment-queries?status=maybe')).status).toBe(400);
      });

      it('resolves a query once, with a note and an audit entry, and does not touch the order', async () => {
        const o = await placeOrder(seller, menu);
        const q = await raise(o);
        const before = plain((await OrderModel.findById(o.id).lean())!);

        const res = await adminResolve(q.body.id, { note: 'Confirmed the transfer with the seller' });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ status: 'resolved', resolvedBy: ADMIN, resolutionNote: 'Confirmed the transfer with the seller' });
        expect(res.body.resolvedAt).toBeTruthy();
        expect(plain((await OrderModel.findById(o.id).lean())!)).toEqual(before);

        const audit = await AdminAuditModel.find({ action: 'payment_query.resolve' });
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({ adminId: ADMIN, targetId: q.body.id, reason: 'Confirmed the transfer with the seller' });

        // Again: the same answer, no second audit entry, the first note kept.
        const again = await adminResolve(q.body.id, { note: 'a different note' });
        expect(again.body.resolutionNote).toBe('Confirmed the transfer with the seller');
        expect(await AdminAuditModel.countDocuments({ action: 'payment_query.resolve' })).toBe(1);
      });

      it('two admins resolving at once resolve it once', async () => {
        const q = await raise(await placeOrder(seller, menu));
        const responses = await Promise.all(Array.from({ length: 4 }, () => adminResolve(q.body.id)));
        for (const r of responses) expect(r.status).toBe(200);
        expect(await PaymentQueryModel.countDocuments({ status: 'resolved' })).toBe(1);
      });

      it('an unknown or malformed id is 404 PAYMENT_QUERY_NOT_FOUND', async () => {
        for (const id of ['64b7f0c2a1b2c3d4e5f60718', 'not-an-id', '%24ne']) {
          const res = await adminResolve(id);
          expect(res.status).toBe(404);
          expect(res.body.error.code).toBe('PAYMENT_QUERY_NOT_FOUND');
        }
      });

      it('once resolved, the same person can raise a new query on that order', async () => {
        const o = await placeOrder(seller, menu);
        const first = await raise(o);
        await adminResolve(first.body.id).expect(200);
        await raise(o).expect(201);
        expect(await PaymentQueryModel.countDocuments({ orderRef: o.ref })).toBe(2);
      });

      it('the audit list can filter by the new action', async () => {
        const q = await raise(await placeOrder(seller, menu));
        await adminResolve(q.body.id).expect(200);
        const res = await adminGet('/api/admin/audit?action=payment_query.resolve');
        expect(res.status).toBe(200);
        expect(res.body.entries).toHaveLength(1);
      });
    });
  });
});
