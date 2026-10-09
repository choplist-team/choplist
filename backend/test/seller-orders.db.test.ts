import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { MenuModel } from '../src/models/menu.js';
import { OrderModel } from '../src/models/order.js';
import { SellerModel } from '../src/models/seller.js';
import { placeOrder } from '../src/orders/place-order.js';
import { lagosDay } from '../src/validation/day.js';
import { connectTestDb, disconnectTestDb, testDbUri } from './helpers/db.js';
import { bearer, fakeAuth } from './helpers/fake-auth.js';

const app = createApp({ allowedOrigins: ['http://localhost:5173'], auth: fakeAuth });
const DAY_MS = 86_400_000;
const DAY = lagosDay(new Date(Date.now() + 3 * DAY_MS));

const as = (userId: string) => ({
  get: (path: string) => request(app).get(path).set('Authorization', bearer(userId)),
  patch: (path: string) => request(app).patch(path).set('Authorization', bearer(userId)),
});

let sellerA: Types.ObjectId;
let menuId: string;
let jollofId: string;

async function jollofLeft(): Promise<number> {
  const menu = await MenuModel.findById(menuId).lean();
  return menu!.items[0]!.qtyRemaining;
}

async function newOrder(qty: number, name = 'Ada'): Promise<string> {
  const order = await placeOrder({
    menuId,
    customer: { name, phone: '+2348091112222' },
    delivery: { area: 'Yaba', address: '12 Herbert Macaulay Way', day: DAY },
    lines: [{ itemId: jollofId, qty }],
  });
  return order.ref;
}

describe.skipIf(!testDbUri)('seller order actions on a real MongoDB', () => {
  beforeAll(async () => {
    await connectTestDb('sellerorders');
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

  describe('GET /api/menus/:id/orders', () => {
    it('lists my orders for the menu, newest first, with phone and address', async () => {
      const first = await newOrder(1, 'First');
      const second = await newOrder(2, 'Second');
      const res = await as('seller_a').get(`/api/menus/${menuId}/orders`);
      expect(res.status).toBe(200);
      expect(res.body.orders.map((o: { ref: string }) => o.ref)).toEqual([second, first]);
      expect(res.body.orders[0]).toMatchObject({
        status: 'pending',
        customer: { name: 'Second', phone: '+2348091112222' },
        delivery: { area: 'Yaba', address: '12 Herbert Macaulay Way', day: DAY },
        total: 7000,
        paidAt: null,
      });
    });

    it('filters by status', async () => {
      const paid = await newOrder(1);
      await newOrder(1);
      await as('seller_a').patch(`/api/orders/${paid}/paid`);
      const res = await as('seller_a').get(`/api/menus/${menuId}/orders?status=paid`);
      expect(res.body.orders.map((o: { ref: string }) => o.ref)).toEqual([paid]);
      expect((await as('seller_a').get(`/api/menus/${menuId}/orders?status=bogus`)).status).toBe(400);
    });

    it("another seller's menu is 404, not an empty list", async () => {
      await newOrder(1);
      const res = await as('seller_b').get(`/api/menus/${menuId}/orders`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('MENU_NOT_FOUND');
    });
  });

  describe('PATCH /api/orders/:ref/paid', () => {
    it('marks paid; repeating it changes nothing (same paidAt)', async () => {
      const ref = await newOrder(1);
      const first = await as('seller_a').patch(`/api/orders/${ref}/paid`);
      expect(first.status).toBe(200);
      expect(first.body.status).toBe('paid');
      expect(first.body.paidAt).not.toBeNull();

      const again = await as('seller_a').patch(`/api/orders/${ref.toLowerCase()}/paid`);
      expect(again.status).toBe(200);
      expect(again.body.paidAt).toBe(first.body.paidAt);
    });

    it('a cancelled order cannot be marked paid (409 ORDER_CANCELLED)', async () => {
      const ref = await newOrder(1);
      await as('seller_a').patch(`/api/orders/${ref}/cancel`);
      const res = await as('seller_a').patch(`/api/orders/${ref}/paid`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ORDER_CANCELLED');
    });
  });

  describe('PATCH /api/orders/:ref/cancel', () => {
    it('cancels and puts the portions back on sale', async () => {
      const ref = await newOrder(3);
      expect(await jollofLeft()).toBe(7);
      const res = await as('seller_a').patch(`/api/orders/${ref}/cancel`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('cancelled');
      expect(res.body.cancelledAt).not.toBeNull();
      expect(await jollofLeft()).toBe(10);
    });

    it('cancelling twice returns the stock once', async () => {
      const ref = await newOrder(3);
      await as('seller_a').patch(`/api/orders/${ref}/cancel`);
      const again = await as('seller_a').patch(`/api/orders/${ref}/cancel`);
      expect(again.status).toBe(200);
      expect(again.body.status).toBe('cancelled');
      expect(await jollofLeft()).toBe(10); // not 13
    });

    it('10 cancels at the same moment return the stock exactly once', async () => {
      const ref = await newOrder(3);
      const results = await Promise.all(Array.from({ length: 10 }, () => as('seller_a').patch(`/api/orders/${ref}/cancel`)));
      expect(results.every((r) => r.status === 200 && r.body.status === 'cancelled')).toBe(true);
      expect(await jollofLeft()).toBe(10);
    });

    it('a paid order can be cancelled (seller refunds by hand) and its stock returns', async () => {
      const ref = await newOrder(2);
      await as('seller_a').patch(`/api/orders/${ref}/paid`);
      const res = await as('seller_a').patch(`/api/orders/${ref}/cancel`);
      expect(res.body.status).toBe('cancelled');
      expect(await jollofLeft()).toBe(10);
    });

    it('stock returns even after the menu has closed', async () => {
      const ref = await newOrder(2);
      await MenuModel.updateOne({ _id: menuId }, { $set: { status: 'closed', closedAt: new Date() } });
      await as('seller_a').patch(`/api/orders/${ref}/cancel`);
      expect(await jollofLeft()).toBe(10);
    });
  });

  it("isolation: another seller cannot see, pay or cancel my orders", async () => {
    const ref = await newOrder(2);
    for (const action of ['paid', 'cancel']) {
      const res = await as('seller_b').patch(`/api/orders/${ref}/${action}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('ORDER_NOT_FOUND');
    }
    const order = await OrderModel.findOne({ ref }).lean();
    expect(order!.status).toBe('pending');
    expect(await jollofLeft()).toBe(8);
  });

  it('an unknown or malformed ref is 404', async () => {
    expect((await as('seller_a').patch('/api/orders/CL-ZZZZZ/paid')).status).toBe(404);
    expect((await as('seller_a').patch('/api/orders/nonsense/cancel')).status).toBe(404);
  });

  it('needs a signed-in seller', async () => {
    const ref = await newOrder(1);
    expect((await request(app).patch(`/api/orders/${ref}/paid`)).status).toBe(401);
    expect((await as('no_profile').patch(`/api/orders/${ref}/cancel`)).status).toBe(403);
  });
});
