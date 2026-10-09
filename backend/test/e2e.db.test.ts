import { createServer, type Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { MenuModel } from '../src/models/menu.js';
import { OrderModel } from '../src/models/order.js';
import { lagosDay } from '../src/validation/day.js';
import { connectTestDb, disconnectTestDb, testDbUri } from './helpers/db.js';
import { bearer, fakeAuth } from './helpers/fake-auth.js';

// Everything over HTTP, as the frontend would call it. Default rate limits
// (no override), so the real limiter sits in front of every order.
const app = createApp({ allowedOrigins: ['http://localhost:5173'], auth: fakeAuth });
let server: Server;

const DAY_MS = 86_400_000;
const DAY = lagosDay(new Date(Date.now() + 3 * DAY_MS));

const seller = (userId: string) => ({
  get: (path: string) => request(server).get(path).set('Authorization', bearer(userId)),
  post: (path: string, body?: object) => request(server).post(path).set('Authorization', bearer(userId)).send(body),
  put: (path: string, body: object) => request(server).put(path).set('Authorization', bearer(userId)).send(body),
  patch: (path: string) => request(server).patch(path).set('Authorization', bearer(userId)),
});

// Each customer on their own IP, as real customers would be.
let ipCounter = 0;
function customerOrder(body: object) {
  ipCounter += 1;
  return request(server)
    .post('/api/public/orders')
    .set('X-Forwarded-For', `10.0.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`)
    .send(body);
}

function orderBody(menuId: string, lines: { itemId: string; qty: number }[], name = 'Ada') {
  return {
    menuId,
    customer: { name, phone: '0809 111 2222' },
    delivery: { area: 'Yaba', address: '12 Herbert Macaulay Way', day: DAY },
    lines,
  };
}

async function onboardAndOpen(userId: string, businessName: string, items: { name: string; price: number; qty: number }[]) {
  const s = seller(userId);
  const profile = await s.put('/api/sellers/me', {
    businessName,
    phone: '0803 123 4567',
    payment: { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Owner' },
  });
  expect(profile.status).toBe(201);

  const draft = await s.post('/api/menus', {
    title: 'This week',
    cutoffAt: new Date(Date.now() + 2 * DAY_MS).toISOString(),
    items,
    areas: ['Yaba', 'Surulere'],
    deliveryDays: [DAY],
  });
  expect(draft.status).toBe(201);
  expect((await s.post(`/api/menus/${draft.body.id}/open`)).status).toBe(200);

  const itemId = (name: string) => draft.body.items.find((i: { name: string }) => i.name === name).id as string;
  return { slug: profile.body.slug as string, menuId: draft.body.id as string, itemId, s };
}

describe.skipIf(!testDbUri)('end to end over HTTP on a real MongoDB', () => {
  beforeAll(async () => {
    await connectTestDb('e2e');
    server = createServer(app).listen(0);
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await disconnectTestDb();
  });

  it('the whole week: onboard, open, order, pay, prep, sell out, cancel, close', async () => {
    const { slug, menuId, itemId, s } = await onboardAndOpen('mama_t', "Mama T's Kitchen", [
      { name: 'Jollof rice', price: 3500, qty: 5 },
      { name: 'Chapman', price: 1500, qty: 10 },
    ]);
    const jollof = itemId('Jollof rice');
    const chapman = itemId('Chapman');

    // Customer opens the link.
    const page = await request(server).get(`/api/public/menu/${slug}`);
    expect(page.body.menu).toMatchObject({ id: menuId, acceptingOrders: true });

    // Ada orders 2 jollof + 1 chapman and is told where to pay.
    const ada = await customerOrder(orderBody(menuId, [{ itemId: jollof, qty: 2 }, { itemId: chapman, qty: 1 }], 'Ada'));
    expect(ada.status).toBe(201);
    expect(ada.body.payment).toMatchObject({ amount: 8500, reference: ada.body.order.ref, accountNumber: '0123456789' });
    const adaRef = ada.body.order.ref as string;

    // Seller sees it, matches the bank transfer, marks it paid.
    const list = await s.get(`/api/menus/${menuId}/orders`);
    expect(list.body.orders.map((o: { ref: string }) => o.ref)).toEqual([adaRef]);
    expect((await s.patch(`/api/orders/${adaRef}/paid`)).body.status).toBe('paid');

    // Bola takes the last 3 jollof; the page shows it sold out; Chidi is refused.
    const bola = await customerOrder(orderBody(menuId, [{ itemId: jollof, qty: 3 }], 'Bola'));
    expect(bola.status).toBe(201);
    const soldOutPage = await request(server).get(`/api/public/menu/${slug}`);
    expect(soldOutPage.body.menu.items[0]).toMatchObject({ qtyRemaining: 0, soldOut: true });
    const chidi = await customerOrder(orderBody(menuId, [{ itemId: jollof, qty: 1 }], 'Chidi'));
    expect(chidi.status).toBe(409);
    expect(chidi.body.error.code).toBe('SOLD_OUT');

    // Prep sheet: all orders vs paid only.
    const prep = await s.get(`/api/menus/${menuId}/prep-sheet`);
    expect(prep.body.items.map((i: { portions: number }) => i.portions)).toEqual([5, 1]);
    const paidPrep = await s.get(`/api/menus/${menuId}/prep-sheet?paidOnly=true`);
    expect(paidPrep.body.items.map((i: { portions: number }) => i.portions)).toEqual([2, 1]);

    // Bola never pays: seller cancels, 3 jollof go back on sale, once.
    const bolaRef = bola.body.order.ref as string;
    await s.patch(`/api/orders/${bolaRef}/cancel`);
    await s.patch(`/api/orders/${bolaRef}/cancel`);
    const afterCancel = await request(server).get(`/api/public/menu/${slug}`);
    expect(afterCancel.body.menu.items[0]).toMatchObject({ qtyRemaining: 3, soldOut: false });

    // Ada checks her order and sees it paid.
    const lookup = await request(server).get(`/api/public/orders/${adaRef}?phoneLast4=2222`);
    expect(lookup.body.order.status).toBe('paid');

    // Delivery list: only Ada (Bola cancelled), under Yaba.
    const delivery = await s.get(`/api/menus/${menuId}/delivery-list`);
    expect(delivery.body.areas).toEqual([expect.objectContaining({ area: 'Yaba', count: 1 })]);
    expect(delivery.body.areas[0].orders[0].customer.name).toBe('Ada');

    // Seller closes the menu: no more orders, and the page shows no open menu.
    expect((await s.post(`/api/menus/${menuId}/close`)).body.status).toBe('closed');
    const late = await customerOrder(orderBody(menuId, [{ itemId: jollof, qty: 1 }], 'Late'));
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('ORDERING_CLOSED');
    expect((await request(server).get(`/api/public/menu/${slug}`)).body.menu).toBeNull();
  });

  it('40 customers at once through POST /api/public/orders for 5 portions: exactly 5 orders', async () => {
    const { menuId, itemId } = await onboardAndOpen('rush_kitchen', 'Rush Kitchen', [{ name: 'Suya', price: 2000, qty: 5 }]);
    const suya = itemId('Suya');

    const results = await Promise.all(
      Array.from({ length: 40 }, (_, n) => customerOrder(orderBody(menuId, [{ itemId: suya, qty: 1 }], `Customer ${n}`))),
    );

    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(5);
    expect(statuses.filter((s) => s === 409)).toHaveLength(35);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.error.code === 'SOLD_OUT')).toBe(true);

    const menu = await MenuModel.findById(menuId).lean();
    expect(menu!.items[0]!.qtyRemaining).toBe(0);
    expect(await OrderModel.countDocuments({ menuId })).toBe(5);
    // Every successful customer got a different reference.
    expect(new Set(results.filter((r) => r.status === 201).map((r) => r.body.order.ref)).size).toBe(5);
  });

  it('an open menu past its cut-off refuses orders through the route and says so on the page', async () => {
    const { slug, menuId, itemId } = await onboardAndOpen('late_kitchen', 'Late Kitchen', [
      { name: 'Amala', price: 2500, qty: 5 },
    ]);
    await MenuModel.updateOne({ _id: menuId }, { $set: { cutoffAt: new Date(Date.now() - 60_000) } });

    const page = await request(server).get(`/api/public/menu/${slug}`);
    expect(page.body.menu.acceptingOrders).toBe(false);

    const res = await customerOrder(orderBody(menuId, [{ itemId: itemId('Amala'), qty: 1 }]));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORDERING_CLOSED');
    expect((await MenuModel.findById(menuId).lean())!.items[0]!.qtyRemaining).toBe(5);
  });
});
