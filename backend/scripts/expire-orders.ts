// Cancels unpaid orders that have waited too long and puts their portions back on
// sale. See src/orders/expire.ts for exactly what it does and what it never touches.
//
//   cd backend
//   npm run expire:orders                  # DRY RUN: counts only, changes nothing
//   npm run expire:orders -- --apply       # does it
//   npm run expire:orders -- --hours 24    # a different age than ORDER_EXPIRY_HOURS
//
// The server also runs this by itself every 15 minutes while ORDER_EXPIRY_HOURS is above
// 0, so this script is for checking first or for running it once by hand. It prints
// counts only, never names, phones or references.

import mongoose from 'mongoose';
import { DEFAULT_ORDER_EXPIRY_HOURS } from '../src/config.js';
import { expireUnpaidOrders } from '../src/orders/expire.js';

const uri = process.env.MONGO_URI;
if (!uri) {
  console.error('MONGO_URI is not set (see .env).');
  process.exit(1);
}
const apply = process.argv.includes('--apply');

const hoursArg = process.argv.indexOf('--hours');
const hours = Number(hoursArg === -1 ? (process.env.ORDER_EXPIRY_HOURS ?? DEFAULT_ORDER_EXPIRY_HOURS) : process.argv[hoursArg + 1]);
if (!Number.isFinite(hours) || hours <= 0) {
  console.error('The age must be a number of hours above 0 (ORDER_EXPIRY_HOURS=0 turns expiry off).');
  process.exit(1);
}

await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000, autoIndex: false });
console.log(`Database: "${mongoose.connection.name}"  mode: ${apply ? 'APPLY (writing)' : 'dry run (nothing is written)'}  older than: ${hours} hours`);

try {
  const r = await expireUnpaidOrders({ olderThanHours: hours, apply });
  console.log(`Unpaid orders older than that (this batch):  ${r.candidates}`);
  console.log(`Left alone (money or a payment in progress): ${r.skipped}`);
  console.log(apply ? `Cancelled, portions put back on sale:        ${r.expired}` : `Would be cancelled:                          ${r.wouldExpire}`);
  if (!apply) console.log('\nNothing was changed. Run again with --apply to cancel them.');
} finally {
  await mongoose.disconnect();
}
