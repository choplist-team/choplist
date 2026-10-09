import mongoose from 'mongoose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectDb, disconnectDb } from '../src/db.js';
import { testDbUri } from './helpers/db.js';

// The connection code server.ts runs at startup (tests otherwise use their
// own helper). Uses the database named in MONGO_URI_TEST.
describe.skipIf(!testDbUri)('connectDb on a real MongoDB', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await disconnectDb();
  });

  it('connects, builds the unique indexes before returning, and logs the database name', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await connectDb(testDbUri!);

    expect(log).toHaveBeenCalledWith(`Connected to MongoDB database "${mongoose.connection.name}"`);
    const indexes = await mongoose.connection.db!.collection('orders').indexes();
    expect(indexes.find((i) => i.name === 'ref_1')?.unique).toBe(true);
    const menuIndexes = await mongoose.connection.db!.collection('menus').indexes();
    expect(menuIndexes.find((i) => i.name === 'one_open_menu_per_seller')?.unique).toBe(true);
  });

  it('warns when the URI has no database name (MongoDB would use "test")', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const url = new URL(testDbUri!);
    url.pathname = '/';
    await connectDb(url.toString());
    expect(mongoose.connection.name).toBe('test');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Add /choplist to MONGO_URI'));
  });
});
