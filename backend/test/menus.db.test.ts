import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { MenuModel } from '../src/models/menu.js';
import { SellerModel } from '../src/models/seller.js';
import { lagosDay } from '../src/validation/day.js';
import { connectTestDb, disconnectTestDb, testDbUri } from './helpers/db.js';
import { bearer, fakeAuth } from './helpers/fake-auth.js';

const app = createApp({ allowedOrigins: ['http://localhost:5173'], auth: fakeAuth });
const DAY_MS = 86_400_000;

function menuBody(title = 'Week menu') {
  const cutoff = new Date(Date.now() + 2 * DAY_MS);
  return {
    title,
    cutoffAt: cutoff.toISOString(),
    items: [
      { name: 'Jollof rice', price: 3500, qty: 20 },
      { name: 'Chapman', price: 1500, qty: 10 },
    ],
    areas: ['Yaba', 'Surulere'],
    deliveryDays: [lagosDay(new Date(cutoff.getTime() + DAY_MS))],
  };
}

const as = (userId: string) => ({
  get: (path: string) => request(app).get(path).set('Authorization', bearer(userId)),
  post: (path: string, body?: object) => request(app).post(path).set('Authorization', bearer(userId)).send(body),
  put: (path: string, body: object) => request(app).put(path).set('Authorization', bearer(userId)).send(body),
});

const seller = (clerkUserId: string, slug: string) => ({
  clerkUserId,
  businessName: slug,
  slug,
  phone: '+2348031234567',
  payment: { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Test' },
});

async function createDraft(userId: string, title?: string): Promise<string> {
  const res = await as(userId).post('/api/menus', menuBody(title));
  expect(res.status).toBe(201);
  return res.body.id as string;
}

describe.skipIf(!testDbUri)('/api/menus on a real MongoDB', () => {
  beforeAll(async () => {
    await connectTestDb('menus');
    await SellerModel.create([seller('seller_a', 'kitchen-a'), seller('seller_b', 'kitchen-b')]);
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it('requires a seller profile (403 PROFILE_REQUIRED)', async () => {
    const res = await as('no_profile').get('/api/menus');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PROFILE_REQUIRED');
  });

  it('creates a draft with full stock and item ids', async () => {
    const res = await as('seller_a').post('/api/menus', menuBody('Draft one'));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ title: 'Draft one', status: 'draft', openedAt: null, closedAt: null });
    expect(res.body.items[0]).toMatchObject({ name: 'Jollof rice', price: 3500, qtyTotal: 20, qtyRemaining: 20 });
    expect(res.body.items[0].id).toMatch(/^[0-9a-f]{24}$/);
  });

  it('lists only my menus, newest first', async () => {
    await createDraft('seller_b', 'B menu');
    const res = await as('seller_a').get('/api/menus');
    expect(res.status).toBe(200);
    const titles = res.body.menus.map((m: { title: string }) => m.title);
    expect(titles).toContain('Draft one');
    expect(titles).not.toContain('B menu');
  });

  it('edits a draft (PUT replaces it)', async () => {
    const id = await createDraft('seller_a', 'Before');
    const res = await as('seller_a').put(`/api/menus/${id}`, { ...menuBody('After'), items: [{ name: 'Egusi', price: 4000, qty: 8 }] });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('After');
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ name: 'Egusi', qtyTotal: 8, qtyRemaining: 8 });
  });

  it('draft -> open -> closed, with timestamps; repeat clicks are harmless', async () => {
    const id = await createDraft('seller_a', 'Lifecycle');

    const opened = await as('seller_a').post(`/api/menus/${id}/open`);
    expect(opened.status).toBe(200);
    expect(opened.body.status).toBe('open');
    expect(opened.body.openedAt).not.toBeNull();
    expect((await as('seller_a').post(`/api/menus/${id}/open`)).status).toBe(200);

    // Open menus cannot be edited.
    const edit = await as('seller_a').put(`/api/menus/${id}`, menuBody('Sneaky edit'));
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe('MENU_NOT_DRAFT');

    const closed = await as('seller_a').post(`/api/menus/${id}/close`);
    expect(closed.status).toBe(200);
    expect(closed.body.status).toBe('closed');
    expect(closed.body.closedAt).not.toBeNull();
    expect((await as('seller_a').post(`/api/menus/${id}/close`)).status).toBe(200);

    // Closed menus cannot reopen or be edited.
    const reopen = await as('seller_a').post(`/api/menus/${id}/open`);
    expect(reopen.status).toBe(409);
    expect(reopen.body.error.code).toBe('MENU_CLOSED');
    expect((await as('seller_a').put(`/api/menus/${id}`, menuBody())).body.error.code).toBe('MENU_NOT_DRAFT');
  });

  it('closing a draft is 409 MENU_NOT_OPEN', async () => {
    const id = await createDraft('seller_a');
    const res = await as('seller_a').post(`/api/menus/${id}/close`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MENU_NOT_OPEN');
  });

  it('only one open menu per seller (409 ANOTHER_MENU_OPEN), but other sellers are unaffected', async () => {
    const first = await createDraft('seller_a', 'First');
    const second = await createDraft('seller_a', 'Second');
    expect((await as('seller_a').post(`/api/menus/${first}/open`)).status).toBe(200);

    const res = await as('seller_a').post(`/api/menus/${second}/open`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ANOTHER_MENU_OPEN');

    const other = await createDraft('seller_b', 'B open');
    expect((await as('seller_b').post(`/api/menus/${other}/open`)).status).toBe(200);

    await as('seller_a').post(`/api/menus/${first}/close`);
    await as('seller_b').post(`/api/menus/${other}/close`);
  });

  it('two drafts opened at the same moment: exactly one wins', async () => {
    const [x, y] = [await createDraft('seller_a', 'Race X'), await createDraft('seller_a', 'Race Y')];
    const results = await Promise.all([
      as('seller_a').post(`/api/menus/${x}/open`),
      as('seller_a').post(`/api/menus/${y}/open`),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await MenuModel.countDocuments({ status: 'open', title: /^Race/ })).toBe(1);
    await Promise.all([x, y].map((id) => as('seller_a').post(`/api/menus/${id}/close`)));
  });

  it('a draft whose cut-off has passed cannot open (409 CUTOFF_PASSED)', async () => {
    const id = await createDraft('seller_a', 'Late');
    // Time passes: simulate it by moving the stored cut-off into the past.
    await MenuModel.updateOne({ _id: id }, { $set: { cutoffAt: new Date(Date.now() - 60_000) } });
    const res = await as('seller_a').post(`/api/menus/${id}/open`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CUTOFF_PASSED');
  });

  it("isolation: another seller's menu is 404 for every action, and is not changed", async () => {
    const id = await createDraft('seller_a', 'Private');
    const b = as('seller_b');

    for (const res of [
      await b.get(`/api/menus/${id}`),
      await b.put(`/api/menus/${id}`, menuBody('Hijacked')),
      await b.post(`/api/menus/${id}/open`),
      await b.post(`/api/menus/${id}/close`),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('MENU_NOT_FOUND');
    }
    const menu = await MenuModel.findById(id).lean();
    expect(menu).toMatchObject({ title: 'Private', status: 'draft' });
  });

  it('a malformed id is 404, not a 500', async () => {
    const res = await as('seller_a').get('/api/menus/not-an-id');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('MENU_NOT_FOUND');
  });

  it('a body that fails validation is 400 and creates nothing', async () => {
    const before = await MenuModel.countDocuments();
    const res = await as('seller_a').post('/api/menus', { ...menuBody(), cutoffAt: '2030-10-16T18:00:00' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(await MenuModel.countDocuments()).toBe(before);
  });
});
