import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { logEvent, logNotificationFailure } from '../src/events/log.js';
import { AdminAuditModel } from '../src/models/admin-audit.js';
import { EventLogModel } from '../src/models/event-log.js';
import { MenuModel } from '../src/models/menu.js';
import { MenuViewDailyModel } from '../src/models/menu-view-daily.js';
import { MissingOrderReportModel } from '../src/models/missing-order-report.js';
import { OrderModel } from '../src/models/order.js';
import { SellerModel } from '../src/models/seller.js';
import { lagosDay } from '../src/validation/day.js';
import { connectTestDb, disconnectTestDb, testDbUri } from './helpers/db.js';
import { bearer, fakeAuth } from './helpers/fake-auth.js';

const ADMIN = 'user_admin1';
const makeApp = (reportsPerWindow = 10_000) =>
  createApp({
    allowedOrigins: ['http://localhost:5173'],
    auth: fakeAuth,
    adminClerkUserIds: [ADMIN, 'user_admin2'],
    rateLimits: { windowMs: 60_000, ordersPerWindow: 10_000, lookupsPerWindow: 10_000, viewsPerWindow: 10_000, reportsPerWindow },
  });
const app = makeApp();
const admin = {
  get: (path: string) => request(app).get(path).set('Authorization', bearer(ADMIN)),
  patch: (path: string) => request(app).patch(path).set('Authorization', bearer(ADMIN)),
};

const DAY = 86_400_000;
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms);
const payment = { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Acct' };
const ids = { a: new Types.ObjectId(), b: new Types.ObjectId(), menuA: new Types.ObjectId(), menuB: new Types.ObjectId(), item: new Types.ObjectId() };

const report = (body: Record<string, unknown>, a = app) => request(a).post('/api/public/orders/report-missing').send(body);

function rawOrder(ref: string, o: { seller: Types.ObjectId; menu: Types.ObjectId; phone: string; age: number; extra?: Record<string, unknown> }) {
  const at = ago(o.age);
  return {
    ref, sellerId: o.seller, menuId: o.menu,
    customer: { name: 'Ada Obi', phone: o.phone },
    delivery: { area: 'Yaba', address: '12 Private Close', day: '2026-11-01' },
    lines: [{ itemId: ids.item, name: 'Jollof rice', unitPrice: 3500, qty: 2 }], total: 7000, status: 'paid', paidAt: at,
    deliveryCodeAttempts: 0, deliveryCodeResets: 0, possibleDuplicate: false, createdAt: at, updatedAt: at, ...o.extra,
  };
}

describe.skipIf(!testDbUri)('admin health, events and missing-order reports on a real MongoDB', () => {
  beforeAll(async () => {
    await connectTestDb('adminhealth');
  });
  afterAll(async () => {
    await disconnectTestDb();
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await Promise.all([
      SellerModel.deleteMany({}), MenuModel.deleteMany({}), OrderModel.deleteMany({}), EventLogModel.deleteMany({}),
      AdminAuditModel.deleteMany({}), MissingOrderReportModel.deleteMany({}), MenuViewDailyModel.deleteMany({}),
    ]);
    await SellerModel.collection.insertMany([
      { _id: ids.a, clerkUserId: 'seller_a', businessName: 'Seller A', slug: 'seller-a', phone: '+2348031230001', payment, status: 'active', createdAt: new Date(), updatedAt: new Date() },
      { _id: ids.b, clerkUserId: 'seller_b', businessName: 'Seller B', slug: 'seller-b', phone: '+2348031230002', payment, status: 'active', createdAt: new Date(), updatedAt: new Date() },
    ] as never);
    const menu = (_id: Types.ObjectId, sellerId: Types.ObjectId) => ({
      _id, sellerId, title: 'Menu', status: 'open', cutoffAt: new Date(Date.now() + 2 * DAY),
      items: [{ _id: ids.item, name: 'Jollof rice', price: 3500, qtyTotal: 100, qtyRemaining: 50 }],
      areas: ['Yaba'], deliveryDays: [lagosDay(new Date(Date.now() + 3 * DAY))], createdAt: new Date(), updatedAt: new Date(),
    });
    await MenuModel.collection.insertMany([menu(ids.menuA, ids.a), menu(ids.menuB, ids.b)] as never);
  });

  // ---------------------------------------------------------------------------
  describe('POST /api/public/orders/report-missing', () => {
    it('stores the report with what the customer said and what the system found, and answers 201 { received: true }', async () => {
      await OrderModel.collection.insertOne(rawOrder('CL-AAAAB', { seller: ids.a, menu: ids.menuA, phone: '+2348031234567', age: HOUR }) as never);
      const res = await report({ ref: 'cl-aaaab', phoneLast4: '4567', menuSlug: 'seller-a', message: 'I paid at 3pm and nothing came.' });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ received: true });

      const [row] = await MissingOrderReportModel.collection.find({}).toArray();
      expect(row).toMatchObject({
        ref: 'CL-AAAAB', phoneLast4: '4567', menuSlug: 'seller-a', message: 'I paid at 3pm and nothing came.',
        status: 'open', orderFound: true, matchedOrderRef: 'CL-AAAAB',
      });
      expect(row!.sellerId.toString()).toBe(ids.a.toString());
      expect(row!.createdAt).toBeInstanceOf(Date);
    });

    it('answers IDENTICALLY whether or not an order matched, so the form cannot be used to probe references', async () => {
      await OrderModel.collection.insertOne(rawOrder('CL-AAAAB', { seller: ids.a, menu: ids.menuA, phone: '+2348031234567', age: HOUR }) as never);
      const found = await report({ ref: 'CL-AAAAB', message: 'Where is my food please' });
      const notFound = await report({ ref: 'CL-ZZZZZ', message: 'Where is my food please' });
      expect(found.status).toBe(notFound.status);
      expect(found.body).toEqual(notFound.body);
      expect(found.headers['content-length']).toBe(notFound.headers['content-length']);
      const rows = await MissingOrderReportModel.find({}).sort({ createdAt: 1 }).lean();
      expect(rows.map((r) => r.orderFound)).toEqual([true, false]); // the admin still knows
    });

    it('a reference with the wrong last 4 digits is not a match', async () => {
      await OrderModel.collection.insertOne(rawOrder('CL-AAAAB', { seller: ids.a, menu: ids.menuA, phone: '+2348031234567', age: HOUR }) as never);
      await report({ ref: 'CL-AAAAB', phoneLast4: '9999', message: 'This is not my order' });
      expect((await MissingOrderReportModel.findOne({}).lean())!.orderFound).toBe(false);
    });

    it('last 4 digits alone: one recent match is named, several are "found" but not named, none is not found', async () => {
      await OrderModel.collection.insertOne(rawOrder('CL-AAAAB', { seller: ids.a, menu: ids.menuA, phone: '+2348031234567', age: HOUR }) as never);
      await report({ phoneLast4: '4567', message: 'one match expected' });
      await OrderModel.collection.insertOne(rawOrder('CL-AAAAC', { seller: ids.b, menu: ids.menuB, phone: '+2347011114567', age: 2 * HOUR }) as never);
      await report({ phoneLast4: '4567', message: 'two matches now' });
      await report({ phoneLast4: '0000', message: 'no match at all' });
      const rows = await MissingOrderReportModel.find({}).sort({ createdAt: 1 }).lean();
      expect(rows[0]).toMatchObject({ orderFound: true, matchedOrderRef: 'CL-AAAAB' });
      expect(rows[1]!.orderFound).toBe(true);
      expect(rows[1]!.matchedOrderRef).toBeUndefined(); // ambiguous
      expect(rows[2]!.orderFound).toBe(false);
    });

    it('digits alone only look at recent orders (7 days), or 30 with a shop link', async () => {
      await OrderModel.collection.insertOne(rawOrder('CL-AAAAB', { seller: ids.a, menu: ids.menuA, phone: '+2348031234567', age: 10 * DAY }) as never);
      await report({ phoneLast4: '4567', message: 'ordered ten days ago' });
      await report({ phoneLast4: '4567', menuSlug: 'seller-a', message: 'ordered ten days ago, from this shop' });
      const rows = await MissingOrderReportModel.find({}).sort({ createdAt: 1 }).lean();
      expect(rows.map((r) => r.orderFound)).toEqual([false, true]);
    });

    it("a shop link limits the search to that shop's orders", async () => {
      await OrderModel.collection.insertOne(rawOrder('CL-AAAAB', { seller: ids.b, menu: ids.menuB, phone: '+2348031234567', age: HOUR }) as never);
      await report({ phoneLast4: '4567', menuSlug: 'seller-a', message: 'wrong shop on purpose' });
      expect((await MissingOrderReportModel.findOne({}).lean())!.orderFound).toBe(false);
    });

    it('an unknown shop link is not an error (that would reveal which links exist)', async () => {
      const res = await report({ ref: 'CL-AAAAB', menuSlug: 'no-such-shop', message: 'Where is my food please' });
      expect(res.status).toBe(201);
      expect((await MissingOrderReportModel.findOne({}).lean())!.sellerId).toBeUndefined();
    });

    it('never stores a whole phone number: only 4 digits are accepted, and a full number is rejected', async () => {
      for (const phoneLast4 of ['08031234567', '+2348031234567', '2348031234567']) {
        const res = await report({ phoneLast4, message: 'Where is my food please' });
        expect(res.status, phoneLast4).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
      expect(await MissingOrderReportModel.countDocuments({})).toBe(0);
    });

    it('rejects a report with neither reference nor digits, and a too-short or too-long message', async () => {
      for (const body of [{ message: 'no way to find it' }, { ref: 'CL-AAAAB', message: 'no' }, { ref: 'CL-AAAAB', message: 'x'.repeat(501) }, {}]) {
        expect((await report(body)).status, JSON.stringify(body).slice(0, 40)).toBe(400);
      }
      expect(await MissingOrderReportModel.countDocuments({})).toBe(0);
    });

    it('cannot be used to set the status, who resolved it, or the match result', async () => {
      await report({ ref: 'CL-AAAAB', message: 'Where is my food please', status: 'resolved', resolvedBy: 'me', orderFound: true, matchedOrderRef: 'CL-AAAAB' });
      expect(await MissingOrderReportModel.findOne({}).lean()).toMatchObject({ status: 'open', orderFound: false });
      expect((await MissingOrderReportModel.findOne({}).lean())!.resolvedBy).toBeUndefined();
    });

    it('is rate limited per network (the 3rd report in a window is 429) and refused ones are not stored', async () => {
      const limited = makeApp(2);
      const statuses = [];
      for (let i = 0; i < 4; i++) statuses.push((await report({ ref: 'CL-AAAAB', message: 'Where is my food please' }, limited)).status);
      expect(statuses).toEqual([201, 201, 429, 429]);
      expect(await MissingOrderReportModel.countDocuments({})).toBe(2);
    });

    it('writes a troubleshooting event with the result, but not the message or the digits', async () => {
      await OrderModel.collection.insertOne(rawOrder('CL-AAAAB', { seller: ids.a, menu: ids.menuA, phone: '+2348031234567', age: HOUR }) as never);
      await report({ ref: 'CL-AAAAB', phoneLast4: '4567', message: 'Private details about my gate' });
      const [event] = await EventLogModel.find({}).lean();
      expect(event).toMatchObject({ type: 'missing_order_report', level: 'warn', code: 'MISSING_ORDER_REPORT', orderRef: 'CL-AAAAB' });
      expect(event!.meta).toEqual({ orderFound: true });
      const json = JSON.stringify(event);
      expect(json).not.toContain('gate');
      expect(json).not.toContain('4567');
    });
  });

  // ---------------------------------------------------------------------------
  describe('GET /api/admin/health', () => {
    const ev = (type: string, code: string, age: number, level = 'warn') => ({ type, level, code, message: `${code}`, meta: {}, createdAt: ago(age) });

    it('counts the last 24 hours: failed submissions (by code), server errors, notification failures, open reports', async () => {
      await EventLogModel.collection.insertMany([
        ev('order_failed', 'SOLD_OUT', HOUR), ev('order_failed', 'SOLD_OUT', 5 * HOUR), ev('order_failed', 'ORDERING_CLOSED', 23 * HOUR),
        ev('order_failed', 'SOLD_OUT', 2 * DAY), // older than 24 hours: not counted
        ev('server_error', 'INTERNAL_ERROR', HOUR, 'error'), ev('server_error', 'INTERNAL_ERROR', 2 * HOUR, 'error'), ev('server_error', 'INTERNAL_ERROR', 3 * DAY, 'error'),
        ev('missing_order_report', 'MISSING_ORDER_REPORT', HOUR),
      ] as never);
      await MissingOrderReportModel.collection.insertMany([
        { message: 'open one', ref: 'CL-AAAAB', status: 'open', orderFound: false, createdAt: ago(HOUR) },
        { message: 'open two', phoneLast4: '1234', status: 'open', orderFound: false, createdAt: ago(3 * DAY) },
        { message: 'done', ref: 'CL-AAAAC', status: 'resolved', orderFound: true, createdAt: ago(2 * HOUR) },
      ] as never);

      const { body, status } = await admin.get('/api/admin/health');
      expect(status).toBe(200);
      expect(body.database).toBe('connected');
      expect(body.window.hours).toBe(24);
      expect(body.failedSubmissions).toEqual({ total: 3, byCode: { SOLD_OUT: 2, ORDERING_CLOSED: 1 } });
      expect(body.serverErrors).toBe(2);
      expect(body.notificationFailures).toBe(0);
      expect(body.openReports).toBe(2); // all time, not only the last 24 hours
      expect(body.reportsLast24h).toBe(2); // open one + done
    });

    it('notification failures are counted once something reports them, and the definition says nothing does yet', async () => {
      await logNotificationFailure({ channel: 'push', reason: 'expired subscription', sellerId: ids.a });
      const { body } = await admin.get('/api/admin/health');
      expect(body.notificationFailures).toBe(1);
      expect(body.definitions.notificationFailures).toMatch(/Nothing sends notifications yet/);
    });

    it('is all zeros on a quiet system', async () => {
      const { body } = await admin.get('/api/admin/health');
      expect(body).toMatchObject({ serverErrors: 0, notificationFailures: 0, openReports: 0, reportsLast24h: 0, failedSubmissions: { total: 0, byCode: {} } });
    });

    it('a really refused order shows up (end to end)', async () => {
      const res = await request(app).post('/api/public/orders').send({
        menuId: ids.menuA.toString(), customer: { name: 'Ada', phone: '08031234567' },
        delivery: { area: 'Yaba', address: '12 Herbert Macaulay Way', day: lagosDay(new Date(Date.now() + 3 * DAY)) },
        lines: [{ itemId: ids.item.toString(), qty: 99 }],
      });
      expect(res.status).toBe(409);
      expect((await admin.get('/api/admin/health')).body.failedSubmissions).toEqual({ total: 1, byCode: { SOLD_OUT: 1 } });
    });
  });

  // ---------------------------------------------------------------------------
  describe('GET /api/admin/events', () => {
    const get = (q = '') => admin.get(`/api/admin/events${q}`);
    async function seed() {
      await EventLogModel.collection.insertMany([
        { type: 'order_failed', level: 'warn', code: 'SOLD_OUT', message: 'm1', sellerId: ids.a, menuId: ids.menuA, meta: {}, createdAt: new Date('2026-10-27T12:00:00Z') },
        { type: 'order_failed', level: 'warn', code: 'ORDERING_CLOSED', message: 'm2', sellerId: ids.b, meta: {}, createdAt: new Date('2026-10-28T12:00:00Z') },
        { type: 'server_error', level: 'error', code: 'INTERNAL_ERROR', message: 'm3', meta: { method: 'GET', route: '/api/menus' }, createdAt: new Date('2026-10-29T12:00:00Z') },
        { type: 'notification_failed', level: 'error', code: 'NOTIFICATION_FAILED', message: 'm4', sellerId: ids.a, meta: { channel: 'push' }, createdAt: new Date('2026-10-29T13:00:00Z') },
      ] as never);
    }
    const codes = (body: { events: { code: string }[] }) => body.events.map((e) => e.code);

    it('lists events newest first, with a total', async () => {
      await seed();
      const { body } = await get();
      expect(codes(body)).toEqual(['NOTIFICATION_FAILED', 'INTERNAL_ERROR', 'ORDERING_CLOSED', 'SOLD_OUT']);
      expect(body.pagination).toEqual({ page: 1, limit: 20, total: 4, totalPages: 1 });
      expect(body.events[2]).toMatchObject({ type: 'order_failed', level: 'warn', sellerId: ids.b.toString(), menuId: null, orderRef: null });
      expect(body.events[1].meta).toEqual({ method: 'GET', route: '/api/menus' });
    });

    it('filters by type, level, seller and date, and combines them', async () => {
      await seed();
      expect(codes((await get('?type=order_failed')).body)).toEqual(['ORDERING_CLOSED', 'SOLD_OUT']);
      expect(codes((await get('?level=error')).body)).toEqual(['NOTIFICATION_FAILED', 'INTERNAL_ERROR']);
      expect(codes((await get(`?sellerId=${ids.a}`)).body)).toEqual(['NOTIFICATION_FAILED', 'SOLD_OUT']);
      expect(codes((await get('?from=2026-10-28&to=2026-10-28')).body)).toEqual(['ORDERING_CLOSED']);
      expect(codes((await get(`?sellerId=${ids.a}&level=error&from=2026-10-29`)).body)).toEqual(['NOTIFICATION_FAILED']);
      expect(codes((await get('?type=server_error&level=warn')).body)).toEqual([]);
    });

    it('paginates', async () => {
      await seed();
      const p1 = (await get('?limit=3&page=1')).body;
      const p2 = (await get('?limit=3&page=2')).body;
      expect(p1.events).toHaveLength(3);
      expect(p2.events).toHaveLength(1);
      expect(p1.pagination).toEqual({ page: 1, limit: 3, total: 4, totalPages: 2 });
    });

    it('rejects an unknown type or level, a bad seller id, a bad date, and a limit over 100', async () => {
      for (const q of ['?type=nope', '?level=fatal', '?sellerId=nope', '?from=2026-13-40', '?from=2026-10-20&to=2026-10-01', '?limit=101']) {
        const res = await get(q);
        expect(res.status, q).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('holds no private data after real failures, reports and server errors', async () => {
      await request(app).post('/api/public/orders').send({
        menuId: ids.menuA.toString(), customer: { name: 'Secret Name', phone: '08039998877' },
        delivery: { area: 'Mars', address: '77 Hidden Road', day: lagosDay(new Date(Date.now() + 3 * DAY)) },
        lines: [{ itemId: ids.item.toString(), qty: 1 }], note: 'secret note',
      });
      await report({ phoneLast4: '8877', message: 'secret message about my gate' });
      await logEvent({ type: 'server_error', level: 'error', code: 'INTERNAL_ERROR', message: 'x', meta: { phone: '08039998877', route: '/x', deliveryCode: '482915' } });
      const json = JSON.stringify((await get()).body);
      for (const secret of ['8039998877', '08039998877', '8877', 'Secret Name', '77 Hidden Road', 'secret note', 'secret message', '482915']) {
        expect(json, secret).not.toContain(secret);
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe('GET /api/admin/reports and PATCH /api/admin/reports/:id/resolve', () => {
    async function seed() {
      await OrderModel.collection.insertOne(rawOrder('CL-AAAAB', { seller: ids.a, menu: ids.menuA, phone: '+2348031234567', age: HOUR, extra: { deliveryCode: '482915', accessKeyHash: 'a'.repeat(64) } }) as never);
      const docs = [
        { ref: 'CL-AAAAB', phoneLast4: '4567', menuSlug: 'seller-a', message: 'oldest open', sellerId: ids.a, orderFound: true, matchedOrderRef: 'CL-AAAAB', status: 'open', createdAt: ago(3 * DAY) },
        { phoneLast4: '1111', message: 'newest open', orderFound: false, status: 'open', createdAt: ago(HOUR) },
        { ref: 'CL-AAAAC', message: 'already handled', orderFound: false, status: 'resolved', resolvedBy: ADMIN, resolvedAt: ago(2 * HOUR), resolutionNote: 'duplicate', createdAt: ago(DAY) },
      ];
      const res = await MissingOrderReportModel.collection.insertMany(docs as never);
      return Object.values(res.insertedIds).map(String);
    }
    const get = (q = '') => admin.get(`/api/admin/reports${q}`);
    const messages = (body: { reports: { message: string }[] }) => body.reports.map((r) => r.message);

    it('lists open reports first (newest first), then resolved ones, with what the system found', async () => {
      await seed();
      const { body, status } = await get();
      expect(status).toBe(200);
      expect(messages(body)).toEqual(['newest open', 'oldest open', 'already handled']);
      expect(body.pagination).toEqual({ page: 1, limit: 20, total: 3, totalPages: 1 });
      expect(body.reports[1]).toMatchObject({
        status: 'open', ref: 'CL-AAAAB', phoneLast4: '4567', menuSlug: 'seller-a', orderFound: true, matchedOrderRef: 'CL-AAAAB',
        seller: { id: ids.a.toString(), businessName: 'Seller A', slug: 'seller-a' }, resolvedBy: null,
      });
      expect(body.reports[0]).toMatchObject({ ref: null, seller: null, orderFound: false, matchedOrderRef: null });
      expect(body.reports[2]).toMatchObject({ status: 'resolved', resolvedBy: ADMIN, resolutionNote: 'duplicate' });
    });

    it('filters by status and paginates', async () => {
      await seed();
      expect(messages((await get('?status=open')).body)).toEqual(['newest open', 'oldest open']);
      expect(messages((await get('?status=resolved')).body)).toEqual(['already handled']);
      expect((await get('?status=closed')).status).toBe(400);
      const p1 = (await get('?limit=2&page=1')).body;
      const p2 = (await get('?limit=2&page=2')).body;
      expect(messages(p1)).toEqual(['newest open', 'oldest open']);
      expect(messages(p2)).toEqual(['already handled']);
      expect(p1.pagination).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
    });

    it('shows a report a customer just sent', async () => {
      await report({ phoneLast4: '2222', message: 'Fresh report from the site' });
      const { body } = await get();
      expect(body.reports).toHaveLength(1);
      expect(body.reports[0]).toMatchObject({ message: 'Fresh report from the site', phoneLast4: '2222', status: 'open' });
    });

    it('never contains a delivery code, key hash, full phone number or address', async () => {
      await seed();
      const json = JSON.stringify({ list: (await get()).body, health: (await admin.get('/api/admin/health')).body });
      for (const secret of ['482915', 'a'.repeat(64), 'deliveryCode', 'accessKeyHash', '8031234567', 'Private Close']) {
        expect(json, secret).not.toContain(secret);
      }
    });

    it('resolves a report: status, who and when are saved, and the audit trail records it with the note', async () => {
      const [openId] = (await seed()).slice(0, 1);
      const res = await admin.patch(`/api/admin/reports/${openId}/resolve`).send({ note: '  Seller confirmed it was delivered  ' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: openId, status: 'resolved', resolvedBy: ADMIN, resolutionNote: 'Seller confirmed it was delivered' });
      expect(res.body.resolvedAt).toEqual(expect.any(String));
      const [entry] = await AdminAuditModel.find({}).lean();
      expect(entry).toMatchObject({ adminId: ADMIN, action: 'report.resolve', targetId: openId, reason: 'Seller confirmed it was delivered' });
      expect((await admin.get('/api/admin/health')).body.openReports).toBe(1);
    });

    it('the note is optional', async () => {
      const [openId] = await seed();
      const res = await admin.patch(`/api/admin/reports/${openId}/resolve`).send({});
      expect(res.status).toBe(200);
      expect(res.body.resolutionNote).toBeNull();
      expect((await admin.patch(`/api/admin/reports/${openId}/resolve`)).status).toBe(200); // no body at all
    });

    it('is idempotent: resolving again keeps the first resolver and time, and adds no audit entry', async () => {
      const [openId] = await seed();
      const first = await admin.patch(`/api/admin/reports/${openId}/resolve`).send({ note: 'first' });
      const second = await request(app).patch(`/api/admin/reports/${openId}/resolve`).set('Authorization', bearer('user_admin2')).send({ note: 'second' });
      expect(second.status).toBe(200);
      expect(second.body.resolvedBy).toBe(ADMIN);
      expect(second.body.resolvedAt).toBe(first.body.resolvedAt);
      expect(second.body.resolutionNote).toBe('first');
      expect(await AdminAuditModel.countDocuments({})).toBe(1);
    });

    it('several admins resolving at once resolve it once', async () => {
      const [openId] = await seed();
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) => request(app).patch(`/api/admin/reports/${openId}/resolve`).set('Authorization', bearer(i % 2 ? 'user_admin2' : ADMIN)).send({})),
      );
      expect(results.every((r) => r.status === 200 && r.body.status === 'resolved')).toBe(true);
      expect(new Set(results.map((r) => r.body.resolvedBy)).size).toBe(1);
      expect(await MissingOrderReportModel.countDocuments({ status: 'resolved', _id: openId })).toBe(1);
    });

    it('if the audit entry cannot be written, the report stays open', async () => {
      const [openId] = await seed();
      vi.spyOn(AdminAuditModel, 'create').mockRejectedValueOnce(new Error('db down') as never);
      const res = await admin.patch(`/api/admin/reports/${openId}/resolve`).send({});
      expect(res.status).toBe(500);
      expect((await MissingOrderReportModel.findById(openId).lean())!.status).toBe('open');
    });

    it('unknown and malformed ids are 404 REPORT_NOT_FOUND; a note over 300 characters is 400', async () => {
      const [openId] = await seed();
      for (const id of ['nope', '123', new Types.ObjectId().toString()]) {
        const res = await admin.patch(`/api/admin/reports/${id}/resolve`).send({});
        expect(res.status, id).toBe(404);
        expect(res.body.error.code).toBe('REPORT_NOT_FOUND');
      }
      const long = await admin.patch(`/api/admin/reports/${openId}/resolve`).send({ note: 'x'.repeat(301) });
      expect(long.status).toBe(400);
      expect(await AdminAuditModel.countDocuments({})).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  describe('access', () => {
    const calls: [string, string][] = [
      ['get', '/api/admin/health'],
      ['get', '/api/admin/events'],
      ['get', '/api/admin/reports'],
      ['patch', `/api/admin/reports/${new Types.ObjectId()}/resolve`],
    ];

    it('401 without a token, 403 for sellers and other users, on every endpoint, and nothing changes', async () => {
      const id = (await MissingOrderReportModel.collection.insertOne({ message: 'open', status: 'open', orderFound: false, createdAt: new Date() } as never)).insertedId;
      for (const [method, path] of calls) {
        const target = path.includes('/reports/') ? `/api/admin/reports/${id}/resolve` : path;
        const anon = await request(app)[method as 'get' | 'patch'](target);
        expect(anon.status, `${method} ${target} anon`).toBe(401);
        for (const user of ['seller_a', 'random_user']) {
          const res = await request(app)[method as 'get' | 'patch'](target).set('Authorization', bearer(user));
          expect(res.status, `${method} ${target} ${user}`).toBe(403);
          expect(res.body.error.code).toBe('FORBIDDEN');
        }
      }
      expect((await MissingOrderReportModel.findById(id).lean())!.status).toBe('open');
      expect(await AdminAuditModel.countDocuments({})).toBe(0);
    });
  });
});
