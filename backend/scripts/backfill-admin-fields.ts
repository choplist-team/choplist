// Brings existing data up to date for the admin console. See
// src/orders/backfill.ts for exactly what it changes.
//
//   cd backend
//   npm run backfill:admin             # DRY RUN: counts only, writes nothing
//   npm run backfill:admin -- --apply  # does it
//
// It prints counts and order references only, never phone numbers. It is safe to
// run twice. Run the dry run first, and take an Atlas backup/snapshot before
// --apply on real data.
//
// To use the local Docker database instead of the one in .env (PowerShell):
//   $env:MONGO_URI='mongodb://127.0.0.1:27018/choplist_dev'; npm run backfill:admin

import mongoose from 'mongoose';
import { backfillAdminFields } from '../src/orders/backfill.js';

const uri = process.env.MONGO_URI;
if (!uri) {
  console.error('MONGO_URI is not set (see .env).');
  process.exit(1);
}
const apply = process.argv.includes('--apply');

await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000, autoIndex: false });
console.log(`Database: "${mongoose.connection.name}"  mode: ${apply ? 'APPLY (writing)' : 'dry run (nothing is written)'}`);

try {
  const r = await backfillAdminFields({ apply });
  console.log(`Sellers without a status:            ${r.sellersWithoutStatus}`);
  console.log(`Order phones to put in +234 form:    ${r.phonesToNormalise}`);
  console.log(`Orders without a fingerprint:        ${r.ordersWithoutFingerprint}`);
  console.log(apply ? `Possible duplicates flagged:         ${r.duplicatesFlagged}` : 'Possible duplicates: (counted only on --apply)');
  if (r.unfixablePhones.length > 0) {
    console.log(`Orders whose phone is not a Nigerian mobile (left unchanged): ${r.unfixablePhones.join(', ')}`);
  }
  if (!apply) console.log('\nNothing was changed. Run again with --apply to write these changes.');
} finally {
  await mongoose.disconnect();
}
