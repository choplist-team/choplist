import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { MenuModel } from '../src/models/menu.js';
import { OrderModel } from '../src/models/order.js';
import { SellerModel } from '../src/models/seller.js';
import { MAX_CODE_ATTEMPTS, MAX_CODE_RESETS } from '../src/orders/delivery.js';
import { placeOrder } from '../src/orders/place-order.js';
import { lagosDay } from '../src/validation/day.js';
import { connectTestDb, disconnectTestDb, testDbUri } from './helpers/db.js';
import { bearer, fakeAuth } from './helpers/fake-auth.js';

const app = createApp({ allowedOrigins: ['http://localhost:5173'], auth: fakeAuth });
const DAY_MS = 86_400_000;
const DAY = lagosDay(new Date(Date.now() + 3 * DAY_MS));
const PHONE = '+2348091112222';

const as = (userId: string) => ({
  patch: (path: string) => request(app).patch(path).set('Authorization', bearer(userId)),
  reset: (ref: string) =>
    request(app).patch(`/api/orders/${ref}/reset-delivery-code`).set('Authorization', bearer(userId)),
  confirm: (ref: string, code: unknown) =>
    request(app)
      .patch(`/api/orders/${ref}/confirm-delivery`)
      .set('Authorization', bearer(userId))
      .send({ code }),
});

const customerView = (ref: string) => request(app).get(`/api/public/orders/${ref}?phoneLast4=2222`);

let sellerA: Types.ObjectId;
let menuId: string;
let jollofId: string;

async function newOrder(): Promise<string> {
  const order = await placeOrder({
    menuId,
    customer: { name: 'Ada', phone: PHONE },
    delivery: { area: 'Yaba', address: '12 Herbert Macaulay Way', day: DAY },
    lines: [{ itemId: jollofId, qty: 1 }],
  });
  return order.ref;
}

async function realCode(ref: string): Promise<string> {
  const order = await OrderModel.findOne({ ref }).select('+deliveryCode').lean();
  return order!.deliveryCode!;
}

async function outForDelivery(): Promise<{ ref: string; code: string }> {
  const ref = await newOrder();
  await as('seller_a').patch(`/api/orders/${ref}/paid`);
  await as('seller_a').patch(`/api/orders/${ref}/out-for-delivery`);
  return { ref, code: await realCode(ref) };
}

function wrongCodeFor(code: string): string {
  return code === '123456' ? '654321' : '123456';
}

describe.skipIf(!testDbUri)('delivery code reset on a real MongoDB', () => {
  beforeAll(async () => {
    await connectTestDb('deliveryreset');
    const [a] = await SellerModel.create([
      {
        clerkUserId: 'seller_a',
        businessName: 'A',
        slug: 'kitchen-a',
        phone: '+2348031234567',
        payment: { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'A' },
      },
      {
        clerkUserId: 'seller_b',
        businessName: 'B',
        slug: 'kitchen-b',
        phone: '+2348031234568',
        payment: { bankName: 'GTBank', accountNumber: '0123456780', accountName: 'B' },
      },
    ]);
    sellerA = a!._id;
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  beforeEach(async () => {
    await Promise.all([MenuModel.deleteMany({}), OrderModel.deleteMany({})]);
    const menu = await MenuModel.create({
      sellerId: sellerA,
      title: 'Week',
      status: 'open',
      openedAt: new Date(),
      cutoffAt: new Date(Date.now() + 2 * DAY_MS),
      items: [{ name: 'Jollof rice', price: 3500, qtyTotal: 10, qtyRemaining: 10 }],
      areas: ['Yaba'],
      deliveryDays: [DAY],
    });
    menuId = menu._id.toString();
    jollofId = menu.items[0]!._id.toString();
  });

  describe('PATCH /api/orders/:ref/reset-delivery-code', () => {
    it('makes a new 6-digit code, never shows it to the seller, and the customer sees it', async () => {
      const { ref } = await outForDelivery();
      const res = await as('seller_a').reset(ref);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('out_for_delivery');
      expect(res.body).not.toHaveProperty('deliveryCode');

      const fresh = await realCode(ref);
      expect(fresh).toMatch(/^\d{6}$/);
      expect(JSON.stringify(res.body)).not.toContain(fresh);

      const view = await customerView(ref);
      expect(view.body.order.deliveryCode).toBe(fresh);
    });

    it('frees a locked order: the new code can then confirm delivery', async () => {
      const { ref, code } = await outForDelivery();
      for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) {
        await as('seller_a').confirm(ref, wrongCodeFor(code));
      }
      const locked = await as('seller_a').confirm(ref, code);
      expect(locked.status).toBe(429);

      const reset = await as('seller_a').reset(ref);
      expect(reset.status).toBe(200);
      const order = await OrderModel.findOne({ ref }).lean();
      expect(order!.codeAttempts).toBe(0);

      const done = await as('seller_a').confirm(ref, await realCode(ref));
      expect(done.status).toBe(200);
      expect(done.body.status).toBe('delivered');
    });

    it('allows the limited number of resets, then 409 DELIVERY_RESET_LIMIT', async () => {
      const { ref } = await outForDelivery();
      for (let i = 0; i < MAX_CODE_RESETS; i++) {
        expect((await as('seller_a').reset(ref)).status).toBe(200);
      }
      const over = await as('seller_a').reset(ref);
      expect(over.status).toBe(409);
      expect(over.body.error.code).toBe('DELIVERY_RESET_LIMIT');
      const order = await OrderModel.findOne({ ref }).lean();
      expect(order!.codeResets).toBe(MAX_CODE_RESETS);
    });

    it('10 resets at the same moment use at most the allowed resets', async () => {
      const { ref } = await outForDelivery();
      const results = await Promise.all(Array.from({ length: 10 }, () => as('seller_a').reset(ref)));
      expect(results.filter((r) => r.status === 200)).toHaveLength(MAX_CODE_RESETS);
      expect(results.filter((r) => r.status === 409)).toHaveLength(10 - MAX_CODE_RESETS);
      const order = await OrderModel.findOne({ ref }).lean();
      expect(order!.codeResets).toBe(MAX_CODE_RESETS);
    });

    it('a paid order that is not out for delivery is 409 NOT_OUT_FOR_DELIVERY', async () => {
      const ref = await newOrder();
      await as('seller_a').patch(`/api/orders/${ref}/paid`);
      const res = await as('seller_a').reset(ref);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('NOT_OUT_FOR_DELIVERY');
    });

    it('a delivered order cannot be reset', async () => {
      const { ref, code } = await outForDelivery();
      await as('seller_a').confirm(ref, code);
      const res = await as('seller_a').reset(ref);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('NOT_OUT_FOR_DELIVERY');
    });

    it('isolation: another seller cannot reset my order', async () => {
      const { ref, code } = await outForDelivery();
      const res = await as('seller_b').reset(ref);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('ORDER_NOT_FOUND');
      expect(await realCode(ref)).toBe(code);
    });

    it('needs a signed-in seller', async () => {
      const { ref } = await outForDelivery();
      const anon = await request(app).patch(`/api/orders/${ref}/reset-delivery-code`);
      expect(anon.status).toBe(401);
      expect((await as('no_profile').reset(ref)).status).toBe(403);
    });
  });
});
