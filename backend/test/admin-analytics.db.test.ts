import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { MenuModel } from '../src/models/menu.js';
import { MenuViewDailyModel } from '../src/models/menu-view-daily.js';
import { OrderModel } from '../src/models/order.js';
import { SellerModel } from '../src/models/seller.js';
import { lagosDay } from '../src/validation/day.js';
import { connectTestDb, disconnectTestDb, testDbUri } from './helpers/db.js';
import { bearer, fakeAuth } from './helpers/fake-auth.js';

const ADMIN = 'user_admin1';
const app = createApp({
  allowedOrigins: ['http://localhost:5173'],
  auth: fakeAuth,
  adminClerkUserIds: [ADMIN],
  rateLimits: { windowMs: 60_000, ordersPerWindow: 10_000, lookupsPerWindow: 10_000, viewsPerWindow: 10_000 },
});
const admin = { get: (path: string) => request(app).get(path).set('Authorization', bearer(ADMIN)) };

const payment = { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Acct' };
const ids = {
  a: new Types.ObjectId(), b: new Types.ObjectId(),
  m1: new Types.ObjectId(), m2: new Types.ObjectId(), m3: new Types.ObjectId(), m4: new Types.ObjectId(), m5: new Types.ObjectId(),
  item: new Types.ObjectId(),
};
const P1 = '+2348031234567';
const P2 = '+2348031234568';
const P3 = '+2348031234569';

let n = 0;
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const nextRef = () => `CL-${LETTERS[Math.floor(n / 32) % 32]}AAA${LETTERS[n++ % 32]}`;

type L = { name: string; qty: number; price?: number };
// An order placed at noon UTC (1pm Lagos) on the given day, so no test sits on a day boundary.
function order(o: { seller: Types.ObjectId; menu: Types.ObjectId; day: string; status?: string; phone?: string; lines?: L[]; extra?: Record<string, unknown> }) {
  const at = new Date(`${o.day}T12:00:00Z`);
  const lines = (o.lines ?? [{ name: 'Jollof rice', qty: 2 }]).map((l) => ({ itemId: ids.item, name: l.name, unitPrice: l.price ?? 3500, qty: l.qty }));
  const status = o.status ?? 'paid';
  return {
    ref: nextRef(),
    sellerId: o.seller,
    menuId: o.menu,
    customer: { name: 'Ada Obi', phone: o.phone ?? P1 },
    delivery: { area: 'Yaba', address: '12 Private Close', day: '2026-11-01' },
    lines,
    total: lines.reduce((sum, l) => sum + l.unitPrice * l.qty, 0),
    status,
    deliveryCodeAttempts: 0,
    deliveryCodeResets: 0,
    possibleDuplicate: false,
    createdAt: at,
    updatedAt: at,
    ...o.extra,
  };
}

const views = (menu: Types.ObjectId, seller: Types.ObjectId, day: string, count: number) => ({ menuId: menu, sellerId: seller, day, count });

describe.skipIf(!testDbUri)('admin analytics on a real MongoDB', () => {
  beforeAll(async () => {
    await connectTestDb('adminanalytics');
  });
  afterAll(async () => {
    await disconnectTestDb();
  });
  beforeEach(async () => {
    n = 0;
    await Promise.all([SellerModel.deleteMany({}), MenuModel.deleteMany({}), OrderModel.deleteMany({}), MenuViewDailyModel.deleteMany({})]);
    await SellerModel.collection.insertMany([
      { _id: ids.a, clerkUserId: 'seller_a', businessName: 'Seller A', slug: 'seller-a', phone: '+2348031230001', payment, status: 'active', createdAt: new Date(), updatedAt: new Date() },
      { _id: ids.b, clerkUserId: 'seller_b', businessName: 'Seller B', slug: 'seller-b', phone: '+2348031230002', payment, status: 'active', createdAt: new Date(), updatedAt: new Date() },
    ] as never);
    const menu = (_id: Types.ObjectId, sellerId: Types.ObjectId, title: string, status = 'open') => ({
      _id, sellerId, title, status, cutoffAt: new Date('2026-12-01T00:00:00Z'),
      items: [{ _id: ids.item, name: 'Jollof rice', price: 3500, qtyTotal: 100, qtyRemaining: 50 }],
      areas: ['Yaba'], deliveryDays: ['2026-11-01'], createdAt: new Date(), updatedAt: new Date(),
    });
    await MenuModel.collection.insertMany([
      menu(ids.m1, ids.a, 'A this week'),
      menu(ids.m2, ids.a, 'A old menu', 'closed'),
      menu(ids.m3, ids.b, 'B menu'),
      menu(ids.m4, ids.b, 'B nothing happened', 'draft'),
      menu(ids.m5, ids.b, 'B orders but no views', 'closed'), // a seller can have only one OPEN menu
    ] as never);
  });

  // ---------------------------------------------------------------------------
  describe('GET /analytics/menus', () => {
    // Views:  M1: 10-27 x10, 10-28 x20, 10-29 x30 (60)   M2: 10-20 x5   M3: 10-28 x10   M5: none
    // Orders: M1: 3 on 10-27, 5 on 10-28 (one cancelled), 2 on 10-29 (10)   M2: 1 on 10-20
    //         M3: 4 on 10-28   M5: 2 on 10-29   M4: nothing
    async function seed() {
      await MenuViewDailyModel.collection.insertMany([
        views(ids.m1, ids.a, '2026-10-27', 10), views(ids.m1, ids.a, '2026-10-28', 20), views(ids.m1, ids.a, '2026-10-29', 30),
        views(ids.m2, ids.a, '2026-10-20', 5), views(ids.m3, ids.b, '2026-10-28', 10),
      ] as never);
      const o = (seller: Types.ObjectId, menu: Types.ObjectId, day: string, status = 'paid') => order({ seller, menu, day, status });
      await OrderModel.collection.insertMany([
        o(ids.a, ids.m1, '2026-10-27'), o(ids.a, ids.m1, '2026-10-27'), o(ids.a, ids.m1, '2026-10-27'),
        o(ids.a, ids.m1, '2026-10-28'), o(ids.a, ids.m1, '2026-10-28'), o(ids.a, ids.m1, '2026-10-28'), o(ids.a, ids.m1, '2026-10-28'), o(ids.a, ids.m1, '2026-10-28', 'cancelled'),
        o(ids.a, ids.m1, '2026-10-29'), o(ids.a, ids.m1, '2026-10-29'),
        o(ids.a, ids.m2, '2026-10-20'),
        o(ids.b, ids.m3, '2026-10-28'), o(ids.b, ids.m3, '2026-10-28'), o(ids.b, ids.m3, '2026-10-28'), o(ids.b, ids.m3, '2026-10-28'),
        o(ids.b, ids.m5, '2026-10-29'), o(ids.b, ids.m5, '2026-10-29'),
      ] as never);
    }
    const get = (q = '') => admin.get(`/api/admin/analytics/menus${q}`);
    type SellerRow = {
      seller: { businessName: string };
      views: number;
      orders: number;
      conversion: number | null;
      menus: { title: string; views: number; orders: number; status: string; conversion: number | null }[];
    };
    const seller = (body: { sellers: SellerRow[] }, name: string) => body.sellers.find((s) => s.seller.businessName === name)!;

    it('all time: views, orders and conversion per menu, grouped by seller, busiest seller first', async () => {
      await seed();
      const { body, status } = await get();
      expect(status).toBe(200);
      expect(body.sellers.map((s: { seller: { businessName: string } }) => s.seller.businessName)).toEqual(['Seller A', 'Seller B']);

      const a = seller(body, 'Seller A');
      expect(a).toMatchObject({ views: 65, orders: 11 });
      expect(a.conversion).toBeCloseTo(11 / 65, 4);
      expect(a.menus.map((m: { title: string }) => m.title)).toEqual(['A this week', 'A old menu']); // most orders first
      expect(a.menus[0]).toMatchObject({ views: 60, orders: 10, status: 'open' });
      expect(a.menus[0]!.conversion).toBeCloseTo(10 / 60, 4);
      expect(a.menus[1]).toMatchObject({ views: 5, orders: 1 });
      expect(a.menus[1]!.conversion).toBeCloseTo(1 / 5, 4);

      const b = seller(body, 'Seller B');
      expect(b).toMatchObject({ views: 10, orders: 6 });
      expect(b.menus.find((m: { title: string }) => m.title === 'B menu')).toMatchObject({ views: 10, orders: 4 });
      expect(body.totals).toMatchObject({ views: 75, orders: 17 });
      expect(body.totals.conversion).toBeCloseTo(17 / 75, 4);
    });

    it('a menu with orders but no views has a null conversion (not infinity, not 0)', async () => {
      await seed();
      const menu = seller((await get()).body, 'Seller B').menus.find((m: { title: string }) => m.title === 'B orders but no views');
      expect(menu).toMatchObject({ views: 0, orders: 2, conversion: null });
    });

    it('a menu with nothing in the period is left out', async () => {
      await seed();
      const titles = (await get()).body.sellers.flatMap((s: { menus: { title: string }[] }) => s.menus.map((m) => m.title));
      expect(titles).not.toContain('B nothing happened');
    });

    it('limits to a date range (days included, Lagos time)', async () => {
      await seed();
      const { body } = await get('?from=2026-10-28&to=2026-10-28');
      expect(seller(body, 'Seller A')).toMatchObject({ views: 20, orders: 5 }); // the cancelled order was still placed
      expect(seller(body, 'Seller A').menus.map((m: { title: string }) => m.title)).toEqual(['A this week']); // old menu: nothing that day
      expect(seller(body, 'Seller B')).toMatchObject({ views: 10, orders: 4 });
      expect(body.totals).toMatchObject({ views: 30, orders: 9 });
      expect(body.range).toEqual({ from: '2026-10-28', to: '2026-10-28' });
    });

    it('either end of the range may be missing', async () => {
      await seed();
      expect((await get('?from=2026-10-29')).body.totals).toMatchObject({ views: 30, orders: 4 });
      expect((await get('?to=2026-10-20')).body.totals).toMatchObject({ views: 5, orders: 1 });
    });

    it('a range with no activity is empty and has a null conversion', async () => {
      await seed();
      const { body } = await get('?from=2025-01-01&to=2025-01-02');
      expect(body.sellers).toEqual([]);
      expect(body.totals).toEqual({ views: 0, orders: 0, conversion: null });
      expect(body.pagination.total).toBe(0);
    });

    it('paginates by seller', async () => {
      await seed();
      const p1 = (await get('?limit=1&page=1')).body;
      const p2 = (await get('?limit=1&page=2')).body;
      expect(p1.sellers.map((s: { seller: { businessName: string } }) => s.seller.businessName)).toEqual(['Seller A']);
      expect(p2.sellers.map((s: { seller: { businessName: string } }) => s.seller.businessName)).toEqual(['Seller B']);
      expect(p1.pagination).toEqual({ page: 1, limit: 1, total: 2, totalPages: 2 });
      expect(p1.totals.views).toBe(75); // totals cover everything, not just the page
    });

    it('returns the definitions and rejects a bad range', async () => {
      const { body } = await get();
      expect(body.definitions.conversion).toMatch(/not an exact rate|indicator/i);
      for (const q of ['?from=2026-13-01', '?from=2026-10-20&to=2026-10-01', '?limit=101', '?page=0']) {
        expect((await get(q)).status, q).toBe(400);
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe('GET /analytics/items', () => {
    const get = (q = '') => admin.get(`/api/admin/analytics/items${q}`);
    async function seed() {
      await OrderModel.collection.insertMany([
        order({ seller: ids.a, menu: ids.m1, day: '2026-10-27', lines: [{ name: 'Jollof rice', qty: 2, price: 3500 }, { name: 'Chapman', qty: 1, price: 1500 }] }),
        order({ seller: ids.a, menu: ids.m1, day: '2026-10-28', lines: [{ name: 'Jollof rice', qty: 3, price: 3500 }] }),
        // Another seller spells it differently: still the same item.
        order({ seller: ids.b, menu: ids.m3, day: '2026-10-28', lines: [{ name: '  jollof RICE ', qty: 4, price: 3000 }] }),
        order({ seller: ids.b, menu: ids.m3, day: '2026-10-29', lines: [{ name: 'Egusi soup', qty: 1, price: 5000 }, { name: 'Chapman', qty: 2, price: 1500 }] }),
        // Cancelled: its portions went back on sale, so they do not count.
        order({ seller: ids.a, menu: ids.m1, day: '2026-10-28', status: 'cancelled', lines: [{ name: 'Egusi soup', qty: 50, price: 5000 }] }),
        // Pending still counts: the customer ordered it.
        order({ seller: ids.a, menu: ids.m1, day: '2026-10-29', status: 'pending', lines: [{ name: 'Egusi soup', qty: 2, price: 5000 }] }),
      ] as never);
    }

    it('ranks items by portions, matching names ignoring case and spaces across sellers', async () => {
      await seed();
      const { body, status } = await get();
      expect(status).toBe(200);
      expect(body.items.map((i: { name: string; portions: number }) => [i.name.toLowerCase(), i.portions])).toEqual([
        ['jollof rice', 9], // 2 + 3 + 4, across both sellers
        ['egusi soup', 3], // 1 + 2 (the cancelled 50 are ignored)
        ['chapman', 3], // 1 + 2
      ].sort((x, y) => (y[1] as number) - (x[1] as number) || String(x[0]).localeCompare(String(y[0]))));
      const jollof = body.items[0];
      expect(jollof).toMatchObject({ portions: 9, orders: 3, sellers: 2, revenue: 2 * 3500 + 3 * 3500 + 4 * 3000 });
      expect(jollof.name).toBe(jollof.name.trim()); // no stray spaces in the name shown
    });

    it('ties are broken by order count then name, so the order is stable', async () => {
      await seed();
      const first = (await get()).body.items.map((i: { name: string }) => i.name);
      const second = (await get()).body.items.map((i: { name: string }) => i.name);
      expect(second).toEqual(first);
    });

    it('filters by seller and by date', async () => {
      await seed();
      const a = (await get(`?sellerId=${ids.a}`)).body;
      expect(a.items.find((i: { name: string }) => i.name === 'Jollof rice')).toMatchObject({ portions: 5, sellers: 1 });
      expect(a.sellerId).toBe(ids.a.toString());
      const day = (await get('?from=2026-10-29&to=2026-10-29')).body;
      expect(day.items.map((i: { name: string; portions: number }) => [i.name, i.portions]).sort()).toEqual([['Chapman', 2], ['Egusi soup', 3]]);
      expect((await get('?sellerId=nope')).status).toBe(400);
    });

    it('paginates', async () => {
      await seed();
      const p1 = (await get('?limit=2&page=1')).body;
      const p2 = (await get('?limit=2&page=2')).body;
      expect(p1.items).toHaveLength(2);
      expect(p2.items).toHaveLength(1);
      expect(p1.pagination).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
    });

    it('is empty (not an error) when there are no orders', async () => {
      const { body } = await get();
      expect(body.items).toEqual([]);
      expect(body.pagination.total).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  describe('GET /analytics/customers', () => {
    // P1 ordered 10-01, 10-10, 10-20.  P2 ordered 10-15, plus a CANCELLED order on 10-05.
    // P3 ordered 09-20 and 10-16.
    async function seed() {
      const o = (phone: string, day: string, status = 'paid') => order({ seller: ids.a, menu: ids.m1, day, phone, status });
      await OrderModel.collection.insertMany([
        o(P1, '2026-10-01'), o(P1, '2026-10-10'), o(P1, '2026-10-20'),
        o(P2, '2026-10-05', 'cancelled'), o(P2, '2026-10-15'),
        o(P3, '2026-09-20'), o(P3, '2026-10-16'),
      ] as never);
    }
    const get = (q = '') => admin.get(`/api/admin/analytics/customers${q}`);

    it('a period: customers whose first order is in it are new; the rest are returning', async () => {
      await seed();
      const { body, status } = await get('?from=2026-10-12&to=2026-10-31');
      expect(status).toBe(200);
      // In the period: P1 (10-20), P2 (10-15), P3 (10-16).
      // P2's first ever order is in the period -> new. P1 and P3 ordered before it -> returning.
      expect(body.customers).toMatchObject({ total: 3, new: 1, returning: 2 });
      expect(body.customers.returningRate).toBeCloseTo(2 / 3, 4);
      expect(body.orders).toMatchObject({ total: 3, firstOrders: 1, repeatOrders: 2 });
    });

    it('a cancelled order does not make someone a returning customer', async () => {
      await seed();
      // P2's cancelled order on 10-05 is ignored, so the order on 10-15 is their first.
      const { body } = await get('?from=2026-10-01&to=2026-10-31');
      expect(body.customers).toMatchObject({ total: 3, new: 2, returning: 1 }); // P1 new (10-01 in period), P2 new, P3 returning
    });

    it('a period where someone orders twice: new customer, one repeat order', async () => {
      await seed();
      const { body } = await get('?from=2026-10-01&to=2026-10-11');
      expect(body.customers).toMatchObject({ total: 1, new: 1, returning: 0 }); // only P1 ordered in this window (10-01 and 10-10)
      expect(body.orders).toMatchObject({ total: 2, firstOrders: 1, repeatOrders: 1 });
    });

    it('all time: everyone is "new" by definition, so repeat orders is the number to read', async () => {
      await seed();
      const { body } = await get();
      expect(body.customers).toMatchObject({ total: 3, new: 3, returning: 0 });
      expect(body.orders).toMatchObject({ total: 6, firstOrders: 3, repeatOrders: 3 });
      expect(body.orders.repeatRate).toBeCloseTo(0.5, 4);
    });

    it('the same number typed as 0803... and +234 803... is one customer', async () => {
      const place = (phone: string) =>
        request(app).post('/api/public/orders').send({
          menuId: ids.m1.toString(),
          customer: { name: 'Ada', phone },
          delivery: { area: 'Yaba', address: '12 Herbert Macaulay Way', day: '2026-11-01' },
          lines: [{ itemId: ids.item.toString(), qty: 1 }],
        });
      // Make the menu orderable: cut-off in the future and the delivery day listed.
      await MenuModel.collection.updateOne({ _id: ids.m1 }, { $set: { cutoffAt: new Date(Date.now() + 86_400_000) } });
      expect((await place('0803 123 4567')).status).toBe(201);
      expect((await place('+234 803 123 4567')).status).toBe(201);
      const { body } = await get();
      expect(body.customers).toMatchObject({ total: 1, new: 1, returning: 0 });
      expect(body.orders).toMatchObject({ total: 2, firstOrders: 1, repeatOrders: 1 });
    });

    it('returns no phone numbers or anything identifying, only counts and definitions', async () => {
      await seed();
      const json = JSON.stringify((await get()).body);
      for (const secret of ['803123', 'Ada Obi', P1, P2, P3]) expect(json, secret).not.toContain(secret);
      expect(Object.keys((await get()).body).sort()).toEqual(['customers', 'definitions', 'orders', 'range']);
    });

    it('with no orders: zeros and null rates', async () => {
      const { body } = await get();
      expect(body.customers).toEqual({ total: 0, new: 0, returning: 0, returningRate: null });
      expect(body.orders).toEqual({ total: 0, firstOrders: 0, repeatOrders: 0, repeatRate: null });
    });

    it('rejects a bad range', async () => {
      for (const q of ['?from=2026-02-30', '?from=2026-10-20&to=2026-10-01']) expect((await get(q)).status, q).toBe(400);
    });
  });

  // ---------------------------------------------------------------------------
  describe('access and privacy', () => {
    const PATHS = ['/api/admin/analytics/menus', '/api/admin/analytics/items', '/api/admin/analytics/customers'];

    it('401 without a token, 403 for a seller, for every analytics endpoint', async () => {
      for (const path of PATHS) {
        expect((await request(app).get(path)).status, `${path} anon`).toBe(401);
        for (const user of ['seller_a', 'random_user']) {
          const res = await request(app).get(path).set('Authorization', bearer(user));
          expect(res.status, `${path} ${user}`).toBe(403);
          expect(res.body.error.code).toBe('FORBIDDEN');
        }
      }
    });

    it('no analytics response contains a delivery code, key hash, address or phone number', async () => {
      await OrderModel.collection.insertMany([
        order({ seller: ids.a, menu: ids.m1, day: '2026-10-28', status: 'out_for_delivery', extra: { deliveryCode: '482915', accessKeyHash: 'a'.repeat(64), fingerprint: 'b'.repeat(64) } }),
      ] as never);
      await MenuViewDailyModel.collection.insertOne(views(ids.m1, ids.a, '2026-10-28', 3) as never);
      for (const path of PATHS) {
        const json = JSON.stringify((await admin.get(path)).body);
        for (const secret of ['482915', 'a'.repeat(64), 'b'.repeat(64), 'deliveryCode', 'accessKeyHash', 'fingerprint', 'Private Close', '8031234567']) {
          expect(json, `${path} ${secret}`).not.toContain(secret);
        }
      }
    });
  });
});
