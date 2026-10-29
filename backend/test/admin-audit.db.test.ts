import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { AdminAuditModel } from '../src/models/admin-audit.js';
import { MissingOrderReportModel } from '../src/models/missing-order-report.js';
import { OrderModel } from '../src/models/order.js';
import { SellerModel } from '../src/models/seller.js';
import { connectTestDb, disconnectTestDb, testDbUri } from './helpers/db.js';
import { bearer, fakeAuth } from './helpers/fake-auth.js';

const ADMIN1 = 'user_admin1';
const ADMIN2 = 'user_admin2';
const app = createApp({
  allowedOrigins: ['http://localhost:5173'],
  auth: fakeAuth,
  adminClerkUserIds: [ADMIN1, ADMIN2],
  rateLimits: { windowMs: 60_000, ordersPerWindow: 10_000, lookupsPerWindow: 10_000 },
});
const as = (id: string) => ({
  get: (path: string) => request(app).get(path).set('Authorization', bearer(id)),
  patch: (path: string) => request(app).patch(path).set('Authorization', bearer(id)),
});
const admin = as(ADMIN1);

const payment = { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Acct' };
const sellerId = new Types.ObjectId();
const PHONE = '+2348031234567';
const ADDRESS = '12 Private Close, Yaba';

const entry = (adminId: string, action: string, targetId: string, at: string, reason?: string) => ({
  adminId, action, targetId, ...(reason ? { reason } : {}), createdAt: new Date(at),
});

describe.skipIf(!testDbUri)('admin audit trail on a real MongoDB', () => {
  beforeAll(async () => {
    await connectTestDb('adminaudit');
  });
  afterAll(async () => {
    await disconnectTestDb();
  });
  beforeEach(async () => {
    await Promise.all([SellerModel.deleteMany({}), OrderModel.deleteMany({}), AdminAuditModel.deleteMany({}), MissingOrderReportModel.deleteMany({})]);
    await SellerModel.collection.insertOne({
      _id: sellerId, clerkUserId: 'seller_a', businessName: 'Mama T Kitchen', slug: 'mama-t', phone: '+2348031230001',
      payment, status: 'active', createdAt: new Date(), updatedAt: new Date(),
    } as never);
  });

  describe('the whole flow: actions are recorded, then readable', () => {
    it('suspend, reveal and resolve each appear, newest first, with who, what, to what and why', async () => {
      await OrderModel.collection.insertOne({
        ref: 'CL-AAAAB', sellerId, menuId: new Types.ObjectId(), customer: { name: 'Ada Obi', phone: PHONE },
        delivery: { area: 'Yaba', address: ADDRESS, day: '2026-11-01' }, note: 'gate code 4321',
        lines: [{ itemId: new Types.ObjectId(), name: 'Jollof', unitPrice: 3500, qty: 2 }], total: 7000, status: 'paid',
        deliveryCodeAttempts: 0, deliveryCodeResets: 0, possibleDuplicate: false, createdAt: new Date(), updatedAt: new Date(),
      } as never);
      const reportId = (await MissingOrderReportModel.collection.insertOne({ message: 'where is it', status: 'open', orderFound: false, createdAt: new Date() } as never)).insertedId;

      await admin.patch(`/api/admin/sellers/${sellerId}/suspend`).send({ reason: 'Repeated fake orders' });
      await as(ADMIN2).get('/api/admin/orders/CL-AAAAB?reveal=true');
      await admin.patch(`/api/admin/reports/${reportId}/resolve`).send({ note: 'Seller confirmed delivery' });

      const { body, status } = await admin.get('/api/admin/audit');
      expect(status).toBe(200);
      expect(body.entries.map((e: { action: string }) => e.action)).toEqual(['report.resolve', 'order.reveal_phone', 'seller.suspend']);
      expect(body.entries[0]).toMatchObject({ adminId: ADMIN1, targetType: 'report', targetId: reportId.toString(), targetLabel: null, reason: 'Seller confirmed delivery' });
      expect(body.entries[1]).toMatchObject({ adminId: ADMIN2, targetType: 'order', targetId: 'CL-AAAAB', targetLabel: 'CL-AAAAB', reason: null });
      expect(body.entries[2]).toMatchObject({ adminId: ADMIN1, targetType: 'seller', targetId: sellerId.toString(), targetLabel: 'Mama T Kitchen', reason: 'Repeated fake orders' });
      expect(body.entries[2].at).toEqual(expect.any(String));
      expect(body.pagination).toEqual({ page: 1, limit: 20, total: 3, totalPages: 1 });
    });

    it('never holds the phone number, address or note that was revealed', async () => {
      await OrderModel.collection.insertOne({
        ref: 'CL-AAAAB', sellerId, menuId: new Types.ObjectId(), customer: { name: 'Ada Obi', phone: PHONE },
        delivery: { area: 'Yaba', address: ADDRESS, day: '2026-11-01' }, note: 'gate code 4321',
        lines: [{ itemId: new Types.ObjectId(), name: 'Jollof', unitPrice: 3500, qty: 2 }], total: 7000, status: 'paid',
        deliveryCode: '482915', deliveryCodeAttempts: 0, deliveryCodeResets: 0, possibleDuplicate: false, createdAt: new Date(), updatedAt: new Date(),
      } as never);
      await admin.get('/api/admin/orders/CL-AAAAB?reveal=true');
      const json = JSON.stringify((await admin.get('/api/admin/audit')).body);
      for (const secret of ['8031234567', 'Private Close', 'gate code', 'Ada Obi', '482915']) expect(json, secret).not.toContain(secret);
    });

    it('reading the trail does not add to it', async () => {
      await AdminAuditModel.collection.insertOne(entry(ADMIN1, 'seller.suspend', sellerId.toString(), '2026-10-28T10:00:00Z', 'x') as never);
      for (let i = 0; i < 3; i++) await admin.get('/api/admin/audit');
      expect(await AdminAuditModel.countDocuments({})).toBe(1);
    });

    it('each entry has exactly these fields, nothing internal', async () => {
      await AdminAuditModel.collection.insertOne(entry(ADMIN1, 'seller.reinstate', sellerId.toString(), '2026-10-28T10:00:00Z', 'back') as never);
      const [e] = (await admin.get('/api/admin/audit')).body.entries;
      expect(Object.keys(e).sort()).toEqual(['action', 'adminId', 'at', 'id', 'reason', 'targetId', 'targetLabel', 'targetType']);
    });
  });

  describe('filters and pagination', () => {
    const OTHER = new Types.ObjectId().toString();
    async function seed() {
      await AdminAuditModel.collection.insertMany([
        entry(ADMIN1, 'seller.suspend', sellerId.toString(), '2026-10-26T10:00:00Z', 'spam'),
        entry(ADMIN2, 'order.reveal_phone', 'CL-AAAAB', '2026-10-27T10:00:00Z'),
        entry(ADMIN1, 'seller.reinstate', sellerId.toString(), '2026-10-28T10:00:00Z', 'appeal accepted'),
        entry(ADMIN1, 'report.resolve', OTHER, '2026-10-28T15:00:00Z', 'handled'),
        entry(ADMIN2, 'seller.deactivate', OTHER, '2026-10-29T10:00:00Z', 'closed their shop'),
      ] as never);
    }
    const get = (q = '') => admin.get(`/api/admin/audit${q}`);
    const actions = (body: { entries: { action: string }[] }) => body.entries.map((e) => e.action);

    it('lists newest first', async () => {
      await seed();
      expect(actions((await get()).body)).toEqual(['seller.deactivate', 'report.resolve', 'seller.reinstate', 'order.reveal_phone', 'seller.suspend']);
    });

    it('filters by admin, action, target and date, and combines them', async () => {
      await seed();
      expect(actions((await get(`?adminId=${ADMIN2}`)).body)).toEqual(['seller.deactivate', 'order.reveal_phone']);
      expect(actions((await get('?action=seller.suspend')).body)).toEqual(['seller.suspend']);
      expect(actions((await get(`?targetId=${sellerId}`)).body)).toEqual(['seller.reinstate', 'seller.suspend']);
      expect(actions((await get('?targetId=CL-AAAAB')).body)).toEqual(['order.reveal_phone']);
      expect(actions((await get('?from=2026-10-28&to=2026-10-28')).body)).toEqual(['report.resolve', 'seller.reinstate']);
      expect(actions((await get(`?adminId=${ADMIN1}&from=2026-10-28`)).body)).toEqual(['report.resolve', 'seller.reinstate']);
      expect(actions((await get('?adminId=user_nobody')).body)).toEqual([]);
    });

    it('the date filter is in Lagos time: 23:30 UTC is already the next day', async () => {
      await AdminAuditModel.collection.insertOne(entry(ADMIN1, 'seller.suspend', OTHER, '2026-10-27T23:30:00Z') as never);
      expect((await get('?from=2026-10-28&to=2026-10-28')).body.entries).toHaveLength(1);
      expect((await get('?from=2026-10-27&to=2026-10-27')).body.entries).toHaveLength(0);
    });

    it('paginates, and the total is the whole matching count', async () => {
      await seed();
      const p1 = (await get('?limit=2&page=1')).body;
      const p3 = (await get('?limit=2&page=3')).body;
      expect(p1.entries).toHaveLength(2);
      expect(p3.entries).toHaveLength(1);
      expect(p1.pagination).toEqual({ page: 1, limit: 2, total: 5, totalPages: 3 });
    });

    it('names sellers, and a seller who no longer exists has no label', async () => {
      await seed();
      const { body } = await get(`?targetId=${OTHER}`);
      expect(body.entries.every((e: { targetId: string }) => e.targetId === OTHER)).toBe(true);
      expect(body.entries.find((e: { action: string }) => e.action === 'seller.deactivate').targetLabel).toBeNull();
      expect((await get(`?targetId=${sellerId}`)).body.entries[0].targetLabel).toBe('Mama T Kitchen');
    });

    it('rejects an unknown action, a bad date range, and a limit over 100', async () => {
      for (const q of ['?action=seller.delete', '?from=2026-13-01', '?from=2026-10-20&to=2026-10-01', '?limit=101', '?page=0', '?adminId=']) {
        const res = await get(q);
        expect(res.status, q).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('a filter value is matched literally (no regex injection)', async () => {
      await seed();
      for (const q of ['?adminId=.*', '?targetId=.*', '?targetId=CL-', '?adminId=user_']) {
        const res = await get(q);
        expect(res.status, q).toBe(200);
        expect(res.body.entries, q).toEqual([]);
      }
    });

    it('MongoDB operators in the query string do nothing (Express reads them as a plain, ignored name)', async () => {
      await seed();
      // If "$ne" took effect this would hide ADMIN1's three entries. It does not:
      // the parameter is not recognised, so no filter is applied and all 5 come back.
      for (const q of [`?adminId[$ne]=${ADMIN1}`, `?action[$in]=seller.suspend`, `?targetId[$regex]=.*`]) {
        const res = await get(q);
        expect(res.status, q).toBe(200);
        expect(res.body.entries, q).toHaveLength(5);
      }
      // A value that is an object, if one ever got through, is refused rather than used.
      expect((await get(`?adminId=${ADMIN1}&adminId=${ADMIN2}`)).status).toBe(400);
    });
  });

  describe('access', () => {
    it('401 without a token, 403 for sellers and other users, and the trail is not changed', async () => {
      await AdminAuditModel.collection.insertOne(entry(ADMIN1, 'seller.suspend', sellerId.toString(), '2026-10-28T10:00:00Z', 'x') as never);
      expect((await request(app).get('/api/admin/audit')).status).toBe(401);
      for (const user of ['seller_a', 'random_user']) {
        const res = await request(app).get('/api/admin/audit').set('Authorization', bearer(user));
        expect(res.status, user).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN');
      }
      expect(await AdminAuditModel.countDocuments({})).toBe(1);
    });

    it('there is no way to write, edit or delete the trail through the API', async () => {
      await AdminAuditModel.collection.insertOne(entry(ADMIN1, 'seller.suspend', sellerId.toString(), '2026-10-28T10:00:00Z', 'x') as never);
      for (const method of ['post', 'put', 'patch', 'delete'] as const) {
        const res = await request(app)[method]('/api/admin/audit').set('Authorization', bearer(ADMIN1)).send({ action: 'seller.suspend' });
        expect(res.status, method).toBe(404);
      }
      expect(await AdminAuditModel.countDocuments({})).toBe(1);
    });

    it('the filter indexes exist', async () => {
      const keys = (await AdminAuditModel.collection.indexes()).map((i) => JSON.stringify(i.key));
      for (const key of [{ createdAt: -1 }, { targetId: 1, createdAt: -1 }, { adminId: 1, createdAt: -1 }, { action: 1, createdAt: -1 }]) {
        expect(keys).toContain(JSON.stringify(key));
      }
    });
  });
});
