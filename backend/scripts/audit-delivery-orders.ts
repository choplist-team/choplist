// Lists orders that are out for delivery but whose delivery code cannot reach
// the customer or cannot be confirmed. READ-ONLY: it changes nothing and prints
// order references only (no codes, no keys).
//
//   cd backend
//   npm run audit:delivery
//
// To check the local Docker database instead of the one in .env (PowerShell):
//   $env:MONGO_URI='mongodb://127.0.0.1:27018/choplist_dev'; npm run audit:delivery

import mongoose from 'mongoose';
import { findUnconfirmableOrders } from '../src/orders/audit.js';

const uri = process.env.MONGO_URI;
if (!uri) {
  console.error('MONGO_URI is not set (see .env).');
  process.exit(1);
}

await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000, autoIndex: false });
console.log(`Database: "${mongoose.connection.name}"`);

try {
  const problems = await findUnconfirmableOrders();
  if (problems.length === 0) {
    console.log('All orders that are out for delivery have a code and a key.');
  }
  for (const { ref, problem } of problems) {
    console.log(
      problem === 'no-code'
        ? `${ref}  no delivery code stored: cannot be confirmed. Cancel it, or mark it delivered by phone.`
        : `${ref}  placed before access keys: the customer cannot see the code. Cancel it and have them reorder, or mark it delivered by phone.`,
    );
  }
} finally {
  await mongoose.disconnect();
}
