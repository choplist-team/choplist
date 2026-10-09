import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { MenuModel } from '../src/models/menu.js';
import { OrderModel } from '../src/models/order.js';
import { SellerModel } from '../src/models/seller.js';
import { connectTestDb, disconnectTestDb, testDbUri } from './helpers/db.js';
import { bearer, fakeAuth } from './helpers/fake-auth.js';

const app = createApp({ allowedOrigins: ['http://localhost:5173'], auth: fakeAuth });
const get = (userId: string, path: string) => request(app).get(path).set('Authorization', bearer(userId));

const SAT = '2030-10-19';
const SUN = '2030-10-20';

let menuId: string;
let ids: { jollof: Types.ObjectId; chapman: Types.ObjectId; egusi: Types.ObjectId };

describe.skipIf(!testDbUri)('reports on a real MongoDB', () => {
  beforeAll(async () => {
    await connectTestDb('reports');
    const seller = await SellerModel.create({
      clerkUserId: 'seller_a',
      businessName: 'A',
      slug: 'kitchen-a',
      phone: '+2348031234567',
      payment: { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'A' },
    });
    await SellerModel.create({
      clerkUserId: 'seller_b',
      businessName: 'B',
      slug: 'kitchen-b',
      phone: '+2348031234568',
      payment: { bankName: 'GTBank', accountNumber: '0123456780', accountName: 'B' },
    });

    const menu = await MenuModel.create({
      sellerId: seller._id,
      title: 'Week',
      status: 'open',
      cutoffAt: new Date('2030-10-18T17:00:00Z'),
      items: [
        { name: 'Jollof rice', price: 3500, qtyTotal: 50, qtyRemaining: 50 },
        { name: 'Chapman', price: 1500, qtyTotal: 50, qtyRemaining: 50 },
        { name: 'Egusi', price: 4000, qtyTotal: 50, qtyRemaining: 50 }, // nobody orders it
      ],
      // Seller's order: Surulere first.
      areas: ['Surulere', 'Yaba'],
      deliveryDays: [SAT, SUN],
    });
    menuId = menu._id.toString();
    ids = { jollof: menu.items[0]!._id, chapman: menu.items[1]!._id, egusi: menu.items[2]!._id };

    let n = 0;
    const order = (
      status: 'pending' | 'paid' | 'cancelled',
      area: string,
      day: string,
      lines: [Types.ObjectId, string, number, number][],
    ) => {
      n += 1;
      const orderLines = lines.map(([itemId, name, unitPrice, qty]) => ({ itemId, name, unitPrice, qty }));
      return {
        ref: `CL-AAAA${'23456789'[n]}`,
        sellerId: seller._id,
        menuId: menu._id,
        customer: { name: `Customer ${n}`, phone: '+2348091112222' },
        delivery: { area, address: `${n} Some Street`, day },
        lines: orderLines,
        total: orderLines.reduce((sum, l) => sum + l.unitPrice * l.qty, 0),
        status,
        createdAt: new Date(Date.UTC(2030, 9, 1, 0, n)), // n minutes after midnight
      };
    };
    const J = (qty: number): [Types.ObjectId, string, number, number] => [ids.jollof, 'Jollof rice', 3500, qty];
    const C = (qty: number): [Types.ObjectId, string, number, number] => [ids.chapman, 'Chapman', 1500, qty];

    await OrderModel.create([
      order('paid', 'Yaba', SAT, [J(2), C(1)]), //       1: paid    8500
      order('pending', 'Yaba', SUN, [J(1)]), //          2: pending 3500
      order('cancelled', 'Yaba', SAT, [J(10)]), //       3: cancelled, never counts
      order('paid', 'Surulere', SAT, [C(3)]), //         4: paid    4500
      order('pending', 'Surulere', SAT, [J(4), C(2)]), // 5: pending 17000
    ]);

    // An order with this menu's id but another seller's id (should never
    // exist, but if it did): only the sellerId filter keeps it out.
    await OrderModel.create({ ...order('paid', 'Yaba', SAT, [J(99)]), sellerId: new Types.ObjectId() });
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  describe('GET /api/menus/:id/prep-sheet', () => {
    it('sums portions per item, excludes cancelled, lists unordered items as 0', async () => {
      const res = await get('seller_a', `/api/menus/${menuId}/prep-sheet`);
      expect(res.status).toBe(200);
      expect(res.body.paidOnly).toBe(false);
      expect(res.body.items).toEqual([
        { itemId: ids.jollof.toString(), name: 'Jollof rice', portions: 7, orders: 3 }, // 2 + 1 + 4 (not the cancelled 10)
        { itemId: ids.chapman.toString(), name: 'Chapman', portions: 6, orders: 3 }, //   1 + 3 + 2
        { itemId: ids.egusi.toString(), name: 'Egusi', portions: 0, orders: 0 },
      ]);
      expect(res.body.totals).toEqual({ orders: 4, portions: 13, amount: 33500 });
    });

    it('paidOnly=true counts only paid orders', async () => {
      const res = await get('seller_a', `/api/menus/${menuId}/prep-sheet?paidOnly=true`);
      expect(res.body.paidOnly).toBe(true);
      expect(res.body.items.map((i: { portions: number }) => i.portions)).toEqual([2, 4, 0]);
      expect(res.body.totals).toEqual({ orders: 2, portions: 6, amount: 13000 });
    });

    it('paidOnly=false really means false (the "false" string trap)', async () => {
      const res = await get('seller_a', `/api/menus/${menuId}/prep-sheet?paidOnly=false`);
      expect(res.body.paidOnly).toBe(false);
      expect(res.body.totals.orders).toBe(4);
    });

    it('rejects other paidOnly values', async () => {
      const res = await get('seller_a', `/api/menus/${menuId}/prep-sheet?paidOnly=yes`);
      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe('paidOnly: paidOnly must be true or false');
    });

    it('reflects a change immediately (computed on request, not stored)', async () => {
      await OrderModel.updateOne({ menuId, 'customer.name': 'Customer 2' }, { $set: { status: 'cancelled' } });
      const res = await get('seller_a', `/api/menus/${menuId}/prep-sheet`);
      expect(res.body.items[0].portions).toBe(6); // Customer 2's 1 jollof dropped out
      await OrderModel.updateOne({ menuId, 'customer.name': 'Customer 2' }, { $set: { status: 'pending' } });
    });
  });

  describe('GET /api/menus/:id/delivery-list', () => {
    it("groups by area in the seller's order, stops sorted by day then arrival", async () => {
      const res = await get('seller_a', `/api/menus/${menuId}/delivery-list`);
      expect(res.status).toBe(200);
      expect(res.body.totalOrders).toBe(4);
      expect(res.body.areas.map((a: { area: string; count: number }) => [a.area, a.count])).toEqual([
        ['Surulere', 2],
        ['Yaba', 2],
      ]);

      const yaba = res.body.areas[1];
      expect(yaba.orders.map((o: { customer: { name: string } }) => o.customer.name)).toEqual(['Customer 1', 'Customer 2']);
      expect(yaba.orders[0]).toEqual({
        ref: expect.stringMatching(/^CL-/),
        status: 'paid',
        customer: { name: 'Customer 1', phone: '+2348091112222' },
        address: '1 Some Street',
        day: SAT,
        note: null,
        lines: [
          { name: 'Jollof rice', qty: 2 },
          { name: 'Chapman', qty: 1 },
        ],
        total: 8500,
      });
      // The cancelled order (Customer 3) is nowhere.
      expect(JSON.stringify(res.body)).not.toContain('Customer 3');
    });

    it('filters by delivery day and by paidOnly', async () => {
      const sunday = await get('seller_a', `/api/menus/${menuId}/delivery-list?day=${SUN}`);
      expect(sunday.body.day).toBe(SUN);
      expect(sunday.body.areas).toEqual([expect.objectContaining({ area: 'Yaba', count: 1 })]);

      const paidSat = await get('seller_a', `/api/menus/${menuId}/delivery-list?day=${SAT}&paidOnly=true`);
      expect(paidSat.body.areas.map((a: { area: string; count: number }) => [a.area, a.count])).toEqual([
        ['Surulere', 1],
        ['Yaba', 1],
      ]);
    });

    it('rejects a day that is not a real date', async () => {
      const res = await get('seller_a', `/api/menus/${menuId}/delivery-list?day=2030-02-30`);
      expect(res.status).toBe(400);
    });
  });

  it("isolation: another seller's menu is 404 for both reports", async () => {
    for (const report of ['prep-sheet', 'delivery-list']) {
      const res = await get('seller_b', `/api/menus/${menuId}/${report}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('MENU_NOT_FOUND');
    }
  });
});
