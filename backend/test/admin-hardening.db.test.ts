import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAdminRouter } from '../src/admin/router.js';
import { createApp } from '../src/app.js';
import { logEvent } from '../src/events/log.js';
import { AdminAuditModel } from '../src/models/admin-audit.js';
import { EventLogModel } from '../src/models/event-log.js';
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
const payment = { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Acct' };
const sellerId = new Types.ObjectId();

// ---- No database: every admin route is guarded, found by inspecting the router ------
describe('every route under /api/admin is guarded', () => {
  type Layer = { route?: { path: string; methods: Record<string, boolean> } };
  const stack = (createAdminRouter(fakeAuth, [ADMIN]) as unknown as { stack: Layer[] }).stack;
  const routes = stack.flatMap((layer) =>
    layer.route ? Object.keys(layer.route.methods).filter((m) => layer.route!.methods[m]).map((method) => ({ method, path: layer.route!.path })) : [],
  );
  // ":id" / ":ref" get a plausible value; the guard must answer before it matters.
  const fill = (path: string) => `/api/admin${path.replace(':id', new Types.ObjectId().toString()).replace(':ref', 'CL-AAAAB')}`;

  it('the inspection found the real routes (so this test cannot pass by finding none)', () => {
    // 16 today: overview, 5 seller, 2 order, 3 analytics, health, events, 2 report, audit.
    // "At least", so adding a route does not break this; the loop below checks it too.
    expect(routes.length).toBeGreaterThanOrEqual(16);
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual(
      expect.arrayContaining(['get /overview', 'get /sellers', 'patch /sellers/:id/suspend', 'get /orders/:ref', 'get /analytics/menus', 'get /health', 'get /audit', 'patch /reports/:id/resolve']),
    );
  });

  it('answers 401 with no token and 403 to a signed-in non-admin, for every method and path', async () => {
    for (const { method, path } of routes) {
      const url = fill(path);
      const anon = await request(app)[method as 'get'](url).send({});
      expect(anon.status, `${method} ${url} without a token`).toBe(401);
      const seller = await request(app)[method as 'get'](url).set('Authorization', bearer('seller_a')).send({});
      expect(seller.status, `${method} ${url} as a non-admin`).toBe(403);
      expect(seller.body.error.code).toBe('FORBIDDEN');
    }
  });

  it('every route is behind the guard even if the guard list is empty', async () => {
    const lockedOut = createApp({ allowedOrigins: ['http://localhost:5173'], auth: fakeAuth, adminClerkUserIds: [] });
    for (const { method, path } of routes) {
      const res = await request(lockedOut)[method as 'get'](fill(path)).set('Authorization', bearer(ADMIN)).send({});
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });
});

describe.skipIf(!testDbUri)('admin hardening on a real MongoDB', () => {
  beforeAll(async () => {
    await connectTestDb('adminhardening');
  });
  afterAll(async () => {
    await disconnectTestDb();
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await Promise.all([SellerModel.deleteMany({}), EventLogModel.deleteMany({}), AdminAuditModel.deleteMany({})]);
    await SellerModel.collection.insertOne({
      _id: sellerId, clerkUserId: 'seller_a', businessName: 'Mama T Kitchen', slug: 'mama-t', phone: '+2348031234567',
      payment, status: 'active', createdAt: new Date(), updatedAt: new Date(),
    } as never);
  });
  const admin = {
    get: (path: string) => request(app).get(path).set('Authorization', bearer(ADMIN)),
    patch: (path: string) => request(app).patch(path).set('Authorization', bearer(ADMIN)),
  };

  describe('bookkeeping must never break the real work', () => {
    it('if recording lastActiveAt fails, the seller request still succeeds', async () => {
      const spy = vi.spyOn(SellerModel, 'updateOne').mockRejectedValue(new Error('db hiccup') as never);
      const res = await request(app).get('/api/menus').set('Authorization', bearer('seller_a'));
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalled(); // it did try
    });

    it('logEvent never throws when the write fails', async () => {
      vi.spyOn(EventLogModel, 'create').mockRejectedValue(new Error('db down') as never);
      await expect(logEvent({ type: 'order_failed', level: 'warn', code: 'SOLD_OUT', message: 'x' })).resolves.toBeUndefined();
    });

    it('logEvent keeps a valid id string, and drops an invalid one instead of failing', async () => {
      await logEvent({ type: 'order_failed', level: 'warn', code: 'SOLD_OUT', message: 'a', sellerId: sellerId.toString() });
      await logEvent({ type: 'order_failed', level: 'warn', code: 'SOLD_OUT', message: 'b', sellerId: 'not-an-id', menuId: '<script>' });
      const [a, b] = await EventLogModel.find({}).sort({ createdAt: 1 }).lean();
      expect(a!.sellerId!.toString()).toBe(sellerId.toString());
      expect(b!.sellerId).toBeUndefined();
      expect(b!.menuId).toBeUndefined();
    });
  });

  describe('requests with no or odd bodies are clean 400s, never 500s', () => {
    it('suspend and deactivate with no body at all', async () => {
      for (const action of ['suspend', 'deactivate']) {
        const res = await admin.patch(`/api/admin/sellers/${sellerId}/${action}`);
        expect(res.status, action).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
      expect((await SellerModel.collection.findOne({ _id: sellerId }))!.status).toBe('active');
      expect(await AdminAuditModel.countDocuments({})).toBe(0);
    });

    it('reinstate with no body works (the reason is optional)', async () => {
      await SellerModel.updateOne({ _id: sellerId }, { $set: { status: 'suspended' } });
      const res = await admin.patch(`/api/admin/sellers/${sellerId}/reinstate`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('active');
    });

    it('a body that is not an object, or has the wrong types, is a 400', async () => {
      for (const body of [JSON.stringify([1, 2]), JSON.stringify('text'), JSON.stringify({ reason: 123 }), JSON.stringify({ reason: { $ne: '' } })]) {
        const res = await request(app).patch(`/api/admin/sellers/${sellerId}/suspend`).set('Authorization', bearer(ADMIN)).set('Content-Type', 'application/json').send(body);
        expect(res.status, body).toBe(400);
      }
      const bad = await request(app).patch(`/api/admin/sellers/${sellerId}/suspend`).set('Authorization', bearer(ADMIN)).set('Content-Type', 'application/json').send('{broken');
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe('INVALID_JSON');
    });

    it('an oversized body is refused before it reaches any admin code', async () => {
      const res = await request(app).patch(`/api/admin/sellers/${sellerId}/suspend`).set('Authorization', bearer(ADMIN)).send({ reason: 'x'.repeat(30_000) });
      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    });
  });

  describe('seller search by phone, however it is written', () => {
    const find = async (q: string) => (await admin.get(`/api/admin/sellers?q=${encodeURIComponent(q)}`)).body.sellers.map((s: { businessName: string }) => s.businessName);

    it('with the 234 prefix, with or without a plus or spaces', async () => {
      for (const q of ['2348031234', '+234 803 1234', '234 803', '0803 1234', '803 1234']) {
        expect(await find(q), q).toEqual(['Mama T Kitchen']);
      }
    });

    it('too few digits are not treated as a phone search (so "08" does not match everyone)', async () => {
      expect(await find('08')).toEqual([]);
      expect(await find('+2')).toEqual([]);
    });
  });
});
