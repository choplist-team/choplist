// Creates a demo seller ("demo-kitchen") with one open menu in the database
// named by MONGO_URI, so the customer routes can be tried without signing in.
//
//   cd backend
//   npm run seed:demo
//
// Safe to rerun: it replaces the previous demo seller, menu and orders, so it
// is also how you reset the demo stock. Refuses to run unless the database name
// ends in _dev or _test, so it cannot touch real data by accident.
//
// To seed the local Docker database instead of the one in .env (PowerShell):
//   $env:MONGO_URI='mongodb://127.0.0.1:27018/choplist_dev'; npm run seed:demo

import mongoose from 'mongoose';
import { MenuModel } from '../src/models/menu.js';
import { OrderModel } from '../src/models/order.js';
import { SellerModel } from '../src/models/seller.js';
import { lagosDay } from '../src/validation/day.js';

const DAY_MS = 86_400_000;

const uri = process.env.MONGO_URI;
if (!uri) {
  console.error('MONGO_URI is not set (see .env).');
  process.exit(1);
}

await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000, autoIndex: false });
const dbName = mongoose.connection.name;

try {
  if (!/_(dev|test)$/.test(dbName)) {
    console.error(`Refusing to seed "${dbName}": the database name must end in _dev or _test.`);
    process.exitCode = 1;
  } else {
    // The one-open-menu rule is a unique index, so make sure it exists.
    await Promise.all([SellerModel.createIndexes(), MenuModel.createIndexes(), OrderModel.createIndexes()]);

    // Replace any previous demo data.
    const old = await SellerModel.findOne({ slug: 'demo-kitchen' });
    if (old) {
      await Promise.all([MenuModel.deleteMany({ sellerId: old._id }), OrderModel.deleteMany({ sellerId: old._id })]);
      await SellerModel.deleteOne({ _id: old._id });
    }

    const seller = await SellerModel.create({
      // Not a real Clerk user: nobody can sign in as the demo seller.
      clerkUserId: 'demo_user',
      businessName: 'Demo Kitchen',
      slug: 'demo-kitchen',
      phone: '+2348031234567',
      payment: { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Demo Owner' },
    });

    const deliveryDay = lagosDay(new Date(Date.now() + 3 * DAY_MS));
    await MenuModel.create({
      sellerId: seller._id,
      title: 'Demo week',
      status: 'open',
      openedAt: new Date(),
      cutoffAt: new Date(Date.now() + 2 * DAY_MS),
      items: [
        { name: 'Jollof rice', description: 'With fried plantain', price: 3500, qtyTotal: 5, qtyRemaining: 5 },
        { name: 'Chapman', price: 1500, qtyTotal: 10, qtyRemaining: 10 },
      ],
      areas: ['Yaba', 'Surulere'],
      deliveryDays: [deliveryDay],
    });

    console.log(`Seeded database "${dbName}": seller "demo-kitchen" with an open menu`);
    console.log(`  5 Jollof rice, 10 Chapman, areas Yaba and Surulere, delivery ${deliveryDay}`);
  }
} finally {
  await mongoose.disconnect();
}
