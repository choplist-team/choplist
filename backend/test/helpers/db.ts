import mongoose from 'mongoose';
import { MenuModel } from '../../src/models/menu.js';
import { OrderModel } from '../../src/models/order.js';
import { SellerModel } from '../../src/models/seller.js';

// Database tests run only when MONGO_URI_TEST is set, e.g.
//   mongodb://127.0.0.1:27018/choplist_test
export const testDbUri = process.env.MONGO_URI_TEST;

// Connects to a database just for one test file ("<name>_test"), wipes it and
// builds the indexes. Vitest runs test files in parallel, so each file gets its
// own database instead of wiping another file's data.
export async function connectTestDb(name: string): Promise<void> {
  if (!testDbUri) throw new Error('MONGO_URI_TEST is not set');
  const dbName = `${name}_test`;
  await mongoose.connect(testDbUri, { dbName, autoIndex: false, serverSelectionTimeoutMS: 5_000 });

  // Refuse to wipe anything that is not clearly a test database.
  if (!mongoose.connection.name.endsWith('_test')) {
    throw new Error(`Refusing to drop "${mongoose.connection.name}": not a *_test database`);
  }
  await mongoose.connection.dropDatabase();
  await Promise.all([SellerModel.createIndexes(), MenuModel.createIndexes(), OrderModel.createIndexes()]);
}

export async function disconnectTestDb(): Promise<void> {
  await mongoose.disconnect();
}
