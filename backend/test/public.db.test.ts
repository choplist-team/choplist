import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { MenuModel } from '../src/models/menu.js';
import { OrderModel } from '../src/models/order.js';
import { SellerModel } from '../src/models/seller.js';
import { lagosDay } from '../src/validation/day.js';
import { connectTestDb, disconnectTestDb, testDbUri } from './helpers/db.js';
import { fakeAuth } from './helpers/fake-auth.js';

// Large limits so these tests never hit them (public.test.ts covers limits).
const app = createApp({
  allowedOrigins: ['http://localhost:5173'],
  auth: fakeAuth,
  rateLimits: { windowMs: 60_000, ordersPerWindow: 10_000, lookupsPerWindow: 10_000 },
});

const DAY_MS = 86_400_000;
const DAY = lagosDay(new Date(Date.now() + 3 * DAY_MS));

let menuId: string;
let jollofId: string;
let chapmanId: string;

function orderBody(overrides: Record<string, unknown> = {}) {
  return {
    menuId,
    customer: { name: 'Ada Obi', phone: '0809 111 2222' },
    delivery: { area: 'yaba', address: '12 Herbert Macaulay Way, Yaba', day: DAY },
    note: 'Extra pepper',
    lines: [
      { itemId: jollofId, qty: 2 },
      { itemId: chapmanId, qty: 1 },
    ],
    ...overrides,
  };
}

describe.skipIf(!testDbUri)('public routes on a real MongoDB', () => {
  beforeAll(async () => {
    await connectTestDb('public');
    const [mamaT] = await SellerModel.create([
      {
        clerkUserId: 'user_t',
        businessName: "Mama T's Kitchen",
        slug: 'mama-ts-kitchen',
        phone: '+2348031234567',
        payment: { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Titilayo Adebayo' },
      },
      {
        clerkUserId: 'user_quiet',
        businessName: 'Quiet Kitchen',
        slug: 'quiet-kitchen',
        phone: '+2348030000000',
        payment: { bankName: 'Opay', accountNumber: '9876543210', accountName: 'Quiet' },
      },
    ]);
    const base = {
      sellerId: mamaT!._id,
      cutoffAt: new Date(Date.now() + 2 * DAY_MS),
      areas: ['Yaba', 'Surulere'],
      deliveryDays: [DAY],
    };
    const [open] = await MenuModel.create([
      {
        ...base,
        title: 'This week',
        status: 'open',
        openedAt: new Date(),
        items: [
          { name: 'Jollof rice', description: 'With plantain', price: 3500, qtyTotal: 5, qtyRemaining: 5 },
          { name: 'Chapman', price: 1500, qtyTotal: 1, qtyRemaining: 1 },
        ],
      },
      // A draft must never be shown to customers.
      { ...base, title: 'Next week draft', status: 'draft', items: [{ name: 'Egusi', price: 4000, qtyTotal: 9, qtyRemaining: 9 }] },
    ]);
    menuId = open!._id.toString();
    jollofId = open!.items[0]!._id.toString();
    chapmanId = open!.items[1]!._id.toString();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  describe('GET /api/public/menu/:slug', () => {
    it("shows the seller's open menu, without internal fields", async () => {
      const res = await request(app).get('/api/public/menu/Mama-Ts-Kitchen');
      expect(res.status).toBe(200);
      expect(res.body.seller).toEqual({ businessName: "Mama T's Kitchen", slug: 'mama-ts-kitchen', phone: '+2348031234567' });
      expect(res.body.menu).toMatchObject({ id: menuId, title: 'This week', acceptingOrders: true, areas: ['Yaba', 'Surulere'] });
      expect(res.body.menu.items[0]).toEqual({
        id: jollofId,
        name: 'Jollof rice',
        description: 'With plantain',
        price: 3500,
        qtyRemaining: 5,
        soldOut: false,
      });
      expect(JSON.stringify(res.body)).not.toMatch(/qtyTotal|clerkUserId|accountNumber|sellerId/);
    });

    it('a seller with no open menu: 200 with menu null', async () => {
      const res = await request(app).get('/api/public/menu/quiet-kitchen');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ seller: { businessName: 'Quiet Kitchen' }, menu: null });
    });

    it('an unknown link is 404 SELLER_NOT_FOUND', async () => {
      const res = await request(app).get('/api/public/menu/nobody-here');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('SELLER_NOT_FOUND');
    });
  });

  describe('POST /api/public/orders', () => {
    let ref: string;

    it('places the order and returns the reference and where to pay', async () => {
      const res = await request(app).post('/api/public/orders').send(orderBody());
      expect(res.status).toBe(201);

      ref = res.body.order.ref;
      expect(ref).toMatch(/^CL-[2-9A-HJ-NP-Z]{5}$/);
      expect(res.body.order).toMatchObject({
        status: 'pending',
        customerName: 'Ada Obi',
        total: 8500,
        delivery: { area: 'Yaba', day: DAY },
        lines: [
          { name: 'Jollof rice', unitPrice: 3500, qty: 2 },
          { name: 'Chapman', unitPrice: 1500, qty: 1 },
        ],
      });
      expect(res.body.payment).toMatchObject({
        amount: 8500,
        reference: ref,
        bankName: 'GTBank',
        accountNumber: '0123456789',
        accountName: 'Titilayo Adebayo',
      });
      expect(res.body.payment.instructions).toBe(
        `Transfer ₦8,500 to Titilayo Adebayo, GTBank 0123456789, and write ${ref} as the transfer description so Mama T's Kitchen can match your payment.`,
      );

      const saved = await OrderModel.findOne({ ref }).lean();
      expect(saved).toMatchObject({ customer: { phone: '+2348091112222' }, note: 'Extra pepper' });
      expect((await request(app).get('/api/public/menu/mama-ts-kitchen')).body.menu.items[1]).toMatchObject({
        qtyRemaining: 0,
        soldOut: true,
      });
    });

    it('ignores prices and totals sent by the client', async () => {
      const res = await request(app)
        .post('/api/public/orders')
        .send(orderBody({ total: 1, lines: [{ itemId: jollofId, qty: 1, price: 1, unitPrice: 1 }] }));
      expect(res.status).toBe(201);
      expect(res.body.order.total).toBe(3500);
      expect(res.body.order.lines[0].unitPrice).toBe(3500);
    });

    it('sold out is 409 SOLD_OUT with what is left', async () => {
      const res = await request(app).post('/api/public/orders').send(orderBody({ lines: [{ itemId: chapmanId, qty: 1 }] }));
      expect(res.status).toBe(409);
      expect(res.body.error).toEqual({ code: 'SOLD_OUT', message: 'Not enough left: Chapman is sold out' });
    });

    it('a wrong area lists the areas', async () => {
      const res = await request(app)
        .post('/api/public/orders')
        .send(orderBody({ lines: [{ itemId: jollofId, qty: 1 }], delivery: { area: 'Lekki', address: '1 Admiralty Way', day: DAY } }));
      expect(res.status).toBe(400);
      expect(res.body.error).toEqual({ code: 'INVALID_AREA', message: 'We deliver to: Yaba, Surulere' });
    });

    it('an unknown menu is 404', async () => {
      const res = await request(app)
        .post('/api/public/orders')
        .send(orderBody({ menuId: new Types.ObjectId().toString() }));
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('MENU_NOT_FOUND');
    });

    describe('GET /api/public/orders/:ref', () => {
      it('finds the order with the right last 4 digits, even with a lowercase ref', async () => {
        const res = await request(app).get(`/api/public/orders/${ref.toLowerCase()}?phoneLast4=2222`);
        expect(res.status).toBe(200);
        expect(res.body.order).toMatchObject({ ref, status: 'pending', total: 8500 });
        expect(res.body.payment.reference).toBe(ref);
        // No address or full phone number in a lookup.
        expect(JSON.stringify(res.body)).not.toMatch(/Herbert Macaulay|8091112222/);
      });

      it('wrong digits and an unknown ref give the same 404', async () => {
        const wrongPhone = await request(app).get(`/api/public/orders/${ref}?phoneLast4=0000`);
        const unknownRef = await request(app).get('/api/public/orders/CL-ZZZZZ?phoneLast4=2222');
        for (const res of [wrongPhone, unknownRef]) {
          expect(res.status).toBe(404);
          expect(res.body).toEqual({
            error: { code: 'ORDER_NOT_FOUND', message: 'No order matches that reference and phone number' },
          });
        }
      });
    });
  });
});
