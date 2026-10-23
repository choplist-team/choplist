import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { MenuModel } from '../src/models/menu.js';
import { OrderModel } from '../src/models/order.js';
import { SellerModel } from '../src/models/seller.js';
import { MAX_CODE_ATTEMPTS } from '../src/orders/delivery-code.js';
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
const PHONE = '+2348091112222';

const as = (userId: string) => ({
  get: (path: string) => request(app).get(path).set('Authorization', bearer(userId)),
  patch: (path: string) => request(app).patch(path).set('Authorization', bearer(userId)),
});

let sellerA: Types.ObjectId;
let menuId: string;
let jollofId: string;

type Placed = { ref: string; accessKey: string };

// The customer's way in: the real public endpoint, so the access key is real.
async function newOrder(qty = 2): Promise<Placed> {
  const res = await request(app)
    .post('/api/public/orders')
    .send({
      menuId,
      customer: { name: 'Ada', phone: PHONE },
      delivery: { area: 'Yaba', address: '12 Herbert Macaulay Way', day: DAY },
      lines: [{ itemId: jollofId, qty }],
    });
  expect(res.status).toBe(201);
  return { ref: res.body.order.ref, accessKey: res.body.accessKey };
}

const seller = (id = 'seller_a') => as(id);
const pay = (ref: string) => seller().patch(`/api/orders/${ref}/paid`);
const outForDelivery = (ref: string, id = 'seller_a') => as(id).patch(`/api/orders/${ref}/out-for-delivery`);
const confirm = (ref: string, code: unknown, id = 'seller_a') =>
  as(id).patch(`/api/orders/${ref}/confirm-delivery`).send({ code });
const reset = (ref: string, id = 'seller_a') => as(id).patch(`/api/orders/${ref}/reset-delivery-code`);
const cancel = (ref: string) => seller().patch(`/api/orders/${ref}/cancel`);

// Test-only peek at the stored secrets, straight from the collection. The API
// never returns these to a seller; that is exactly what is being tested.
async function raw(ref: string) {
  return (await OrderModel.collection.findOne({ ref }))!;
}
async function codeOf(ref: string): Promise<string> {
  return (await raw(ref)).deliveryCode as string;
}
function wrongCodeFor(code: string): string {
  return code === '000000' ? '111111' : '000000';
}

// What a customer sees: ref + phone digits, and the key if their browser has it.
const lookup = (ref: string, accessKey?: string) => {
  const req = request(app).get(`/api/public/orders/${ref}?phoneLast4=2222`);
  return accessKey ? req.set('X-Order-Key', accessKey) : req;
};

async function jollofLeft(): Promise<number> {
  const menu = await MenuModel.findById(menuId).lean();
  return menu!.items[0]!.qtyRemaining;
}

// A paid order sent out: ready for the code to be entered.
async function inTransit(): Promise<Placed & { code: string }> {
  const placed = await newOrder();
  expect((await pay(placed.ref)).status).toBe(200);
  expect((await outForDelivery(placed.ref)).status).toBe(200);
  return { ...placed, code: await codeOf(placed.ref) };
}

describe.skipIf(!testDbUri)('delivery confirmation on a real MongoDB', () => {
  beforeAll(async () => {
    await connectTestDb('delivery');
    const [a] = await SellerModel.create([
      {
        clerkUserId: 'seller_a',
        businessName: 'A',
        slug: 'kitchen-a',
        phone: '+2348031234567',
        payment: { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'A' },
      },
      {
        clerkUserId: 'seller_b',
        businessName: 'B',
        slug: 'kitchen-b',
        phone: '+2348031234568',
        payment: { bankName: 'GTBank', accountNumber: '0123456780', accountName: 'B' },
      },
    ]);
    sellerA = a!._id;
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  beforeEach(async () => {
    await Promise.all([MenuModel.deleteMany({}), OrderModel.deleteMany({})]);
    const menu = await MenuModel.create({
      sellerId: sellerA,
      title: 'Week',
      status: 'open',
      openedAt: new Date(),
      cutoffAt: new Date(Date.now() + 2 * DAY_MS),
      items: [{ name: 'Jollof rice', price: 3500, qtyTotal: 10, qtyRemaining: 10 }],
      areas: ['Yaba'],
      deliveryDays: [DAY],
    });
    menuId = menu._id.toString();
    jollofId = menu.items[0]!._id.toString();
  });

  describe('the full flow', () => {
    it('order -> paid -> out for delivery -> customer reads the code -> seller confirms -> delivered', async () => {
      const { ref, accessKey } = await newOrder();
      expect((await lookup(ref, accessKey)).body.order).toMatchObject({ status: 'pending', deliveryCode: null });

      expect((await pay(ref)).body.status).toBe('paid');

      const out = await outForDelivery(ref);
      expect(out.status).toBe(200);
      expect(out.body).toMatchObject({ ref, status: 'out_for_delivery', deliveredAt: null });
      expect(out.body.outForDeliveryAt).toEqual(expect.any(String));

      const seen = await lookup(ref, accessKey);
      expect(seen.body.order.status).toBe('out_for_delivery');
      expect(seen.body.order.deliveryCode).toMatch(/^\d{6}$/);
      expect(seen.body.order.deliveryCode).toBe(await codeOf(ref));

      const done = await confirm(ref, seen.body.order.deliveryCode);
      expect(done.status).toBe(200);
      expect(done.body).toMatchObject({ ref, status: 'delivered' });
      expect(done.body.deliveredAt).toEqual(expect.any(String));

      // The code is removed once used, and the customer no longer sees one.
      expect(await raw(ref)).not.toHaveProperty('deliveryCode');
      const after = await lookup(ref, accessKey);
      expect(after.body.order).toMatchObject({ status: 'delivered', deliveryCode: null, deliveryCodeHidden: false });
    });

    it('the order-creation response has a key and no code', async () => {
      const res = await request(app)
        .post('/api/public/orders')
        .send({
          menuId,
          customer: { name: 'Ada', phone: PHONE },
          delivery: { area: 'Yaba', address: '12 Herbert Macaulay Way', day: DAY },
          lines: [{ itemId: jollofId, qty: 1 }],
        });
      expect(res.body.order.deliveryCode).toBeNull();
      expect(res.body.accessKey).toMatch(/^[A-Za-z0-9_-]{32}$/);
      // Only the hash is stored.
      const stored = await raw(res.body.order.ref);
      expect(JSON.stringify(stored)).not.toContain(res.body.accessKey);
      expect(stored.accessKeyHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('confirming twice is fine: the second answer is the same delivered order', async () => {
      const { ref, code } = await inTransit();
      const first = await confirm(ref, code);
      const second = await confirm(ref, code);
      expect(second.status).toBe(200);
      expect(second.body.deliveredAt).toBe(first.body.deliveredAt);
    });
  });

  describe('PATCH out-for-delivery', () => {
    it('needs a paid order', async () => {
      const { ref } = await newOrder();
      const res = await outForDelivery(ref);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ORDER_NOT_PAID');
    });

    it('is idempotent and does NOT make a new code', async () => {
      const { ref } = await newOrder();
      await pay(ref);
      const first = await outForDelivery(ref);
      const code = await codeOf(ref);
      const second = await outForDelivery(ref);
      expect(second.status).toBe(200);
      expect(second.body.outForDeliveryAt).toBe(first.body.outForDeliveryAt);
      expect(await codeOf(ref)).toBe(code);
    });

    it('refuses cancelled and delivered orders with their own codes', async () => {
      const cancelled = await newOrder();
      await cancel(cancelled.ref);
      expect((await outForDelivery(cancelled.ref)).body.error.code).toBe('ORDER_CANCELLED');

      const { ref, code } = await inTransit();
      await confirm(ref, code);
      const res = await outForDelivery(ref);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ORDER_DELIVERED');
    });

    it('starts the counters at 0 explicitly', async () => {
      const { ref } = await inTransit();
      const stored = await raw(ref);
      expect(stored.deliveryCodeAttempts).toBe(0);
      expect(stored.deliveryCodeResets).toBe(0);
    });
  });

  describe('PATCH confirm-delivery: wrong codes', () => {
    it('counts each wrong code and says how many attempts are left', async () => {
      const { ref, code } = await inTransit();
      const wrong = wrongCodeFor(code);
      const messages: string[] = [];
      for (let i = 1; i <= MAX_CODE_ATTEMPTS; i++) {
        const res = await confirm(ref, wrong);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('INVALID_DELIVERY_CODE');
        expect((await raw(ref)).deliveryCodeAttempts).toBe(i);
        messages.push(res.body.error.message);
      }
      expect(messages[0]).toContain('4 attempts left');
      expect(messages[3]).toContain('1 attempt left');
      expect(messages[4]).toContain('No attempts left');
      // Still in transit: wrong codes never deliver anything.
      expect((await raw(ref)).status).toBe('out_for_delivery');
    });

    it('a code that is not exactly 6 digits is a 400 VALIDATION_ERROR and does not count', async () => {
      const { ref } = await inTransit();
      for (const bad of ['12345', '1234567', 'abcdef', '12 456', 123456, null, undefined, '']) {
        const res = await confirm(ref, bad);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
      const noBody = await as('seller_a').patch(`/api/orders/${ref}/confirm-delivery`);
      expect(noBody.status).toBe(400);
      expect((await raw(ref)).deliveryCodeAttempts).toBe(0);
    });

    it('an unpaid or merely paid order is not out for delivery', async () => {
      const { ref } = await newOrder();
      const pending = await confirm(ref, '123456');
      expect(pending.status).toBe(409);
      expect(pending.body.error.code).toBe('ORDER_NOT_OUT_FOR_DELIVERY');
      await pay(ref);
      expect((await confirm(ref, '123456')).body.error.code).toBe('ORDER_NOT_OUT_FOR_DELIVERY');
    });

    it('a cancelled order cannot be confirmed', async () => {
      const { ref, code } = await inTransit();
      await cancel(ref);
      const res = await confirm(ref, code);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ORDER_CANCELLED');
    });
  });

  describe('lockout and reset', () => {
    it('after 5 wrong codes even the correct code is refused, until the seller resets', async () => {
      const { ref, code } = await inTransit();
      for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) await confirm(ref, wrongCodeFor(code));

      const locked = await confirm(ref, code);
      expect(locked.status).toBe(409);
      expect(locked.body.error.code).toBe('DELIVERY_CODE_LOCKED');
      expect((await raw(ref)).status).toBe('out_for_delivery');
      // Locked attempts are not counted further.
      expect((await raw(ref)).deliveryCodeAttempts).toBe(MAX_CODE_ATTEMPTS);

      const res = await reset(ref);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('out_for_delivery');
      const fresh = await raw(ref);
      expect(fresh.deliveryCodeAttempts).toBe(0);
      expect(fresh.deliveryCodeResets).toBe(1);
      expect(fresh.deliveryCode).not.toBe(code); // a reset never repeats the code

      // The old code no longer works; the new one does.
      expect((await confirm(ref, code)).body.error.code).toBe('INVALID_DELIVERY_CODE');
      expect((await confirm(ref, fresh.deliveryCode)).body.status).toBe('delivered');
    });

    it('a reset can be used twice per order; the third is DELIVERY_RESET_LIMIT', async () => {
      const { ref } = await inTransit();
      expect((await reset(ref)).status).toBe(200);
      expect((await reset(ref)).status).toBe(200);
      const third = await reset(ref);
      expect(third.status).toBe(409);
      expect(third.body.error.code).toBe('DELIVERY_RESET_LIMIT');
      expect((await raw(ref)).deliveryCodeResets).toBe(2);
    });

    it('so an order allows at most 15 guesses in total', async () => {
      const { ref } = await inTransit();
      let counted = 0;
      for (let round = 0; round < 3; round++) {
        const current = await codeOf(ref);
        for (let i = 0; i < 8; i++) {
          const res = await confirm(ref, wrongCodeFor(current));
          if (res.body.error.code === 'INVALID_DELIVERY_CODE') counted++;
        }
        if (round < 2) expect((await reset(ref)).status).toBe(200);
        else expect((await reset(ref)).body.error.code).toBe('DELIVERY_RESET_LIMIT');
      }
      expect(counted).toBe(15);
    });

    it('can only reset while out for delivery', async () => {
      const { ref } = await newOrder();
      for (const step of [async () => {}, () => pay(ref)]) {
        await step();
        const res = await reset(ref);
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('ORDER_NOT_OUT_FOR_DELIVERY');
      }
      await outForDelivery(ref);
      const code = await codeOf(ref);
      await confirm(ref, code);
      expect((await reset(ref)).body.error.code).toBe('ORDER_NOT_OUT_FOR_DELIVERY'); // delivered
    });

    // Whether two simultaneous resets count once or twice depends on whether the
    // second one starts before the first finishes, so that is not asserted. What
    // must hold for any timing is the cap.
    it('10 simultaneous resets never use more than 2, and never repeat a code', async () => {
      const { ref, code: first } = await inTransit();
      const results = await Promise.all(Array.from({ length: 10 }, () => reset(ref)));
      for (const res of results) {
        if (res.status === 200) continue;
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('DELIVERY_RESET_LIMIT');
      }
      const stored = await raw(ref);
      expect(stored.deliveryCodeResets).toBeGreaterThanOrEqual(1);
      expect(stored.deliveryCodeResets).toBeLessThanOrEqual(2);
      expect(stored.deliveryCodeAttempts).toBe(0);
      expect(stored.deliveryCode).not.toBe(first);
      expect(stored.status).toBe('out_for_delivery');
    });

    it('a double tap: both get 200 (the cap is 2), and it counts as one reset or two', async () => {
      const { ref } = await inTransit();
      const results = await Promise.all([reset(ref), reset(ref)]);
      expect(results.map((r) => r.status)).toEqual([200, 200]); // the cap is 2, so both fit
      const resets = (await raw(ref)).deliveryCodeResets;
      expect([1, 2]).toContain(resets);
    });
  });

  describe('concurrency', () => {
    it('30 simultaneous wrong guesses are counted exactly: attempts never pass 5', async () => {
      const { ref, code } = await inTransit();
      const wrong = wrongCodeFor(code);
      const results = await Promise.all(Array.from({ length: 30 }, () => confirm(ref, wrong)));
      const codes = results.map((r) => r.body.error.code as string);
      expect(codes.filter((c) => c === 'INVALID_DELIVERY_CODE')).toHaveLength(MAX_CODE_ATTEMPTS);
      expect(codes.filter((c) => c === 'DELIVERY_CODE_LOCKED')).toHaveLength(30 - MAX_CODE_ATTEMPTS);
      expect((await raw(ref)).deliveryCodeAttempts).toBe(MAX_CODE_ATTEMPTS);
      // And the lock held for the right code too.
      expect((await confirm(ref, code)).body.error.code).toBe('DELIVERY_CODE_LOCKED');
    });

    it('wrong guesses racing the right code: the lockout is never bypassed', async () => {
      const { ref, code } = await inTransit();
      const wrong = wrongCodeFor(code);
      const batch = [
        ...Array.from({ length: 20 }, () => confirm(ref, wrong)),
        ...Array.from({ length: 5 }, () => confirm(ref, code)),
      ];
      const results = await Promise.all(batch);
      const stored = await raw(ref);
      expect(stored.deliveryCodeAttempts).toBeLessThanOrEqual(MAX_CODE_ATTEMPTS);
      // Either the right code got in before the lock (delivered) or it did not (still locked).
      if (stored.status === 'delivered') expect(results.some((r) => r.status === 200)).toBe(true);
      else expect(stored.deliveryCodeAttempts).toBe(MAX_CODE_ATTEMPTS);
    });

    it('10 simultaneous correct confirms deliver once', async () => {
      const { ref, code } = await inTransit();
      const results = await Promise.all(Array.from({ length: 10 }, () => confirm(ref, code)));
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(new Set(results.map((r) => r.body.deliveredAt)).size).toBe(1);
    });
  });

  describe('secrets never reach the seller', () => {
    it('no seller response contains the code, the key, the hash or the counters', async () => {
      const { ref, accessKey } = await newOrder();
      const responses: { name: string; body: unknown }[] = [];
      const collect = async (name: string, p: Promise<{ body: unknown }>) => responses.push({ name, body: (await p).body });

      await collect('paid', pay(ref));
      await collect('out-for-delivery', outForDelivery(ref));
      const code = await codeOf(ref);
      const hash = (await raw(ref)).accessKeyHash as string;
      await collect('wrong code', confirm(ref, wrongCodeFor(code)));
      await collect('reset', reset(ref));
      const code2 = await codeOf(ref);
      await collect('order list', seller().get(`/api/menus/${menuId}/orders`));
      await collect('order list (filtered)', seller().get(`/api/menus/${menuId}/orders?status=out_for_delivery`));
      await collect('prep sheet', seller().get(`/api/menus/${menuId}/prep-sheet`));
      await collect('delivery list', seller().get(`/api/menus/${menuId}/delivery-list`));
      await collect('delivered', confirm(ref, code2));
      await collect('order list (after)', seller().get(`/api/menus/${menuId}/orders`));
      await collect('cancel (refused)', cancel(ref));

      expect(responses).toHaveLength(11);
      for (const { name, body } of responses) {
        const json = JSON.stringify(body);
        for (const secret of [code, code2, accessKey, hash]) {
          expect(json, `${name} leaked a secret`).not.toContain(secret);
        }
        for (const field of ['deliveryCode', 'accessKeyHash', 'deliveryCodeAttempts', 'deliveryCodeResets']) {
          expect(json, `${name} has ${field}`).not.toContain(field);
        }
      }
    });

    it('the seller cannot get the code from the public lookup either (they have no key)', async () => {
      const { ref, code } = await inTransit();
      for (const key of [undefined, 'A'.repeat(32), 'short']) {
        const res = await lookup(ref, key);
        expect(res.status).toBe(200);
        expect(res.body.order.deliveryCode).toBeNull();
        expect(res.body.order.deliveryCodeHidden).toBe(true);
        expect(JSON.stringify(res.body)).not.toContain(code);
      }
    });
  });

  describe('what the customer sees', () => {
    it('the code shows only while out for delivery, and only with the right key', async () => {
      const { ref, accessKey } = await newOrder();
      const order = async (key?: string) => (await lookup(ref, key)).body.order;

      expect(await order(accessKey)).toMatchObject({ status: 'pending', deliveryCode: null, deliveryCodeHidden: false });
      await pay(ref);
      expect(await order(accessKey)).toMatchObject({ status: 'paid', deliveryCode: null, deliveryCodeHidden: false });

      await outForDelivery(ref);
      const code = await codeOf(ref);
      expect(await order(accessKey)).toMatchObject({ status: 'out_for_delivery', deliveryCode: code, deliveryCodeHidden: false });
      expect(await order()).toMatchObject({ deliveryCode: null, deliveryCodeHidden: true });
      expect(await order('B'.repeat(32))).toMatchObject({ deliveryCode: null, deliveryCodeHidden: true });

      // After a reset the customer sees the NEW code.
      await reset(ref);
      expect((await order(accessKey)).deliveryCode).toBe(await codeOf(ref));

      await confirm(ref, await codeOf(ref));
      expect(await order(accessKey)).toMatchObject({ status: 'delivered', deliveryCode: null, deliveryCodeHidden: false });
    });

    it('a cancelled order shows no code', async () => {
      const { ref, accessKey } = await inTransit();
      await cancel(ref);
      expect((await lookup(ref, accessKey)).body.order).toMatchObject({ status: 'cancelled', deliveryCode: null });
    });

    it('an order from before keys existed never shows a code, and nothing crashes', async () => {
      const { ref } = await inTransit();
      await OrderModel.collection.updateOne({ ref }, { $unset: { accessKeyHash: '' } });
      const res = await lookup(ref, 'C'.repeat(32));
      expect(res.status).toBe(200);
      expect(res.body.order).toMatchObject({ deliveryCode: null, deliveryCodeHidden: true });
    });
  });

  describe('cancel and mark paid with the new statuses', () => {
    it('a delivered order cannot be cancelled, and its stock is NOT returned', async () => {
      const { ref, code } = await inTransit();
      await confirm(ref, code);
      const before = await jollofLeft();
      const res = await cancel(ref);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ORDER_DELIVERED');
      expect(await jollofLeft()).toBe(before);
      expect((await raw(ref)).status).toBe('delivered');
    });

    it('cancelling in transit returns the stock once and removes the code', async () => {
      const { ref } = await inTransit(); // 2 portions taken: 10 -> 8
      expect(await jollofLeft()).toBe(8);
      const res = await cancel(ref);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('cancelled');
      expect(await jollofLeft()).toBe(10);
      expect(await raw(ref)).not.toHaveProperty('deliveryCode');

      expect((await cancel(ref)).status).toBe(200); // repeat: fine...
      expect(await jollofLeft()).toBe(10); // ...and no second return of stock
    });

    it('marking paid again is harmless once the order is out for delivery or delivered', async () => {
      const { ref, code } = await inTransit();
      const out = await pay(ref);
      expect(out.status).toBe(200);
      expect(out.body.status).toBe('out_for_delivery'); // not pushed back to "paid"
      await confirm(ref, code);
      expect((await pay(ref)).body.status).toBe('delivered');
    });

    it('a cancelled order still cannot be paid', async () => {
      const { ref } = await newOrder();
      await cancel(ref);
      expect((await pay(ref)).body.error.code).toBe('ORDER_CANCELLED');
    });
  });

  describe('seller isolation and access', () => {
    it("another seller's order is a 404 on all three routes, and nothing changes", async () => {
      const { ref, code } = await inTransit();
      for (const res of [await outForDelivery(ref, 'seller_b'), await confirm(ref, code, 'seller_b'), await reset(ref, 'seller_b')]) {
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('ORDER_NOT_FOUND');
      }
      const stored = await raw(ref);
      expect(stored.status).toBe('out_for_delivery');
      expect(stored.deliveryCode).toBe(code);
      expect(stored.deliveryCodeAttempts).toBe(0);
    });

    it('wrong guesses by another seller do not count against the real one', async () => {
      const { ref, code } = await inTransit();
      for (let i = 0; i < 10; i++) await confirm(ref, wrongCodeFor(code), 'seller_b');
      expect((await raw(ref)).deliveryCodeAttempts).toBe(0);
    });

    it('the ref is case-insensitive, and unknown or malformed refs are 404', async () => {
      const { ref, code } = await inTransit();
      expect((await confirm(ref.toLowerCase(), code)).body.status).toBe('delivered');
      for (const bad of ['CL-AAAAA', 'nonsense', 'CL-00000']) {
        expect((await outForDelivery(bad)).status).toBe(404);
        expect((await confirm(bad, '123456')).status).toBe(404);
        expect((await reset(bad)).status).toBe(404);
      }
    });

    it('no sign-in is a 401 on all three routes', async () => {
      const { ref } = await newOrder();
      for (const path of ['out-for-delivery', 'confirm-delivery', 'reset-delivery-code']) {
        const res = await request(app).patch(`/api/orders/${ref}/${path}`).send({ code: '123456' });
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('UNAUTHENTICATED');
      }
    });
  });

  describe('reports', () => {
    async function oneOfEach() {
      const pending = await newOrder(1);
      const paid = await newOrder(1);
      await pay(paid.ref);
      const transit = await newOrder(1);
      await pay(transit.ref);
      await outForDelivery(transit.ref);
      const delivered = await newOrder(1);
      await pay(delivered.ref);
      await outForDelivery(delivered.ref);
      await confirm(delivered.ref, await codeOf(delivered.ref));
      const cancelled = await newOrder(1);
      await cancel(cancelled.ref);
      return { pending, paid, transit, delivered, cancelled };
    }

    it('the prep sheet counts every order that is not cancelled, delivered included', async () => {
      await oneOfEach();
      const all = await seller().get(`/api/menus/${menuId}/prep-sheet`);
      expect(all.body.totals).toMatchObject({ orders: 4, portions: 4, amount: 4 * 3500 });
      const paidOnly = await seller().get(`/api/menus/${menuId}/prep-sheet?paidOnly=true`);
      expect(paidOnly.body.totals).toMatchObject({ orders: 3, portions: 3 });
    });

    it('the delivery list shows pending, paid and out for delivery, but not delivered or cancelled', async () => {
      const o = await oneOfEach();
      const res = await seller().get(`/api/menus/${menuId}/delivery-list`);
      const refs = res.body.areas.flatMap((a: { orders: { ref: string }[] }) => a.orders.map((x) => x.ref)).sort();
      expect(refs).toEqual([o.pending.ref, o.paid.ref, o.transit.ref].sort());
      expect(res.body.totalOrders).toBe(3);

      const paidOnly = await seller().get(`/api/menus/${menuId}/delivery-list?paidOnly=true`);
      const paidRefs = paidOnly.body.areas.flatMap((a: { orders: { ref: string }[] }) => a.orders.map((x) => x.ref)).sort();
      expect(paidRefs).toEqual([o.paid.ref, o.transit.ref].sort());
    });
  });
});
