import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../src/errors.js';
import { MenuModel } from '../src/models/menu.js';
import { OrderModel } from '../src/models/order.js';
import { placeOrder, type PlaceOrderInput } from '../src/orders/place-order.js';
import { lagosDay } from '../src/validation/day.js';
import { connectTestDb, disconnectTestDb, testDbUri } from './helpers/db.js';

const DAY_MS = 86_400_000;
const DELIVERY_DAY = lagosDay(new Date(Date.now() + 3 * DAY_MS));

// An open menu, by default with Jollof (5 left) and Chapman (10 left).
async function openMenu(stock: Record<string, number> = { Jollof: 5, Chapman: 10 }, extra: object = {}) {
  const menu = await MenuModel.create({
    sellerId: new Types.ObjectId(),
    title: 'Week',
    status: 'open',
    openedAt: new Date(),
    cutoffAt: new Date(Date.now() + 2 * DAY_MS),
    items: Object.entries(stock).map(([name, qty]) => ({ name, price: 2000, qtyTotal: Math.max(qty, 1), qtyRemaining: qty })),
    areas: ['Yaba', 'Surulere'],
    deliveryDays: [DELIVERY_DAY],
    ...extra,
  });
  const id = (name: string) => menu.items.find((i) => i.name === name)!._id.toString();
  return { menuId: menu._id.toString(), id };
}

function order(menuId: string, lines: PlaceOrderInput['lines'], overrides: Partial<PlaceOrderInput> = {}): PlaceOrderInput {
  return {
    menuId,
    customer: { name: 'Ada', phone: '+2348091112222' },
    delivery: { area: 'Yaba', address: '12 Herbert Macaulay Way', day: DELIVERY_DAY },
    lines,
    ...overrides,
  };
}

async function remaining(menuId: string): Promise<Record<string, number>> {
  const menu = await MenuModel.findById(menuId).lean();
  return Object.fromEntries(menu!.items.map((i) => [i.name, i.qtyRemaining]));
}

// The AppError code a placeOrder call fails with.
async function failureCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof AppError) return err.code;
    throw err;
  }
  throw new Error('expected placeOrder to fail');
}

describe.skipIf(!testDbUri)('placeOrder on a real MongoDB', () => {
  beforeAll(async () => {
    await connectTestDb('orders');
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  beforeEach(async () => {
    await Promise.all([MenuModel.deleteMany({}), OrderModel.deleteMany({})]);
  });

  it('places an order: snapshots name and price, computes the total, takes the stock', async () => {
    const { menuId, id } = await openMenu();
    const placed = await placeOrder(order(menuId, [{ itemId: id('Jollof'), qty: 2 }, { itemId: id('Chapman'), qty: 1 }]));

    expect(placed.ref).toMatch(/^CL-[2-9A-HJ-NP-Z]{5}$/);
    expect(placed.status).toBe('pending');
    expect(placed.total).toBe(6000);
    expect(placed.lines.map((l) => [l.name, l.unitPrice, l.qty])).toEqual([
      ['Jollof', 2000, 2],
      ['Chapman', 2000, 1],
    ]);
    expect(await remaining(menuId)).toEqual({ Jollof: 3, Chapman: 9 });
  });

  it('40 customers at once for 5 portions: exactly 5 succeed and stock ends at 0', async () => {
    const { menuId, id } = await openMenu({ Jollof: 5 });

    const results = await Promise.allSettled(
      Array.from({ length: 40 }, (_, n) =>
        placeOrder(order(menuId, [{ itemId: id('Jollof'), qty: 1 }], { customer: { name: `Customer ${n}`, phone: '+2348091112222' } })),
      ),
    );

    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(5);
    expect(failed).toHaveLength(35);
    expect(failed.every((r) => r.reason instanceof AppError && r.reason.code === 'SOLD_OUT')).toBe(true);
    expect(await remaining(menuId)).toEqual({ Jollof: 0 });
    expect(await OrderModel.countDocuments({ menuId })).toBe(5);
  });

  it('a multi-item order is all-or-nothing', async () => {
    const { menuId, id } = await openMenu({ Jollof: 5, Chapman: 1 });
    const code = await failureCode(placeOrder(order(menuId, [{ itemId: id('Jollof'), qty: 1 }, { itemId: id('Chapman'), qty: 2 }])));
    expect(code).toBe('SOLD_OUT');
    // Jollof had enough, but nothing was taken because Chapman did not.
    expect(await remaining(menuId)).toEqual({ Jollof: 5, Chapman: 1 });
    expect(await OrderModel.countDocuments()).toBe(0);
  });

  it('$elemMatch: one sold-out item is not rescued by another item having stock', async () => {
    // Without $elemMatch, "some item has this id" and "some item has >= 1 left"
    // would both be true (different items) and Jollof would go to -1.
    const { menuId, id } = await openMenu({ Jollof: 0, Chapman: 10 });
    expect(await failureCode(placeOrder(order(menuId, [{ itemId: id('Jollof'), qty: 1 }])))).toBe('SOLD_OUT');
    expect(await remaining(menuId)).toEqual({ Jollof: 0, Chapman: 10 });
  });

  it('the same item twice is checked against its total', async () => {
    const { menuId, id } = await openMenu({ Jollof: 3 });
    const twice = (a: number, b: number) => order(menuId, [{ itemId: id('Jollof'), qty: a }, { itemId: id('Jollof'), qty: b }]);

    expect(await failureCode(placeOrder(twice(2, 2)))).toBe('SOLD_OUT');
    expect(await remaining(menuId)).toEqual({ Jollof: 3 });

    const placed = await placeOrder(twice(1, 2));
    expect(placed.lines).toHaveLength(1);
    expect(placed.lines[0]!.qty).toBe(3);
    expect(await remaining(menuId)).toEqual({ Jollof: 0 });
  });

  it('the sold-out message says what is left', async () => {
    const { menuId, id } = await openMenu({ Jollof: 2 });
    await expect(placeOrder(order(menuId, [{ itemId: id('Jollof'), qty: 3 }]))).rejects.toThrow('only 2 Jollof left');
  });

  it('a closed menu, a draft and a passed cut-off all refuse orders without touching stock', async () => {
    for (const extra of [
      { status: 'closed', closedAt: new Date() },
      { status: 'draft' },
      { cutoffAt: new Date(Date.now() - 60_000) },
    ]) {
      const { menuId, id } = await openMenu({ Jollof: 5 }, extra);
      expect(await failureCode(placeOrder(order(menuId, [{ itemId: id('Jollof'), qty: 1 }])))).toBe('ORDERING_CLOSED');
      expect(await remaining(menuId)).toEqual({ Jollof: 5 });
    }
  });

  // placeOrder reads the menu (it looks fine), then `change` runs, then the
  // stock update. Proves the update's own filter enforces the rule, not just
  // the earlier read.
  async function changeAfterRead(menuId: string, change: object, run: () => Promise<unknown>) {
    const findById = MenuModel.findById.bind(MenuModel);
    let first = true;
    MenuModel.findById = ((...args: Parameters<typeof findById>) => {
      const query = findById(...args);
      if (!first) return query;
      first = false;
      return query.then(async (doc) => {
        await MenuModel.updateOne({ _id: menuId }, { $set: change });
        return doc;
      });
    }) as typeof MenuModel.findById;
    try {
      return await run();
    } finally {
      MenuModel.findById = findById;
    }
  }

  it('closing the menu between the read and the update is caught by the update (status clause)', async () => {
    const { menuId, id } = await openMenu({ Jollof: 5 });
    const code = await changeAfterRead(menuId, { status: 'closed' }, () =>
      failureCode(placeOrder(order(menuId, [{ itemId: id('Jollof'), qty: 1 }]))),
    );
    expect(code).toBe('ORDERING_CLOSED');
    expect(await remaining(menuId)).toEqual({ Jollof: 5 });
  });

  it('the cut-off passing between the read and the update is caught by the update (cutoffAt clause)', async () => {
    const { menuId, id } = await openMenu({ Jollof: 5 });
    // Still "open", but the cut-off is now in the past.
    const code = await changeAfterRead(menuId, { cutoffAt: new Date(Date.now() - 1_000) }, () =>
      failureCode(placeOrder(order(menuId, [{ itemId: id('Jollof'), qty: 1 }]))),
    );
    expect(code).toBe('ORDERING_CLOSED');
    expect(await remaining(menuId)).toEqual({ Jollof: 5 });
  });

  it('rejects unknown items, areas and days without touching stock', async () => {
    const { menuId, id } = await openMenu({ Jollof: 5 });
    const jollof = [{ itemId: id('Jollof'), qty: 1 }];

    expect(await failureCode(placeOrder(order(menuId, [{ itemId: new Types.ObjectId().toString(), qty: 1 }])))).toBe('ITEM_NOT_FOUND');
    expect(await failureCode(placeOrder(order(menuId, [{ itemId: 'not-an-id', qty: 1 }])))).toBe('ITEM_NOT_FOUND');
    expect(
      await failureCode(placeOrder(order(menuId, jollof, { delivery: { area: 'Lekki', address: 'x', day: DELIVERY_DAY } }))),
    ).toBe('INVALID_AREA');
    expect(
      await failureCode(placeOrder(order(menuId, jollof, { delivery: { area: 'Yaba', address: 'x', day: '2020-01-01' } }))),
    ).toBe('INVALID_DELIVERY_DAY');
    expect(await failureCode(placeOrder(order(new Types.ObjectId().toString(), jollof)))).toBe('MENU_NOT_FOUND');
    expect(await remaining(menuId)).toEqual({ Jollof: 5 });
  });

  it("stores the seller's spelling of the area", async () => {
    const { menuId, id } = await openMenu({ Jollof: 5 });
    const placed = await placeOrder(
      order(menuId, [{ itemId: id('Jollof'), qty: 1 }], { delivery: { area: '  yaba ', address: 'x', day: DELIVERY_DAY } }),
    );
    expect(placed.delivery.area).toBe('Yaba');
  });

  it('retries the insert on a reference collision and takes the stock only once', async () => {
    const { menuId, id } = await openMenu({ Jollof: 5 });
    await placeOrder(order(menuId, [{ itemId: id('Jollof'), qty: 1 }]), { generateRef: () => 'CL-AAAAA' });

    const refs = ['CL-AAAAA', 'CL-AAAAA', 'CL-BBBBB'];
    const placed = await placeOrder(order(menuId, [{ itemId: id('Jollof'), qty: 1 }]), { generateRef: () => refs.shift()! });

    expect(placed.ref).toBe('CL-BBBBB');
    expect(await remaining(menuId)).toEqual({ Jollof: 3 }); // 5 - 1 - 1
  });

  it('gives the stock back when the order cannot be saved', async () => {
    const { menuId, id } = await openMenu({ Jollof: 5, Chapman: 10 });
    await placeOrder(order(menuId, [{ itemId: id('Chapman'), qty: 1 }]), { generateRef: () => 'CL-ZZZZZ' });

    // Every code collides: the insert never succeeds.
    await expect(
      placeOrder(order(menuId, [{ itemId: id('Jollof'), qty: 2 }, { itemId: id('Chapman'), qty: 3 }]), {
        generateRef: () => 'CL-ZZZZZ',
      }),
    ).rejects.toMatchObject({ code: 11000 });

    expect(await remaining(menuId)).toEqual({ Jollof: 5, Chapman: 9 });
    expect(await OrderModel.countDocuments()).toBe(1);
  });

  it('demonstration: read-then-write oversells (why we do not do it)', async () => {
    const { menuId, id } = await openMenu({ Jollof: 1 });
    const itemId = id('Jollof');

    // Two customers, replayed step by step: both read, both check, both write.
    const readA = await MenuModel.findById(menuId);
    const readB = await MenuModel.findById(menuId);
    const sold: string[] = [];
    for (const [who, read] of [['A', readA], ['B', readB]] as const) {
      const item = read!.items.find((i) => i._id.toString() === itemId)!;
      if (item.qtyRemaining >= 1) {
        await MenuModel.updateOne(
          { _id: menuId, 'items._id': item._id },
          { $set: { 'items.$.qtyRemaining': item.qtyRemaining - 1 } },
        );
        sold.push(who);
      }
    }
    expect(sold).toEqual(['A', 'B']); // one portion, two customers told "yes"
    expect(await remaining(menuId)).toEqual({ Jollof: 0 }); // and the count hides it
  });
});
