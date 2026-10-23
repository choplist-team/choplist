import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OrderModel } from '../src/models/order.js';
import { generateAccessKey, hashAccessKey } from '../src/orders/delivery-code.js';
import { toSellerOrder } from '../src/orders/seller-view.js';
import { connectTestDb, disconnectTestDb, testDbUri } from './helpers/db.js';

const key = generateAccessKey();
const REF = 'CL-7KQ2M';

function orderData(overrides: Record<string, unknown> = {}) {
  return {
    ref: REF,
    sellerId: new Types.ObjectId(),
    menuId: new Types.ObjectId(),
    customer: { name: 'Ada', phone: '+2348091112222' },
    delivery: { area: 'Yaba', address: '12 Herbert Macaulay Way', day: '2026-10-17' },
    lines: [{ itemId: new Types.ObjectId(), name: 'Jollof rice', unitPrice: 3500, qty: 2 }],
    total: 7000,
    status: 'out_for_delivery',
    deliveryCode: '482915',
    accessKeyHash: hashAccessKey(key),
    ...overrides,
  };
}

describe.skipIf(!testDbUri)('delivery secrets on a real MongoDB', () => {
  beforeAll(async () => {
    await connectTestDb('secrets');
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  beforeEach(async () => {
    await OrderModel.deleteMany({});
    await new OrderModel(orderData()).save();
  });

  it('really stores both secrets (read straight from the collection, bypassing Mongoose)', async () => {
    const raw = await OrderModel.collection.findOne({ ref: REF });
    expect(raw?.deliveryCode).toBe('482915');
    expect(raw?.accessKeyHash).toBe(hashAccessKey(key));
  });

  it('findOne, find, findById and lean() all leave both secrets out', async () => {
    const one = await OrderModel.findOne({ ref: REF });
    expect(one?.deliveryCode).toBeUndefined();
    expect(one?.accessKeyHash).toBeUndefined();
    expect(JSON.stringify(one)).not.toContain('482915');

    const many = await OrderModel.find({ ref: REF });
    expect(many[0]?.deliveryCode).toBeUndefined();

    const byId = await OrderModel.findById(one!._id);
    expect(byId?.deliveryCode).toBeUndefined();

    const lean = await OrderModel.findOne({ ref: REF }).lean();
    expect(lean).not.toHaveProperty('deliveryCode');
    expect(lean).not.toHaveProperty('accessKeyHash');
  });

  it('a query that asks for them by name gets them back', async () => {
    const order = await OrderModel.findOne({ ref: REF }).select('+deliveryCode +accessKeyHash');
    expect(order?.deliveryCode).toBe('482915');
    expect(order?.accessKeyHash).toBe(hashAccessKey(key));
  });

  it('findOneAndUpdate returns the document without them, even when it changed them', async () => {
    const updated = await OrderModel.findOneAndUpdate(
      { ref: REF },
      { $set: { deliveryCode: '111222' } },
      { returnDocument: 'after' },
    );
    expect(updated?.deliveryCode).toBeUndefined();
    // ...but the new code really was written.
    const raw = await OrderModel.collection.findOne({ ref: REF });
    expect(raw?.deliveryCode).toBe('111222');
  });

  it('a filter can match on a select:false field (the atomic confirm in step 3 relies on this)', async () => {
    const right = await OrderModel.findOne({ ref: REF, deliveryCode: '482915' });
    expect(right?.ref).toBe(REF);
    expect(right?.deliveryCode).toBeUndefined(); // matched on it, but still not returned

    expect(await OrderModel.findOne({ ref: REF, deliveryCode: '000000' })).toBeNull();
  });

  it('even when a route selects the secrets, the seller view still leaves them out', async () => {
    const order = await OrderModel.findOne({ ref: REF }).select('+deliveryCode +accessKeyHash');
    expect(order?.deliveryCode).toBe('482915'); // loaded...
    const json = JSON.stringify(toSellerOrder(order!));
    expect(json).not.toContain('482915'); // ...and still not in the response
    expect(json).not.toContain(hashAccessKey(key));
  });

  it('aggregate() ignores select:false: this is why reports list their fields explicitly', async () => {
    const [row] = await OrderModel.aggregate([{ $match: { ref: REF } }]);
    expect(row.deliveryCode).toBe('482915'); // an aggregation returns whatever the pipeline passes through
  });

  it('an order from before this feature has no counters, and "$lt 5" does not match a missing field', async () => {
    await OrderModel.deleteMany({});
    // Written straight to the collection, as an old order would be: no counters at all.
    await OrderModel.collection.insertOne({ ...orderData(), deliveryCode: '482915', createdAt: new Date() });

    const raw = await OrderModel.collection.findOne({ ref: REF });
    expect(raw).not.toHaveProperty('deliveryCodeAttempts');

    // The check the confirm step will use, against a missing counter: no match.
    expect(await OrderModel.findOne({ ref: REF, deliveryCodeAttempts: { $lt: 5 } })).toBeNull();

    // So "go out for delivery" must set the counters explicitly. Once set, it matches.
    await OrderModel.updateOne({ ref: REF }, { $set: { deliveryCodeAttempts: 0, deliveryCodeResets: 0 } });
    expect(await OrderModel.findOne({ ref: REF, deliveryCodeAttempts: { $lt: 5 } })).not.toBeNull();
  });

  it('new orders get the counters from the schema defaults', async () => {
    const raw = await OrderModel.collection.findOne({ ref: REF });
    expect(raw?.deliveryCodeAttempts).toBe(0);
    expect(raw?.deliveryCodeResets).toBe(0);
  });
});
