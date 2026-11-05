import { createHmac } from 'node:crypto';
import type { Express } from 'express';
import type { Types } from 'mongoose';
import request from 'supertest';
import { MenuModel } from '../../src/models/menu.js';
import { OrderModel } from '../../src/models/order.js';
import { PaymentModel } from '../../src/models/payment.js';
import { SellerModel } from '../../src/models/seller.js';
import { lagosDay } from '../../src/validation/day.js';
import { bearer } from './fake-auth.js';
import type { fakePaystack } from './fake-paystack.js';

// Obviously fake. The real key is never needed or used by any test.
export const SECRET = 'sk_test_not_a_real_key_for_tests';
export const ADMIN = 'user_admin1';
export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
export const LIMITS = { windowMs: 60_000, ordersPerWindow: 10_000, lookupsPerWindow: 10_000, paymentsPerWindow: 10_000, reportsPerWindow: 10_000, statusPerWindow: 10_000 };
const DAY = lagosDay(new Date(Date.now() + 3 * DAY_MS));

let counter = 0;
export async function makeSeller(overrides: Record<string, unknown> = {}) {
  counter += 1;
  return SellerModel.create({
    clerkUserId: `user_flow${counter}`,
    businessName: `Flow Kitchen ${counter}`,
    slug: `flow-kitchen-${counter}`,
    phone: '+2348031234567',
    payment: { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Owner', bankCode: '058' },
    paymentsReady: true,
    paystackSubaccountCode: `ACCT_flow${counter}`,
    ...overrides,
  });
}

export const makeMenu = (sellerId: Types.ObjectId) =>
  MenuModel.create({
    sellerId, title: 'Week menu', status: 'open', openedAt: new Date(), cutoffAt: new Date(Date.now() + 2 * DAY_MS),
    areas: ['Yaba'], deliveryDays: [DAY], items: [{ name: 'Jollof rice', price: 3750, qtyTotal: 20, qtyRemaining: 20 }],
  });

export type Placed = { id: Types.ObjectId; ref: string; key: string; sellerClerk: string; sellerId: Types.ObjectId; menuId: Types.ObjectId };

// Places an order through the real route (2 x 3,750 = 7,500 by default).
export async function placeOrder(
  app: Express,
  seller: Awaited<ReturnType<typeof makeSeller>>,
  menu: Awaited<ReturnType<typeof makeMenu>>,
  qty = 2,
): Promise<Placed> {
  const res = await request(app).post('/api/public/orders').send({
    menuId: menu._id.toString(),
    customer: { name: 'Ada Obi', phone: '0809 111 2222' },
    delivery: { area: 'yaba', address: '12 Herbert Macaulay Way, Yaba', day: DAY },
    lines: [{ itemId: menu.items[0]!._id.toString(), qty }],
  });
  if (res.status !== 201) throw new Error(`order failed: ${res.status} ${JSON.stringify(res.body)}`);
  const order = (await OrderModel.findOne({ ref: res.body.order.ref }))!;
  return { id: order._id, ref: order.ref, key: res.body.accessKey, sellerClerk: seller.clerkUserId, sellerId: seller._id, menuId: menu._id };
}

export const asSeller = (o: { sellerClerk: string }) => ({ Authorization: bearer(o.sellerClerk) });
export const asAdmin = { Authorization: bearer(ADMIN) };

export async function startOnline(app: Express, o: Placed): Promise<string> {
  const res = await request(app).post(`/api/public/orders/${o.ref}/pay`).set('X-Order-Key', o.key);
  if (res.status !== 200) throw new Error(`pay failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.reference as string;
}

// Paystack reports `status` for any reference, with exactly the amount we asked for
// (or `amountKobo` to simulate a wrong one). Works for orders and subscriptions.
export function paystackSays(paystack: ReturnType<typeof fakePaystack>, status: string, amountKobo?: number) {
  paystack.verifyTransaction.mockImplementation(async (reference) => {
    const payment = await PaymentModel.findOne({ reference });
    const asked = payment?.amountKobo ?? 0;
    return { status, reference, amountKobo: amountKobo ?? asked, currency: 'NGN' };
  });
}

const sign = (body: string) => createHmac('sha512', SECRET).update(body).digest('hex');
export function deliverWebhook(app: Express, reference: string) {
  const body = JSON.stringify({ event: 'charge.success', data: { reference } });
  return request(app).post('/api/webhooks/paystack').set('Content-Type', 'application/json').set('x-paystack-signature', sign(body)).send(body);
}

export const cancelAsSeller = (app: Express, o: Placed) => request(app).patch(`/api/orders/${o.ref}/cancel`).set(asSeller(o));
export const customerStatus = (app: Express, o: Placed) => request(app).get(`/api/public/orders/${o.ref}/payment-status`).set('X-Order-Key', o.key);

// A Paystack-paid order: placed, paid online, confirmed by the (fake) Paystack webhook.
export async function paidOnline(app: Express, paystack: ReturnType<typeof fakePaystack>, o: Placed): Promise<string> {
  const reference = await startOnline(app, o);
  paystackSays(paystack, 'success');
  await deliverWebhook(app, reference).expect(200);
  return reference;
}

// Moves a document's createdAt into the past without Mongoose's timestamps getting in
// the way, so tests can age an order or a payment.
export async function backdate(model: 'order' | 'payment' | 'subscription', id: Types.ObjectId, ms: number) {
  const when = new Date(Date.now() - ms);
  const collection =
    model === 'order'
      ? OrderModel.collection
      : model === 'payment'
        ? PaymentModel.collection
        : (await import('../../src/models/subscription.js')).SubscriptionModel.collection;
  await collection.updateOne({ _id: id }, { $set: { createdAt: when } });
}
