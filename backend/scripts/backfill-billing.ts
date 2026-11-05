// Gives existing sellers their free trial for the new billing system. See
// src/billing/backfill.ts for exactly what it changes.
//
//   cd backend
//   npm run backfill:billing                       # DRY RUN: counts only, writes nothing
//   npm run backfill:billing -- --check-clerk      # also counts sellers who would use the
//                                                  # placeholder payer email (reads Clerk)
//   npm run backfill:billing -- --apply            # does it
//   npm run backfill:billing -- --apply --start 2026-11-10T00:00:00Z   # a chosen start
//
// The trial starts at the time you run it (or --start), not at each seller's
// registration date, so no trial is already over. Sellers who already have trial
// dates are never touched, so it is safe to run twice. It prints counts only,
// never emails, phones or ids. Run the dry run first, and take an Atlas
// backup/snapshot before --apply on real data.
//
// To use the local Docker database instead of the one in .env (PowerShell):
//   $env:MONGO_URI='mongodb://127.0.0.1:27018/choplist_dev'; npm run backfill:billing

import mongoose from 'mongoose';
import { createClerkEmailLookup } from '../src/auth/clerk.js';
import { backfillBilling } from '../src/billing/backfill.js';
import { DEFAULT_TRIAL_DAYS } from '../src/config.js';

const uri = process.env.MONGO_URI;
if (!uri) {
  console.error('MONGO_URI is not set (see .env).');
  process.exit(1);
}
const apply = process.argv.includes('--apply');
const checkClerk = process.argv.includes('--check-clerk');

const startArg = process.argv.indexOf('--start');
const startAt = startArg === -1 ? new Date() : new Date(process.argv[startArg + 1] ?? '');
if (Number.isNaN(startAt.getTime())) {
  console.error('--start needs a date, e.g. --start 2026-11-10T00:00:00Z');
  process.exit(1);
}

const trialDays = Number(process.env.TRIAL_DAYS ?? DEFAULT_TRIAL_DAYS);
if (!Number.isInteger(trialDays) || trialDays < 1 || trialDays > 90) {
  console.error('TRIAL_DAYS must be a whole number from 1 to 90.');
  process.exit(1);
}

let lookupEmail: ((clerkUserId: string) => Promise<string | null>) | undefined;
if (checkClerk) {
  const secret = process.env.CLERK_SECRET_KEY;
  if (!secret) {
    console.error('--check-clerk needs CLERK_SECRET_KEY (see .env).');
    process.exit(1);
  }
  lookupEmail = createClerkEmailLookup(secret);
}

await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000, autoIndex: false });
console.log(`Database: "${mongoose.connection.name}"  mode: ${apply ? 'APPLY (writing)' : 'dry run (nothing is written)'}`);

try {
  const r = await backfillBilling({ apply, startAt, trialDays, lookupEmail });
  console.log(`Sellers in total:                         ${r.sellersTotal}`);
  console.log(`Sellers without a free trial yet:         ${r.sellersNeedingTrial}`);
  if (r.sellersNeedingTrial > 0) {
    console.log(`  trial would run:                        ${r.trialStartedAt.toISOString()}  ->  ${r.trialEndsAt.toISOString()}  (${trialDays} days)`);
  }
  console.log(`Sellers with an email on their profile:   ${r.sellersWithOwnEmail}`);
  console.log(`Sellers without one:                      ${r.sellersWithoutOwnEmail}`);
  if (r.sellersOnPlaceholder === null) {
    console.log('  of those, no email on the login account either: (not checked; add --check-clerk)');
  } else {
    console.log(`  of those, no email on the login account either: ${r.sellersOnPlaceholder}  <- these would pay Paystack with the placeholder address`);
  }
  if (apply) console.log(`Sellers given a trial:                    ${r.updated}`);
  else console.log('\nNothing was changed. Run again with --apply to write these changes.');
} finally {
  await mongoose.disconnect();
}
