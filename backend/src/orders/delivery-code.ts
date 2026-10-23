import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

// ---- The delivery code ------------------------------------------------------
// When an order goes out for delivery the server makes a short code. The
// customer sees it on their order page; the rider asks for it at the door and
// the seller types it in to confirm. See orders/router.ts for who may see it.

export const DELIVERY_CODE_LENGTH = 6;
// Wrong guesses allowed per code. After this, even the right code is refused
// until the seller resets it.
export const MAX_CODE_ATTEMPTS = 5;
// How many times a seller may reset one order's code. Without a cap a script
// could guess 5 codes, reset, and repeat. In total an order allows
// MAX_CODE_ATTEMPTS * (1 + MAX_CODE_RESETS) = 15 guesses.
export const MAX_CODE_RESETS = 2;

const CODE_SPACE = 10 ** DELIVERY_CODE_LENGTH;

// "000042", not "42": every code has the same length, so a code that starts
// with zeros is still a code.
export function formatDeliveryCode(n: number): string {
  return String(n).padStart(DELIVERY_CODE_LENGTH, '0');
}

export const DELIVERY_CODE_PATTERN = new RegExp(`^\\d{${DELIVERY_CODE_LENGTH}}$`);

// crypto.randomInt is unpredictable and unbiased. Math.random is neither
// guaranteed, and a code that can be predicted proves nothing.
export function generateDeliveryCode(): string {
  return formatDeliveryCode(randomInt(0, CODE_SPACE));
}

// A reset must give a code that differs from the one it replaces, or "reset"
// could hand back the same code. The generator is a parameter so a test can
// force a repeat; in real use the loop almost never runs a second time.
export function generateDifferentDeliveryCode(previous: string, generate: () => string = generateDeliveryCode): string {
  let code = generate();
  while (code === previous) code = generate();
  return code;
}

// ---- The order access key ---------------------------------------------------
// A random secret handed to the customer ONCE, in the response to placing the
// order, and never to the seller. The seller knows an order's ref and the
// customer's phone, so those cannot tell the customer from the seller; this key
// can. The customer's lookup shows the delivery code only when it carries the
// key. Only a hash is stored (like a password), so a database leak does not
// hand out working keys.

const ACCESS_KEY_BYTES = 24; // 192 bits: cannot be guessed
// 24 bytes as base64url is always 32 characters of A-Z a-z 0-9 - _
export const ACCESS_KEY_PATTERN = /^[A-Za-z0-9_-]{32}$/;

export function generateAccessKey(): string {
  return randomBytes(ACCESS_KEY_BYTES).toString('base64url');
}

// SHA-256 is fine here (unlike for a short password) because the input is 192
// random bits: there is nothing to guess, so no need for a slow hash.
export function hashAccessKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

// Compares in constant time, and answers false for a missing key or hash (an
// order made before keys existed has no hash).
export function accessKeyMatches(key: string | undefined, storedHash: string | null | undefined): boolean {
  if (!key || !storedHash || !ACCESS_KEY_PATTERN.test(key)) return false;
  const given = Buffer.from(hashAccessKey(key), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return given.length === stored.length && timingSafeEqual(given, stored);
}
