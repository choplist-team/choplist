import mongoose from 'mongoose';
import { MenuModel } from './models/menu.js';
import { AdminAuditModel } from './models/admin-audit.js';
import { EventLogModel } from './models/event-log.js';
import { MenuViewDailyModel } from './models/menu-view-daily.js';
import { MissingOrderReportModel } from './models/missing-order-report.js';
import { OrderModel } from './models/order.js';
import { PaymentModel } from './models/payment.js';
import { SellerModel } from './models/seller.js';

// Every model whose indexes must exist before the first request. Exported so the
// tests build exactly this set: a model missing here would silently have no
// unique indexes in production (autoIndex is off).
export const models = [SellerModel, MenuModel, OrderModel, EventLogModel, AdminAuditModel, MenuViewDailyModel, MissingOrderReportModel, PaymentModel];

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
