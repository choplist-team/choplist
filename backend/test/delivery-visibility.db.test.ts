import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { MenuModel } from '../src/models/menu.js';
import { OrderModel } from '../src/models/order.js';
import { SellerModel } from '../src/models/seller.js';
import { findUnconfirmableOrders } from '../src/orders/audit.js';
import { hashAccessKey } from '../src/orders/delivery-code.js';
import { lagosDay } from '../src/validation/day.js';
import { connectTestDb, disconnectTestDb, testDbUri } from './helpers/db.js';
import { bearer, fakeAuth } from './helpers/fake-auth.js';

const app = createApp({
  allowedOrigins: ['http://localhost:5173'],
  auth: fakeAuth,
  rateLimits: { windowMs: 60_000, ordersPerWindow: 10_000, lookupsPerWindow: 10_000 },
});
const DAY_MS = 86_400_000;
const DAY = lagosDay(new Date(Date.now() + 3 * DAY_MS));

let sellerA: Types.ObjectId;
let menuId: string;
let jollofId: string;

const seller = () => ({
  get: (path: string) => request(app).get(path).set('Authorization', bearer('seller_a')),
  patch: (path: string) => request(app).patch(path).set('Authorization', bearer('seller_a')),
});

async function placeOverHttp(): Promise<{ ref: string; accessKey: string }> {
  const res = await request(app)
    .post('/api/public/orders')
    .send({
      menuId,
      customer: { name: 'Ada', phone: '+2348091112222' },
      delivery: { area: 'Yaba', address: '12 Herbert Macaulay Way', day: DAY },
      lines: [{ itemId: jollofId, qty: 1 }],
    });
  expect(res.status).toBe(201);
  return { ref: res.body.order.ref, accessKey: res.body.accessKey };
}

const raw = async (ref: string) => (await OrderModel.collection.findOne({ ref }))!;

describe.skipIf(!testDbUri)('the customer can see the delivery code (and the seller cannot)', () => {
  beforeAll(async () => {
    await connectTestDb('codevisible');
    const [a] = await SellerModel.create([
      {
        clerkUserId: 'seller_a',
        businessName: 'A',
        slug: 'kitchen-a',
        phone: '+2348031234567',
        payment: { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'A' },
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
      items: [{ name: 'Jollof rice', price: 3500, qtyTotal: 100, qtyRemaining: 100 }],
      areas: ['Yaba'],
      deliveryDays: [DAY],
    });
    menuId = menu._id.toString();
    jollofId = menu.items[0]!._id.toString();
  });

  it('the reported case: no key -> code null and hidden; with the key saved at checkout -> the real code', async () => {
    const { ref, accessKey } = await placeOverHttp();
    await seller().patch(`/api/orders/${ref}/paid`);
    await seller().patch(`/api/orders/${ref}/out-for-delivery`);
    const stored = (await raw(ref)).deliveryCode as string;
    expect(stored).toMatch(/^\d{6}$/);

    // What the frontend did before: no key.
    const before = await request(app).get(`/api/public/orders/${ref}?phoneLast4=2222`);
    expect(before.body.order).toMatchObject({ status: 'out_for_delivery', deliveryCode: null, deliveryCodeHidden: true });

    // What it does now: the key from the order-creation response, as X-Order-Key.
    const after = await request(app).get(`/api/public/orders/${ref}?phoneLast4=2222`).set('X-Order-Key', accessKey);
    expect(after.body.order).toMatchObject({ status: 'out_for_delivery', deliveryCode: stored, deliveryCodeHidden: false });

    // Header names are case-insensitive, whatever the browser sends.
    const lower = await request(app).get(`/api/public/orders/${ref}?phoneLast4=2222`).set('x-order-key', accessKey);
    expect(lower.body.order.deliveryCode).toBe(stored);
  });

  it('the code shows only while out for delivery: not before dispatch, not after delivery', async () => {
    const { ref, accessKey } = await placeOverHttp();
    const view = async () => (await request(app).get(`/api/public/orders/${ref}?phoneLast4=2222`).set('X-Order-Key', accessKey)).body.order;

    expect((await view()).deliveryCode).toBeNull(); // pending
    await seller().patch(`/api/orders/${ref}/paid`);
    expect((await view()).deliveryCode).toBeNull(); // paid
    await seller().patch(`/api/orders/${ref}/out-for-delivery`);
    const code = (await view()).deliveryCode as string;
    expect(code).toMatch(/^\d{6}$/); // out for delivery
    await request(app)
      .patch(`/api/orders/${ref}/confirm-delivery`)
      .set('Authorization', bearer('seller_a'))
      .send({ code });
    expect(await view()).toMatchObject({ status: 'delivered', deliveryCode: null, deliveryCodeHidden: false });
  });

  it('after the change, the seller still never sees the code, on any seller route', async () => {
    const { ref, accessKey } = await placeOverHttp();
    await seller().patch(`/api/orders/${ref}/paid`);
    await seller().patch(`/api/orders/${ref}/out-for-delivery`);
    const code = (await raw(ref)).deliveryCode as string;
    // The customer reads it (this must not make it visible anywhere else).
    await request(app).get(`/api/public/orders/${ref}?phoneLast4=2222`).set('X-Order-Key', accessKey);

    const bodies = [
      (await seller().get(`/api/menus/${menuId}/orders`)).body,
      (await seller().get(`/api/menus/${menuId}/orders?status=out_for_delivery`)).body,
      (await seller().get(`/api/menus/${menuId}/prep-sheet`)).body,
      (await seller().get(`/api/menus/${menuId}/delivery-list`)).body,
      (await seller().patch(`/api/orders/${ref}/out-for-delivery`)).body,
      (await seller().patch(`/api/orders/${ref}/reset-delivery-code`)).body,
    ];
    const code2 = (await raw(ref)).deliveryCode as string;
    for (const body of bodies) {
      const json = JSON.stringify(body);
      expect(json).not.toContain(code);
      expect(json).not.toContain(code2);
      expect(json).not.toContain('deliveryCode');
    }
    // And a seller who calls the public lookup without the customer's key gets no code.
    const asSeller = await request(app).get(`/api/public/orders/${ref}?phoneLast4=2222`).set('Authorization', bearer('seller_a'));
    expect(asSeller.body.order.deliveryCode).toBeNull();
    expect(asSeller.body.order.deliveryCodeHidden).toBe(true);
  });

  it('dispatch always stores a code: 20 orders dispatched 3 times at once, none without one', async () => {
    const refs: string[] = [];
    for (let i = 0; i < 20; i++) {
      const { ref } = await placeOverHttp();
      await seller().patch(`/api/orders/${ref}/paid`);
      refs.push(ref);
    }
    await Promise.all(refs.flatMap((ref) => [1, 2, 3].map(() => seller().patch(`/api/orders/${ref}/out-for-delivery`))));

    const all = await OrderModel.collection.find({ status: 'out_for_delivery' }).toArray();
    expect(all).toHaveLength(20);
    for (const o of all) {
      expect(o.deliveryCode).toMatch(/^\d{6}$/);
      expect(o.deliveryCodeAttempts).toBe(0);
    }
    // Repeated dispatch never replaced a code the customer might already be looking at.
    const second = await seller().patch(`/api/orders/${refs[0]}/out-for-delivery`);
    expect(second.status).toBe(200);
    expect((await raw(refs[0]!)).deliveryCode).toBe(all.find((o) => o.ref === refs[0])!.deliveryCode);
    // And nothing is out for delivery without a code.
    expect(await findUnconfirmableOrders()).toEqual([]);
  });

  describe('audit: orders that cannot show or accept a code', () => {
    it('reports an order with no code and an order with a code but no key, by reference only', async () => {
      const healthy = await placeOverHttp();
      await seller().patch(`/api/orders/${healthy.ref}/paid`);
      await seller().patch(`/api/orders/${healthy.ref}/out-for-delivery`);

      const noCode = await placeOverHttp();
      await seller().patch(`/api/orders/${noCode.ref}/paid`);
      await seller().patch(`/api/orders/${noCode.ref}/out-for-delivery`);
      await OrderModel.collection.updateOne({ ref: noCode.ref }, { $unset: { deliveryCode: '' } });

      const noKey = await placeOverHttp();
      await seller().patch(`/api/orders/${noKey.ref}/paid`);
      await seller().patch(`/api/orders/${noKey.ref}/out-for-delivery`);
      await OrderModel.collection.updateOne({ ref: noKey.ref }, { $unset: { accessKeyHash: '' } });

      // Not out for delivery: never reported, even without a key.
      const paidOnly = await placeOverHttp();
      await seller().patch(`/api/orders/${paidOnly.ref}/paid`);
      await OrderModel.collection.updateOne({ ref: paidOnly.ref }, { $unset: { accessKeyHash: '' } });

      const found = await findUnconfirmableOrders();
      expect(found).toEqual(
        expect.arrayContaining([
          { ref: noCode.ref, problem: 'no-code' },
          { ref: noKey.ref, problem: 'no-key' },
        ]),
      );
      expect(found).toHaveLength(2);

      // References only: no code, no key hash anywhere in the output.
      const json = JSON.stringify(found);
      expect(json).not.toContain(((await raw(healthy.ref)).deliveryCode as string));
      expect(json).not.toContain(hashAccessKey(healthy.accessKey));
    });

    it('is read-only: running it twice changes nothing', async () => {
      const { ref } = await placeOverHttp();
      await seller().patch(`/api/orders/${ref}/paid`);
      await seller().patch(`/api/orders/${ref}/out-for-delivery`);
      await OrderModel.collection.updateOne({ ref }, { $unset: { accessKeyHash: '' } });
      const before = JSON.stringify(await raw(ref));
      await findUnconfirmableOrders();
      await findUnconfirmableOrders();
      expect(JSON.stringify(await raw(ref))).toBe(before);
    });
  });
});
