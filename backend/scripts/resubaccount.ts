// Recreates sellers' Paystack payout accounts ("subaccounts") in the mode of the current
// key. Needed once after moving from test to live (or back): a code made in one mode does
// not exist in the other. See src/payments/resubaccount.ts.
//
//   cd backend
//   npm run paystack:resubaccount             # DRY RUN: counts only, writes nothing
//   npm run paystack:resubaccount -- --apply  # recreates them
//
// It prints the mode (from the key's prefix) and counts only: never the key, codes,
// account numbers or names. Take an Atlas snapshot before --apply on real data.

import mongoose from 'mongoose';
import { keyMode } from '../src/admin/system.js';
import { createPaystackClient } from '../src/payments/paystack.js';
import { resubaccountSellers } from '../src/payments/resubaccount.js';

const uri = process.env.MONGO_URI;
const key = process.env.PAYSTACK_SECRET_KEY?.trim() || undefined;
if (!uri) {
  console.error('MONGO_URI is not set (see .env).');
  process.exit(1);
}
const apply = process.argv.includes('--apply');
if (apply && !key) {
  console.error('--apply needs PAYSTACK_SECRET_KEY (see .env).');
  process.exit(1);
}

await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000, autoIndex: false });
console.log(`Database: "${mongoose.connection.name}"  Paystack mode: ${keyMode(key) ?? 'no key'}  run: ${apply ? 'APPLY (writing)' : 'dry run (nothing is written)'}`);

try {
  const r = await resubaccountSellers({ apply, paystack: key ? createPaystackClient(key) : null });
  console.log(`Sellers with a stored payout account:     ${r.withCode}`);
  console.log(`  without a bank code (cannot be redone): ${r.skippedNoBankCode}  <- they must pick their bank again`);
  if (apply) {
    console.log(`Recreated:                                ${r.recreated}`);
    console.log(`Failed (Paystack said no):                ${r.failed}`);
  } else {
    console.log('\nNothing was changed. Run again with --apply to recreate them.');
  }
} finally {
  await mongoose.disconnect();
}
