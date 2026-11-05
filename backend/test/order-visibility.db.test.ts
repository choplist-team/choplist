import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { EventLogModel } from '../src/models/event-log.js';
import { MenuModel } from '../src/models/menu.js';
import { OrderModel } from '../src/models/order.js';
import { OrderPaymentEventModel } from '../src/models/order-payment-event.js';
import { PaymentModel } from '../src/models/payment.js';
import { PaymentQueryModel } from '../src/models/payment-query.js';
import { SellerModel } from '../src/models/seller.js';
import { connectTestDb, disconnectTestDb, testDbUri } from './helpers/db.js';
import { bearer, fakeAuth } from './helpers/fake-auth.js';
import { fakePaystack } from './helpers/fake-paystack.js';
import {
  ADMIN, LIMITS, SECRET, asAdmin, asSeller, cancelAsSeller, makeMenu, makeSeller, paidOnline, placeOrder, startOnline, type Placed,
} from './helpers/flow.js';

let paystack = fakePaystack();
const buildApp = () => createApp({ allowedOrigins: ['http://localhost:5173'], auth: fakeAuth, paystack, paystackSecretKey: SECRET, adminClerkUserIds: [ADMIN], rateLimits: LIMITS });
let app = buildApp();

describe.skipIf(!testDbUri)('payment history, admin order detail and query visibility, on a real MongoDB', () => {
  let seller: Awaited<ReturnType<typeof makeSeller>>;
  let menu: Awaited<ReturnType<typeof makeMenu>>;

  beforeAll(async () => {
    await connectTestDb('order_visibility');
  });
  afterAll(disconnectTestDb);
  beforeEach(async () => {
    paystack = fakePaystack();
    app = buildApp();
    await Promise.all([
      SellerModel.deleteMany({}), MenuModel.deleteMany({}), OrderModel.deleteMany({}), PaymentModel.deleteMany({}),
      OrderPaymentEventModel.deleteMany({}), PaymentQueryModel.deleteMany({}), EventLogModel.deleteMany({}),
    ]);
    seller = await makeSeller();
    menu = await makeMenu(seller._id);
  });

  describe('GET /api/orders/:ref/payment-history (the seller)', () => {
    const history = (o: Placed, as = o.sellerClerk) => request(app).get(`/api/orders/${o.ref}/payment-history`).set({ Authorization: bearer(as) });

    it('tells the story in order: who said what, and when', async () => {
      const o = await placeOrder(app, seller, menu);
      await request(app).post(`/api/public/orders/${o.ref}/report-paid`).set('X-Order-Key', o.key).expect(200);
      await request(app).patch(`/api/orders/${o.ref}/paid`).set(asSeller(o)).expect(200);

      const res = await history(o);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ref: o.ref, payment: { status: 'confirmed', confirmedBy: 'seller' } });
      expect(res.body.history.map((e: { from: string; to: string; source: string }) => [e.from, e.to, e.source])).toEqual([
        ['unpaid', 'customer_reported', 'customer'],
        ['customer_reported', 'confirmed', 'seller'],
      ]);
      const times = res.body.history.map((e: { at: string }) => new Date(e.at).getTime());
      expect(times[0]).toBeLessThanOrEqual(times[1]);
    });

    it('is empty for a new order, and shows a Paystack payment as paystack', async () => {
      const fresh = await placeOrder(app, seller, menu);
      expect((await history(fresh)).body).toMatchObject({ history: [], payment: { status: 'unpaid' } });
      const paid = await placeOrder(app, seller, menu);
      await paidOnline(app, paystack, paid);
      expect((await history(paid)).body.history).toEqual([expect.objectContaining({ from: 'unpaid', to: 'confirmed', source: 'paystack' })]);
    });

    it('is the seller\'s own orders only, and needs a sign-in', async () => {
      const o = await placeOrder(app, seller, menu);
      const other = await makeSeller();
      const stranger = await history(o, other.clerkUserId);
      expect(stranger.status).toBe(404);
      expect(stranger.body.error.code).toBe('ORDER_NOT_FOUND');
      await request(app).get(`/api/orders/${o.ref}/payment-history`).expect(401);
    });

    it('does not expose the internal event id, the delivery code or anything about fees', async () => {
      const o = await placeOrder(app, seller, menu);
      await paidOnline(app, paystack, o);
      const text = JSON.stringify((await history(o)).body);
      expect(text).not.toMatch(/eventId|paystack:CLP|CLP-|accessKey|deliveryCode|serviceFee|ACCT_|orderId/);
    });
  });

  describe('GET /api/admin/orders/:ref', () => {
    const detail = (o: Placed) => request(app).get(`/api/admin/orders/${o.ref}`).set(asAdmin);

    it('shows the payment state, the history and each Paystack payment for the order', async () => {
      const o = await placeOrder(app, seller, menu);
      await request(app).post(`/api/public/orders/${o.ref}/report-paid`).set('X-Order-Key', o.key).expect(200);
      const reference = await paidOnline(app, paystack, o);

      const res = await detail(o);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ paymentMethod: 'paystack', payment: { status: 'confirmed', confirmedBy: 'paystack' }, cancelReason: null });
      expect(res.body.paymentHistory.map((e: { source: string }) => e.source)).toEqual(['customer', 'paystack']);
      expect(res.body.onlinePayments).toHaveLength(1);
      expect(res.body.onlinePayments[0]).toMatchObject({
        reference, status: 'succeeded', amountNaira: 7716, serviceFee: 216, platformFeeNaira: 0, feePayer: 'customer', refund: null,
      });
      expect(res.body.onlinePayments[0].paidAt).toBeTruthy();
    });

    it('lists every attempt, newest first, including one that never completed', async () => {
      const o = await placeOrder(app, seller, menu);
      const abandoned = await startOnline(app, o);
      const paidRef = await startOnline(app, o);
      const res = await detail(o);
      expect(res.body.onlinePayments.map((p: { reference: string }) => p.reference)).toEqual([paidRef, abandoned]);
      expect(res.body.onlinePayments.map((p: { status: string }) => p.status)).toEqual(['initialized', 'initialized']);
    });

    it('shows a refund once an admin has recorded it, and the cancelled-after-payment flag', async () => {
      const o = await placeOrder(app, seller, menu);
      const reference = await paidOnline(app, paystack, o);
      await cancelAsSeller(app, o).expect(200);
      const id = (await PaymentModel.findOne({ reference }))!._id.toString();
      await request(app).patch(`/api/admin/refunds/${id}/mark-refunded`).set(asAdmin).send({ note: 'done in dashboard' }).expect(200);

      const res = await detail(o);
      expect(res.body).toMatchObject({ status: 'cancelled', paymentStatus: 'paid_then_cancelled' });
      expect(res.body.onlinePayments[0].refund).toMatchObject({ refundedBy: ADMIN, note: 'done in dashboard' });
    });

    it('an order that was never paid online has no payments and no history', async () => {
      const o = await placeOrder(app, seller, menu);
      const res = await detail(o);
      expect(res.body).toMatchObject({ paymentHistory: [], onlinePayments: [], payment: { status: 'unpaid' }, paymentMethod: 'transfer' });
    });

    it('shows why an order was cancelled by the system', async () => {
      const o = await placeOrder(app, seller, menu);
      await OrderModel.updateOne({ _id: o.id }, { $set: { status: 'cancelled', cancelledAt: new Date(), cancelReason: 'expired' } });
      expect((await detail(o)).body.cancelReason).toBe('expired');
    });

    it('never shows the seller\'s payout account, the access key, the delivery code or the customer\'s full details', async () => {
      const o = await placeOrder(app, seller, menu);
      await paidOnline(app, paystack, o);
      const text = JSON.stringify((await detail(o)).body);
      expect(text).not.toMatch(/ACCT_|accessKey|deliveryCode|subaccount|0809 111 2222|2348091112222|Herbert Macaulay|sk_test/);
    });
  });

  describe('seeing your own payment queries', () => {
    const raise = (o: Placed, reason = 'payment_not_reflected', message = 'I paid by transfer an hour ago') =>
      request(app).post(`/api/public/orders/${o.ref}/payment-query`).set('X-Order-Key', o.key).send({ reason, message });
    const mine = (o: Placed, key: string | null = o.key) => {
      const req = request(app).get(`/api/public/orders/${o.ref}/payment-queries`);
      return key === null ? req : req.set('X-Order-Key', key);
    };
    const resolve = (id: string, note?: string) => request(app).patch(`/api/admin/payment-queries/${id}/resolve`).set(asAdmin).send(note ? { note } : {});

    it('the customer sees their query open, then resolved with the admin\'s reply', async () => {
      const o = await placeOrder(app, seller, menu);
      const made = await raise(o);
      expect((await mine(o)).body).toMatchObject({ ref: o.ref, queries: [{ id: made.body.id, status: 'open', resolvedAt: null, resolutionNote: null, message: 'I paid by transfer an hour ago' }] });

      await resolve(made.body.id, 'We have asked the seller to check their account').expect(200);
      const after = (await mine(o)).body.queries[0];
      expect(after).toMatchObject({ status: 'resolved', resolutionNote: 'We have asked the seller to check their account' });
      expect(after.resolvedAt).toBeTruthy();
      expect((await mine(o)).headers['cache-control']).toBe('no-store');
    });

    it('never shows who resolved it', async () => {
      const o = await placeOrder(app, seller, menu);
      const made = await raise(o);
      await resolve(made.body.id, 'sorted').expect(200);
      expect(JSON.stringify((await mine(o)).body)).not.toMatch(new RegExp(`resolvedBy|${ADMIN}|sellerId`));
    });

    it('the customer sees only their own, not the seller\'s', async () => {
      const o = await placeOrder(app, seller, menu);
      await raise(o).expect(201);
      await request(app).post(`/api/orders/${o.ref}/payment-query`).set(asSeller(o)).send({ reason: 'payment_not_received', message: 'Seller side report' }).expect(201);
      const customer = (await mine(o)).body.queries;
      expect(customer).toHaveLength(1);
      expect(customer[0].raisedBy).toBe('customer');
    });

    it('the seller sees every query on their own order, theirs and the customer\'s', async () => {
      const o = await placeOrder(app, seller, menu);
      await raise(o).expect(201);
      await request(app).post(`/api/orders/${o.ref}/payment-query`).set(asSeller(o)).send({ reason: 'payment_not_received', message: 'Seller side report' }).expect(201);
      const res = await request(app).get(`/api/orders/${o.ref}/payment-queries`).set(asSeller(o));
      expect(res.status).toBe(200);
      expect(res.body.queries.map((q: { raisedBy: string }) => q.raisedBy).sort()).toEqual(['customer', 'seller']);
    });

    it('a stranger cannot read them: a missing, wrong or other order\'s key, or another seller', async () => {
      const o = await placeOrder(app, seller, menu);
      const other = await placeOrder(app, seller, menu);
      await raise(o).expect(201);
      for (const res of [await mine(o, null), await mine(o, 'wrong'), await mine(o, other.key)]) {
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('ORDER_NOT_FOUND');
      }
      const stranger = await makeSeller();
      const res = await request(app).get(`/api/orders/${o.ref}/payment-queries`).set({ Authorization: bearer(stranger.clerkUserId) });
      expect(res.status).toBe(404);
      await request(app).get(`/api/orders/${o.ref}/payment-queries`).expect(401);
    });

    it('an order with no queries gives an empty list', async () => {
      const o = await placeOrder(app, seller, menu);
      expect((await mine(o)).body.queries).toEqual([]);
    });
  });

  describe('how ChopList finds out a query was raised', () => {
    it('writes one line to the event log with the reason and the order, and none of the message', async () => {
      const o = await placeOrder(app, seller, menu);
      await request(app).post(`/api/public/orders/${o.ref}/payment-query`).set('X-Order-Key', o.key).send({ reason: 'paid_twice', message: 'I was charged two times, my number is 08091112222' }).expect(201);

      const events = await EventLogModel.find({ type: 'payment_query_raised' });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ level: 'warn', code: 'PAID_TWICE', orderRef: o.ref, sellerId: seller._id });
      expect(events[0]!.meta).toMatchObject({ raisedBy: 'customer' });
      expect(JSON.stringify(events[0])).not.toMatch(/charged two times|08091112222|Ada/);

      const listed = await request(app).get('/api/admin/events?type=payment_query_raised').set(asAdmin);
      expect(listed.status).toBe(200);
      expect(listed.body.events).toHaveLength(1);
    });

    it('a duplicate attempt does not add a second line', async () => {
      const o = await placeOrder(app, seller, menu);
      const body = { reason: 'other', message: 'something is wrong here' };
      await request(app).post(`/api/public/orders/${o.ref}/payment-query`).set('X-Order-Key', o.key).send(body).expect(201);
      await request(app).post(`/api/public/orders/${o.ref}/payment-query`).set('X-Order-Key', o.key).send(body).expect(409);
      expect(await EventLogModel.countDocuments({ type: 'payment_query_raised' })).toBe(1);
    });

    it('the overview shows how many are open, and the count falls when one is resolved', async () => {
      const a = await placeOrder(app, seller, menu);
      const b = await placeOrder(app, seller, menu);
      const first = await request(app).post(`/api/public/orders/${a.ref}/payment-query`).set('X-Order-Key', a.key).send({ reason: 'other', message: 'problem number one' });
      await request(app).post(`/api/orders/${b.ref}/payment-query`).set(asSeller(b)).send({ reason: 'other', message: 'problem number two' }).expect(201);

      const open = async () => (await request(app).get('/api/admin/overview').set(asAdmin)).body.payments.openPaymentQueries;
      expect(await open()).toBe(2);
      await request(app).patch(`/api/admin/payment-queries/${first.body.id}/resolve`).set(asAdmin).send({}).expect(200);
      expect(await open()).toBe(1);
    });
  });
});
