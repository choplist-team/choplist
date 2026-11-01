import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { EventLogModel } from '../src/models/event-log.js';
import { OrderModel } from '../src/models/order.js';
import { PaymentModel } from '../src/models/payment.js';
import { SellerModel } from '../src/models/seller.js';
import { generateAccessKey, hashAccessKey } from '../src/orders/delivery-code.js';
import { generateRef } from '../src/orders/reference.js';
import { startPayment } from '../src/payments/pay.js';
import { PaystackError } from '../src/payments/paystack.js';
import { connectTestDb, disconnectTestDb, testDbUri } from './helpers/db.js';
import { fakeAuth } from './helpers/fake-auth.js';
import { fakePaystack } from './helpers/fake-paystack.js';

const PHONE = '+2348091112222';
const NAME = 'Ada Customer';
const LIMITS = { windowMs: 60_000, ordersPerWindow: 1000, lookupsPerWindow: 1000, paymentsPerWindow: 1000 };

let paystack = fakePaystack();
let pricing = { freeOrders: 50, platformFeeBps: 300 };
let callbackUrl: string | undefined = 'https://choplistafrica.com/pay/done';
let rateLimits: typeof LIMITS = LIMITS;
let configured = true;

function buildApp() {
  return createApp({
    allowedOrigins: ['http://localhost:5173'],
    auth: fakeAuth,
    paystack: configured ? paystack : null,
    pricing,
    paystackCallbackUrl: callbackUrl,
    rateLimits,
  });
}
let app = buildApp();

type World = { sellerId: Types.ObjectId; orderId: Types.ObjectId; ref: string; key: string };
let counter = 0;

// A seller who can take Paystack payments, and one pending order for them.
async function world(opts: { seller?: Record<string, unknown>; order?: Record<string, unknown>; total?: number } = {}): Promise<World> {
  counter += 1;
  const key = generateAccessKey();
  const ref = generateRef();
  const seller = await SellerModel.create({
    clerkUserId: `user_${counter}`,
    businessName: `Kitchen ${counter}`,
    slug: `kitchen-${counter}`,
    phone: '+2348031234567',
    payment: { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Owner', bankCode: '058' },
    paymentsReady: true,
    paystackSubaccountCode: `ACCT_seller${counter}`,
    ...opts.seller,
  });
  const total = opts.total ?? 7500;
  const order = await OrderModel.create({
    ref,
    sellerId: seller._id,
    menuId: new Types.ObjectId(),
    customer: { name: NAME, phone: PHONE },
    delivery: { area: 'Yaba', address: '12 Herbert Macaulay Way', day: '2026-10-17' },
    lines: [{ itemId: new Types.ObjectId(), name: 'Jollof rice', unitPrice: total, qty: 1 }],
    total,
    accessKeyHash: hashAccessKey(key),
    ...opts.order,
  });
  return { sellerId: seller._id, orderId: order._id, ref, key };
}

// key: undefined = the order's own key, null = send no X-Order-Key header at all.
const pay = (w: World, key: string | null | undefined = w.key, ref: string = w.ref) => {
  const req = request(app).post(`/api/public/orders/${ref}/pay`);
  return key === null ? req : req.set('X-Order-Key', key);
};

describe.skipIf(!testDbUri)('POST /api/public/orders/:ref/pay on a real MongoDB', () => {
  beforeAll(async () => {
    await connectTestDb('pay');
  });
  afterAll(async () => {
    await disconnectTestDb();
  });
  beforeEach(async () => {
    paystack = fakePaystack();
    pricing = { freeOrders: 50, platformFeeBps: 300 };
    callbackUrl = 'https://choplistafrica.com/pay/done';
    rateLimits = LIMITS;
    configured = true;
    app = buildApp();
    await Promise.all([SellerModel.deleteMany({}), OrderModel.deleteMany({}), PaymentModel.deleteMany({}), EventLogModel.deleteMany({})]);
  });

  describe('what the customer is charged', () => {
    it('7,500 naira, customer pays the fees, free tier: service fee 216, total 7,716', async () => {
      const w = await world();
      const res = await pay(w);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        authorizationUrl: expect.stringMatching(/^https:\/\/checkout\.paystack\.com\/CLP-[0-9a-f]{24}$/),
        reference: expect.stringMatching(/^CLP-[0-9a-f]{24}$/),
        serviceFee: 216,
        total: 7716,
      });
      expect(res.body.authorizationUrl.endsWith(res.body.reference)).toBe(true);
      expect(paystack.initializeTransaction).toHaveBeenCalledExactlyOnceWith({
        email: `${w.ref.toLowerCase()}@orders.choplistafrica.com`,
        amountKobo: 771_600,
        reference: res.body.reference,
        subaccountCode: expect.stringMatching(/^ACCT_seller/),
        transactionChargeKobo: 21_600, // exactly the service fee: the seller still nets 7,500
        bearer: 'account',
        callbackUrl: 'https://choplistafrica.com/pay/done',
        metadata: { orderRef: w.ref },
      });
    });

    it('7,500 naira, customer pays, after the free orders: 3% platform fee, service fee 445, total 7,945', async () => {
      const w = await world({ seller: { paidOrderCount: 50 } });
      const res = await pay(w);
      expect(res.body).toMatchObject({ serviceFee: 445, total: 7945 });
      expect(paystack.initializeTransaction.mock.calls[0]![0]).toMatchObject({ amountKobo: 794_500, transactionChargeKobo: 44_500, bearer: 'account' });
    });

    it('11,000 naira: 270 / 11,270 on the free tier and 605 / 11,605 after it', async () => {
      const free = await world({ total: 11_000 });
      expect((await pay(free)).body).toMatchObject({ serviceFee: 270, total: 11_270 });
      const paid = await world({ total: 11_000, seller: { paidOrderCount: 50 } });
      expect((await pay(paid)).body).toMatchObject({ serviceFee: 605, total: 11_605 });
    });

    it('seller pays the fees: the customer pays only the order, ChopList takes 3% at source, the seller bears Paystack', async () => {
      const w = await world({ seller: { feeMode: 'seller', paidOrderCount: 50 } });
      const res = await pay(w);
      expect(res.body).toMatchObject({ serviceFee: 0, total: 7500 });
      expect(paystack.initializeTransaction.mock.calls[0]![0]).toMatchObject({ amountKobo: 750_000, transactionChargeKobo: 22_500, bearer: 'subaccount' });
    });

    it('seller pays, free tier: ChopList takes nothing, the seller still bears Paystack', async () => {
      const w = await world({ seller: { feeMode: 'seller' } });
      const res = await pay(w);
      expect(res.body).toMatchObject({ serviceFee: 0, total: 7500 });
      expect(paystack.initializeTransaction.mock.calls[0]![0]).toMatchObject({ amountKobo: 750_000, transactionChargeKobo: 0, bearer: 'subaccount' });
    });

    it('the 50th paid order is still free and the 51st is charged', async () => {
      const fiftieth = await world({ seller: { paidOrderCount: 49 } });
      await pay(fiftieth);
      expect((await OrderModel.findById(fiftieth.orderId))!.platformFeeBps).toBe(0);
      const fiftyFirst = await world({ seller: { paidOrderCount: 50 } });
      await pay(fiftyFirst);
      expect((await OrderModel.findById(fiftyFirst.orderId))!.platformFeeBps).toBe(300);
    });

    it('an old seller with none of the new fields is customer-pays, free tier', async () => {
      const w = await world();
      await SellerModel.collection.updateOne({ _id: w.sellerId }, { $unset: { feeMode: '', paidOrderCount: '' } });
      expect((await pay(w)).body).toMatchObject({ serviceFee: 216, total: 7716 });
    });
  });

  describe('what is recorded', () => {
    it('freezes the fee on the order and writes a Payment row, and leaves the order unpaid', async () => {
      const w = await world({ seller: { paidOrderCount: 50 } });
      const res = await pay(w);

      const order = await OrderModel.findById(w.orderId);
      expect(order).toMatchObject({ status: 'pending', total: 7500, serviceFee: 445, platformFeeBps: 300, platformFeeKobo: 22_500 });
      expect(order!.paystackFeeKobo).toBeGreaterThan(0);
      expect(order!.paidAt).toBeUndefined();
      // Still a transfer until Paystack confirms money (the webhook changes it).
      expect(order!.paymentMethod).toBe('transfer');

      const payments = await PaymentModel.find({ orderId: w.orderId }).lean();
      expect(payments).toHaveLength(1);
      expect(payments[0]).toMatchObject({
        reference: res.body.reference,
        orderRef: w.ref,
        sellerId: w.sellerId,
        status: 'initialized',
        amountKobo: 794_500,
        transactionChargeKobo: 44_500,
        platformFeeKobo: 22_500,
        platformFeeBps: 300,
        serviceFee: 445,
        bearer: 'account',
        currency: 'NGN',
      });
      expect(payments[0]!.subaccountCode).toMatch(/^ACCT_seller/);
      expect(payments[0]!.paidAt).toBeUndefined();
    });

    it('the order keeps the fee it was quoted when FREE_ORDERS and PLATFORM_FEE_BPS change afterwards', async () => {
      const w = await world({ seller: { paidOrderCount: 50 } });
      await pay(w);
      const before = await OrderModel.findById(w.orderId).lean();

      pricing = { freeOrders: 1000, platformFeeBps: 900 };
      app = buildApp();
      // Nothing re-prices the stored order or its payment.
      const after = await OrderModel.findById(w.orderId).lean();
      expect(after).toMatchObject({ serviceFee: before!.serviceFee, platformFeeBps: 300, platformFeeKobo: 22_500, paystackFeeKobo: before!.paystackFeeKobo });
      expect((await PaymentModel.findOne({ orderId: w.orderId }))!.platformFeeKobo).toBe(22_500);

      // A NEW payment is quoted under the new rules (50 paid orders is now inside 1000 free).
      const fresh = await world({ seller: { paidOrderCount: 50 } });
      await pay(fresh);
      expect((await OrderModel.findById(fresh.orderId))!.platformFeeBps).toBe(0);
    });

    it('a second tap starts a second attempt with its own unique reference', async () => {
      const w = await world();
      const a = await pay(w);
      const b = await pay(w);
      expect(a.body.reference).not.toBe(b.body.reference);
      expect(await PaymentModel.countDocuments({ orderId: w.orderId })).toBe(2);
    });

    it('five payments started at once all succeed with distinct references', async () => {
      const w = await world();
      const results = await Promise.all(Array.from({ length: 5 }, () => pay(w)));
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(new Set(results.map((r) => r.body.reference)).size).toBe(5);
      expect(await PaymentModel.countDocuments({ orderId: w.orderId })).toBe(5);
    });

    it('sends Paystack no name, phone or address, only the order ref', async () => {
      const w = await world();
      await pay(w);
      const sent = JSON.stringify(paystack.initializeTransaction.mock.calls);
      for (const secret of [PHONE, NAME, 'Herbert Macaulay', 'Yaba', w.key, hashAccessKey(w.key)]) {
        expect(sent).not.toContain(secret);
      }
    });

    it('leaves out the callback address when none is configured', async () => {
      callbackUrl = undefined;
      app = buildApp();
      await pay(await world());
      expect(paystack.initializeTransaction.mock.calls[0]![0].callbackUrl).toBeUndefined();
    });

    it('answers with exactly four fields: no key hash, no seller data, no fee internals', async () => {
      const w = await world();
      const res = await pay(w);
      expect(Object.keys(res.body).sort()).toEqual(['authorizationUrl', 'reference', 'serviceFee', 'total']);
      const text = JSON.stringify(res.body);
      expect(text).not.toContain('ACCT_');
      expect(text).not.toContain(hashAccessKey(w.key));
    });
  });

  describe('who may pay', () => {
    it('a wrong key, a missing key and a key from another order all get the same 404', async () => {
      const a = await world();
      const b = await world();
      const bodies = [
        await pay(a, generateAccessKey()),
        await pay(a, null),
        await pay(a, b.key),
        await pay(a, 'not-a-key'),
        await pay(a, '', a.ref),
      ];
      for (const res of bodies) {
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('ORDER_NOT_FOUND');
      }
      expect(new Set(bodies.map((r) => JSON.stringify(r.body))).size).toBe(1);
      expect(paystack.initializeTransaction).not.toHaveBeenCalled();
      expect(await PaymentModel.countDocuments()).toBe(0);
    });

    it('an unknown ref, a malformed ref and a wrong-ref-right-key look identical to a wrong key', async () => {
      const a = await world();
      const unknown = await pay(a, a.key, 'CL-ZZZZZ');
      const malformed = await pay(a, a.key, 'nope');
      const wrong = await pay(a, generateAccessKey());
      for (const res of [unknown, malformed]) {
        expect(res.status).toBe(404);
        expect(res.body).toEqual(wrong.body);
      }
    });

    it('an order from before access keys existed cannot be paid online', async () => {
      const w = await world();
      await OrderModel.collection.updateOne({ _id: w.orderId }, { $unset: { accessKeyHash: '' } });
      expect((await pay(w)).status).toBe(404);
    });

    it('accepts the ref in lower case', async () => {
      const w = await world();
      expect((await pay(w, w.key, w.ref.toLowerCase())).status).toBe(200);
    });
  });

  describe('what cannot be paid', () => {
    it.each([
      ['cancelled', 409, 'ORDER_CANCELLED'],
      ['paid', 409, 'ORDER_ALREADY_PAID'],
      ['out_for_delivery', 409, 'ORDER_ALREADY_PAID'],
      ['delivered', 409, 'ORDER_ALREADY_PAID'],
    ])('a %s order is refused (%i %s) and nothing is recorded', async (status, httpStatus, code) => {
      const w = await world({ order: { status } });
      const res = await pay(w);
      expect(res.status).toBe(httpStatus);
      expect(res.body.error.code).toBe(code);
      expect(paystack.initializeTransaction).not.toHaveBeenCalled();
      expect(await PaymentModel.countDocuments()).toBe(0);
      // The refused attempt does not touch the order's stored fee either.
      expect((await OrderModel.findById(w.orderId))!.platformFeeBps).toBeUndefined();
    });

    it('an order cancelled between loading it and starting the payment is caught by the write itself', async () => {
      const w = await world();
      const stale = (await OrderModel.findById(w.orderId))!; // pending when loaded
      const seller = (await SellerModel.findById(w.sellerId))!;
      await OrderModel.updateOne({ _id: w.orderId }, { $set: { status: 'cancelled' } });
      await expect(startPayment(stale, seller, { paystack, pricing })).rejects.toMatchObject({ code: 'ORDER_CANCELLED' });
      expect(paystack.initializeTransaction).not.toHaveBeenCalled();
      expect(await PaymentModel.countDocuments()).toBe(0);
    });

    it('an order paid between loading it and starting the payment is refused as already paid', async () => {
      const w = await world();
      const stale = (await OrderModel.findById(w.orderId))!;
      const seller = (await SellerModel.findById(w.sellerId))!;
      await OrderModel.updateOne({ _id: w.orderId }, { $set: { status: 'paid' } });
      await expect(startPayment(stale, seller, { paystack, pricing })).rejects.toMatchObject({ code: 'ORDER_ALREADY_PAID' });
    });

    it.each([
      ['payments not ready', { paymentsReady: false }],
      ['no subaccount', { paystackSubaccountCode: undefined }],
      ['suspended', { status: 'suspended' }],
      ['deactivated', { status: 'deactivated' }],
    ])('a seller with %s takes bank transfer only (409 PAYMENTS_NOT_READY)', async (_name, seller) => {
      const w = await world({ seller });
      const res = await pay(w);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PAYMENTS_NOT_READY');
      expect(res.body.error.message).toContain('bank transfer');
      expect(paystack.initializeTransaction).not.toHaveBeenCalled();
      expect(await PaymentModel.countDocuments()).toBe(0);
    });

    it('a seller saved before payments existed takes bank transfer only', async () => {
      const w = await world();
      await SellerModel.collection.updateOne({ _id: w.sellerId }, { $unset: { paymentsReady: '', paystackSubaccountCode: '' } });
      expect((await pay(w)).body.error.code).toBe('PAYMENTS_NOT_READY');
    });

    it('with no Paystack key on the server, online payment is 503 PAYMENTS_UNAVAILABLE', async () => {
      configured = false;
      app = buildApp();
      const res = await pay(await world());
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('PAYMENTS_UNAVAILABLE');
    });
  });

  describe('when Paystack fails', () => {
    it.each([
      ['is down', new PaystackError('unavailable', 'Could not reach Paystack')],
      ['refuses', new PaystackError('rejected', 'Invalid subaccount', 400)],
      ['crashes', new TypeError('boom')],
    ])('Paystack %s: 503, no Payment row, the order stays payable, and the failure is logged', async (_name, error) => {
      const w = await world();
      paystack.initializeTransaction.mockRejectedValueOnce(error);
      const res = await pay(w);
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('PAYMENTS_UNAVAILABLE');
      expect(res.body.error.message).toContain('bank transfer');
      expect(await PaymentModel.countDocuments()).toBe(0);
      expect((await OrderModel.findById(w.orderId))!.status).toBe('pending');

      const events = await EventLogModel.find({ type: 'payment_start_failed' }).lean();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ level: 'error', orderRef: w.ref, sellerId: w.sellerId });

      // ...and trying again works.
      expect((await pay(w)).status).toBe(200);
    });

    it('the event log and the response hold no phone, name, address or key', async () => {
      const w = await world();
      paystack.initializeTransaction.mockRejectedValueOnce(new PaystackError('unavailable', 'Invalid key supplied: INTERNAL_DETAIL', 401));
      const res = await pay(w);
      const text = JSON.stringify([res.body, await EventLogModel.find().lean()]);
      for (const secret of [PHONE, NAME, 'Herbert', w.key]) expect(text).not.toContain(secret);
      // Paystack's own wording is for our log, not for the customer.
      expect(JSON.stringify(res.body)).not.toContain('INTERNAL_DETAIL');
      expect(JSON.stringify(res.body)).not.toContain('Invalid key');
    });
  });

  describe('abuse limits', () => {
    it('starting payments is rate limited per address', async () => {
      rateLimits = { ...LIMITS, paymentsPerWindow: 2 };
      app = buildApp();
      const w = await world();
      expect((await pay(w)).status).toBe(200);
      expect((await pay(w)).status).toBe(200);
      const third = await pay(w);
      expect(third.status).toBe(429);
      expect(third.body.error.code).toBe('RATE_LIMITED');
      expect(paystack.initializeTransaction).toHaveBeenCalledTimes(2);
    });
  });
});
