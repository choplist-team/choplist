import mongoose from 'mongoose';
import { MenuModel } from './models/menu.js';
import { OrderModel } from './models/order.js';
import { SellerModel } from './models/seller.js';

const models = [SellerModel, MenuModel, OrderModel];

export async function connectDb(uri: string): Promise<void> {
  await mongoose.connect(uri, {
    // Give up after 10s instead of the default 30s, so a wrong URI fails the
    // deploy quickly.
    serverSelectionTimeoutMS: 10_000,
    // We build indexes ourselves below, and wait for them.
    autoIndex: false,
  });

  // The unique indexes (order ref, seller slug, one open menu) are what stop
  // duplicates, so they must exist before the first request. createIndexes
  // only adds missing indexes; it never drops any.
  await Promise.all(models.map((m) => m.createIndexes()));

  const dbName = mongoose.connection.name;
  console.log(`Connected to MongoDB database "${dbName}"`);
  if (dbName === 'test') {
    // An Atlas URI copied without a /<database> path silently uses "test".
    console.warn('Warning: using the default "test" database. Add /choplist to MONGO_URI.');
  }
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}
