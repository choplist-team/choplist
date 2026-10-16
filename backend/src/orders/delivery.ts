import { randomInt, timingSafeEqual } from 'node:crypto';

// Wrong guesses allowed per delivery. 5 tries out of 1,000,000 codes is a
// 1-in-200,000 chance of guessing right.
export const MAX_CODE_ATTEMPTS = 5;

export const CODE_PATTERN = /^\d{6}$/;

// 6 digits, unbiased and unpredictable (crypto.randomInt, not Math.random).
export function generateDeliveryCode(): string {
  return randomInt(100000, 1000000).toString();
}

// Compares in constant time so response timing can't leak how many leading
// digits were right.
export function codesMatch(given: string, stored: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(stored);
  return a.length === b.length && timingSafeEqual(a, b);
}
