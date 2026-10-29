import { Types, mongo } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { recordMenuView } from '../src/analytics/record-view.js';
import { MenuModel } from '../src/models/menu.js';
import { MenuViewDailyModel } from '../src/models/menu-view-daily.js';
import { SellerModel } from '../src/models/seller.js';
import { lagosDay } from '../src/validation/day.js';
import { connectTestDb, disconnectTestDb, testDbUri } from './helpers/db.js';
import { fakeAuth } from './helpers/fake-auth.js';

const makeApp = (viewsPerWindow = 10_000) =>
  createApp({
    allowedOrigins: ['http://localhost:5173'],
    auth: fakeAuth,
    rateLimits: { windowMs: 60_000, ordersPerWindow: 10_000, lookupsPerWindow: 10_000, viewsPerWindow },
  });
const app = makeApp();
const DAY_MS = 86_400_000;

let sellerA: Types.ObjectId;
let menuId: Types.ObjectId;

const view = (slug = 'kitchen-a', a = app) => request(a).post(`/api/public/menu/${slug}/view`);
const counters = () => MenuViewDailyModel.collection.find({}).toArray();

describe.skipIf(!testDbUri)('menu views on a real MongoDB', () => {
  beforeAll(async () => {
    await connectTestDb('menuviews');
  });
  afterAll(async () => {
    await disconnectTestDb();
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await Promise.all([SellerModel.deleteMany({}), MenuModel.deleteMany({}), MenuViewDailyModel.deleteMany({})]);
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
      items: [{ name: 'Jollof rice', price: 3500, qtyTotal: 10, qtyRemaining: 10 }],
      areas: ['Yaba'],
      deliveryDays: [lagosDay(new Date(Date.now() + 3 * DAY_MS))],
    });
    menuId = menu._id;
  });

  it('counts a view: 204, no body, one counter for today', async () => {
    const res = await view();
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    const [row] = await counters();
    expect(row).toMatchObject({ day: lagosDay(new Date()), count: 1 });
    expect(row!.menuId.toString()).toBe(menuId.toString());
    expect(row!.sellerId.toString()).toBe(sellerA.toString());
  });

  it('adds to the same counter for the same day instead of creating more', async () => {
    for (let i = 0; i < 5; i++) await view();
    const rows = await counters();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(5);
  });

  it('50 simultaneous first views make exactly one counter that reads 50', async () => {
    const results = await Promise.all(Array.from({ length: 50 }, () => view()));
    expect(results.every((r) => r.status === 204)).toBe(true);
    const rows = await counters();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(50);
  });

  it('retries once if the counter was created by another request at the same moment', async () => {
    const real = MenuViewDailyModel.updateOne.bind(MenuViewDailyModel);
    const spy = vi.spyOn(MenuViewDailyModel, 'updateOne');
    spy.mockImplementationOnce((() => {
      throw new mongo.MongoServerError({ message: 'E11000 duplicate key error', code: 11000 });
    }) as never);
    spy.mockImplementation(real as never);
    await recordMenuView({ _id: menuId, sellerId: sellerA });
    expect((await counters())[0]!.count).toBe(1);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('files a view under the LAGOS day: 23:30 UTC is already tomorrow in Lagos', async () => {
    await recordMenuView({ _id: menuId, sellerId: sellerA }, new Date('2026-10-28T23:30:00Z'));
    await recordMenuView({ _id: menuId, sellerId: sellerA }, new Date('2026-10-28T22:30:00Z'));
    const days = (await counters()).map((r) => `${r.day}:${r.count}`).sort();
    expect(days).toEqual(['2026-10-28:1', '2026-10-29:1']);
  });

  it('stores nothing about the visitor', async () => {
    await request(app).post('/api/public/menu/kitchen-a/view').set('User-Agent', 'SecretBrowser/9').set('X-Forwarded-For', '203.0.113.7');
    const [row] = await counters();
    expect(Object.keys(row!).sort()).toEqual(['_id', 'count', 'day', 'menuId', 'sellerId']);
    const json = JSON.stringify(row);
    expect(json).not.toContain('SecretBrowser');
    expect(json).not.toContain('203.0.113.7');
  });

  it('the slug is not case-sensitive', async () => {
    expect((await view('KITCHEN-A')).status).toBe(204);
    expect(await counters()).toHaveLength(1);
  });

  it('an unknown shop is 404 and counts nothing', async () => {
    const res = await view('no-such-shop');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('SELLER_NOT_FOUND');
    expect(await counters()).toHaveLength(0);
  });

  it('a shop with no open menu answers 204 but counts nothing (draft and closed menus)', async () => {
    for (const status of ['draft', 'closed']) {
      await MenuModel.updateOne({ _id: menuId }, { $set: { status } });
      expect((await view()).status).toBe(204);
    }
    expect(await counters()).toHaveLength(0);
  });

  it('a suspended shop is 404 and counts nothing', async () => {
    await SellerModel.updateOne({ _id: sellerA }, { $set: { status: 'suspended' } });
    expect((await view()).status).toBe(404);
    expect(await counters()).toHaveLength(0);
  });

  it('loading the menu with GET does NOT count (crawlers and link previews only GET)', async () => {
    for (let i = 0; i < 3; i++) expect((await request(app).get('/api/public/menu/kitchen-a')).status).toBe(200);
    expect(await counters()).toHaveLength(0);
  });

  it('never fails the page: if the counter cannot be written the answer is still 204', async () => {
    vi.spyOn(MenuViewDailyModel, 'updateOne').mockRejectedValue(new Error('db down') as never);
    expect((await view()).status).toBe(204);
  });

  it('is rate limited per network (the 4th view in a window is 429 RATE_LIMITED)', async () => {
    const limited = makeApp(3);
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await view('kitchen-a', limited)).status);
    expect(statuses).toEqual([204, 204, 204, 429, 429]);
    expect((await view('kitchen-a', limited)).body.error.code).toBe('RATE_LIMITED');
    expect((await counters())[0]!.count).toBe(3); // refused views are not counted
  });

  it('the database allows only one counter per menu per day', async () => {
    const indexes = await MenuViewDailyModel.collection.indexes();
    const unique = indexes.find((i) => i.name === 'one_counter_per_menu_per_day');
    expect(unique?.unique).toBe(true);
    expect(unique?.key).toEqual({ menuId: 1, day: 1 });
    await MenuViewDailyModel.collection.insertOne({ menuId, sellerId: sellerA, day: '2026-01-01', count: 1 });
    await expect(MenuViewDailyModel.collection.insertOne({ menuId, sellerId: sellerA, day: '2026-01-01', count: 1 })).rejects.toThrow(/duplicate key/);
  });
});
