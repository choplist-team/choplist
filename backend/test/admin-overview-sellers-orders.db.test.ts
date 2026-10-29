import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { AdminAuditModel } from '../src/models/admin-audit.js';
import { EventLogModel } from '../src/models/event-log.js';
import { MenuModel } from '../src/models/menu.js';
import { OrderModel } from '../src/models/order.js';
import { SellerModel } from '../src/models/seller.js';
import { connectTestDb, disconnectTestDb, testDbUri } from './helpers/db.js';
import { bearer, fakeAuth } from './helpers/fake-auth.js';

const ADMIN = 'user_admin1';
const app = createApp({
  allowedOrigins: ['http://localhost:5173'],
  auth: fakeAuth,
  adminClerkUserIds: [ADMIN],
  rateLimits: { windowMs: 60_000, ordersPerWindow: 10_000, lookupsPerWindow: 10_000 },
});

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms);

const admin = {
  get: (path: string) => request(app).get(path).set('Authorization', bearer(ADMIN)),
  patch: (path: string) => request(app).patch(path).set('Authorization', bearer(ADMIN)),
};
const asSeller = (id: string) => ({
  get: (path: string) => request(app).get(path).set('Authorization', bearer(id)),
  patch: (path: string) => request(app).patch(path).set('Authorization', bearer(id)),
});

const payment = { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Secret Account Name' };

// ---- The fixed dataset ----------------------------------------------------------
// Sellers:  S1 active, used the app now           S2 active, idle 40 days, no orders
//           S3 SUSPENDED, used the app now        S4 no status stored (old), order 25 days ago
//           S5 deactivated
// Menus:    M1 (S1) open, cut-off in the future   M2 (S1) closed, cut-off passed
//           M3 (S4) closed, cut-off passed        M4 (S2) draft
// Orders:   M2: paid 2d, delivered 10d, out_for_delivery 20d, cancelled 40d, pending 5d ago
//           M3: delivered 25d ago
//           M1: pending 1h ago, paid 1d ago
// Orders on menus whose cut-off passed: 6; reached paid/beyond: 4; delivered: 2.
const ids = {
  s1: new Types.ObjectId(), s2: new Types.ObjectId(), s3: new Types.ObjectId(), s4: new Types.ObjectId(), s5: new Types.ObjectId(),
  m1: new Types.ObjectId(), m2: new Types.ObjectId(), m3: new Types.ObjectId(), m4: new Types.ObjectId(),
  item: new Types.ObjectId(),
};

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
let refCounter = 0;
const nextRef = () => `CL-AAAA${LETTERS[refCounter++]}`;

type RawOrderOptions = {
  ref?: string;
  seller: Types.ObjectId;
  menu: Types.ObjectId;
  status: string;
  age: number;
  phone?: string;
  qty?: number;
  extra?: Record<string, unknown>;
};

function rawOrder(o: RawOrderOptions) {
  const createdAt = ago(o.age);
  const qty = o.qty ?? 2;
  return {
    ref: o.ref ?? nextRef(),
    sellerId: o.seller,
    menuId: o.menu,
    customer: { name: 'Ada Obi', phone: o.phone ?? '+2348031234567' },
    delivery: { area: 'Yaba', address: '12 Private Close, Yaba', day: '2026-10-17' },
    note: 'gate code is 4321',
    lines: [{ itemId: ids.item, name: 'Jollof rice', unitPrice: 3500, qty }],
    total: 3500 * qty,
    status: o.status,
    ...(o.status !== 'pending' && o.status !== 'cancelled' ? { paidAt: createdAt } : {}),
    ...(o.status === 'cancelled' ? { cancelledAt: createdAt } : {}),
    deliveryCodeAttempts: 0,
    deliveryCodeResets: 0,
    possibleDuplicate: false,
    createdAt,
    updatedAt: createdAt,
    ...o.extra,
  };
}

async function seedDataset() {
  await SellerModel.collection.insertMany([
    { _id: ids.s1, clerkUserId: 'seller_1', businessName: 'Mama T Kitchen', slug: 'mama-t', phone: '+2348031234567', email: 'mama@example.com', payment, status: 'active', lastActiveAt: new Date(NOW), createdAt: ago(60 * DAY), updatedAt: new Date(NOW) },
    { _id: ids.s2, clerkUserId: 'seller_2', businessName: 'Idle Bites', slug: 'idle-bites', phone: '+2347012345678', payment, status: 'active', lastActiveAt: ago(40 * DAY), createdAt: ago(50 * DAY), updatedAt: new Date(NOW) },
    { _id: ids.s3, clerkUserId: 'seller_3', businessName: 'Blocked Foods', slug: 'blocked-foods', phone: '+2349011111111', payment, status: 'suspended', statusReason: 'spam', lastActiveAt: new Date(NOW), createdAt: ago(40 * DAY), updatedAt: new Date(NOW) },
    { _id: ids.s4, clerkUserId: 'seller_4', businessName: 'Old Seller (no status)', slug: 'old-seller', phone: '+2348099998888', payment, createdAt: ago(100 * DAY), updatedAt: new Date(NOW) },
    { _id: ids.s5, clerkUserId: 'seller_5', businessName: 'Closed Down', slug: 'closed-down', phone: '+2348055554444', payment, status: 'deactivated', createdAt: ago(30 * DAY), updatedAt: new Date(NOW) },
  ] as never);

  const menu = (_id: Types.ObjectId, sellerId: Types.ObjectId, status: string, cutoff: Date, title: string) => ({
    _id, sellerId, title, status, cutoffAt: cutoff,
    items: [{ _id: ids.item, name: 'Jollof rice', price: 3500, qtyTotal: 100, qtyRemaining: 50 }],
    areas: ['Yaba'], deliveryDays: ['2026-10-17'],
    ...(status !== 'draft' ? { openedAt: ago(30 * DAY) } : {}),
    ...(status === 'closed' ? { closedAt: ago(10 * DAY) } : {}),
    createdAt: ago(30 * DAY), updatedAt: new Date(NOW),
  });
  await MenuModel.collection.insertMany([
    menu(ids.m1, ids.s1, 'open', new Date(NOW + 2 * DAY), 'This week'),
    menu(ids.m2, ids.s1, 'closed', ago(DAY), 'Last week'),
    menu(ids.m3, ids.s4, 'closed', ago(2 * DAY), 'Old menu'),
    menu(ids.m4, ids.s2, 'draft', new Date(NOW + 5 * DAY), 'Draft'),
  ] as never);

  await OrderModel.collection.insertMany([
    rawOrder({ seller: ids.s1, menu: ids.m2, status: 'paid', age: 2 * DAY }),
    rawOrder({ seller: ids.s1, menu: ids.m2, status: 'delivered', age: 10 * DAY }),
    rawOrder({ seller: ids.s1, menu: ids.m2, status: 'out_for_delivery', age: 20 * DAY, extra: { deliveryCode: '482915', accessKeyHash: 'a'.repeat(64), fingerprint: 'b'.repeat(64) } }),
    rawOrder({ seller: ids.s1, menu: ids.m2, status: 'cancelled', age: 40 * DAY }),
    rawOrder({ seller: ids.s1, menu: ids.m2, status: 'pending', age: 5 * DAY }),
    rawOrder({ seller: ids.s4, menu: ids.m3, status: 'delivered', age: 25 * DAY }),
    rawOrder({ seller: ids.s1, menu: ids.m1, status: 'pending', age: HOUR }),
    rawOrder({ seller: ids.s1, menu: ids.m1, status: 'paid', age: DAY }),
  ] as never);
}

const ENDPOINTS: [string, string][] = [
  ['GET', '/api/admin/overview'],
  ['GET', '/api/admin/sellers'],
  ['GET', `/api/admin/sellers/${ids.s1}`],
  ['PATCH', `/api/admin/sellers/${ids.s1}/suspend`],
  ['PATCH', `/api/admin/sellers/${ids.s1}/deactivate`],
  ['PATCH', `/api/admin/sellers/${ids.s1}/reinstate`],
  ['GET', '/api/admin/orders'],
  ['GET', '/api/admin/orders/CL-AAAAB'],
];

describe.skipIf(!testDbUri)('admin overview, sellers and orders on a real MongoDB', () => {
  beforeAll(async () => {
    await connectTestDb('adminphase2');
  });
  afterAll(async () => {
    await disconnectTestDb();
  });
  beforeEach(async () => {
    refCounter = 0;
    vi.restoreAllMocks();
    await Promise.all([SellerModel.deleteMany({}), MenuModel.deleteMany({}), OrderModel.deleteMany({}), AdminAuditModel.deleteMany({}), EventLogModel.deleteMany({})]);
    await seedDataset();
  });

  describe('access', () => {
    it('every admin endpoint: 401 without a token, 403 for a seller, and a seller cannot change anything', async () => {
      for (const [method, path] of ENDPOINTS) {
        const anon = await request(app)[method.toLowerCase() as 'get' | 'patch'](path).send({ reason: 'abc' });
        expect(anon.status, `${method} ${path} anon`).toBe(401);
        for (const user of ['seller_1', 'seller_3', 'random_user']) {
          const res = await request(app)[method.toLowerCase() as 'get' | 'patch'](path).set('Authorization', bearer(user)).send({ reason: 'abc' });
          expect(res.status, `${method} ${path} ${user}`).toBe(403);
          expect(res.body.error.code).toBe('FORBIDDEN');
        }
      }
      expect((await SellerModel.collection.findOne({ _id: ids.s1 }))!.status).toBe('active');
      expect(await AdminAuditModel.countDocuments({})).toBe(0);
    });
  });

  describe('GET /overview', () => {
    it('counts on the fixed dataset', async () => {
      const res = await admin.get('/api/admin/overview');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        totalSellers: 5,
        activeSellers: 2, // S1 (active, used app) and S4 (no status = active, order 25 days ago); S2 idle, S3 suspended, S5 deactivated
        publishedMenus: 3, // M1 open, M2 closed, M3 closed (M4 is a draft)
        openMenus: 1,
        totalOrders: 8,
        ordersLast7Days: 4, // 2d, 5d, 1h, 1d
        ordersLast30Days: 7, // all but the one 40 days ago
      });
    });

    it('success rate: 4 of the 6 orders whose menu cut-off has passed reached paid or beyond (0.6667); 2 of 6 delivered (0.3333)', async () => {
      const { body } = await admin.get('/api/admin/overview');
      expect(body.ordersCounted).toBe(6); // the 2 orders on the still-open menu are not counted
      expect(body.successRate).toBeCloseTo(4 / 6, 4);
      expect(body.fulfilmentRate).toBeCloseTo(2 / 6, 4);
    });

    it('returns the definitions as text for the frontend to show', async () => {
      const { definitions } = (await admin.get('/api/admin/overview')).body;
      for (const key of ['totalSellers', 'activeSellers', 'publishedMenus', 'ordersLast7Days', 'ordersLast30Days', 'successRate', 'fulfilmentRate']) {
        expect(typeof definitions[key], key).toBe('string');
        expect(definitions[key].length).toBeGreaterThan(20);
      }
      expect(definitions.successRate).toMatch(/cut-off/);
      expect(definitions.successRate).toMatch(/seller|never handles money/i);
    });

    it('a pending order only counts as a failure once its cut-off has passed', async () => {
      // Change the 2 orders on the open menu: they must not move the rate.
      await OrderModel.collection.updateMany({ menuId: ids.m1 }, { $set: { status: 'cancelled' } });
      const { body } = await admin.get('/api/admin/overview');
      expect(body.successRate).toBeCloseTo(4 / 6, 4);
    });

    it('on an empty database: zeros, and null rates (no data is not 0%)', async () => {
      await Promise.all([SellerModel.deleteMany({}), MenuModel.deleteMany({}), OrderModel.deleteMany({})]);
      const { body } = await admin.get('/api/admin/overview');
      expect(body).toMatchObject({ totalSellers: 0, activeSellers: 0, totalOrders: 0, ordersLast7Days: 0, ordersLast30Days: 0, successRate: null, fulfilmentRate: null, ordersCounted: 0 });
    });

    it('a suspended seller with recent activity and orders is still not active', async () => {
      await OrderModel.collection.insertOne(rawOrder({ seller: ids.s3, menu: ids.m1, status: 'paid', age: HOUR }) as never);
      expect((await admin.get('/api/admin/overview')).body.activeSellers).toBe(2);
    });
  });

  describe('GET /sellers', () => {
    const names = (body: { sellers: { businessName: string }[] }) => body.sellers.map((s) => s.businessName);

    it('lists sellers newest-registered first, with total counts', async () => {
      const { body } = await admin.get('/api/admin/sellers');
      expect(names(body)).toEqual(['Closed Down', 'Blocked Foods', 'Idle Bites', 'Mama T Kitchen', 'Old Seller (no status)']);
      expect(body.pagination).toEqual({ page: 1, limit: 20, total: 5, totalPages: 1 });
    });

    it('shows name, registration date, contact, link, status, last active, open menu and order count', async () => {
      const { body } = await admin.get('/api/admin/sellers?q=mama');
      expect(body.sellers).toHaveLength(1);
      expect(body.sellers[0]).toMatchObject({
        id: ids.s1.toString(),
        businessName: 'Mama T Kitchen',
        slug: 'mama-t',
        publicMenuPath: '/api/public/menu/mama-t',
        phone: '+2348031234567',
        email: 'mama@example.com',
        status: 'active',
        totalOrders: 7,
        openMenu: { id: ids.m1.toString(), title: 'This week' },
      });
      expect(body.sellers[0].registeredAt).toEqual(expect.any(String));
      expect(body.sellers[0].lastActiveAt).toEqual(expect.any(String));
    });

    it('never returns bank details', async () => {
      for (const path of ['/api/admin/sellers', `/api/admin/sellers/${ids.s1}`]) {
        const json = JSON.stringify((await admin.get(path)).body);
        for (const secret of ['0123456789', 'Secret Account Name', 'GTBank', 'accountNumber', 'clerkUserId', 'seller_1']) {
          expect(json, `${path} ${secret}`).not.toContain(secret);
        }
      }
    });

    it('searches name, link, email and the phone however it is typed', async () => {
      const find = async (q: string) => names((await admin.get(`/api/admin/sellers?q=${encodeURIComponent(q)}`)).body);
      expect(await find('mama')).toEqual(['Mama T Kitchen']);
      expect(await find('IDLE')).toEqual(['Idle Bites']); // any case
      expect(await find('blocked-foods')).toEqual(['Blocked Foods']); // link
      expect(await find('mama@example')).toEqual(['Mama T Kitchen']); // email
      expect(await find('0803 123')).toEqual(['Mama T Kitchen']); // 0803 form
      expect(await find('+234 803 123')).toEqual(['Mama T Kitchen']); // +234 form
      expect(await find('803123')).toEqual(['Mama T Kitchen']);
      expect(await find('nobody-called-this')).toEqual([]);
    });

    it('search text is literal: regex characters neither crash nor match everything', async () => {
      for (const q of ['[a-z]', '.*', '\\', '+++', '$^', '))']) {
        const res = await admin.get(`/api/admin/sellers?q=${encodeURIComponent(q)}`);
        expect(res.status, q).toBe(200);
        expect(res.body.sellers, q).toHaveLength(0);
      }
      // "(" is a real character in one seller's name, so it matches exactly that
      // seller (as a literal), not everyone, and does not crash.
      const paren = await admin.get(`/api/admin/sellers?q=${encodeURIComponent('(')}`);
      expect(paren.status).toBe(200);
      expect(names(paren.body)).toEqual(['Old Seller (no status)']);
    });

    it('filters by status; "active" includes a seller with no status stored', async () => {
      const by = async (status: string) => names((await admin.get(`/api/admin/sellers?status=${status}`)).body).sort();
      expect(await by('active')).toEqual(['Idle Bites', 'Mama T Kitchen', 'Old Seller (no status)']);
      expect(await by('suspended')).toEqual(['Blocked Foods']);
      expect(await by('deactivated')).toEqual(['Closed Down']);
      expect((await admin.get('/api/admin/sellers?status=banned')).status).toBe(400);
    });

    it('paginates: page and limit, total stays the whole count', async () => {
      const p1 = (await admin.get('/api/admin/sellers?limit=2&page=1')).body;
      const p2 = (await admin.get('/api/admin/sellers?limit=2&page=2')).body;
      const p3 = (await admin.get('/api/admin/sellers?limit=2&page=3')).body;
      expect(names(p1)).toEqual(['Closed Down', 'Blocked Foods']);
      expect(names(p2)).toEqual(['Idle Bites', 'Mama T Kitchen']);
      expect(names(p3)).toEqual(['Old Seller (no status)']);
      expect(p1.pagination).toEqual({ page: 1, limit: 2, total: 5, totalPages: 3 });
      expect((await admin.get('/api/admin/sellers?limit=2&page=9')).body.sellers).toEqual([]);
    });

    it('rejects a bad page or limit (limit above 100, 0, decimals)', async () => {
      for (const q of ['limit=101', 'limit=0', 'page=0', 'page=2.5', 'limit=abc', 'page=-1']) {
        const res = await admin.get(`/api/admin/sellers?${q}`);
        expect(res.status, q).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
    });
  });

  describe('GET /sellers/:id', () => {
    it('profile, menus, order counts by status and the last order', async () => {
      const { body } = await admin.get(`/api/admin/sellers/${ids.s1}`);
      expect(body).toMatchObject({ businessName: 'Mama T Kitchen', status: 'active', email: 'mama@example.com' });
      expect(body.orders).toMatchObject({ total: 7, pending: 2, paid: 2, out_for_delivery: 1, delivered: 1, cancelled: 1 });
      expect(body.orders.lastOrderAt).toEqual(expect.any(String));
      expect(body.menus.map((m: { title: string }) => m.title).sort()).toEqual(['Last week', 'This week']);
      expect(body.menus.find((m: { title: string }) => m.title === 'This week')).toMatchObject({ status: 'open', itemCount: 1 });
      expect(body.lastActiveAt).toEqual(expect.any(String));
    });

    it('a seller with nothing yet has zero counts and a null last order', async () => {
      const { body } = await admin.get(`/api/admin/sellers/${ids.s5}`);
      expect(body.orders).toMatchObject({ total: 0, pending: 0, delivered: 0, lastOrderAt: null });
      expect(body.menus).toEqual([]);
      expect(body.status).toBe('deactivated');
    });

    it('a seller saved before statuses existed shows as active', async () => {
      expect((await admin.get(`/api/admin/sellers/${ids.s4}`)).body.status).toBe('active');
    });

    it('a malformed or unknown id is 404 SELLER_NOT_FOUND', async () => {
      for (const id of ['nope', '123', new Types.ObjectId().toString()]) {
        const res = await admin.get(`/api/admin/sellers/${id}`);
        expect(res.status, id).toBe(404);
        expect(res.body.error.code).toBe('SELLER_NOT_FOUND');
      }
    });
  });

  describe('suspend, deactivate, reinstate', () => {
    it('suspend needs a reason', async () => {
      for (const body of [{}, { reason: '' }, { reason: 'ab' }, { reason: '   ' }]) {
        const res = await admin.patch(`/api/admin/sellers/${ids.s1}/suspend`).send(body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
      expect((await SellerModel.collection.findOne({ _id: ids.s1 }))!.status).toBe('active');
      expect(await AdminAuditModel.countDocuments({})).toBe(0);
    });

    it('suspends: status, reason and time are saved, the audit trail has who/what/why, and nothing is deleted', async () => {
      const before = { orders: await OrderModel.countDocuments({}), menus: await MenuModel.countDocuments({}) };
      const res = await admin.patch(`/api/admin/sellers/${ids.s1}/suspend`).send({ reason: '  Repeated fake orders  ' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: ids.s1.toString(), status: 'suspended', statusReason: 'Repeated fake orders' });
      expect(res.body.statusChangedAt).toEqual(expect.any(String));

      const [entry] = await AdminAuditModel.find({}).lean();
      expect(entry).toMatchObject({ adminId: ADMIN, action: 'seller.suspend', targetId: ids.s1.toString(), reason: 'Repeated fake orders' });
      expect({ orders: await OrderModel.countDocuments({}), menus: await MenuModel.countDocuments({}) }).toEqual(before);
    });

    it('the suspended seller is blocked, hidden and gets no new orders; reinstating undoes it', async () => {
      await admin.patch(`/api/admin/sellers/${ids.s1}/suspend`).send({ reason: 'investigation' });
      const blocked = await asSeller('seller_1').get('/api/menus');
      expect(blocked.status).toBe(403);
      expect(blocked.body.error.code).toBe('ACCOUNT_SUSPENDED');
      expect((await request(app).get('/api/public/menu/mama-t')).status).toBe(404);

      const back = await admin.patch(`/api/admin/sellers/${ids.s1}/reinstate`).send({});
      expect(back.status).toBe(200);
      expect(back.body.status).toBe('active');
      expect(back.body.statusReason).toBeNull();
      expect((await asSeller('seller_1').get('/api/menus')).status).toBe(200);
      expect((await request(app).get('/api/public/menu/mama-t')).status).toBe(200);
      expect((await AdminAuditModel.find({}).sort({ createdAt: 1 }).lean()).map((e) => e.action)).toEqual(['seller.suspend', 'seller.reinstate']);
    });

    it('deactivates, and reinstates from deactivated', async () => {
      const res = await admin.patch(`/api/admin/sellers/${ids.s2}/deactivate`).send({ reason: 'closed their business' });
      expect(res.body.status).toBe('deactivated');
      expect((await asSeller('seller_2').get('/api/menus')).body.error.code).toBe('ACCOUNT_SUSPENDED');
      expect((await admin.patch(`/api/admin/sellers/${ids.s2}/reinstate`).send({ reason: 'they came back' })).body).toMatchObject({ status: 'active', statusReason: 'they came back' });
    });

    it('is idempotent: repeating a change returns the seller and adds no audit entry', async () => {
      await admin.patch(`/api/admin/sellers/${ids.s1}/suspend`).send({ reason: 'first reason' });
      const again = await admin.patch(`/api/admin/sellers/${ids.s1}/suspend`).send({ reason: 'second reason' });
      expect(again.status).toBe(200);
      expect(again.body.statusReason).toBe('first reason'); // unchanged
      expect(await AdminAuditModel.countDocuments({})).toBe(1);

      // Reinstating a seller who is already active (including one with no status stored) changes nothing.
      const active = await admin.patch(`/api/admin/sellers/${ids.s4}/reinstate`).send({});
      expect(active.status).toBe(200);
      expect(active.body.status).toBe('active');
      expect(await AdminAuditModel.countDocuments({})).toBe(1);
    });

    it('several admins suspending at once leave one clean suspended state', async () => {
      const results = await Promise.all(Array.from({ length: 6 }, () => admin.patch(`/api/admin/sellers/${ids.s1}/suspend`).send({ reason: 'at the same time' })));
      expect(results.every((r) => r.status === 200 && r.body.status === 'suspended')).toBe(true);
      const audits = await AdminAuditModel.countDocuments({ action: 'seller.suspend' });
      expect(audits).toBeGreaterThanOrEqual(1);
      expect(audits).toBeLessThanOrEqual(6);
    });

    it('if the audit entry cannot be written, the seller is NOT changed', async () => {
      vi.spyOn(AdminAuditModel, 'create').mockRejectedValueOnce(new Error('db down') as never);
      const res = await admin.patch(`/api/admin/sellers/${ids.s1}/suspend`).send({ reason: 'cannot be audited' });
      expect(res.status).toBe(500);
      expect((await SellerModel.collection.findOne({ _id: ids.s1 }))!.status).toBe('active');
    });

    it('unknown or malformed ids are 404', async () => {
      for (const action of ['suspend', 'deactivate', 'reinstate']) {
        for (const id of ['nope', new Types.ObjectId().toString()]) {
          const res = await admin.patch(`/api/admin/sellers/${id}/${action}`).send({ reason: 'abc def' });
          expect(res.status, `${action} ${id}`).toBe(404);
        }
      }
      expect(await AdminAuditModel.countDocuments({})).toBe(0);
    });
  });

  describe('GET /orders', () => {
    const refsOf = (body: { orders: { ref: string }[] }) => body.orders.map((o) => o.ref);
    const get = (query = '') => admin.get(`/api/admin/orders${query}`);

    it('lists orders from all sellers, newest first, with a total', async () => {
      const { body } = await get();
      expect(body.orders).toHaveLength(8);
      expect(body.pagination).toEqual({ page: 1, limit: 20, total: 8, totalPages: 1 });
      const times = body.orders.map((o: { createdAt: string }) => new Date(o.createdAt).getTime());
      expect(times).toEqual([...times].sort((a, b) => b - a));
    });

    it('shows value, payment status (confirmed by the seller), seller, menu and flags', async () => {
      const { body } = await get('?status=paid');
      const order = body.orders.find((o: { menu: { title: string } }) => o.menu.title === 'Last week');
      expect(order).toMatchObject({
        status: 'paid',
        total: 7000,
        portions: 2,
        paymentStatus: 'paid',
        paymentConfirmedBy: 'seller',
        seller: { id: ids.s1.toString(), businessName: 'Mama T Kitchen', slug: 'mama-t' },
        menu: { title: 'Last week' },
        customer: { name: 'Ada Obi', phone: '0803****567' },
        delivery: { area: 'Yaba', day: '2026-10-17' },
        flags: { possibleDuplicate: false, cancelled: false, failed: false },
      });
    });

    it('payment status: unpaid, paid, and paid_then_cancelled', async () => {
      const byStatus = async (status: string) => (await get(`?status=${status}`)).body.orders.map((o: { paymentStatus: string }) => o.paymentStatus);
      expect(await byStatus('pending')).toEqual(['unpaid', 'unpaid']);
      expect(await byStatus('delivered')).toEqual(['paid', 'paid']);
      expect(await byStatus('cancelled')).toEqual(['unpaid']); // cancelled before paying
      await OrderModel.collection.updateOne({ status: 'cancelled' }, { $set: { paidAt: new Date() } });
      expect(await byStatus('cancelled')).toEqual(['paid_then_cancelled']);
    });

    it('masks every phone, and never returns an address, note, delivery code, key hash or fingerprint', async () => {
      const json = JSON.stringify((await get()).body);
      expect(json).toContain('0803****567');
      for (const secret of ['+2348031234567', '08031234567', '8031234567', '12 Private Close', 'gate code', '482915', 'a'.repeat(64), 'b'.repeat(64), 'deliveryCode', 'accessKeyHash', 'fingerprint', 'address']) {
        expect(json, secret).not.toContain(secret);
      }
    });

    it('finds an order by reference: exact, any case, or the first characters', async () => {
      const all = refsOf((await get()).body);
      const one = all[0]!;
      expect(refsOf((await get(`?ref=${one}`)).body)).toEqual([one]);
      expect(refsOf((await get(`?ref=${one.toLowerCase()}`)).body)).toEqual([one]);
      expect(refsOf((await get('?ref=CL-AAAA')).body)).toHaveLength(8); // prefix
      expect(refsOf((await get('?ref=CL-ZZZZZ')).body)).toEqual([]);
      for (const bad of ['', 'x', '.*', 'CL-(', '%20']) {
        expect((await get(`?ref=${encodeURIComponent(bad)}`)).status, bad).toBe(400);
      }
    });

    it('filters by seller', async () => {
      expect((await get(`?sellerId=${ids.s4}`)).body.orders).toHaveLength(1);
      expect((await get(`?sellerId=${ids.s1}`)).body.orders).toHaveLength(7);
      expect((await get(`?sellerId=${ids.s2}`)).body.orders).toHaveLength(0);
      expect((await get('?sellerId=nope')).status).toBe(400);
    });

    it('filters by status: one, a comma list, repeated; bad status is 400', async () => {
      expect((await get('?status=delivered')).body.orders).toHaveLength(2);
      expect((await get('?status=paid,out_for_delivery')).body.orders).toHaveLength(3);
      expect((await get('?status=paid&status=cancelled')).body.orders).toHaveLength(3);
      expect((await get('?status=all')).status).toBe(400);
    });

    it('filters by date in Lagos time, both ends included', async () => {
      await OrderModel.collection.deleteMany({});
      const at = (iso: string) => ({ createdAt: new Date(iso), updatedAt: new Date(iso) });
      // 23:30 UTC on 17 Oct is 00:30 on 18 Oct in Lagos.
      await OrderModel.collection.insertMany([
        rawOrder({ ref: 'CL-AAAAB', seller: ids.s1, menu: ids.m1, status: 'paid', age: 0, extra: at('2026-10-17T22:59:00Z') }), // 23:59 on the 17th, Lagos
        rawOrder({ ref: 'CL-AAAAC', seller: ids.s1, menu: ids.m1, status: 'paid', age: 0, extra: at('2026-10-17T23:00:00Z') }), // 00:00 on the 18th
        rawOrder({ ref: 'CL-AAAAD', seller: ids.s1, menu: ids.m1, status: 'paid', age: 0, extra: at('2026-10-18T22:59:00Z') }), // 23:59 on the 18th
        rawOrder({ ref: 'CL-AAAAE', seller: ids.s1, menu: ids.m1, status: 'paid', age: 0, extra: at('2026-10-18T23:00:00Z') }), // 00:00 on the 19th
      ] as never);
      const on = async (q: string) => refsOf((await get(q)).body).sort();
      expect(await on('?from=2026-10-18&to=2026-10-18')).toEqual(['CL-AAAAC', 'CL-AAAAD']);
      expect(await on('?to=2026-10-17')).toEqual(['CL-AAAAB']);
      expect(await on('?from=2026-10-19')).toEqual(['CL-AAAAE']);
      expect((await get('?from=2026-10-20&to=2026-10-01')).status).toBe(400);
      expect((await get('?from=2026-13-01')).status).toBe(400);
    });

    it('flag=cancelled lists cancelled orders', async () => {
      const { body } = await get('?flag=cancelled');
      expect(body.orders).toHaveLength(1);
      expect(body.orders[0].flags.cancelled).toBe(true);
    });

    it('flag=duplicate lists possible duplicates', async () => {
      await OrderModel.collection.updateOne({ status: 'delivered', sellerId: ids.s4 }, { $set: { possibleDuplicate: true } });
      const { body } = await get('?flag=duplicate');
      expect(body.orders).toHaveLength(1);
      expect(body.orders[0].flags.possibleDuplicate).toBe(true);
    });

    it('flag=failed is pending AFTER the menu cut-off: the pending order on the open menu is not failed', async () => {
      const { body } = await get('?flag=failed');
      expect(body.orders).toHaveLength(1); // only the pending order on the closed "Last week" menu
      expect(body.orders[0]).toMatchObject({ status: 'pending', menu: { title: 'Last week' }, flags: { failed: true } });
      expect(body.pagination.total).toBe(1);
      const open = (await get('?status=pending')).body.orders.find((o: { menu: { title: string } }) => o.menu.title === 'This week');
      expect(open.flags.failed).toBe(false);
    });

    it('combines filters (seller + status + dates)', async () => {
      const { body } = await get(`?sellerId=${ids.s1}&status=paid&from=${new Date(NOW - 3 * DAY).toISOString().slice(0, 10)}`);
      expect(body.orders).toHaveLength(2);
    });

    it('paginates, and the total is the whole matching count', async () => {
      const p1 = (await get('?limit=3&page=1')).body;
      const p3 = (await get('?limit=3&page=3')).body;
      expect(p1.orders).toHaveLength(3);
      expect(p3.orders).toHaveLength(2);
      expect(p1.pagination).toEqual({ page: 1, limit: 3, total: 8, totalPages: 3 });
      expect(new Set([...refsOf(p1), ...refsOf((await get('?limit=3&page=2')).body), ...refsOf(p3)]).size).toBe(8);
      expect((await get('?limit=101')).status).toBe(400);
    });
  });

  describe('GET /orders/:ref', () => {
    const inTransit = () => OrderModel.collection.findOne({ status: 'out_for_delivery' }).then((o) => o!.ref as string);

    it('masks the phone and leaves out the address and note by default, and writes no audit entry', async () => {
      const ref = await inTransit();
      const { body, status } = await admin.get(`/api/admin/orders/${ref}`);
      expect(status).toBe(200);
      expect(body).toMatchObject({ ref, status: 'out_for_delivery', revealed: false, total: 7000, paymentStatus: 'paid', paymentConfirmedBy: 'seller' });
      expect(body.customer.phone).toBe('0803****567');
      expect(body.delivery).toEqual({ area: 'Yaba', day: '2026-10-17' });
      expect(body).not.toHaveProperty('note');
      expect(body.lines).toEqual([{ name: 'Jollof rice', unitPrice: 3500, qty: 2 }]);
      expect(await AdminAuditModel.countDocuments({})).toBe(0);
    });

    it('reveal=true returns the full phone, address and note, and writes an audit entry first', async () => {
      const ref = await inTransit();
      const { body } = await admin.get(`/api/admin/orders/${ref}?reveal=true`);
      expect(body.revealed).toBe(true);
      expect(body.customer.phone).toBe('+2348031234567');
      expect(body.delivery.address).toBe('12 Private Close, Yaba');
      expect(body.note).toBe('gate code is 4321');
      const [entry] = await AdminAuditModel.find({}).lean();
      expect(entry).toMatchObject({ adminId: ADMIN, action: 'order.reveal_phone', targetId: ref });
    });

    it('reveal=false is the same as no reveal; anything else is a 400', async () => {
      const ref = await inTransit();
      expect((await admin.get(`/api/admin/orders/${ref}?reveal=false`)).body.revealed).toBe(false);
      for (const bad of ['yes', '1', 'TRUE']) expect((await admin.get(`/api/admin/orders/${ref}?reveal=${bad}`)).status, bad).toBe(400);
      expect(await AdminAuditModel.countDocuments({})).toBe(0);
    });

    it('if the audit entry cannot be saved, nothing private is returned', async () => {
      const ref = await inTransit();
      vi.spyOn(AdminAuditModel, 'create').mockRejectedValueOnce(new Error('db down') as never);
      const res = await admin.get(`/api/admin/orders/${ref}?reveal=true`);
      expect(res.status).toBe(500);
      const json = JSON.stringify(res.body);
      expect(json).not.toContain('8031234567');
      expect(json).not.toContain('Private Close');
    });

    it('never contains the delivery code, the access key hash or the fingerprint, revealed or not', async () => {
      const ref = await inTransit();
      for (const query of ['', '?reveal=true']) {
        const json = JSON.stringify((await admin.get(`/api/admin/orders/${ref}${query}`)).body);
        for (const secret of ['482915', 'a'.repeat(64), 'b'.repeat(64), 'deliveryCode', 'accessKeyHash', 'fingerprint']) {
          expect(json, `${query} ${secret}`).not.toContain(secret);
        }
      }
    });

    it('shows the timeline and the failed flag for a pending order past its cut-off', async () => {
      const failed = (await admin.get('/api/admin/orders?flag=failed')).body.orders[0].ref;
      const { body } = await admin.get(`/api/admin/orders/${failed}`);
      expect(body.flags.failed).toBe(true);
      expect(body.timeline).toMatchObject({ paidAt: null, deliveredAt: null, cancelledAt: null });
      expect(body.timeline.createdAt).toEqual(expect.any(String));
    });

    it('lists similar orders (same customer, menu and items within 10 minutes) by reference only', async () => {
      const fp = 'c'.repeat(64);
      await OrderModel.collection.insertMany([
        rawOrder({ ref: 'CL-BBBBB', seller: ids.s1, menu: ids.m1, status: 'pending', age: 60_000, extra: { fingerprint: fp } }),
        rawOrder({ ref: 'CL-BBBBC', seller: ids.s1, menu: ids.m1, status: 'pending', age: 120_000, extra: { fingerprint: fp, possibleDuplicate: true } }),
        rawOrder({ ref: 'CL-BBBBD', seller: ids.s1, menu: ids.m1, status: 'pending', age: 3 * HOUR, extra: { fingerprint: fp } }),
      ] as never);
      const { body } = await admin.get('/api/admin/orders/CL-BBBBC');
      expect(body.flags.possibleDuplicate).toBe(true);
      expect(body.similarOrders.map((o: { ref: string }) => o.ref)).toEqual(['CL-BBBBB']);
      expect(JSON.stringify(body)).not.toContain(fp);
    });

    it('is not case-sensitive, and unknown or malformed references are 404', async () => {
      const ref = await inTransit();
      expect((await admin.get(`/api/admin/orders/${ref.toLowerCase()}`)).status).toBe(200);
      for (const bad of ['CL-ZZZZZ', 'nonsense', 'CL-00000']) {
        const res = await admin.get(`/api/admin/orders/${bad}`);
        expect(res.status, bad).toBe(404);
        expect(res.body.error.code).toBe('ORDER_NOT_FOUND');
      }
    });
  });
});
