import { createHmac } from 'node:crypto';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { MenuModel } from '../src/models/menu.js';
import { OrderModel } from '../src/models/order.js';
import { PaymentModel } from '../src/models/payment.js';
import { SellerModel } from '../src/models/seller.js';
import { generateAccessKey, hashAccessKey } from '../src/orders/delivery-code.js';
import { generateRef } from '../src/orders/reference.js';
import { connectTestDb, disconnectTestDb, testDbUri } from './helpers/db.js';
import { bearer, fakeAuth } from './helpers/fake-auth.js';
import { fakePaystack } from './helpers/fake-paystack.js';

const SECRET = 'sk_test_not_a_real_key_for_tests';
const ADMIN = 'user_admin1';
const paystack = fakePaystack();
const app = createApp({
  allowedOrigins: ['http://localhost:5173'],
  auth: fakeAuth,
  adminClerkUserIds: [ADMIN],
  paystack,
  paystackSecretKey: SECRET,
  pricing: { freeOrders: 50, platformFeeBps: 300 },
  rateLimits: { windowMs: 60_000, ordersPerWindow: 1000, lookupsPerWindow: 1000, paymentsPerWindow: 1000, statusPerWindow: 1000 },
});

type Shop = { userId: string; sellerId: Types.ObjectId; menuId: Types.ObjectId; ref: string; key: string; reference: string; subaccount: string; phone: string };

// One seller, one open menu, one order the customer paid through Paystack.
async function paidShop(name: string, phone: string, over: Record<string, unknown> = {}): Promise<Shop> {
  const userId = `user_${name}`;
  const subaccount = `ACCT_${name}`;
  const seller = await SellerModel.create({
    clerkUserId: userId,
    businessName: `${name} Kitchen`,
    slug: `${name}-kitchen`,
    phone: '+2348031234567',
    payment: { bankName: 'GTBank', accountNumber: '0123456789', accountName: `${name} Owner`, bankCode: '058' },
    paymentsReady: true,
    paystackSubaccountCode: subaccount,
    paidOrderCount: 50,
    ...over,
  });
  const menuId = new Types.ObjectId();
  await MenuModel.collection.insertOne({
    _id: menuId,
    sellerId: seller._id,
    title: `${name} menu`,
    status: 'open',
    cutoffAt: new Date(Date.now() + 86_400_000),
    items: [{ _id: new Types.ObjectId(), name: 'Jollof', price: 7500, qtyTotal: 10, qtyRemaining: 9 }],
    areas: ['Yaba'],
    deliveryDays: ['2026-10-17'],
    openedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  } as never);

  const key = generateAccessKey();
  const ref = generateRef();
  await OrderModel.create({
    ref,
    sellerId: seller._id,
    menuId,
    customer: { name: `${name} Customer`, phone },
    delivery: { area: 'Yaba', address: `1 ${name} Street`, day: '2026-10-17' },
    lines: [{ itemId: new Types.ObjectId(), name: 'Jollof', unitPrice: 7500, qty: 1 }],
    total: 7500,
    accessKeyHash: hashAccessKey(key),
  });

  const pay = await request(app).post(`/api/public/orders/${ref}/pay`).set('X-Order-Key', key);
  if (pay.status !== 200) throw new Error(`pay failed ${pay.status}`);
  const reference = pay.body.reference as string;
  const row = await PaymentModel.findOne({ reference });
  paystack.verifyTransaction.mockImplementation(async (r) => {
    const p = await PaymentModel.findOne({ reference: r });
    return { status: 'success', reference: r, amountKobo: p!.amountKobo, currency: 'NGN' };
  });
  const body = JSON.stringify({ event: 'charge.success', data: { reference } });
  const signature = createHmac('sha512', SECRET).update(body).digest('hex');
  const hook = await request(app).post('/api/webhooks/paystack').set('Content-Type', 'application/json').set('x-paystack-signature', signature).send(body);
  if (hook.status !== 200 || !row) throw new Error('webhook failed');
  return { userId, sellerId: seller._id, menuId, ref, key, reference, subaccount, phone };
}

const asSeller = (userId: string) => ({
  get: (path: string) => request(app).get(path).set('Authorization', bearer(userId)),
  patch: (path: string) => request(app).patch(path).set('Authorization', bearer(userId)),
  put: (path: string) => request(app).put(path).set('Authorization', bearer(userId)),
  post: (path: string) => request(app).post(path).set('Authorization', bearer(userId)),
});

describe.skipIf(!testDbUri)('one seller can never see or touch another seller\'s payment data', () => {
  let a: Shop;
  let b: Shop;

  beforeAll(async () => {
    await connectTestDb('paymentisolation');
  });
  afterAll(async () => {
    await disconnectTestDb();
  });
  beforeEach(async () => {
    await Promise.all([SellerModel.deleteMany({}), MenuModel.deleteMany({}), OrderModel.deleteMany({}), PaymentModel.deleteMany({})]);
    a = await paidShop('alpha', '+2348011111111');
    b = await paidShop('bravo', '+2348022222222', { feeMode: 'seller' });
  });

  it('a seller\'s own Paystack order says how it was paid, and nothing about fees or Paystack', async () => {
    const res = await asSeller(a.userId).get(`/api/menus/${a.menuId}/orders`);
    expect(res.status).toBe(200);
    expect(res.body.orders).toHaveLength(1);
    const order = res.body.orders[0];
    expect(order).toMatchObject({ ref: a.ref, status: 'paid', paymentMethod: 'paystack', total: 7500 });
    expect(Object.keys(order).sort()).toEqual(
      ['cancelledAt', 'createdAt', 'customer', 'delivery', 'deliveredAt', 'id', 'lines', 'note', 'outForDeliveryAt', 'paidAt', 'paymentMethod', 'ref', 'status', 'total'].sort(),
    );
    const text = JSON.stringify(res.body);
    for (const hidden of ['serviceFee', 'platformFee', 'paystackFee', 'ACCT_', 'CLP-', 'subaccount', 'reference', a.key, hashAccessKey(a.key)]) {
      expect(text, hidden).not.toContain(hidden);
    }
  });

  it('another seller\'s menu orders are a 404, not an empty list and not their data', async () => {
    const res = await asSeller(b.userId).get(`/api/menus/${a.menuId}/orders`);
    expect(res.status).toBe(404);
    const text = JSON.stringify(res.body);
    for (const hidden of [a.ref, a.phone, 'alpha', a.subaccount, a.reference]) expect(text, hidden).not.toContain(hidden);
  });

  it('another seller cannot mark, cancel, advance or reset a Paystack-paid order', async () => {
    const before = JSON.stringify(await OrderModel.findOne({ ref: a.ref }).lean());
    const attempts = [
      asSeller(b.userId).patch(`/api/orders/${a.ref}/paid`),
      asSeller(b.userId).patch(`/api/orders/${a.ref}/cancel`),
      asSeller(b.userId).patch(`/api/orders/${a.ref}/out-for-delivery`),
      asSeller(b.userId).patch(`/api/orders/${a.ref}/reset-delivery-code`),
      asSeller(b.userId).patch(`/api/orders/${a.ref}/confirm-delivery`).send({ code: '123456' }),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('ORDER_NOT_FOUND');
    }
    expect(JSON.stringify(await OrderModel.findOne({ ref: a.ref }).lean())).toBe(before);
    expect(await PaymentModel.countDocuments({ sellerId: a.sellerId, status: 'succeeded' })).toBe(1);
  });

  it('a seller\'s own profile and payment status contain only their own numbers and no Paystack ids', async () => {
    for (const [seller, other] of [[a, b], [b, a]] as const) {
      const me = await asSeller(seller.userId).get('/api/sellers/me');
      const status = await asSeller(seller.userId).get('/api/sellers/me/payments');
      expect(me.status).toBe(200);
      expect(status.status).toBe(200);
      const text = JSON.stringify([me.body, status.body]);
      for (const hidden of [seller.subaccount, other.subaccount, other.ref, other.reference, other.phone, 'CLP-', 'ACCT_']) {
        expect(text, hidden).not.toContain(hidden);
      }
      expect(status.body.paidOrderCount).toBe(51);
    }
    // Their fee modes are their own.
    expect((await asSeller(a.userId).get('/api/sellers/me/payments')).body.feeMode).toBe('customer');
    expect((await asSeller(b.userId).get('/api/sellers/me/payments')).body.feeMode).toBe('seller');
  });

  it('changing your own fee mode or retrying setup never touches another seller', async () => {
    // A and B move in opposite directions, so a change that leaked to the other
    // seller would flip one of them back.
    await asSeller(a.userId).put('/api/sellers/me/fee-mode').send({ feeMode: 'seller' });
    await asSeller(b.userId).put('/api/sellers/me/fee-mode').send({ feeMode: 'customer' });
    await asSeller(a.userId).post('/api/sellers/me/payments/retry');
    const other = await SellerModel.findById(b.sellerId).lean();
    expect(other).toMatchObject({ feeMode: 'customer', paidOrderCount: 51, paystackSubaccountCode: b.subaccount, paymentsReady: true });
    const mine = await SellerModel.findById(a.sellerId).lean();
    expect(mine).toMatchObject({ feeMode: 'seller', paystackSubaccountCode: a.subaccount });
  });

  it('no seller route returns a Payment row, a payment reference or a subaccount code', async () => {
    const reads = [
      asSeller(a.userId).get('/api/sellers/me'),
      asSeller(a.userId).get('/api/sellers/me/payments'),
      asSeller(a.userId).get('/api/menus'),
      asSeller(a.userId).get(`/api/menus/${a.menuId}`),
      asSeller(a.userId).get(`/api/menus/${a.menuId}/orders`),
      asSeller(a.userId).get(`/api/menus/${a.menuId}/prep-sheet`),
      asSeller(a.userId).get(`/api/menus/${a.menuId}/delivery-list`),
      asSeller(a.userId).get('/api/sellers/banks'),
    ];
    for (const res of await Promise.all(reads)) {
      expect(res.status).toBe(200);
      const text = JSON.stringify(res.body);
      for (const hidden of ['ACCT_', 'CLP-', 'transactionCharge', 'amountKobo', SECRET, a.reference, b.reference]) {
        expect(text, hidden).not.toContain(hidden);
      }
    }
  });

  it('a seller cannot read payment status for a customer order using only the ref and phone', async () => {
    const res = await asSeller(b.userId).get(`/api/public/orders/${a.ref}/payment-status`);
    expect(res.status).toBe(404);
    const phoneOnly = await request(app).get(`/api/public/orders/${a.ref}/payment-status?phoneLast4=${a.phone.slice(-4)}`);
    expect(phoneOnly.status).toBe(404);
  });

  it('a seller cannot use their own order key on someone else\'s order, and the other seller\'s key does not work on theirs', async () => {
    const res = await request(app).get(`/api/public/orders/${a.ref}/payment-status`).set('X-Order-Key', b.key);
    expect(res.status).toBe(404);
    const pay = await request(app).post(`/api/public/orders/${a.ref}/pay`).set('X-Order-Key', b.key);
    expect(pay.status).toBe(404);
  });

  it('a signed-in seller (or anyone) cannot trigger the webhook', async () => {
    const body = JSON.stringify({ event: 'charge.success', data: { reference: a.reference } });
    const res = await asSeller(b.userId).post('/api/webhooks/paystack').set('Content-Type', 'application/json').send(body);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_SIGNATURE');
  });

  it('only an admin sees ChopList-wide money, and the admin overview shows totals, not who paid what', async () => {
    expect((await asSeller(a.userId).get('/api/admin/overview')).status).toBe(403);
    const res = await asSeller(ADMIN).get('/api/admin/overview');
    expect(res.status).toBe(200);
    expect(res.body.payments.gmv.allTime).toBe(15_000);
    const text = JSON.stringify(res.body.payments);
    for (const hidden of ['ACCT_', 'CLP-', a.ref, a.phone, a.key]) expect(text, hidden).not.toContain(hidden);
  });
});
