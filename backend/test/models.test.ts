import { Error as MongooseError, Types, type Document } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { MenuModel } from '../src/models/menu.js';
import { OrderModel } from '../src/models/order.js';
import { SellerModel } from '../src/models/seller.js';

// validate() runs the schema rules and pre('validate') hooks in memory: no
// database needed.

function validSeller() {
  return {
    clerkUserId: 'user_123',
    businessName: "Mama Titi's Kitchen",
    slug: 'mama-titi',
    phone: '+2348031234567',
    payment: { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Titi Adebayo' },
  };
}

function validMenu() {
  return {
    sellerId: new Types.ObjectId(),
    title: 'Week of 13 Oct',
    cutoffAt: new Date('2026-10-16T18:00:00Z'),
    items: [{ name: 'Jollof rice', price: 3500, qtyTotal: 20, qtyRemaining: 20 }],
    areas: ['Yaba', 'Surulere'],
    deliveryDays: ['2026-10-17'],
  };
}

function validOrder() {
  return {
    ref: 'CL-7KQ2M',
    sellerId: new Types.ObjectId(),
    menuId: new Types.ObjectId(),
    customer: { name: 'Ada', phone: '+2348091112222' },
    delivery: { area: 'Yaba', address: '12 Herbert Macaulay Way', day: '2026-10-17' },
    lines: [
      { itemId: new Types.ObjectId(), name: 'Jollof rice', unitPrice: 3500, qty: 2 },
      { itemId: new Types.ObjectId(), name: 'Chapman', unitPrice: 1500, qty: 1 },
    ],
    total: 8500,
  };
}

// The paths that failed validation, or [] if the document is valid.
async function errorPaths(doc: Document): Promise<string[]> {
  try {
    await doc.validate();
    return [];
  } catch (err) {
    if (err instanceof MongooseError.ValidationError) return Object.keys(err.errors);
    throw err;
  }
}

describe('Seller schema', () => {
  it('accepts a valid seller', async () => {
    expect(await errorPaths(new SellerModel(validSeller()))).toEqual([]);
  });

  it('lowercases the slug', () => {
    expect(new SellerModel({ ...validSeller(), slug: 'Mama-Titi' }).slug).toBe('mama-titi');
  });

  it.each(['mama titi', 'mama--titi', '-mama', 'ab'])('rejects slug %j', async (slug) => {
    expect(await errorPaths(new SellerModel({ ...validSeller(), slug }))).toContain('slug');
  });

  it('rejects a phone that is not normalised to +234', async () => {
    expect(await errorPaths(new SellerModel({ ...validSeller(), phone: '08031234567' }))).toContain('phone');
  });

  it('requires payment details and a 10-digit account number', async () => {
    const seller = validSeller();
    const paths = await errorPaths(
      new SellerModel({ ...seller, payment: { ...seller.payment, accountNumber: '12345', bankName: undefined } }),
    );
    expect(paths).toEqual(expect.arrayContaining(['payment.accountNumber', 'payment.bankName']));
  });
});

describe('Menu schema', () => {
  it('accepts a valid menu and defaults status to draft', async () => {
    const menu = new MenuModel(validMenu());
    expect(await errorPaths(menu)).toEqual([]);
    expect(menu.status).toBe('draft');
  });

  it('gives every item its own _id (order lines refer to it)', () => {
    expect(new MenuModel(validMenu()).items[0]?._id).toBeInstanceOf(Types.ObjectId);
  });

  it('rejects an unknown status', async () => {
    expect(await errorPaths(new MenuModel({ ...validMenu(), status: 'live' }))).toContain('status');
  });

  it('rejects a fractional price and qtyRemaining above qtyTotal', async () => {
    const paths = await errorPaths(
      new MenuModel({ ...validMenu(), items: [{ name: 'Jollof', price: 3500.5, qtyTotal: 5, qtyRemaining: 6 }] }),
    );
    expect(paths).toEqual(expect.arrayContaining(['items.0.price', 'items.0.qtyRemaining']));
  });

  it('rejects negative stock', async () => {
    const paths = await errorPaths(
      new MenuModel({ ...validMenu(), items: [{ name: 'Jollof', price: 3500, qtyTotal: 5, qtyRemaining: -1 }] }),
    );
    expect(paths).toContain('items.0.qtyRemaining');
  });

  it('requires at least one item, area and delivery day', async () => {
    const paths = await errorPaths(new MenuModel({ ...validMenu(), items: [], areas: [], deliveryDays: [] }));
    expect(paths).toEqual(expect.arrayContaining(['items', 'areas', 'deliveryDays']));
  });

  it('rejects a delivery day that is not YYYY-MM-DD', async () => {
    expect(await errorPaths(new MenuModel({ ...validMenu(), deliveryDays: ['17/10/2026'] }))).toContain(
      'deliveryDays.0',
    );
  });
});

describe('Order schema', () => {
  it('accepts a valid order and defaults status to pending', async () => {
    const order = new OrderModel(validOrder());
    expect(await errorPaths(order)).toEqual([]);
    expect(order.status).toBe('pending');
  });

  it('rejects a total that does not match the lines', async () => {
    expect(await errorPaths(new OrderModel({ ...validOrder(), total: 8000 }))).toContain('total');
  });

  it.each(['CL-7KQ2O', 'CL-7KQ21', 'CL-7KQ2', 'cl-7kq2m'])('rejects ref %j', async (ref) => {
    expect(await errorPaths(new OrderModel({ ...validOrder(), ref }))).toContain('ref');
  });

  it('rejects an order with no lines', async () => {
    expect(await errorPaths(new OrderModel({ ...validOrder(), lines: [], total: 0 }))).toContain('lines');
  });
});

describe('declared indexes', () => {
  it('makes seller clerkUserId and slug unique', () => {
    const paths = SellerModel.schema.paths;
    expect(paths.clerkUserId?.options.unique).toBe(true);
    expect(paths.slug?.options.unique).toBe(true);
  });

  it('makes order ref unique', () => {
    expect(OrderModel.schema.paths.ref?.options.unique).toBe(true);
  });

  it('allows only one open menu per seller', () => {
    const index = MenuModel.schema.indexes().find(([, opts]) => opts?.name === 'one_open_menu_per_seller');
    expect(index).toEqual([
      { sellerId: 1 },
      expect.objectContaining({ unique: true, partialFilterExpression: { status: 'open' } }),
    ]);
  });
});
