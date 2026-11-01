import { createHmac } from 'node:crypto';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { OrderModel } from '../src/models/order.js';
import { PaymentModel } from '../src/models/payment.js';
import { SellerModel } from '../src/models/seller.js';
import { generateAccessKey, hashAccessKey } from '../src/orders/delivery-code.js';
import { generateRef } from '../src/orders/reference.js';
import { connectTestDb, disconnectTestDb, testDbUri } from './helpers/db.js';
import { fakeAuth } from './helpers/fake-auth.js';
import { fakePaystack } from './helpers/fake-paystack.js';

const SECRET = 'sk_test_not_a_real_key_for_tests';
const LIMITS = { windowMs: 60_000, ordersPerWindow: 1000, lookupsPerWindow: 1000, paymentsPerWindow: 1000, statusPerWindow: 1000 };

let paystack = fakePaystack();
let configured = true;
let rateLimits: typeof LIMITS = LIMITS;
let app = buildApp();

function buildApp() {
  return createApp({
    allowedOrigins: ['http://localhost:5173'],
    auth: fakeAuth,
    paystack: configured ? paystack : null,
    paystackSecretKey: SECRET,
    pricing: { freeOrders: 50, platformFeeBps: 300 },
    rateLimits,
  });
}

type Started = { orderId: Types.ObjectId; sellerId: Types.ObjectId; ref: string; key: string };
let counter = 0;

async function makeSeller(overrides: Record<string, unknown> = {}) {
  counter += 1;
  return SellerModel.create({
    clerkUserId: `user_${counter}`,
    businessName: `Kitchen ${counter}`,
    slug: `kitchen-${counter}`,
    phone: '+2348031234567',
    payment: { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Owner', bankCode: '058' },
    paymentsReady: true,
    paystackSubaccountCode: `ACCT_seller${counter}`,
    ...overrides,
  });
}

async function makeOrder(sellerOverrides: Record<string, unknown> = {}, orderOverrides: Record<string, unknown> = {}): Promise<Started> {
  const seller = await makeSeller(sellerOverrides);
  const key = generateAccessKey();
  const ref = generateRef();
  const order = await OrderModel.create({
    ref,
    sellerId: seller._id,
    menuId: new Types.ObjectId(),
    customer: { name: 'Ada Customer', phone: '+2348091112222' },
    delivery: { area: 'Yaba', address: '12 Herbert Macaulay Way', day: '2026-10-17' },
    lines: [{ itemId: new Types.ObjectId(), name: 'Jollof rice', unitPrice: 7500, qty: 1 }],
    total: 7500,
    accessKeyHash: hashAccessKey(key),
    ...orderOverrides,
  });
  return { orderId: order._id, sellerId: seller._id, ref, key };
}

const startPay = async (o: Started) => {
  const res = await request(app).post(`/api/public/orders/${o.ref}/pay`).set('X-Order-Key', o.key);
  if (res.status !== 200) throw new Error(`pay failed ${res.status}`);
  return res.body as { reference: string; total: number; serviceFee: number };
};

// Confirms a payment the way Paystack would: a signed charge.success whose verify answer matches.
async function confirm(reference: string) {
  const payment = await PaymentModel.findOne({ reference });
  paystack.verifyTransaction.mockImplementation(async (r) => ({ status: 'success', reference: r, amountKobo: payment!.amountKobo, currency: 'NGN' }));
  const body = JSON.stringify({ event: 'charge.success', data: { reference } });
  const signature = createHmac('sha512', SECRET).update(body).digest('hex');
  const res = await request(app).post('/api/webhooks/paystack').set('Content-Type', 'application/json').set('x-paystack-signature', signature).send(body);
  if (res.status !== 200) throw new Error(`webhook failed ${res.status}`);
}

const status = (o: Started, key: string | null | undefined = o.key, ref: string = o.ref) => {
  const req = request(app).get(`/api/public/orders/${ref}/payment-status`);
  return key === null ? req : req.set('X-Order-Key', key);
};

describe.skipIf(!testDbUri)('GET /api/public/orders/:ref/payment-status on a real MongoDB', () => {
  beforeAll(async () => {
    await connectTestDb('payment_status');
  });
  afterAll(async () => {
    await disconnectTestDb();
  });
  beforeEach(async () => {
    paystack = fakePaystack();
    configured = true;
    rateLimits = LIMITS;
    app = buildApp();
    await Promise.all([SellerModel.deleteMany({}), OrderModel.deleteMany({}), PaymentModel.deleteMany({})]);
  });

  describe('who may ask', () => {
    it('a wrong key, no key, another order\'s key, a malformed key and an unknown ref all get one identical 404', async () => {
      const a = await makeOrder();
      const b = await makeOrder();
      const answers = [
        await status(a, generateAccessKey()),
        await status(a, null),
        await status(a, b.key),
        await status(a, 'nope'),
        await status(a, ''),
        await status(a, a.key, 'CL-ZZZZZ'),
        await status(a, a.key, 'bad-ref'),
      ];
      for (const res of answers) {
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('ORDER_NOT_FOUND');
      }
      expect(new Set(answers.map((r) => JSON.stringify(r.body))).size).toBe(1);
    });

    it('the ref and the customer\'s phone digits are not enough', async () => {
      const a = await makeOrder();
      const res = await request(app).get(`/api/public/orders/${a.ref}/payment-status?phoneLast4=2222`);
      expect(res.status).toBe(404);
    });

    it('an order from before access keys existed cannot be read', async () => {
      const a = await makeOrder();
      await OrderModel.collection.updateOne({ _id: a.orderId }, { $unset: { accessKeyHash: '' } });
      expect((await status(a)).status).toBe(404);
    });

    it('accepts the ref in lower case', async () => {
      const a = await makeOrder();
      expect((await status(a, a.key, a.ref.toLowerCase())).status).toBe(200);
    });
  });

  describe('what the customer is told', () => {
    it('before any online payment: not_started, nothing charged, online payment offered', async () => {
      const o = await makeOrder();
      const res = await status(o);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ref: o.ref,
        orderStatus: 'pending',
        paymentMethod: 'transfer',
        state: 'not_started',
        paid: false,
        total: 7500,
        serviceFee: null,
        amountCharged: null,
        reference: null,
        paidAt: null,
        onlinePaymentAvailable: true,
      });
    });

    it('after pressing Pay but before Paystack confirms: awaiting_payment, with the amounts being charged', async () => {
      const o = await makeOrder();
      const started = await startPay(o);
      const res = await status(o);
      expect(res.body).toMatchObject({
        state: 'awaiting_payment',
        paid: false,
        orderStatus: 'pending',
        paymentMethod: 'transfer',
        total: 7500,
        serviceFee: 216,
        amountCharged: 7716,
        reference: started.reference,
        paidAt: null,
      });
    });

    it('once the webhook confirms: paid by Paystack, with the paid time and the amount', async () => {
      const o = await makeOrder();
      const started = await startPay(o);
      await confirm(started.reference);
      const res = await status(o);
      expect(res.body).toMatchObject({
        state: 'paid',
        paid: true,
        orderStatus: 'paid',
        paymentMethod: 'paystack',
        serviceFee: 216,
        amountCharged: 7716,
        reference: started.reference,
        total: 7500,
      });
      expect(new Date(res.body.paidAt).getTime()).toBeGreaterThan(0);
    });

    it('stays paid as the order moves on (out for delivery, delivered)', async () => {
      const o = await makeOrder();
      await confirm((await startPay(o)).reference);
      for (const next of ['out_for_delivery', 'delivered']) {
        await OrderModel.updateOne({ _id: o.orderId }, { $set: { status: next } });
        expect((await status(o)).body).toMatchObject({ state: 'paid', paid: true, orderStatus: next });
      }
    });

    it('a seller-pays order shows no service fee and the base amount', async () => {
      const o = await makeOrder({ feeMode: 'seller' });
      const started = await startPay(o);
      await confirm(started.reference);
      expect((await status(o)).body).toMatchObject({ state: 'paid', serviceFee: 0, amountCharged: 7500 });
    });

    it('when several attempts exist, the newest unpaid one is described; the paid one wins once it is confirmed', async () => {
      const o = await makeOrder();
      const first = await startPay(o);
      await new Promise((r) => setTimeout(r, 15));
      const second = await startPay(o);
      expect((await status(o)).body).toMatchObject({ state: 'awaiting_payment', reference: second.reference });

      await confirm(first.reference);
      expect((await status(o)).body).toMatchObject({ state: 'paid', reference: first.reference });
    });

    it('paid by bank transfer (the seller marked it paid): paid, no online payment details', async () => {
      const o = await makeOrder({}, { status: 'paid', paidAt: new Date('2026-10-16T10:00:00Z') });
      const res = await status(o);
      expect(res.body).toMatchObject({ state: 'paid', paid: true, paymentMethod: 'transfer', serviceFee: null, amountCharged: null, reference: null });
      expect(res.body.paidAt).toBe('2026-10-16T10:00:00.000Z');
      expect(res.body.onlinePaymentAvailable).toBe(true);
    });

    it('cancelled with nothing taken: cancelled', async () => {
      const o = await makeOrder({}, { status: 'cancelled' });
      expect((await status(o)).body).toMatchObject({ state: 'cancelled', paid: false });
    });

    it('cancelled after an abandoned attempt: still cancelled', async () => {
      const o = await makeOrder();
      await startPay(o);
      await OrderModel.updateOne({ _id: o.orderId }, { $set: { status: 'cancelled' } });
      expect((await status(o)).body).toMatchObject({ state: 'cancelled', amountCharged: null });
    });

    it('cancelled but the customer paid anyway: under_review, with what they paid, not "cancelled"', async () => {
      const o = await makeOrder();
      const started = await startPay(o);
      await OrderModel.updateOne({ _id: o.orderId }, { $set: { status: 'cancelled' } });
      await confirm(started.reference);
      const res = await status(o);
      expect(res.body).toMatchObject({ state: 'under_review', paid: false, orderStatus: 'cancelled', amountCharged: 7716, reference: started.reference });
    });

    it('a second payment set aside for refund does not change a paid order\'s answer', async () => {
      const o = await makeOrder();
      const a = await startPay(o);
      const b = await startPay(o);
      await confirm(a.reference);
      await confirm(b.reference);
      expect((await PaymentModel.findOne({ reference: b.reference }))!.status).toBe('needs_review');
      expect((await status(o)).body).toMatchObject({ state: 'paid', reference: a.reference });
    });

    it('an order saved before payment methods existed is a transfer', async () => {
      const o = await makeOrder({}, { status: 'paid' });
      await OrderModel.collection.updateOne({ _id: o.orderId }, { $unset: { paymentMethod: '', serviceFee: '' } });
      expect((await status(o)).body).toMatchObject({ paymentMethod: 'transfer', state: 'paid' });
    });
  });

  describe('whether to offer the Pay button', () => {
    it.each([
      ['seller payments not ready', { paymentsReady: false }],
      ['seller has no subaccount', { paystackSubaccountCode: undefined }],
      ['seller suspended', { status: 'suspended' }],
    ])('is false when %s', async (_name, seller) => {
      const o = await makeOrder(seller);
      const res = await status(o);
      expect(res.status).toBe(200);
      expect(res.body.onlinePaymentAvailable).toBe(false);
    });

    it('is false when the server has no Paystack key', async () => {
      const o = await makeOrder();
      configured = false;
      app = buildApp();
      expect((await status(o)).body.onlinePaymentAvailable).toBe(false);
    });

    it('agrees with what /pay will actually do', async () => {
      const ready = await makeOrder();
      const notReady = await makeOrder({ paymentsReady: false });
      expect((await status(ready)).body.onlinePaymentAvailable).toBe(true);
      expect((await request(app).post(`/api/public/orders/${ready.ref}/pay`).set('X-Order-Key', ready.key)).status).toBe(200);
      expect((await status(notReady)).body.onlinePaymentAvailable).toBe(false);
      expect((await request(app).post(`/api/public/orders/${notReady.ref}/pay`).set('X-Order-Key', notReady.key)).status).toBe(409);
    });
  });

  describe('what it must not do or reveal', () => {
    it('answers with exactly the documented fields, nothing about fees taken, the seller or Paystack', async () => {
      const o = await makeOrder({ paidOrderCount: 50 });
      await confirm((await startPay(o)).reference);
      const res = await status(o);
      expect(Object.keys(res.body).sort()).toEqual(
        ['amountCharged', 'onlinePaymentAvailable', 'orderStatus', 'paid', 'paidAt', 'paymentMethod', 'ref', 'reference', 'serviceFee', 'state', 'total'].sort(),
      );
      const text = JSON.stringify(res.body);
      for (const secret of ['ACCT_', hashAccessKey(o.key), o.key, '+2348091112222', 'Ada Customer', 'Herbert', String(o.sellerId), 'platformFee', 'paystackFee', SECRET]) {
        expect(text, secret).not.toContain(secret);
      }
    });

    it('is never cached', async () => {
      const o = await makeOrder();
      expect((await status(o)).headers['cache-control']).toBe('no-store');
    });

    it('is read-only: it asks Paystack nothing and changes nothing', async () => {
      const o = await makeOrder();
      await startPay(o);
      const before = JSON.stringify([await OrderModel.findById(o.orderId).lean(), await PaymentModel.find({ orderId: o.orderId }).lean(), await SellerModel.findById(o.sellerId).lean()]);
      paystack.verifyTransaction.mockClear();
      paystack.initializeTransaction.mockClear();
      for (let i = 0; i < 5; i += 1) await status(o);
      expect(paystack.verifyTransaction).not.toHaveBeenCalled();
      expect(paystack.initializeTransaction).not.toHaveBeenCalled();
      const after = JSON.stringify([await OrderModel.findById(o.orderId).lean(), await PaymentModel.find({ orderId: o.orderId }).lean(), await SellerModel.findById(o.sellerId).lean()]);
      expect(after).toBe(before);
    });

    it('one order\'s key never shows another order\'s payments', async () => {
      const a = await makeOrder();
      const b = await makeOrder();
      await confirm((await startPay(b)).reference);
      expect((await status(a)).body).toMatchObject({ state: 'not_started', reference: null, paid: false });
    });

    it('is rate limited per address, with a limit generous enough for polling', async () => {
      rateLimits = { ...LIMITS, statusPerWindow: 3 };
      app = buildApp();
      const o = await makeOrder();
      for (let i = 0; i < 3; i += 1) expect((await status(o)).status).toBe(200);
      const fourth = await status(o);
      expect(fourth.status).toBe(429);
      expect(fourth.body.error.code).toBe('RATE_LIMITED');
    });
  });
});
