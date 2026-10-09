import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { MenuModel } from '../src/models/menu.js';
import { OrderModel } from '../src/models/order.js';
import { SellerModel } from '../src/models/seller.js';
import { placeOrder } from '../src/orders/place-order.js';
import { lagosDay } from '../src/validation/day.js';
import { connectTestDb, disconnectTestDb, testDbUri } from './helpers/db.js';
import { bearer, fakeAuth } from './helpers/fake-auth.js';

// The documented known limits, shown exactly: when giving stock back fails,
// what is logged and what state is left. The database "failing" is simulated
// by making one MenuModel.updateOne call reject.

const app = createApp({ allowedOrigins: ['http://localhost:5173'], auth: fakeAuth });
const DAY_MS = 86_400_000;
const DAY = lagosDay(new Date(Date.now() + 3 * DAY_MS));

let sellerId: Types.ObjectId;

async function openMenu(qty: number) {
  // One open menu per seller (the index from the models step): start fresh.
  await Promise.all([MenuModel.deleteMany({}), OrderModel.deleteMany({})]);
  const menu = await MenuModel.create({
    sellerId,
    title: 'Week',
    status: 'open',
    cutoffAt: new Date(Date.now() + 2 * DAY_MS),
    items: [{ name: 'Jollof', price: 2000, qtyTotal: qty, qtyRemaining: qty }],
    areas: ['Yaba'],
    deliveryDays: [DAY],
  });
  return { menuId: menu._id.toString(), itemId: menu.items[0]!._id.toString() };
}

async function left(menuId: string) {
  return (await MenuModel.findById(menuId).lean())!.items[0]!.qtyRemaining;
}

function input(menuId: string, itemId: string, qty: number) {
  return {
    menuId,
    customer: { name: 'Ada', phone: '+2348091112222' },
    delivery: { area: 'Yaba', address: '1 Road', day: DAY },
    lines: [{ itemId, qty }],
  };
}

describe.skipIf(!testDbUri)('known-limit failure paths on a real MongoDB', () => {
  beforeAll(async () => {
    await connectTestDb('failures');
    const seller = await SellerModel.create({
      clerkUserId: 'seller_a',
      businessName: 'A',
      slug: 'kitchen-a',
      phone: '+2348031234567',
      payment: { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'A' },
    });
    sellerId = seller._id;
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('order insert fails AND giving stock back fails: logged, stock stays held', async () => {
    const { menuId, itemId } = await openMenu(5);
    await placeOrder(input(menuId, itemId, 1), { generateRef: () => 'CL-QQQQQ' });

    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const realUpdateOne = MenuModel.updateOne.bind(MenuModel);
    let calls = 0;
    vi.spyOn(MenuModel, 'updateOne').mockImplementation(((...args: Parameters<typeof realUpdateOne>) => {
      calls += 1;
      // Call 1 is takeStock (let it work); call 2 is returnStock (fail it).
      if (calls === 2) return Promise.reject(new Error('database went away'));
      return realUpdateOne(...args);
    }) as typeof MenuModel.updateOne);

    // Every ref collides, so the insert fails and the stock must be given back.
    await expect(placeOrder(input(menuId, itemId, 2), { generateRef: () => 'CL-QQQQQ' })).rejects.toMatchObject({
      code: 11000,
    });

    expect(log).toHaveBeenCalledWith(
      'STOCK NOT RETURNED after failed order insert',
      expect.objectContaining({ menuId, lines: [{ itemId, qty: 2 }] }),
    );
    // The limit, as documented: 2 portions are held with no order for them.
    expect(await left(menuId)).toBe(2); // 5 - 1 (real order) - 2 (held)
    expect(await OrderModel.countDocuments({ menuId })).toBe(1);
  });

  it('cancel: status changes but giving stock back fails: 500, logged, and a retry cannot fix it', async () => {
    const { menuId, itemId } = await openMenu(5);
    const order = await placeOrder(input(menuId, itemId, 3));
    expect(await left(menuId)).toBe(2);

    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(MenuModel, 'updateOne').mockReturnValueOnce(
      Promise.reject(new Error('database went away')) as unknown as ReturnType<typeof MenuModel.updateOne>,
    );

    const res = await request(app).patch(`/api/orders/${order.ref}/cancel`).set('Authorization', bearer('seller_a'));
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(log).toHaveBeenCalledWith('STOCK NOT RETURNED after cancel', expect.objectContaining({ ref: order.ref, menuId }));

    // The order is cancelled, but its 3 portions are still held.
    expect((await OrderModel.findOne({ ref: order.ref }).lean())!.status).toBe('cancelled');
    expect(await left(menuId)).toBe(2);

    // Retrying cancel does not return them: the order is already cancelled, and
    // returning stock only happens for the request that changed the status.
    // This is the "cancel is two writes" limit; fixing it means a manual $inc.
    vi.restoreAllMocks();
    await request(app).patch(`/api/orders/${order.ref}/cancel`).set('Authorization', bearer('seller_a'));
    expect(await left(menuId)).toBe(2);
  });
});
