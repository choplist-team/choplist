import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { PAID_OR_BEYOND } from '../src/admin/overview.js';
import { PAID_STATUSES } from '../src/admin/revenue.js';
import { MenuModel } from '../src/models/menu.js';
import { OrderModel } from '../src/models/order.js';
import { PaymentModel } from '../src/models/payment.js';
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
const getOverview = () => request(app).get('/api/admin/overview').set('Authorization', bearer(ADMIN));

const DAY = 86_400_000;
const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms);

const bank = { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Owner' };
const ids = Object.fromEntries(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((k) => [k, new Types.ObjectId()])) as Record<string, Types.ObjectId>;
const menuIds = Object.fromEntries(Object.keys(ids).map((k) => [k, new Types.ObjectId()])) as Record<string, Types.ObjectId>;
const orderIds: Types.ObjectId[] = [];

let refCounter = 0;
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const nextRef = () => `CL-BBBB${LETTERS[refCounter++]}`;

function rawSeller(key: string, over: Record<string, unknown> = {}) {
  return {
    _id: ids[key],
    clerkUserId: `seller_${key}`,
    businessName: `Kitchen ${key}`,
    slug: `kitchen-${key.toLowerCase()}`,
    phone: '+2348031234567',
    payment: bank,
    status: 'active',
    createdAt: ago(90 * DAY),
    updatedAt: new Date(NOW),
    ...over,
  };
}

function rawMenu(key: string, status: string) {
  return {
    _id: menuIds[key],
    sellerId: ids[key],
    title: `Menu ${key}`,
    status,
    cutoffAt: ago(DAY),
    items: [{ _id: new Types.ObjectId(), name: 'Jollof', price: 1000, qtyTotal: 10, qtyRemaining: 5 }],
    areas: ['Yaba'],
    deliveryDays: ['2026-10-17'],
    ...(status !== 'draft' ? { openedAt: ago(30 * DAY) } : {}),
    createdAt: ago(30 * DAY),
    updatedAt: new Date(NOW),
  };
}

function rawOrder(key: string, status: string, total: number, age: number | null, method?: 'paystack' | 'transfer') {
  const _id = new Types.ObjectId();
  orderIds.push(_id);
  return {
    _id,
    ref: nextRef(),
    sellerId: ids[key],
    menuId: menuIds[key],
    customer: { name: 'Ada', phone: '+2348091112222' },
    delivery: { area: 'Yaba', address: '1 Street', day: '2026-10-17' },
    lines: [{ itemId: new Types.ObjectId(), name: 'Jollof', unitPrice: total, qty: 1 }],
    total,
    status,
    ...(method ? { paymentMethod: method } : {}), // left out = an order from before Paystack
    // A Paystack order carries the service fee the customer paid on top; GMV must ignore it.
    ...(method === 'paystack' ? { serviceFee: 250 } : {}),
    ...(age === null ? {} : { paidAt: ago(age) }),
    deliveryCodeAttempts: 0,
    deliveryCodeResets: 0,
    possibleDuplicate: false,
    createdAt: ago((age ?? 0) + 3_600_000),
    updatedAt: new Date(NOW),
  };
}

let paymentCounter = 0;
function rawPayment(key: string, orderIndex: number, status: string, platformFeeKobo: number, age: number | null) {
  paymentCounter += 1;
  return {
    orderId: orderIds[orderIndex],
    orderRef: `CL-X${paymentCounter}`,
    sellerId: ids[key],
    reference: `CLP-${String(paymentCounter).padStart(24, '0')}`,
    status,
    amountKobo: 800_000,
    transactionChargeKobo: 30_000,
    platformFeeKobo,
    paystackFeeKobo: 20_000,
    currency: 'NGN',
    bearer: 'account',
    subaccountCode: 'ACCT_x',
    ...(age === null ? {} : { paidAt: ago(age) }),
    createdAt: ago((age ?? 0) + 60_000),
    updatedAt: new Date(NOW),
  };
}

// ---- The dataset (every expected number below is worked out from this) -------
//
// Sellers   A  Paystack, past the free orders (pays ChopList)    ready
//           B  Paystack, free tier (platform fee 0)               ready
//           C  bank transfer only; paymentsReady but NO subaccount
//           D  complete profile, only a DRAFT menu, no orders
//           E  INCOMPLETE profile (no bank name) but has a menu and a paid order
//           F  menu open, no orders
//           G  (unused slot: not inserted)
//           H  menu open, only a pending order
//
// Paid orders (status paid / out_for_delivery / delivered):
//   0  A  paid              paystack  7,500  paid 2 days ago
//   1  A  delivered         paystack 11,000  paid 40 days ago
//   2  B  paid              paystack  4,000  paid 1 day ago
//   3  C  paid              transfer  6,000  paid 5 days ago
//   4  C  out_for_delivery  (legacy: no paymentMethod field)  2,500  paid 50 days ago
//   5  E  paid              transfer  1,000  paid 1 day ago
// Not paid:
//   6  A  cancelled (after the customer paid by Paystack)  5,000
//   7  A  pending  3,000
//   8  H  pending  2,000
//
// Payments  p0 A succeeded fee 225 naira  (order 0, 2 days ago)
//           p1 A succeeded fee 330 naira  (order 1, 40 days ago)
//           p2 B succeeded fee 0          (order 2, 1 day ago)
//           p3 A needs_review fee 150     (order 6, the cancelled one)
//           p4 A initialized  fee 999     (order 7)
//           p5 A failed       fee 777     (order 7)
//           p6 H needs_review fee 120     (order 8; H's ONLY payment, so H is not "on the platform")
async function seed() {
  refCounter = 0;
  paymentCounter = 0;
  orderIds.length = 0;
  await SellerModel.collection.insertMany([
    rawSeller('A', { paymentsReady: true, paystackSubaccountCode: 'ACCT_A', paidOrderCount: 60 }),
    rawSeller('B', { paymentsReady: true, paystackSubaccountCode: 'ACCT_B', paidOrderCount: 3 }),
    rawSeller('C', { paymentsReady: true }),
    rawSeller('D', { paymentsReady: false }),
    rawSeller('E', { payment: { accountNumber: '0123456789', accountName: 'Owner' } }),
    rawSeller('F'),
    rawSeller('H'),
  ] as never);
  await MenuModel.collection.insertMany([
    rawMenu('A', 'open'),
    rawMenu('B', 'closed'),
    rawMenu('C', 'closed'),
    rawMenu('D', 'draft'),
    rawMenu('E', 'open'),
    rawMenu('F', 'open'),
    rawMenu('H', 'open'),
  ] as never);
  await OrderModel.collection.insertMany([
    rawOrder('A', 'paid', 7500, 2 * DAY, 'paystack'),
    rawOrder('A', 'delivered', 11_000, 40 * DAY, 'paystack'),
    rawOrder('B', 'paid', 4000, DAY, 'paystack'),
    rawOrder('C', 'paid', 6000, 5 * DAY, 'transfer'),
    rawOrder('C', 'out_for_delivery', 2500, 50 * DAY),
    rawOrder('E', 'paid', 1000, DAY, 'transfer'),
    rawOrder('A', 'cancelled', 5000, null, 'paystack'),
    rawOrder('A', 'pending', 3000, null, 'transfer'),
    rawOrder('H', 'pending', 2000, null, 'transfer'),
  ] as never);
  await PaymentModel.collection.insertMany([
    rawPayment('A', 0, 'succeeded', 22_500, 2 * DAY),
    rawPayment('A', 1, 'succeeded', 33_000, 40 * DAY),
    rawPayment('B', 2, 'succeeded', 0, DAY),
    rawPayment('A', 6, 'needs_review', 15_000, null),
    rawPayment('A', 7, 'initialized', 99_900, null),
    rawPayment('A', 7, 'failed', 77_700, null),
    rawPayment('H', 8, 'needs_review', 12_000, null),
  ] as never);
}

describe('the paid-status lists', () => {
  it('revenue.ts and overview.ts agree on what counts as paid', () => {
    expect([...PAID_STATUSES]).toEqual([...PAID_OR_BEYOND]);
  });
});

describe.skipIf(!testDbUri)('admin overview: money and the seller funnel on a real MongoDB', () => {
  beforeAll(async () => {
    await connectTestDb('adminrevenue');
  });
  afterAll(async () => {
    await disconnectTestDb();
  });
  beforeEach(async () => {
    await Promise.all([SellerModel.deleteMany({}), MenuModel.deleteMany({}), OrderModel.deleteMany({}), PaymentModel.deleteMany({})]);
    await seed();
  });

  describe('payments', () => {
    it('GMV: the food value of orders that reached paid or beyond, by either method, split all-time / last 30 days', async () => {
      const { payments } = (await getOverview()).body;
      // all time: 7,500 + 11,000 + 4,000 + 6,000 + 2,500 + 1,000
      // last 30 days (paid within): 7,500 + 4,000 + 6,000 + 1,000   (the 40- and 50-day-old ones fall out)
      expect(payments.gmv).toEqual({ allTime: 32_000, last30Days: 18_500 });
    });

    it('cancelled and pending orders never count towards GMV', async () => {
      const before = (await getOverview()).body.payments.gmv;
      await OrderModel.collection.updateMany({ status: { $in: ['cancelled', 'pending'] } }, { $set: { total: 1_000_000 } });
      expect((await getOverview()).body.payments.gmv).toEqual(before);
    });

    it('revenue: only the platform fee on payments Paystack confirmed', async () => {
      const { payments } = (await getOverview()).body;
      // succeeded: 225 + 330 + 0. Not counted: needs_review 150 and 120, initialized 999, failed 777.
      expect(payments.revenue).toEqual({ allTime: 555, last30Days: 225 });
    });

    it('revenue keeps kobo: a fee that is not a whole naira shows as a decimal', async () => {
      await PaymentModel.collection.updateOne({ status: 'succeeded', platformFeeKobo: 0 }, { $set: { platformFeeKobo: 3333, paidAt: ago(DAY) } });
      expect((await getOverview()).body.payments.revenue).toEqual({ allTime: 588.33, last30Days: 258.33 });
    });

    it('paid on the platform vs paid by transfer: orders and GMV, with legacy orders counted as transfers', async () => {
      const { payments } = (await getOverview()).body;
      expect(payments.paidOnPlatform).toEqual({
        allTime: { orders: 3, gmv: 22_500 },
        last30Days: { orders: 2, gmv: 11_500 },
      });
      expect(payments.paidByTransfer).toEqual({
        allTime: { orders: 3, gmv: 9500 }, // 6,000 + 2,500 (no paymentMethod stored) + 1,000
        last30Days: { orders: 2, gmv: 7000 },
      });
      // The two never overlap and add up to the totals.
      expect(payments.paidOnPlatform.allTime.gmv + payments.paidByTransfer.allTime.gmv).toBe(payments.gmv.allTime);
      expect(payments.paidOnPlatform.allTime.orders + payments.paidByTransfer.allTime.orders).toBe(6);
      expect(payments.platformShare).toBe(0.5);
    });

    it('paying sellers (past their free orders) vs sellers on the platform (any confirmed payment)', async () => {
      const { payments } = (await getOverview()).body;
      expect(payments.payingSellers).toEqual({ allTime: 1, last30Days: 1 }); // A only; B paid during its free orders
      expect(payments.sellersOnPlatform).toEqual({ allTime: 2, last30Days: 2 }); // A and B
    });

    it('a seller whose only payments are older than 30 days is on the platform but not in the 30-day figures', async () => {
      await PaymentModel.collection.updateMany({ sellerId: ids.B }, { $set: { paidAt: ago(45 * DAY) } });
      await PaymentModel.collection.updateMany({ sellerId: ids.A, paidAt: { $gte: ago(30 * DAY) } }, { $set: { paidAt: ago(45 * DAY) } });
      const { payments } = (await getOverview()).body;
      expect(payments.sellersOnPlatform).toEqual({ allTime: 2, last30Days: 0 });
      expect(payments.payingSellers).toEqual({ allTime: 1, last30Days: 0 });
      expect(payments.revenue.last30Days).toBe(0);
    });

    it('payments needing review and sellers ready for online payment', async () => {
      const { payments } = (await getOverview()).body;
      expect(payments.paymentsNeedingReview).toBe(2); // A's cancelled-order payment and H's
      // A and B have a subaccount. C is flagged ready but has none, D is not ready.
      expect(payments.onlinePaymentsReady).toBe(2);
    });

    it('every figure comes with a definition that says what it is', async () => {
      const { payments } = (await getOverview()).body;
      for (const key of ['gmv', 'revenue', 'paidOnPlatform', 'paidByTransfer', 'platformShare', 'payingSellers', 'sellersOnPlatform', 'onlinePaymentsReady', 'paymentsNeedingReview']) {
        expect(typeof payments.definitions[key], key).toBe('string');
        expect(payments.definitions[key].length, key).toBeGreaterThan(40);
      }
      expect(payments.definitions.gmv).toMatch(/not including any service fee/i);
      expect(payments.definitions.revenue).toMatch(/service fee/i);
      expect(payments.definitions.revenue).toMatch(/refund/i);
    });

    it('on an empty database: zeros, and no share (no data is not 0%)', async () => {
      await Promise.all([SellerModel.deleteMany({}), MenuModel.deleteMany({}), OrderModel.deleteMany({}), PaymentModel.deleteMany({})]);
      const { payments } = (await getOverview()).body;
      expect(payments).toMatchObject({
        gmv: { allTime: 0, last30Days: 0 },
        revenue: { allTime: 0, last30Days: 0 },
        paidOnPlatform: { allTime: { orders: 0, gmv: 0 }, last30Days: { orders: 0, gmv: 0 } },
        paidByTransfer: { allTime: { orders: 0, gmv: 0 }, last30Days: { orders: 0, gmv: 0 } },
        platformShare: null,
        payingSellers: { allTime: 0, last30Days: 0 },
        sellersOnPlatform: { allTime: 0, last30Days: 0 },
        onlinePaymentsReady: 0,
        paymentsNeedingReview: 0,
      });
    });

    it('a database with no payments at all (before Paystack) reports transfer-only', async () => {
      await PaymentModel.deleteMany({});
      await OrderModel.collection.updateMany({}, { $unset: { paymentMethod: '' } });
      const { payments } = (await getOverview()).body;
      expect(payments.paidOnPlatform.allTime.orders).toBe(0);
      expect(payments.paidByTransfer.allTime.orders).toBe(6);
      expect(payments.platformShare).toBe(0);
      expect(payments.revenue).toEqual({ allTime: 0, last30Days: 0 });
    });
  });

  describe('funnel', () => {
    it('each stage only keeps sellers who got through every earlier stage', async () => {
      const { funnel } = (await getOverview()).body as { funnel: { key: string; label: string; count: number; fromPrevious: number | null; definition: string }[] };
      expect(funnel.map((s) => [s.key, s.count])).toEqual([
        ['registered', 7], // A B C D E F H
        ['profileComplete', 6], // E has no bank name
        ['menuPublished', 5], // A B C F H (D is only a draft; E has a menu but was dropped earlier)
        ['firstOrder', 4], // A B C H (F has none; E was dropped earlier even though it has orders)
        ['firstPaidOrder', 3], // A B C (H's order is only pending)
      ]);
      expect(funnel.map((s) => s.fromPrevious)).toEqual([null, 0.8571, 0.8333, 0.8, 0.75]);
    });

    it('stages are in order, labelled, and each has a definition', async () => {
      const { funnel } = (await getOverview()).body;
      expect(funnel.map((s: { label: string }) => s.label)).toEqual(['Registered', 'Profile complete', 'Menu published', 'First order', 'First paid order']);
      for (const stage of funnel) expect(stage.definition.length).toBeGreaterThan(40);
      expect(funnel[0].definition).toMatch(/Clerk/);
    });

    it('can only shrink: a count never exceeds the one before', async () => {
      const { funnel } = (await getOverview()).body;
      for (let i = 1; i < funnel.length; i += 1) expect(funnel[i].count).toBeLessThanOrEqual(funnel[i - 1].count);
    });

    it('a paid order by transfer counts for "first paid order" just as a Paystack one does', async () => {
      await OrderModel.collection.updateMany({ sellerId: ids.A }, { $set: { status: 'cancelled' } });
      await OrderModel.collection.updateMany({ sellerId: ids.B }, { $set: { status: 'cancelled' } });
      const { funnel } = (await getOverview()).body;
      expect(funnel[4].count).toBe(1); // only C (a bank-transfer seller) is left
    });

    it('suspended and deactivated sellers are still part of the funnel (it is history, not status)', async () => {
      await SellerModel.collection.updateOne({ _id: ids.A }, { $set: { status: 'suspended' } });
      expect((await getOverview()).body.funnel[4].count).toBe(3);
    });

    it('on an empty database: every stage 0 and no conversion', async () => {
      await Promise.all([SellerModel.deleteMany({}), MenuModel.deleteMany({}), OrderModel.deleteMany({})]);
      const { funnel } = (await getOverview()).body;
      expect(funnel.map((s: { count: number }) => s.count)).toEqual([0, 0, 0, 0, 0]);
      expect(funnel.map((s: { fromPrevious: number | null }) => s.fromPrevious)).toEqual([null, null, null, null, null]);
    });
  });

  describe('the rest of the overview is unchanged', () => {
    it('keeps its existing figures and definitions, and says Paystack as well as the seller can confirm payment', async () => {
      const { body } = await getOverview();
      expect(body).toMatchObject({ totalSellers: 7, openMenus: 4, totalOrders: 9 });
      expect(body.definitions.successRate).toMatch(/Paystack/);
      expect(body.definitions.successRate).toMatch(/seller/);
    });

    it('is still admin-only and leaks no customer or bank details', async () => {
      expect((await request(app).get('/api/admin/overview')).status).toBe(401);
      expect((await request(app).get('/api/admin/overview').set('Authorization', bearer('seller_A'))).status).toBe(403);
      const text = JSON.stringify((await getOverview()).body);
      for (const secret of ['+2348091112222', '0123456789', 'ACCT_', 'CLP-', 'Ada']) expect(text, secret).not.toContain(secret);
    });
  });
});
