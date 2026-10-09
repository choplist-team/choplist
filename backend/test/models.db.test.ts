import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectDb, disconnectDb } from '../src/db.js';
import { MenuModel } from '../src/models/menu.js';
import { OrderModel } from '../src/models/order.js';
import { SellerModel } from '../src/models/seller.js';

// Runs only when MONGO_URI_TEST points at a throwaway database whose name ends
// in "_test". That database is DROPPED at the start.
const uri = process.env.MONGO_URI_TEST;

describe.skipIf(!uri)('indexes on a real MongoDB', () => {
  beforeAll(async () => {
    await connectDb(uri!);
    // Refuse to wipe anything that is not clearly a test database.
    if (!mongoose.connection.name.endsWith('_test')) {
      throw new Error(`Refusing to drop "${mongoose.connection.name}": MONGO_URI_TEST must name a *_test database`);
    }
    await mongoose.connection.dropDatabase();
    // dropDatabase removes the indexes too; rebuild them like startup does.
    await Promise.all([SellerModel.createIndexes(), MenuModel.createIndexes(), OrderModel.createIndexes()]);
  });

  afterAll(async () => {
    await disconnectDb();
  });

  const seller = (clerkUserId: string, slug: string) => ({
    clerkUserId,
    businessName: 'Test Kitchen',
    slug,
    phone: '+2348031234567',
    payment: { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Test' },
  });

  const menu = (sellerId: Types.ObjectId, status: 'draft' | 'open' | 'closed') => ({
    sellerId,
    title: 'Week',
    status,
    cutoffAt: new Date(Date.now() + 86_400_000),
    items: [{ name: 'Jollof', price: 3500, qtyTotal: 5, qtyRemaining: 5 }],
    areas: ['Yaba'],
    deliveryDays: ['2026-10-17'],
  });

  const order = (ref: string) => ({
    ref,
    sellerId: new Types.ObjectId(),
    menuId: new Types.ObjectId(),
    customer: { name: 'Ada', phone: '+2348091112222' },
    delivery: { area: 'Yaba', address: '1 Road', day: '2026-10-17' },
    lines: [{ itemId: new Types.ObjectId(), name: 'Jollof', unitPrice: 3500, qty: 1 }],
    total: 3500,
  });

  it('rejects a second seller with the same slug (code 11000 = duplicate key)', async () => {
    await SellerModel.create(seller('user_a', 'mama-titi'));
    await expect(SellerModel.create(seller('user_b', 'mama-titi'))).rejects.toMatchObject({ code: 11000 });
  });

  it('rejects a second order with the same ref', async () => {
    await OrderModel.create(order('CL-ABCDE'));
    await expect(OrderModel.create(order('CL-ABCDE'))).rejects.toMatchObject({ code: 11000 });
  });

  it('allows many drafts and closed menus but only one open menu per seller', async () => {
    const sellerId = new Types.ObjectId();
    await MenuModel.create([menu(sellerId, 'draft'), menu(sellerId, 'draft'), menu(sellerId, 'closed')]);
    await MenuModel.create(menu(sellerId, 'open'));
    await expect(MenuModel.create(menu(sellerId, 'open'))).rejects.toMatchObject({ code: 11000 });

    // A different seller can have their own open menu.
    await expect(MenuModel.create(menu(new Types.ObjectId(), 'open'))).resolves.toBeDefined();
  });
});
