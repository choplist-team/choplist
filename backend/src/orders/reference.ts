import { randomInt } from 'node:crypto';

// 32 characters: digits 2-9 and A-Z without I and O. No 0/O or 1/I, so a code
// read out over WhatsApp or typed into a bank transfer note can't be misread.
export const REF_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const REF_LENGTH = 5;

// 32^5 = 33,554,432 possible codes. Collisions are rare, not impossible, so
// the unique index on Order.ref is the real guarantee and placeOrder retries.
export function generateRef(): string {
  let code = '';
  for (let i = 0; i < REF_LENGTH; i++) {
    // crypto.randomInt is unbiased and unpredictable (Math.random is neither
    // guaranteed), so codes can't be guessed from earlier ones.
    code += REF_ALPHABET[randomInt(REF_ALPHABET.length)];
  }
  return `CL-${code}`;
}
