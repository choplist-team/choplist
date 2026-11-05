import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { DEFAULT_PLATFORM_FEE_BPS } from '../src/config.js';
import { OrderModel } from '../src/models/order.js';
import { PaymentModel } from '../src/models/payment.js';
import { SellerModel } from '../src/models/seller.js';
import { generateAccessKey, hashAccessKey } from '../src/orders/delivery-code.js';
import { generateRef } from '../src/orders/reference.js';
import { connectTestDb, disconnectTestDb, testDbUri } from './helpers/db.js';
import { fakeAuth } from './helpers/fake-auth.js';
import { fakePaystack } from './helpers/fake-paystack.js';

const LIMITS = { windowMs: 60_000, ordersPerWindow: 10_000, lookupsPerWindow: 10_000, paymentsPerWindow: 10_000 };

let paystack = fakePaystack();
// No `pricing` option: the app uses its built-in default, which is what a deployment
// with PLATFORM_FEE_BPS unset gets.
const buildDefaultApp = () => createApp({ allowedOrigins: ['http://localhost:5173'], auth: fakeAuth, paystack, rateLimits: LIMITS });
let app = buildDefaultApp();

let n = 0;
async function sellerWith(paidOrderCount: number, feeMode: 'customer' | 'seller') {
  n += 1;
  return SellerModel.create({
    clerkUserId: `user_p${n}`, businessName: `Kitchen ${n}`, slug: `kitchen-p${n}`, phone: '+2348031234567',
    payment: { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Owner', bankCode: '058' },
    paymentsReady: true, paystackSubaccountCode: `ACCT_p${n}`, paidOrderCount, feeMode,
  });
}

async function orderFor(sellerId: Types.ObjectId, total = 7500) {
  const key = generateAccessKey();
  const ref = generateRef();
  await OrderModel.create({
    ref, sellerId, menuId: new Types.ObjectId(),
    customer: { name: 'Ada Customer', phone: '+2348091112222' },
    delivery: { area: 'Yaba', address: '12 Herbert Macaulay Way', day: '2026-10-17' },
    lines: [{ itemId: new Types.ObjectId(), name: 'Jollof rice', unitPrice: total, qty: 1 }],
    total, accessKeyHash: hashAccessKey(key),
  });
  return { ref, key };
}

describe('the per-order platform fee is off by default', () => {
  it('the default is 0 basis points', () => {
    expect(DEFAULT_PLATFORM_FEE_BPS).toBe(0);
  });
});

describe.skipIf(!testDbUri)('paying an order with the platform fee off', () => {
  beforeAll(async () => {
    await connectTestDb('platform_fee_off');
  });
  afterAll(disconnectTestDb);
  beforeEach(() => {
    paystack = fakePaystack();
    app = buildDefaultApp();
  });

  it('charges no ChopList fee even past the old 50 free orders; the customer still covers Paystack\'s fee', async () => {
    // 60 paid orders: under the old rules this seller would be on the 3% tier.
    const seller = await sellerWith(60, 'customer');
    const { ref, key } = await orderFor(seller._id);
    const res = await request(app).post(`/api/public/orders/${ref}/pay`).set('X-Order-Key', key);

    expect(res.status).toBe(200);
    // The same total a brand-new seller pays: Paystack's cost passed on, nothing more.
    expect(res.body).toMatchObject({ serviceFee: 216, total: 7716 });

    const order = await OrderModel.findOne({ ref });
    expect(order).toMatchObject({ serviceFee: 216, platformFeeBps: 0, platformFeeKobo: 0 });
    const payment = await PaymentModel.findOne({ orderId: order!._id });
    expect(payment).toMatchObject({ amountKobo: 771_600, platformFeeKobo: 0, platformFeeBps: 0, bearer: 'account' });

    // The pass-through to Paystack is exactly as before.
    expect(paystack.initializeTransaction.mock.calls[0]![0]).toMatchObject({
      amountKobo: 771_600, subaccountCode: seller.paystackSubaccountCode, transactionChargeKobo: 21_600, bearer: 'account',
    });
  });

  it('seller-pays mode: the customer pays the order total, ChopList takes nothing, Paystack\'s fee comes from the seller', async () => {
    const seller = await sellerWith(60, 'seller');
    const { ref, key } = await orderFor(seller._id);
    const res = await request(app).post(`/api/public/orders/${ref}/pay`).set('X-Order-Key', key);

    expect(res.body).toMatchObject({ serviceFee: 0, total: 7500 });
    const sent = paystack.initializeTransaction.mock.calls[0]![0];
    expect(sent).toMatchObject({ amountKobo: 750_000, transactionChargeKobo: 0, bearer: 'subaccount' });
    expect(await OrderModel.findOne({ ref })).toMatchObject({ platformFeeKobo: 0, platformFeeBps: 0 });
  });

  it('the tier code still works when someone switches the fee back on', async () => {
    const on = createApp({ allowedOrigins: ['http://localhost:5173'], auth: fakeAuth, paystack, rateLimits: LIMITS, pricing: { freeOrders: 50, platformFeeBps: 300 } });
    const seller = await sellerWith(60, 'customer');
    const { ref, key } = await orderFor(seller._id);
    const res = await request(on).post(`/api/public/orders/${ref}/pay`).set('X-Order-Key', key);
    expect(res.body).toMatchObject({ serviceFee: 445, total: 7945 });
    expect(await OrderModel.findOne({ ref })).toMatchObject({ platformFeeBps: 300, platformFeeKobo: 22_500 });
  });
});
