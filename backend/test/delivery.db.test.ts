import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { MenuModel } from '../src/models/menu.js';
import { OrderModel } from '../src/models/order.js';
import { SellerModel } from '../src/models/seller.js';
import { MAX_CODE_ATTEMPTS } from '../src/orders/delivery.js';
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

async function jollofLeft(): Promise<number> {
  const menu = await MenuModel.findById(menuId).lean();
  return menu!.items[0]!.qtyRemaining;
}

async function newOrder(qty = 1): Promise<string> {
  const order = await placeOrder({
    menuId,
    customer: { name: 'Ada', phone: PHONE },
    delivery: { area: 'Yaba', address: '12 Herbert Macaulay Way', day: DAY },
    lines: [{ itemId: jollofId, qty }],
  });
  return order.ref;
}

async function outForDelivery(): Promise<{ ref: string; code: string }> {
  const ref = await newOrder();
  await as('seller_a').patch(`/api/orders/${ref}/paid`);
  await as('seller_a').patch(`/api/orders/${ref}/out-for-delivery`);
  return { ref, code: await realCode(ref) };
}

async function realCode(ref: string): Promise<string> {
  const order = await OrderModel.findOne({ ref }).select('+deliveryCode').lean();
  return order!.deliveryCode!;
}

function wrongCodeFor(code: string): string {
  return code === '123456' ? '654321' : '123456';
}

describe.skipIf(!testDbUri)('delivery confirmation on a real MongoDB', () => {
  beforeAll(async () => {
    await connectTestDb('delivery');
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

  describe('PATCH /api/orders/:ref/out-for-delivery', () => {
    it('a pending order cannot go out for delivery (409 ORDER_NOT_PAID)', async () => {
      const ref = await newOrder();
      const res = await as('seller_a').patch(`/api/orders/${ref}/out-for-delivery`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ORDER_NOT_PAID');
    });

    it('a cancelled order cannot go out for delivery (409 ORDER_CANCELLED)', async () => {
      const ref = await newOrder();
      await as('seller_a').patch(`/api/orders/${ref}/cancel`);
      const res = await as('seller_a').patch(`/api/orders/${ref}/out-for-delivery`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ORDER_CANCELLED');
    });

    it('a paid order goes out; the seller never sees the code', async () => {
      const ref = await newOrder();
      await as('seller_a').patch(`/api/orders/${ref}/paid`);
      const res = await as('seller_a').patch(`/api/orders/${ref}/out-for-delivery`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('out_for_delivery');
      expect(res.body.outForDeliveryAt).not.toBeNull();
      expect(JSON.stringify(res.body)).not.toContain(await realCode(ref));
      expect(res.body).not.toHaveProperty('deliveryCode');
      expect(await realCode(ref)).toMatch(/^\d{6}$/);
    });

    it('repeating it keeps the same code (idempotent)', async () => {
      const { ref, code } = await outForDelivery();
      const again = await as('seller_a').patch(`/api/orders/${ref}/out-for-delivery`);
      expect(again.status).toBe(200);
      expect(again.body.status).toBe('out_for_delivery');
      expect(await realCode(ref)).toBe(code);
    });

    it('10 taps at the same moment still make exactly one code', async () => {
      const ref = await newOrder();
      await as('seller_a').patch(`/api/orders/${ref}/paid`);
      const results = await Promise.all(
        Array.from({ length: 10 }, () => as('seller_a').patch(`/api/orders/${ref}/out-for-delivery`)),
      );
      expect(results.every((r) => r.status === 200 && r.body.status === 'out_for_delivery')).toBe(true);
      const code = await realCode(ref);
      expect(code).toMatch(/^\d{6}$/);
      await as('seller_a').patch(`/api/orders/${ref}/out-for-delivery`);
      expect(await realCode(ref)).toBe(code);
    });

    it('marking paid again after it is out for delivery changes nothing', async () => {
      const { ref } = await outForDelivery();
      const res = await as('seller_a').patch(`/api/orders/${ref}/paid`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('out_for_delivery');
    });

    it('an out-for-delivery order can no longer be cancelled, and its stock stays taken', async () => {
      const { ref } = await outForDelivery();
      const stockBefore = await jollofLeft();
      const res = await as('seller_a').patch(`/api/orders/${ref}/cancel`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('out_for_delivery');
      expect(await jollofLeft()).toBe(stockBefore);
    });
  });

  describe('what the customer sees', () => {
    it('shows no code before delivery starts', async () => {
      const ref = await newOrder();
      await as('seller_a').patch(`/api/orders/${ref}/paid`);
      const res = await customerView(ref);
      expect(res.status).toBe(200);
      expect(res.body.order.deliveryCode).toBeNull();
    });

    it('shows the code while the order is out for delivery', async () => {
      const { ref, code } = await outForDelivery();
      const res = await customerView(ref);
      expect(res.status).toBe(200);
      expect(res.body.order.status).toBe('out_for_delivery');
      expect(res.body.order.deliveryCode).toBe(code);
    });

    it('a wrong phone gets the same 404 and never the code', async () => {
      const { ref, code } = await outForDelivery();
      const res = await request(app).get(`/api/public/orders/${ref}?phoneLast4=9999`);
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain(code);
    });

    it('hides the code again once delivered', async () => {
      const { ref, code } = await outForDelivery();
      await as('seller_a').confirm(ref, code);
      const res = await customerView(ref);
      expect(res.body.order.status).toBe('delivered');
      expect(res.body.order.deliveryCode).toBeNull();
    });

    it('placing an order never returns a code', async () => {
      const res = await request(app)
        .post('/api/public/orders')
        .send({
          menuId,
          customer: { name: 'Ada', phone: PHONE },
          delivery: { area: 'Yaba', address: '12 Herbert Macaulay Way', day: DAY },
          lines: [{ itemId: jollofId, qty: 1 }],
        });
      expect(res.status).toBe(201);
      expect(res.body.order.deliveryCode).toBeNull();
    });
  });

  describe('PATCH /api/orders/:ref/confirm-delivery', () => {
    it('the right code marks it delivered and removes the code', async () => {
      const { ref, code } = await outForDelivery();
      const res = await as('seller_a').confirm(ref, code);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('delivered');
      expect(res.body.deliveredAt).not.toBeNull();
      expect(await realCode(ref)).toBeUndefined();
    });

    it('confirming a delivered order again is harmless', async () => {
      const { ref, code } = await outForDelivery();
      const first = await as('seller_a').confirm(ref, code);
      const again = await as('seller_a').confirm(ref, code);
      expect(again.status).toBe(200);
      expect(again.body.status).toBe('delivered');
      expect(again.body.deliveredAt).toBe(first.body.deliveredAt);
    });

    it('a wrong code is 400 WRONG_DELIVERY_CODE and says how many tries are left', async () => {
      const { ref, code } = await outForDelivery();
      const res = await as('seller_a').confirm(ref, wrongCodeFor(code));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('WRONG_DELIVERY_CODE');
      expect(res.body.error.message).toContain(`${MAX_CODE_ATTEMPTS - 1} tries left`);
      const order = await OrderModel.findOne({ ref }).lean();
      expect(order!.status).toBe('out_for_delivery');
    });

    it('after the allowed wrong tries the order locks, even for the right code', async () => {
      const { ref, code } = await outForDelivery();
      const wrong = wrongCodeFor(code);
      for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) {
        const res = await as('seller_a').confirm(ref, wrong);
        expect(res.status).toBe(400);
      }
      const locked = await as('seller_a').confirm(ref, wrong);
      expect(locked.status).toBe(429);
      expect(locked.body.error.code).toBe('DELIVERY_CODE_LOCKED');

      const rightCode = await as('seller_a').confirm(ref, code);
      expect(rightCode.status).toBe(429);
      expect(rightCode.body.error.code).toBe('DELIVERY_CODE_LOCKED');
      const order = await OrderModel.findOne({ ref }).lean();
      expect(order!.status).toBe('out_for_delivery');
    });

    it('20 wrong guesses at the same moment use at most the allowed attempts', async () => {
      const { ref, code } = await outForDelivery();
      const wrong = wrongCodeFor(code);
      const results = await Promise.all(Array.from({ length: 20 }, () => as('seller_a').confirm(ref, wrong)));
      expect(results.filter((r) => r.status === 400)).toHaveLength(MAX_CODE_ATTEMPTS);
      expect(results.filter((r) => r.status === 429)).toHaveLength(20 - MAX_CODE_ATTEMPTS);
      const order = await OrderModel.findOne({ ref }).lean();
      expect(order!.codeAttempts).toBe(MAX_CODE_ATTEMPTS);
    });

    it('a paid order that is not out for delivery is 409 NOT_OUT_FOR_DELIVERY', async () => {
      const ref = await newOrder();
      await as('seller_a').patch(`/api/orders/${ref}/paid`);
      const res = await as('seller_a').confirm(ref, '123456');
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('NOT_OUT_FOR_DELIVERY');
    });

    it('a code that is not 6 digits is 400 VALIDATION_ERROR and costs no attempt', async () => {
      const { ref } = await outForDelivery();
      for (const bad of ['12345', '1234567', 'abcdef', '', 123456, undefined]) {
        const res = await as('seller_a').confirm(ref, bad);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
      const order = await OrderModel.findOne({ ref }).lean();
      expect(order!.codeAttempts).toBe(0);
    });

    it('isolation: another seller cannot confirm or start my delivery', async () => {
      const { ref, code } = await outForDelivery();
      const confirm = await as('seller_b').confirm(ref, code);
      expect(confirm.status).toBe(404);
      expect(confirm.body.error.code).toBe('ORDER_NOT_FOUND');

      const other = await newOrder();
      await as('seller_a').patch(`/api/orders/${other}/paid`);
      const start = await as('seller_b').patch(`/api/orders/${other}/out-for-delivery`);
      expect(start.status).toBe(404);

      const order = await OrderModel.findOne({ ref }).lean();
      expect(order!.status).toBe('out_for_delivery');
    });

    it('needs a signed-in seller', async () => {
      const { ref, code } = await outForDelivery();
      const anon = await request(app).patch(`/api/orders/${ref}/confirm-delivery`).send({ code });
      expect(anon.status).toBe(401);
      expect((await as('no_profile').confirm(ref, code)).status).toBe(403);
    });
  });
});
