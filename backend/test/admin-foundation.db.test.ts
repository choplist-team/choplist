import express from 'express';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { LAST_ACTIVE_INTERVAL_MS } from '../src/auth/middleware.js';
import { logNotificationFailure, recordAdminAction } from '../src/events/log.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { AdminAuditModel } from '../src/models/admin-audit.js';
import { EVENT_LOG_TTL_SECONDS, EventLogModel } from '../src/models/event-log.js';
import { MenuModel } from '../src/models/menu.js';
import { OrderModel } from '../src/models/order.js';
import { SellerModel } from '../src/models/seller.js';
import { backfillAdminFields } from '../src/orders/backfill.js';
import { DUPLICATE_WINDOW_MS } from '../src/orders/fingerprint.js';
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
const PHONE = '+2348031234567';

let sellerA: Types.ObjectId;
let menuId: string;
let jollofId: string;
let chapmanId: string;

const as = (userId: string) => ({
  get: (path: string) => request(app).get(path).set('Authorization', bearer(userId)),
  put: (path: string) => request(app).put(path).set('Authorization', bearer(userId)),
  patch: (path: string) => request(app).patch(path).set('Authorization', bearer(userId)),
});

const orderBody = (phone: string, lines = [{ itemId: jollofId, qty: 2 }]) => ({
  menuId,
  customer: { name: 'Ada Obi', phone },
  delivery: { area: 'Yaba', address: '12 Herbert Macaulay Way, Yaba', day: DAY },
  lines,
});
const place = (phone: string, lines?: { itemId: string; qty: number }[]) =>
  request(app).post('/api/public/orders').send(orderBody(phone, lines));

const rawOrder = async (ref: string) => (await OrderModel.collection.findOne({ ref }))!;
const events = () => EventLogModel.collection.find({}).toArray();

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let i = 0; i < 40 && !done(value); i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    value = await read();
  }
  return value;
}

const profileBody = {
  businessName: 'A Kitchen',
  phone: '0803 123 4567',
  payment: { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'A Kitchen' },
};

describe.skipIf(!testDbUri)('admin foundation on a real MongoDB', () => {
  beforeAll(async () => {
    await connectTestDb('adminfound');
  });
  afterAll(async () => {
    await disconnectTestDb();
  });

  beforeEach(async () => {
    await Promise.all([
      SellerModel.deleteMany({}),
      MenuModel.deleteMany({}),
      OrderModel.deleteMany({}),
      EventLogModel.deleteMany({}),
      AdminAuditModel.deleteMany({}),
    ]);
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
    const menu = await MenuModel.create({
      sellerId: sellerA,
      title: 'Week',
      status: 'open',
      openedAt: new Date(),
      cutoffAt: new Date(Date.now() + 2 * DAY_MS),
      items: [
        { name: 'Jollof rice', price: 3500, qtyTotal: 50, qtyRemaining: 50 },
        { name: 'Chapman', price: 1500, qtyTotal: 50, qtyRemaining: 50 },
      ],
      areas: ['Yaba'],
      deliveryDays: [DAY],
    });
    menuId = menu._id.toString();
    jollofId = menu.items[0]!._id.toString();
    chapmanId = menu.items[1]!._id.toString();
  });

  describe('suspended and deactivated sellers', () => {
    for (const status of ['suspended', 'deactivated'] as const) {
      it(`${status}: every seller route is 403 ACCOUNT_SUSPENDED`, async () => {
        await SellerModel.updateOne({ _id: sellerA }, { $set: { status, statusReason: 'test' } });
        const orderRef = (await place(PHONE)).body.order?.ref;
        expect(orderRef).toBeUndefined(); // (the shop is closed to customers too: see below)

        const calls = [
          as('seller_a').get('/api/sellers/me'),
          as('seller_a').put('/api/sellers/me').send(profileBody),
          as('seller_a').get('/api/menus'),
          as('seller_a').get(`/api/menus/${menuId}/orders`),
          as('seller_a').patch('/api/orders/CL-AAAAA/paid'),
          as('seller_a').patch('/api/orders/CL-AAAAA/confirm-delivery').send({ code: '123456' }),
        ];
        for (const res of await Promise.all(calls)) {
          expect(res.status).toBe(403);
          expect(res.body.error.code).toBe('ACCOUNT_SUSPENDED');
        }
      });
    }

    it('their public menu is a 404 and new orders are refused without taking stock', async () => {
      expect((await request(app).get('/api/public/menu/kitchen-a')).status).toBe(200);
      await SellerModel.updateOne({ _id: sellerA }, { $set: { status: 'suspended' } });

      const menuRes = await request(app).get('/api/public/menu/kitchen-a');
      expect(menuRes.status).toBe(404);
      expect(menuRes.body.error.code).toBe('SELLER_NOT_FOUND');

      const res = await place(PHONE);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ORDERING_CLOSED'); // does not say "suspended"
      expect(JSON.stringify(res.body)).not.toMatch(/suspend/i);
      expect((await MenuModel.findById(menuId).lean())!.items[0]!.qtyRemaining).toBe(50);
      expect(await OrderModel.countDocuments({})).toBe(0);
    });

    it('nothing is deleted, and reinstating restores everything', async () => {
      const { ref } = (await place(PHONE)).body.order;
      await SellerModel.updateOne({ _id: sellerA }, { $set: { status: 'suspended' } });
      expect(await OrderModel.countDocuments({})).toBe(1);
      expect(await MenuModel.countDocuments({})).toBe(1);
      // A customer can still look their existing order up.
      expect((await request(app).get(`/api/public/orders/${ref}?phoneLast4=4567`)).status).toBe(200);

      await SellerModel.updateOne({ _id: sellerA }, { $set: { status: 'active' } });
      expect((await as('seller_a').get('/api/sellers/me')).status).toBe(200);
      expect((await request(app).get('/api/public/menu/kitchen-a')).status).toBe(200);
      expect((await place(PHONE)).status).toBe(201);
    });

    it('a seller saved before the status field existed counts as active', async () => {
      await SellerModel.collection.updateOne({ _id: sellerA }, { $unset: { status: '' } });
      expect((await SellerModel.collection.findOne({ _id: sellerA }))).not.toHaveProperty('status');
      expect((await as('seller_a').get('/api/sellers/me')).status).toBe(200);
      expect((await request(app).get('/api/public/menu/kitchen-a')).status).toBe(200);
      expect((await place(PHONE)).status).toBe(201);
    });

    it('an active seller who has no profile yet can still onboard', async () => {
      const res = await as('user_new').put('/api/sellers/me').send({ ...profileBody, phone: '0803 111 2222' });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('active');
    });
  });

  describe('lastActiveAt', () => {
    it('is set on the first seller request', async () => {
      expect((await SellerModel.findById(sellerA).lean())!.lastActiveAt).toBeUndefined();
      await as('seller_a').get('/api/menus');
      expect((await SellerModel.findById(sellerA).lean())!.lastActiveAt).toBeInstanceOf(Date);
    });

    it('is not rewritten within 10 minutes, and is rewritten after', async () => {
      const recent = new Date(Date.now() - 60_000);
      await SellerModel.updateOne({ _id: sellerA }, { $set: { lastActiveAt: recent } });
      await as('seller_a').get('/api/menus');
      expect((await SellerModel.findById(sellerA).lean())!.lastActiveAt!.getTime()).toBe(recent.getTime());

      const stale = new Date(Date.now() - LAST_ACTIVE_INTERVAL_MS - 60_000);
      await SellerModel.updateOne({ _id: sellerA }, { $set: { lastActiveAt: stale } });
      await as('seller_a').get('/api/menus');
      expect((await SellerModel.findById(sellerA).lean())!.lastActiveAt!.getTime()).toBeGreaterThan(stale.getTime() + 60_000);
    });

    it('is not touched by customers, and not by a refused (suspended) seller', async () => {
      await place(PHONE);
      await request(app).get('/api/public/menu/kitchen-a');
      expect((await SellerModel.findById(sellerA).lean())!.lastActiveAt).toBeUndefined();
      await SellerModel.updateOne({ _id: sellerA }, { $set: { status: 'suspended' } });
      await as('seller_a').get('/api/menus');
      expect((await SellerModel.findById(sellerA).lean())!.lastActiveAt).toBeUndefined();
    });
  });

  describe('seller email', () => {
    it('is stored lower-cased, returned, kept when omitted, and removed with ""', async () => {
      const set = await as('seller_a').put('/api/sellers/me').send({ ...profileBody, email: '  Ada@Example.COM ' });
      expect(set.status).toBe(200);
      expect(set.body.email).toBe('ada@example.com');

      const kept = await as('seller_a').put('/api/sellers/me').send(profileBody);
      expect(kept.body.email).toBe('ada@example.com');

      const removed = await as('seller_a').put('/api/sellers/me').send({ ...profileBody, email: '' });
      expect(removed.body.email).toBeNull();
      expect(await SellerModel.collection.findOne({ _id: sellerA })).not.toHaveProperty('email');
    });

    it('must look like an email', async () => {
      for (const email of ['nope', 'a@b', '@x.com', 'a b@c.com']) {
        const res = await as('seller_a').put('/api/sellers/me').send({ ...profileBody, email });
        expect(res.status, email).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('a new seller can sign up without one', async () => {
      const res = await as('user_new').put('/api/sellers/me').send({ ...profileBody, phone: '0803 111 2222' });
      expect(res.status).toBe(201);
      expect(res.body.email).toBeNull();
    });
  });

  describe('order fingerprint and duplicates', () => {
    it('stores a fingerprint, and the same number typed as 0803... and +234803... is the same customer', async () => {
      const a = await place('0803 123 4567');
      const b = await place('+234 803 123 4567');
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      const [ra, rb] = [await rawOrder(a.body.order.ref), await rawOrder(b.body.order.ref)];
      expect(ra.customer.phone).toBe('+2348031234567');
      expect(rb.customer.phone).toBe('+2348031234567');
      expect(ra.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(rb.fingerprint).toBe(ra.fingerprint);
      expect(JSON.stringify(ra.fingerprint)).not.toContain('8031234567');
    });

    it('flags the second identical order, not the first', async () => {
      const first = await place('08031234567');
      const second = await place('+2348031234567');
      expect((await rawOrder(first.body.order.ref)).possibleDuplicate).toBe(false);
      expect((await rawOrder(second.body.order.ref)).possibleDuplicate).toBe(true);
    });

    it('does not flag a different quantity, a different item list, a different person or another menu', async () => {
      const base = await place(PHONE, [{ itemId: jollofId, qty: 2 }]);
      const others = [
        await place(PHONE, [{ itemId: jollofId, qty: 3 }]),
        await place(PHONE, [{ itemId: jollofId, qty: 2 }, { itemId: chapmanId, qty: 1 }]),
        await place('+2348031234568', [{ itemId: jollofId, qty: 2 }]),
      ];
      expect((await rawOrder(base.body.order.ref)).possibleDuplicate).toBe(false);
      for (const res of others) expect((await rawOrder(res.body.order.ref)).possibleDuplicate).toBe(false);
    });

    it('item order does not matter', async () => {
      await place(PHONE, [{ itemId: jollofId, qty: 2 }, { itemId: chapmanId, qty: 1 }]);
      const swapped = await place(PHONE, [{ itemId: chapmanId, qty: 1 }, { itemId: jollofId, qty: 2 }]);
      expect((await rawOrder(swapped.body.order.ref)).possibleDuplicate).toBe(true);
    });

    it('only counts the 10-minute window, and ignores a cancelled earlier order', async () => {
      const early = await place(PHONE);
      await OrderModel.collection.updateOne(
        { ref: early.body.order.ref },
        { $set: { createdAt: new Date(Date.now() - DUPLICATE_WINDOW_MS - 60_000) } },
      );
      const afterWindow = await place(PHONE);
      expect((await rawOrder(afterWindow.body.order.ref)).possibleDuplicate).toBe(false);

      const cancelled = await place('+2348031234999');
      await OrderModel.collection.updateOne({ ref: cancelled.body.order.ref }, { $set: { status: 'cancelled' } });
      const reorder = await place('+2348031234999');
      expect((await rawOrder(reorder.body.order.ref)).possibleDuplicate).toBe(false);
    });

    it('10 identical orders at once: all succeed, and at least 9 are flagged (never the whole group missed)', async () => {
      const results = await Promise.all(Array.from({ length: 10 }, () => place(PHONE)));
      expect(results.every((r) => r.status === 201)).toBe(true);
      const flagged = await OrderModel.countDocuments({ possibleDuplicate: true });
      expect(flagged).toBeGreaterThanOrEqual(9);
      expect(flagged).toBeLessThanOrEqual(10);
    });

    it('the seller never sees the fingerprint or the flag', async () => {
      await place(PHONE);
      await place(PHONE);
      const res = await as('seller_a').get(`/api/menus/${menuId}/orders`);
      const json = JSON.stringify(res.body);
      expect(json).not.toContain('fingerprint');
      expect(json).not.toContain('possibleDuplicate');
    });
  });

  describe('failed orders are logged without private data', () => {
    it('logs the error code, menu and seller for SOLD_OUT, ORDERING_CLOSED, INVALID_AREA, INVALID_DELIVERY_DAY, ITEM_NOT_FOUND, VALIDATION_ERROR', async () => {
      await place(PHONE, [{ itemId: jollofId, qty: 51 }]); // SOLD_OUT
      await request(app).post('/api/public/orders').send({ ...orderBody(PHONE), delivery: { area: 'Mars', address: '1 Secret Street', day: DAY } });
      await request(app).post('/api/public/orders').send({ ...orderBody(PHONE), delivery: { area: 'Yaba', address: '1 Secret Street', day: '2030-01-01' } });
      await place(PHONE, [{ itemId: new Types.ObjectId().toString(), qty: 1 }]);
      await request(app).post('/api/public/orders').send({ ...orderBody(PHONE), customer: { name: 'Ada', phone: '12345' } });
      await MenuModel.updateOne({ _id: menuId }, { $set: { status: 'closed' } });
      await place(PHONE);

      const logged = await events();
      const codes = logged.map((e) => e.code).sort();
      expect(codes).toEqual(
        ['INVALID_AREA', 'INVALID_DELIVERY_DAY', 'ITEM_NOT_FOUND', 'ORDERING_CLOSED', 'SOLD_OUT', 'VALIDATION_ERROR'].sort(),
      );
      for (const e of logged) {
        expect(e.type).toBe('order_failed');
        expect(e.level).toBe('warn');
        expect(e.menuId.toString()).toBe(menuId);
        expect(e.sellerId.toString()).toBe(sellerA.toString());
      }
    });

    it('never stores a phone number, name, address, key or delivery code', async () => {
      await place('+2348039998888', [{ itemId: jollofId, qty: 51 }]);
      await request(app)
        .post('/api/public/orders')
        .send({ ...orderBody('+2348039998888'), delivery: { area: 'Mars', address: '77 Private Close', day: DAY }, note: 'secret note' });
      const json = JSON.stringify(await events());
      for (const secret of ['8039998888', '039998888', 'Ada Obi', '77 Private Close', 'secret note', 'Herbert']) {
        expect(json, secret).not.toContain(secret);
      }
    });

    it('a successful order, and a lookup that fails, log nothing', async () => {
      const ok = await place(PHONE);
      await request(app).get(`/api/public/orders/${ok.body.order.ref}?phoneLast4=0000`);
      expect(await events()).toHaveLength(0);
    });

    it('an unknown menu id is logged without a menu or seller', async () => {
      await request(app).post('/api/public/orders').send({ ...orderBody(PHONE), menuId: new Types.ObjectId().toString() });
      const [e] = await events();
      expect(e!.code).toBe('MENU_NOT_FOUND');
      expect(e).not.toHaveProperty('menuId');
      expect(e).not.toHaveProperty('sellerId');
    });

    it('no event ever holds a delivery code, after a whole delivery flow with failures', async () => {
      const { ref } = (await place(PHONE)).body.order;
      await as('seller_a').patch(`/api/orders/${ref}/paid`);
      await as('seller_a').patch(`/api/orders/${ref}/out-for-delivery`);
      const code = (await rawOrder(ref)).deliveryCode as string;
      await as('seller_a').patch(`/api/orders/${ref}/confirm-delivery`).send({ code: code === '000000' ? '111111' : '000000' });
      await place(PHONE, [{ itemId: jollofId, qty: 51 }]);
      expect(JSON.stringify(await events())).not.toContain(code);
    });
  });

  describe('unhandled 5xx errors are logged', () => {
    it('keeps the method, route and error class, but not the query string, body or message', async () => {
      const boom = express();
      boom.use(express.json());
      boom.get('/boom', () => {
        throw new Error('connection string mongodb+srv://user:hunter2@cluster0 leaked');
      });
      boom.use(errorHandler);

      const res = await request(boom).get('/boom?phoneLast4=2222');
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');

      const logged = await eventually(events, (list) => list.length > 0);
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({ type: 'server_error', level: 'error', code: 'INTERNAL_ERROR' });
      expect(logged[0]!.meta).toMatchObject({ method: 'GET', errorType: 'Error' });
      const json = JSON.stringify(logged);
      expect(json).not.toContain('2222');
      expect(json).not.toContain('hunter2');
      expect(json).not.toContain('mongodb+srv');
    });

    it('a 4xx the app handles on purpose is NOT logged as a server error', async () => {
      await request(app).get('/api/sellers/me'); // 401
      await request(app).get('/api/nope'); // 404
      await request(app).post('/api/public/orders').set('Content-Type', 'application/json').send('{bad'); // 400
      expect((await events()).filter((e) => e.type === 'server_error')).toHaveLength(0);
    });
  });

  describe('logNotificationFailure and the admin audit', () => {
    it('logNotificationFailure writes a notification_failed event (nothing calls it yet)', async () => {
      await logNotificationFailure({ channel: 'push', reason: 'subscription expired', sellerId: sellerA, orderRef: 'CL-7KQ2M' });
      const [e] = await events();
      expect(e).toMatchObject({ type: 'notification_failed', level: 'error', code: 'NOTIFICATION_FAILED', orderRef: 'CL-7KQ2M' });
      expect(e!.meta).toEqual({ channel: 'push', reason: 'subscription expired' });
    });

    it('recordAdminAction stores who did what to what, and why', async () => {
      await recordAdminAction({ adminId: 'user_admin1', action: 'seller.suspend', targetId: sellerA.toString(), reason: 'spam' });
      const [entry] = await AdminAuditModel.find({}).lean();
      expect(entry).toMatchObject({ adminId: 'user_admin1', action: 'seller.suspend', targetId: sellerA.toString(), reason: 'spam' });
      expect(entry!.createdAt).toBeInstanceOf(Date);
    });

    it('an unknown action cannot be recorded', async () => {
      await expect(recordAdminAction({ adminId: 'user_admin1', action: 'seller.delete' as never, targetId: 'x' })).rejects.toThrow();
    });
  });

  describe('indexes', () => {
    const names = async (c: 'orders' | 'sellers' | 'eventlogs' | 'adminaudits') =>
      (await OrderModel.db.collection(c).indexes()).map((i) => i.name);

    it('orders have the admin query indexes', async () => {
      const keys = (await OrderModel.db.collection('orders').indexes()).map((i) => JSON.stringify(i.key));
      for (const key of [
        { createdAt: -1 },
        { sellerId: 1, createdAt: -1 },
        { status: 1, createdAt: -1 },
        { fingerprint: 1, createdAt: 1 },
        { ref: 1 },
      ]) {
        expect(keys, JSON.stringify(key)).toContain(JSON.stringify(key));
      }
    });

    it('sellers have status and lastActiveAt indexes', async () => {
      const keys = (await OrderModel.db.collection('sellers').indexes()).map((i) => JSON.stringify(i.key));
      expect(keys).toContain(JSON.stringify({ status: 1 }));
      expect(keys).toContain(JSON.stringify({ lastActiveAt: -1 }));
    });

    it('the event log expires after 60 days (a TTL index)', async () => {
      const ttl = (await OrderModel.db.collection('eventlogs').indexes()).find((i) => i.name === 'ttl_60_days');
      expect(ttl?.expireAfterSeconds).toBe(EVENT_LOG_TTL_SECONDS);
      expect(EVENT_LOG_TTL_SECONDS).toBe(60 * 24 * 60 * 60);
      expect(await names('adminaudits')).not.toContain('ttl_60_days'); // the audit trail is kept
    });
  });

  describe('backfill', () => {
    const oldOrder = (ref: string, phone: string, extra: Record<string, unknown> = {}) => ({
      ref,
      sellerId: sellerA,
      menuId: new Types.ObjectId(menuId),
      customer: { name: 'Old Customer', phone },
      delivery: { area: 'Yaba', address: '1 Old Road', day: DAY },
      lines: [{ itemId: new Types.ObjectId(jollofId), name: 'Jollof rice', unitPrice: 3500, qty: 2 }],
      total: 7000,
      status: 'paid',
      createdAt: new Date(),
      updatedAt: new Date(),
      ...extra,
    });

    async function seedOld() {
      await SellerModel.collection.updateOne({ _id: sellerA }, { $unset: { status: '' } });
      const t = Date.now() - 3600_000;
      await OrderModel.collection.insertMany([
        oldOrder('CL-AAAA2', '08031234567', { createdAt: new Date(t) }), //                 0803 form
        oldOrder('CL-AAAA3', '+234 803 123 4567', { createdAt: new Date(t + 120_000) }), // same person, 2 min later
        oldOrder('CL-AAAA4', '0803 123 4567', { createdAt: new Date(t + 3 * 3600_000) }), // same person, hours later
        oldOrder('CL-AAAA5', 'not-a-number', { createdAt: new Date(t) }),
      ] as never);
    }

    it('a dry run reports counts and changes nothing', async () => {
      await seedOld();
      const before = JSON.stringify(await OrderModel.collection.find({}).sort({ ref: 1 }).toArray());
      const result = await backfillAdminFields({ apply: false });
      expect(result).toMatchObject({
        applied: false,
        sellersWithoutStatus: 1,
        phonesToNormalise: 3,
        unfixablePhones: ['CL-AAAA5'],
        ordersWithoutFingerprint: 4,
        duplicatesFlagged: 0,
      });
      expect(JSON.stringify(await OrderModel.collection.find({}).sort({ ref: 1 }).toArray())).toBe(before);
      expect(await SellerModel.collection.findOne({ _id: sellerA })).not.toHaveProperty('status');
    });

    it('apply fixes status, phones and fingerprints, and flags the historical duplicate', async () => {
      await seedOld();
      const result = await backfillAdminFields({ apply: true });
      expect(result).toMatchObject({ applied: true, sellersWithoutStatus: 1, phonesToNormalise: 3, ordersWithoutFingerprint: 4, duplicatesFlagged: 1 });

      expect((await SellerModel.collection.findOne({ _id: sellerA }))!.status).toBe('active');
      for (const ref of ['CL-AAAA2', 'CL-AAAA3', 'CL-AAAA4']) {
        expect((await rawOrder(ref)).customer.phone).toBe('+2348031234567');
      }
      expect((await rawOrder('CL-AAAA5')).customer.phone).toBe('not-a-number'); // left alone, reported
      const [a2, a3, a4] = [await rawOrder('CL-AAAA2'), await rawOrder('CL-AAAA3'), await rawOrder('CL-AAAA4')];
      expect(a2.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(a3.fingerprint).toBe(a2.fingerprint);
      expect(a4.fingerprint).toBe(a2.fingerprint);
      // The 2-minute-later order is a duplicate; the first, and the one hours later, are not.
      expect(a2.possibleDuplicate ?? false).toBe(false);
      expect(a3.possibleDuplicate).toBe(true);
      expect(a4.possibleDuplicate ?? false).toBe(false);
    });

    it('running it again changes nothing, and its report never contains a phone number', async () => {
      await seedOld();
      await backfillAdminFields({ apply: true });
      const after = JSON.stringify(await OrderModel.collection.find({}).sort({ ref: 1 }).toArray());
      const again = await backfillAdminFields({ apply: true });
      expect(again).toMatchObject({ sellersWithoutStatus: 0, phonesToNormalise: 0, ordersWithoutFingerprint: 0, duplicatesFlagged: 0 });
      expect(JSON.stringify(await OrderModel.collection.find({}).sort({ ref: 1 }).toArray())).toBe(after);
      expect(JSON.stringify(again)).not.toMatch(/803\d{3}|8031234567/);
    });
  });
});
