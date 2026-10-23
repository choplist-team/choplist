import { Error as MongooseError, Types, type Document } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { ORDER_STATUSES, OrderModel } from '../src/models/order.js';
import { generateAccessKey, hashAccessKey } from '../src/orders/delivery-code.js';
import { toSellerOrder } from '../src/orders/seller-view.js';

// No database: documents are built in memory and validated.

function validOrder(overrides: Record<string, unknown> = {}) {
  return {
    ref: 'CL-7KQ2M',
    sellerId: new Types.ObjectId(),
    menuId: new Types.ObjectId(),
    customer: { name: 'Ada', phone: '+2348091112222' },
    delivery: { area: 'Yaba', address: '12 Herbert Macaulay Way', day: '2026-10-17' },
    lines: [{ itemId: new Types.ObjectId(), name: 'Jollof rice', unitPrice: 3500, qty: 2 }],
    total: 7000,
    ...overrides,
  };
}

async function errorPaths(doc: Document): Promise<string[]> {
  try {
    await doc.validate();
    return [];
  } catch (err) {
    if (err instanceof MongooseError.ValidationError) return Object.keys(err.errors);
    throw err;
  }
}

describe('order statuses in the model', () => {
  it('accepts every status in the list, including the two new ones', async () => {
    for (const status of ORDER_STATUSES) {
      expect(await errorPaths(new OrderModel(validOrder({ status })))).toEqual([]);
    }
  });

  it('rejects the hyphenated spelling and made-up statuses', async () => {
    for (const status of ['out-for-delivery', 'shipped', 'PAID', '']) {
      expect(await errorPaths(new OrderModel(validOrder({ status })))).toContain('status');
    }
  });
});

describe('delivery fields in the model', () => {
  it('start out empty: no code, no key, counters at 0, nothing delivered', () => {
    const order = new OrderModel(validOrder());
    expect(order.status).toBe('pending');
    expect(order.deliveryCode).toBeUndefined();
    expect(order.accessKeyHash).toBeUndefined();
    expect(order.deliveryCodeAttempts).toBe(0);
    expect(order.deliveryCodeResets).toBe(0);
    expect(order.outForDeliveryAt).toBeUndefined();
    expect(order.deliveredAt).toBeUndefined();
  });

  it('accepts a 6-digit code, including leading zeros', async () => {
    for (const deliveryCode of ['482915', '012345', '000000']) {
      expect(await errorPaths(new OrderModel(validOrder({ deliveryCode })))).toEqual([]);
    }
  });

  it('rejects a code that is not exactly 6 digits', async () => {
    for (const deliveryCode of ['48291', '4829155', 'abcdef', '48 915', '4829-5']) {
      expect(await errorPaths(new OrderModel(validOrder({ deliveryCode })))).toContain('deliveryCode');
    }
  });

  it('rejects negative counters', async () => {
    const paths = await errorPaths(new OrderModel(validOrder({ deliveryCodeAttempts: -1, deliveryCodeResets: -1 })));
    expect(paths).toEqual(expect.arrayContaining(['deliveryCodeAttempts', 'deliveryCodeResets']));
  });

  it('marks exactly the two secrets select:false', () => {
    const selectFalse = Object.entries(OrderModel.schema.paths)
      .filter(([, path]) => path.options.select === false)
      .map(([name]) => name)
      .sort();
    expect(selectFalse).toEqual(['accessKeyHash', 'deliveryCode']);
  });
});

describe('toSellerOrder never shows the secrets', () => {
  // The document here CARRIES the secrets, as if a route had selected them. The
  // seller view is built from a whitelist, so they must still not come out.
  const key = generateAccessKey();
  const secretOrder = () =>
    new OrderModel(
      validOrder({
        status: 'out_for_delivery',
        deliveryCode: '482915',
        accessKeyHash: hashAccessKey(key),
        deliveryCodeAttempts: 3,
        deliveryCodeResets: 1,
        outForDeliveryAt: new Date('2026-10-17T09:00:00Z'),
      }),
    );

  it('the document really does carry them (so the next tests mean something)', () => {
    const order = secretOrder();
    expect(order.deliveryCode).toBe('482915');
    expect(order.accessKeyHash).toBe(hashAccessKey(key));
  });

  it('leaves out the code, the key hash, and the counters', () => {
    const view = toSellerOrder(secretOrder());
    const json = JSON.stringify(view);
    expect(json).not.toContain('482915');
    expect(json).not.toContain(hashAccessKey(key));
    expect(json).not.toContain(key);
    for (const name of ['deliveryCode', 'accessKeyHash', 'deliveryCodeAttempts', 'deliveryCodeResets']) {
      expect(view).not.toHaveProperty(name);
      expect(json).not.toContain(name);
    }
  });

  it('has exactly this set of fields: adding one is a deliberate choice, caught here', () => {
    expect(Object.keys(toSellerOrder(secretOrder())).sort()).toEqual(
      [
        'cancelledAt',
        'createdAt',
        'customer',
        'delivery',
        'deliveredAt',
        'id',
        'lines',
        'note',
        'outForDeliveryAt',
        'paidAt',
        'ref',
        'status',
        'total',
      ].sort(),
    );
  });

  it('shows the delivery timestamps, and null when they have not happened', () => {
    const inTransit = toSellerOrder(secretOrder());
    expect(inTransit.outForDeliveryAt).toEqual(new Date('2026-10-17T09:00:00Z'));
    expect(inTransit.deliveredAt).toBeNull();

    const fresh = toSellerOrder(new OrderModel(validOrder()));
    expect(fresh.outForDeliveryAt).toBeNull();
    expect(fresh.deliveredAt).toBeNull();
  });
});
