import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { MenuModel } from '../src/models/menu.js';
import { OrderModel } from '../src/models/order.js';
import { PaymentModel } from '../src/models/payment.js';
import { SellerModel } from '../src/models/seller.js';
import { connectTestDb, disconnectTestDb, testDbUri } from './helpers/db.js';
import { fakeAuth } from './helpers/fake-auth.js';
import { fakePaystack } from './helpers/fake-paystack.js';
import { LIMITS, SECRET, asSeller, cancelAsSeller, makeMenu, makeSeller, placeOrder, type Placed } from './helpers/flow.js';

let paystack = fakePaystack();
const buildApp = (withPaystack = true, pricing = { freeOrders: 50, platformFeeBps: 0 }) =>
  createApp({ allowedOrigins: ['http://localhost:5173'], auth: fakeAuth, paystack: withPaystack ? paystack : null, paystackSecretKey: SECRET, pricing, rateLimits: LIMITS });
let app = buildApp();

const quote = (o: Placed, key: string | null = o.key) => {
  const req = request(app).get(`/api/public/orders/${o.ref}/payment-quote`);
  return key === null ? req : req.set('X-Order-Key', key);
};
const pay = (o: Placed, body?: Record<string, unknown>) => {
  const req = request(app).post(`/api/public/orders/${o.ref}/pay`).set('X-Order-Key', o.key);
  return body === undefined ? req : req.send(body);
};

describe.skipIf(!testDbUri)('fee preview and customer email, on a real MongoDB', () => {
  let seller: Awaited<ReturnType<typeof makeSeller>>;
  let menu: Awaited<ReturnType<typeof makeMenu>>;

  beforeAll(async () => {
    await connectTestDb('quote_email');
  });
  afterAll(disconnectTestDb);
  beforeEach(async () => {
    paystack = fakePaystack();
    app = buildApp();
    await Promise.all([SellerModel.deleteMany({}), MenuModel.deleteMany({}), OrderModel.deleteMany({}), PaymentModel.deleteMany({})]);
    seller = await makeSeller();
    menu = await makeMenu(seller._id);
  });

  describe('GET /api/public/orders/:ref/payment-quote', () => {
    it('shows what paying would cost when the customer covers the card fee', async () => {
      const o = await placeOrder(app, seller, menu);
      const res = await quote(o);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toEqual({ ref: o.ref, onlinePaymentAvailable: true, payable: true, orderTotal: 7500, serviceFee: 216, total: 7716, feePayer: 'customer' });
    });

    it('shows the order total as it is when the seller covers the card fee', async () => {
      await SellerModel.updateOne({ _id: seller._id }, { $set: { feeMode: 'seller' } });
      const o = await placeOrder(app, seller, menu);
      expect((await quote(o)).body).toMatchObject({ orderTotal: 7500, serviceFee: 0, total: 7500, feePayer: 'seller' });
    });

    it('is exactly what pressing Pay then charges, in both modes and with the fee switched on', async () => {
      for (const [mode, pricing] of [
        ['customer', { freeOrders: 50, platformFeeBps: 0 }],
        ['seller', { freeOrders: 50, platformFeeBps: 0 }],
        ['customer', { freeOrders: 0, platformFeeBps: 300 }],
        ['seller', { freeOrders: 0, platformFeeBps: 300 }],
      ] as const) {
        app = buildApp(true, pricing);
        await SellerModel.updateOne({ _id: seller._id }, { $set: { feeMode: mode } });
        const o = await placeOrder(app, seller, menu, 1);
        const preview = (await quote(o)).body;
        const paid = (await pay(o)).body;
        expect({ serviceFee: preview.serviceFee, total: preview.total }).toEqual({ serviceFee: paid.serviceFee, total: paid.total });
      }
    });

    it('changes nothing: no payment, no Paystack call, nothing saved on the order', async () => {
      const o = await placeOrder(app, seller, menu);
      const before = JSON.parse(JSON.stringify((await OrderModel.findById(o.id).lean())!));
      for (let i = 0; i < 3; i += 1) await quote(o).expect(200);
      expect(await PaymentModel.countDocuments({})).toBe(0);
      expect(paystack.initializeTransaction).not.toHaveBeenCalled();
      expect(paystack.verifyTransaction).not.toHaveBeenCalled();
      expect(JSON.parse(JSON.stringify((await OrderModel.findById(o.id).lean())!))).toEqual(before);
    });

    it('needs the order key: a missing, wrong or another order\'s key is the same 404', async () => {
      const a = await placeOrder(app, seller, menu);
      const b = await placeOrder(app, seller, menu);
      for (const res of [await quote(a, null), await quote(a, 'wrong'), await quote(a, b.key)]) {
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('ORDER_NOT_FOUND');
      }
    });

    it('says online payment is not available, with no figures, when it is off or the seller is not set up', async () => {
      const o = await placeOrder(app, seller, menu);
      app = buildApp(false);
      expect((await quote(o)).body).toEqual({ ref: o.ref, onlinePaymentAvailable: false, payable: true, orderTotal: 7500, serviceFee: null, total: null, feePayer: null });

      app = buildApp();
      await SellerModel.updateOne({ _id: seller._id }, { $set: { paymentsReady: false } });
      expect((await quote(o)).body).toMatchObject({ onlinePaymentAvailable: false, serviceFee: null, total: null });
    });

    it('says not payable, with no figures, once the order is paid or cancelled', async () => {
      const paid = await placeOrder(app, seller, menu, 1);
      await request(app).patch(`/api/orders/${paid.ref}/paid`).set(asSeller(paid)).expect(200);
      expect((await quote(paid)).body).toMatchObject({ payable: false, serviceFee: null, total: null });
      const cancelled = await placeOrder(app, seller, menu, 1);
      await cancelAsSeller(app, cancelled).expect(200);
      expect((await quote(cancelled)).body).toMatchObject({ payable: false, serviceFee: null, total: null });
    });

    it('does not reveal fees taken, the seller, or anything about their payout account', async () => {
      const o = await placeOrder(app, seller, menu);
      const text = JSON.stringify((await quote(o)).body);
      expect(text).not.toMatch(/platformFee|paystackFee|ACCT_|businessName|slug|accountNumber|bank/i);
    });
  });

  describe('the customer\'s own email on POST /pay', () => {
    const emailSent = () => paystack.initializeTransaction.mock.calls.at(-1)![0].email;

    it('is given to Paystack so the receipt reaches them (lower-cased)', async () => {
      const o = await placeOrder(app, seller, menu);
      const res = await pay(o, { email: 'Ada.Obi@Example.COM' });
      expect(res.status).toBe(200);
      expect(emailSent()).toBe('ada.obi@example.com');
    });

    it('falls back to the placeholder when none is given: no body at all, or an empty one', async () => {
      const a = await placeOrder(app, seller, menu, 1);
      await pay(a).expect(200);
      expect(emailSent()).toBe(`${a.ref.toLowerCase()}@orders.choplistafrica.com`);
      const b = await placeOrder(app, seller, menu, 1);
      await pay(b, {}).expect(200);
      expect(emailSent()).toBe(`${b.ref.toLowerCase()}@orders.choplistafrica.com`);
    });

    it('refuses a bad address with 400 and starts nothing', async () => {
      const o = await placeOrder(app, seller, menu);
      for (const email of ['not an email', 'a@b', '', 'x'.repeat(130) + '@example.com', 123]) {
        const res = await pay(o, { email });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
      expect(paystack.initializeTransaction).not.toHaveBeenCalled();
      expect(await PaymentModel.countDocuments({})).toBe(0);
    });

    it('is not stored by ChopList, or returned, or logged', async () => {
      const o = await placeOrder(app, seller, menu);
      const res = await pay(o, { email: 'private.customer@example.com' });
      const stored = JSON.stringify([await OrderModel.findById(o.id).lean(), await PaymentModel.find({}).lean(), res.body]);
      expect(stored).not.toContain('private.customer@example.com');
    });

    it('does not change the price or what is sent to Paystack apart from the address', async () => {
      const a = await placeOrder(app, seller, menu, 1);
      await pay(a).expect(200);
      const withPlaceholder = { ...paystack.initializeTransaction.mock.calls.at(-1)![0] };
      const b = await placeOrder(app, seller, menu, 1);
      await pay(b, { email: 'someone@example.com' }).expect(200);
      const withEmail = { ...paystack.initializeTransaction.mock.calls.at(-1)![0] };
      const strip = ({ email: _e, reference: _r, metadata: _m, ...rest }: typeof withEmail) => rest;
      expect(strip(withEmail)).toEqual(strip(withPlaceholder));
    });
  });
});
