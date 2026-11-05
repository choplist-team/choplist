import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { AdminAuditModel } from '../src/models/admin-audit.js';
import { MenuModel } from '../src/models/menu.js';
import { OrderModel } from '../src/models/order.js';
import { PaymentModel } from '../src/models/payment.js';
import { SellerModel } from '../src/models/seller.js';
import { connectTestDb, disconnectTestDb, testDbUri } from './helpers/db.js';
import { bearer, fakeAuth } from './helpers/fake-auth.js';
import { fakePaystack } from './helpers/fake-paystack.js';
import {
  ADMIN, LIMITS, SECRET, asAdmin, asSeller, cancelAsSeller, customerStatus, deliverWebhook, makeMenu, makeSeller, paidOnline, paystackSays,
  placeOrder, startOnline, type Placed,
} from './helpers/flow.js';

let paystack = fakePaystack();
const buildApp = () => createApp({ allowedOrigins: ['http://localhost:5173'], auth: fakeAuth, paystack, paystackSecretKey: SECRET, adminClerkUserIds: [ADMIN], rateLimits: LIMITS });
let app = buildApp();

const listRefunds = (query = '') => request(app).get(`/api/admin/refunds${query}`).set(asAdmin);
const markRefunded = (id: string, body: Record<string, unknown> = {}) => request(app).patch(`/api/admin/refunds/${id}/mark-refunded`).set(asAdmin).send(body);
const paymentId = async (reference: string) => (await PaymentModel.findOne({ reference }))!._id.toString();

describe.skipIf(!testDbUri)('refunds owed to customers, on a real MongoDB', () => {
  let seller: Awaited<ReturnType<typeof makeSeller>>;
  let menu: Awaited<ReturnType<typeof makeMenu>>;

  beforeAll(async () => {
    await connectTestDb('refunds');
  });
  afterAll(disconnectTestDb);
  beforeEach(async () => {
    paystack = fakePaystack();
    app = buildApp();
    await Promise.all([SellerModel.deleteMany({}), MenuModel.deleteMany({}), OrderModel.deleteMany({}), PaymentModel.deleteMany({}), AdminAuditModel.deleteMany({})]);
    seller = await makeSeller();
    menu = await makeMenu(seller._id);
  });

  describe('who may see them', () => {
    it('is closed to anyone who is not an admin', async () => {
      await request(app).get('/api/admin/refunds').expect(401);
      await request(app).get('/api/admin/refunds').set('Authorization', bearer(seller.clerkUserId)).expect(403);
      await request(app).patch('/api/admin/refunds/64b7f0c2a1b2c3d4e5f60718/mark-refunded').set('Authorization', bearer(seller.clerkUserId)).send({}).expect(403);
    });
  });

  describe('a paid online order that is then cancelled', () => {
    it('appears as a refund due, with the amount the customer actually paid', async () => {
      const o = await placeOrder(app, seller, menu);
      const reference = await paidOnline(app, paystack, o);
      expect((await listRefunds()).body.refunds).toHaveLength(0);

      await cancelAsSeller(app, o).expect(200);

      const res = await listRefunds();
      expect(res.status).toBe(200);
      expect(res.body.dueCount).toBe(1);
      expect(res.body.refunds).toHaveLength(1);
      expect(res.body.refunds[0]).toMatchObject({
        kind: 'cancelled_after_payment',
        status: 'due',
        orderRef: o.ref,
        // 7,500 of food plus the 216 service fee that covers Paystack's charge.
        amountNaira: 7716,
        paystackReference: reference,
        seller: { id: seller._id.toString(), businessName: seller.businessName, slug: seller.slug },
        refundedAt: null, refundedBy: null, note: null,
      });
      expect(res.body.refunds[0].id).toBe(await paymentId(reference));
      expect(res.body.definitions.due).toBeTruthy();
    });

    it('is found even if the server died right after the cancel (nothing had to be written)', async () => {
      const o = await placeOrder(app, seller, menu);
      await paidOnline(app, paystack, o);
      // The cancel route's own write only; no refund bookkeeping anywhere.
      await OrderModel.updateOne({ _id: o.id }, { $set: { status: 'cancelled', cancelledAt: new Date() } });
      expect((await listRefunds()).body.refunds).toHaveLength(1);
    });

    it('is not listed while the order is paid and going ahead', async () => {
      const o = await placeOrder(app, seller, menu);
      await paidOnline(app, paystack, o);
      await request(app).patch(`/api/orders/${o.ref}/out-for-delivery`).set(asSeller(o)).expect(200);
      expect((await listRefunds()).body).toMatchObject({ dueCount: 0, refunds: [] });
    });

    it('lists only the cancelled one when an ordinary paid order sits beside it', async () => {
      // A cancelled order must exist so the "cancelled orders" part of the filter is
      // actually in play; the paid one must not be swept in with it.
      const cancelled = await placeOrder(app, seller, menu, 1);
      const cancelledRef = await paidOnline(app, paystack, cancelled);
      await cancelAsSeller(app, cancelled).expect(200);
      const ordinary = await placeOrder(app, seller, menu, 1);
      await paidOnline(app, paystack, ordinary);

      const res = await listRefunds();
      expect(res.body.refunds.map((r: { orderRef: string }) => r.orderRef)).toEqual([cancelled.ref]);
      expect(res.body.dueCount).toBe(1);
      expect(res.body.refunds[0].paystackReference).toBe(cancelledRef);
      // And it cannot be marked refunded either.
      const ordinaryPayment = await PaymentModel.findOne({ orderRef: ordinary.ref });
      expect((await markRefunded(ordinaryPayment!._id.toString())).status).toBe(404);
    });

    it('is not listed for an order the seller was paid for by bank transfer and then cancelled', async () => {
      const o = await placeOrder(app, seller, menu);
      await request(app).patch(`/api/orders/${o.ref}/paid`).set(asSeller(o)).expect(200);
      await cancelAsSeller(app, o).expect(200);
      expect((await listRefunds()).body.refunds).toHaveLength(0);
    });

    it('is not listed for an order cancelled before anything was paid', async () => {
      const o = await placeOrder(app, seller, menu);
      await startOnline(app, o);
      await cancelAsSeller(app, o).expect(200);
      expect((await listRefunds()).body.refunds).toHaveLength(0);
    });

    it('the customer is told it was cancelled and a refund is due, not that it is paid', async () => {
      const o = await placeOrder(app, seller, menu);
      await paidOnline(app, paystack, o);
      await cancelAsSeller(app, o).expect(200);

      const res = await customerStatus(app, o);
      expect(res.body).toMatchObject({ orderStatus: 'cancelled', state: 'cancelled', paid: false, refund: { status: 'due' }, payment: { status: 'confirmed', confirmedBy: 'paystack' } });
    });

    it('an order that was never paid says there is no refund', async () => {
      const o = await placeOrder(app, seller, menu);
      await cancelAsSeller(app, o).expect(200);
      expect((await customerStatus(app, o)).body).toMatchObject({ state: 'cancelled', refund: null });
    });

    it('the order is cancelled exactly as before: stock back, nothing else about the payment moved', async () => {
      const o = await placeOrder(app, seller, menu, 3);
      const reference = await paidOnline(app, paystack, o);
      const before = JSON.parse(JSON.stringify((await PaymentModel.findOne({ reference }).lean())!));
      await cancelAsSeller(app, o).expect(200);
      expect((await MenuModel.findById(menu._id))!.items[0]!.qtyRemaining).toBe(20);
      expect(JSON.parse(JSON.stringify((await PaymentModel.findOne({ reference }).lean())!))).toEqual(before);
    });
  });

  describe('money that arrived but could not be applied', () => {
    it('a payment confirmed after the order was cancelled is listed as money held', async () => {
      const o = await placeOrder(app, seller, menu);
      const reference = await startOnline(app, o);
      await cancelAsSeller(app, o).expect(200);
      paystackSays(paystack, 'success');
      await deliverWebhook(app, reference).expect(200);

      const res = await listRefunds();
      expect(res.body.refunds).toHaveLength(1);
      expect(res.body.refunds[0]).toMatchObject({ kind: 'money_held', status: 'due', orderRef: o.ref, amountNaira: 7716 });
      expect((await customerStatus(app, o)).body).toMatchObject({ state: 'under_review', refund: { status: 'due' } });
    });

    it('a customer who paid the same order twice has the second listed', async () => {
      const o = await placeOrder(app, seller, menu);
      const first = await startOnline(app, o);
      const second = await startOnline(app, o);
      paystackSays(paystack, 'success');
      await deliverWebhook(app, first).expect(200);
      await deliverWebhook(app, second).expect(200);
      const res = await listRefunds();
      expect(res.body.refunds).toHaveLength(1);
      expect(res.body.refunds[0]).toMatchObject({ kind: 'money_held', paystackReference: second });
    });
  });

  describe('recording that it was refunded', () => {
    it('marks it refunded with a note and an audit entry, and changes nothing about the order or the payment', async () => {
      const o = await placeOrder(app, seller, menu);
      const reference = await paidOnline(app, paystack, o);
      await cancelAsSeller(app, o).expect(200);
      const id = await paymentId(reference);
      const orderBefore = JSON.parse(JSON.stringify((await OrderModel.findById(o.id).lean())!));

      const res = await markRefunded(id, { note: 'Refunded in the Paystack dashboard, ref 12345' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id, status: 'refunded', refundedBy: ADMIN, note: 'Refunded in the Paystack dashboard, ref 12345' });
      expect(res.body.refundedAt).toBeTruthy();

      expect(JSON.parse(JSON.stringify((await OrderModel.findById(o.id).lean())!))).toEqual(orderBefore);
      const payment = (await PaymentModel.findById(id))!;
      expect(payment.status).toBe('succeeded');
      expect(payment.refund).toMatchObject({ refundedBy: ADMIN, note: 'Refunded in the Paystack dashboard, ref 12345' });

      const audit = await AdminAuditModel.find({ action: 'refund.mark_refunded' });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ adminId: ADMIN, targetId: id, reason: 'Refunded in the Paystack dashboard, ref 12345' });

      // It leaves the "due" count and the customer is told.
      const list = await listRefunds();
      expect(list.body.dueCount).toBe(0);
      expect(list.body.refunds[0]).toMatchObject({ status: 'refunded' });
      expect((await customerStatus(app, o)).body.refund).toEqual({ status: 'refunded' });
    });

    it('never calls Paystack: ChopList does not move the money', async () => {
      const o = await placeOrder(app, seller, menu);
      const reference = await paidOnline(app, paystack, o);
      await cancelAsSeller(app, o).expect(200);
      const verifyCalls = paystack.verifyTransaction.mock.calls.length;
      const initCalls = paystack.initializeTransaction.mock.calls.length;
      await listRefunds().expect(200);
      await markRefunded(await paymentId(reference)).expect(200);
      expect(paystack.verifyTransaction.mock.calls.length).toBe(verifyCalls);
      expect(paystack.initializeTransaction.mock.calls.length).toBe(initCalls);
    });

    it('asking again changes nothing, adds no audit entry and keeps the first note', async () => {
      const o = await placeOrder(app, seller, menu);
      const id = await paymentId(await paidOnline(app, paystack, o));
      await cancelAsSeller(app, o).expect(200);
      const first = await markRefunded(id, { note: 'first' });
      const again = await markRefunded(id, { note: 'second' });
      expect(again.body.note).toBe('first');
      expect(again.body.refundedAt).toBe(first.body.refundedAt);
      expect(await AdminAuditModel.countDocuments({ action: 'refund.mark_refunded' })).toBe(1);
    });

    it('several admins marking it at once mark it once', async () => {
      const o = await placeOrder(app, seller, menu);
      const id = await paymentId(await paidOnline(app, paystack, o));
      await cancelAsSeller(app, o).expect(200);
      const responses = await Promise.all(Array.from({ length: 5 }, () => markRefunded(id)));
      for (const r of responses) expect(r.status).toBe(200);
      expect(new Set(responses.map((r) => r.body.refundedAt)).size).toBe(1);
      expect((await PaymentModel.findById(id))!.refund).toBeTruthy();
    });

    it('only a payment that really needs a refund can be marked: an ordinary paid one is a 404', async () => {
      const o = await placeOrder(app, seller, menu);
      const id = await paymentId(await paidOnline(app, paystack, o));
      for (const target of [id, '64b7f0c2a1b2c3d4e5f60718', 'not-an-id', '%24ne']) {
        const res = await markRefunded(target);
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('REFUND_NOT_FOUND');
      }
      expect((await PaymentModel.findById(id))!.refund).toBeUndefined();
      expect(await AdminAuditModel.countDocuments({ action: 'refund.mark_refunded' })).toBe(0);
    });

    it('a note over 300 characters is refused', async () => {
      const o = await placeOrder(app, seller, menu);
      const id = await paymentId(await paidOnline(app, paystack, o));
      await cancelAsSeller(app, o).expect(200);
      expect((await markRefunded(id, { note: 'x'.repeat(301) })).status).toBe(400);
    });
  });

  describe('the list', () => {
    it('shows what is still due first, filters by status and pages', async () => {
      const refs: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const o = await placeOrder(app, seller, menu, 1);
        refs.push(await paidOnline(app, paystack, o));
        await cancelAsSeller(app, o).expect(200);
      }
      // The NEWEST is refunded, so "due first" and "newest first" disagree.
      await markRefunded(await paymentId(refs[2]!)).expect(200);

      const all = await listRefunds();
      expect(all.body.refunds.map((r: { status: string }) => r.status)).toEqual(['due', 'due', 'refunded']);
      expect(all.body.dueCount).toBe(2);
      expect((await listRefunds('?status=due')).body.refunds).toHaveLength(2);
      expect((await listRefunds('?status=refunded')).body.refunds).toHaveLength(1);
      expect((await listRefunds('?limit=2&page=2')).body.refunds).toHaveLength(1);
      expect((await listRefunds('?status=maybe')).status).toBe(400);
    });

    it('never shows the customer\'s details, the delivery code or the seller\'s payout account', async () => {
      const o = await placeOrder(app, seller, menu);
      const reference = await paidOnline(app, paystack, o);
      await cancelAsSeller(app, o).expect(200);
      await markRefunded(await paymentId(reference), { note: 'done' });
      const text = JSON.stringify((await listRefunds()).body);
      expect(text).not.toMatch(/Ada Obi|0809|2348091112222|Herbert Macaulay|accessKey|deliveryCode|ACCT_|0123456789|sk_test/);
    });
  });

  describe('the admin overview', () => {
    it('counts the refunds still due, and the count falls when one is marked', async () => {
      const a = await placeOrder(app, seller, menu, 1);
      const b = await placeOrder(app, seller, menu, 1);
      const refA = await paidOnline(app, paystack, a);
      await paidOnline(app, paystack, b);
      await cancelAsSeller(app, a).expect(200);
      await cancelAsSeller(app, b).expect(200);

      const before = await request(app).get('/api/admin/overview').set(asAdmin);
      expect(before.body.payments.refundsDue).toBe(2);
      expect(before.body.payments.definitions.refundsDue).toBeTruthy();

      await markRefunded(await paymentId(refA)).expect(200);
      expect((await request(app).get('/api/admin/overview').set(asAdmin)).body.payments.refundsDue).toBe(1);
    });
  });
});
