import { createHash } from 'node:crypto';

// A short fingerprint of "who ordered what from which menu", stored on every
// order when it is created. Two orders with the same fingerprint are the same
// customer (by phone number) asking for exactly the same food from the same
// menu. Admins use it to spot a double tap or a retry that placed an order twice.
//
// It is a hash, so the order does not carry a second copy of the phone number.
// It cannot be used to read the phone back.
//
// The phone is already in one canonical form (+234...) when it reaches here
// (validation/phone.ts), so "0803..." and "+234803..." give the same fingerprint.
export function orderFingerprint(input: {
  phone: string;
  menuId: string;
  lines: { itemId: { toString(): string }; qty: number }[];
}): string {
  // Sorted, so "2 jollof then 1 chapman" and "1 chapman then 2 jollof" match.
  const lines = input.lines
    .map((line) => `${line.itemId.toString().toLowerCase()}:${line.qty}`)
    .sort()
    .join(',');
  return createHash('sha256').update(`${input.phone}|${input.menuId.toLowerCase()}|${lines}`).digest('hex');
}

// An order is a "possible duplicate" when the same fingerprint was used by an
// earlier, non-cancelled order within this long. A real second order for a
// friend is possible, which is why the flag says "possible".
export const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
