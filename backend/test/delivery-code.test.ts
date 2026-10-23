import { describe, expect, it } from 'vitest';
import {
  ACCESS_KEY_PATTERN,
  DELIVERY_CODE_LENGTH,
  DELIVERY_CODE_PATTERN,
  MAX_CODE_ATTEMPTS,
  MAX_CODE_RESETS,
  accessKeyMatches,
  formatDeliveryCode,
  generateAccessKey,
  generateDeliveryCode,
  generateDifferentDeliveryCode,
  hashAccessKey,
} from '../src/orders/delivery-code.js';

// No database: pure functions only.

describe('limits', () => {
  it('are the agreed numbers: 6 digits, 5 attempts, 2 resets (15 guesses per order)', () => {
    expect(DELIVERY_CODE_LENGTH).toBe(6);
    expect(MAX_CODE_ATTEMPTS).toBe(5);
    expect(MAX_CODE_RESETS).toBe(2);
    expect(MAX_CODE_ATTEMPTS * (1 + MAX_CODE_RESETS)).toBe(15);
  });
});

describe('formatDeliveryCode', () => {
  it.each([
    [0, '000000'],
    [7, '000007'],
    [42, '000042'],
    [123456, '123456'],
    [999999, '999999'],
  ])('%i -> %s (always 6 characters, zero padded)', (n, expected) => {
    expect(formatDeliveryCode(n)).toBe(expected);
  });
});

describe('DELIVERY_CODE_PATTERN', () => {
  it('accepts exactly 6 digits, including leading zeros', () => {
    for (const ok of ['000000', '012345', '123456', '999999']) expect(DELIVERY_CODE_PATTERN.test(ok)).toBe(true);
  });

  it('rejects everything else', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 456', '12345a', ' 123456', '123456 ', '１２３４５６']) {
      expect(DELIVERY_CODE_PATTERN.test(bad)).toBe(false);
    }
  });
});

describe('generateDeliveryCode', () => {
  it('always gives 6 digits', () => {
    for (let i = 0; i < 2_000; i++) expect(generateDeliveryCode()).toMatch(DELIVERY_CODE_PATTERN);
  });

  it('uses the whole range, including codes that start with 0', () => {
    // 10% of codes start with 0: missing all of 3,000 draws has a chance of about 1 in 10^137.
    const codes = Array.from({ length: 3_000 }, generateDeliveryCode);
    expect(codes.some((c) => c.startsWith('0'))).toBe(true);
    expect(codes.some((c) => c.startsWith('9'))).toBe(true);
    // Every digit shows up in every position often enough that none is stuck.
    for (let position = 0; position < DELIVERY_CODE_LENGTH; position++) {
      expect(new Set(codes.map((c) => c[position])).size).toBe(10);
    }
  });
});

describe('generateDifferentDeliveryCode', () => {
  it('never returns the code it replaces, even if the generator repeats it', () => {
    const draws = ['123456', '123456', '123456', '654321'];
    const result = generateDifferentDeliveryCode('123456', () => draws.shift()!);
    expect(result).toBe('654321');
    expect(draws).toEqual([]); // it kept drawing until it got a different one
  });

  it('returns the first draw when it already differs', () => {
    expect(generateDifferentDeliveryCode('111111', () => '222222')).toBe('222222');
  });

  it('with the real generator, 2,000 resets never repeat the old code', () => {
    let code = generateDeliveryCode();
    for (let i = 0; i < 2_000; i++) {
      const next = generateDifferentDeliveryCode(code);
      expect(next).not.toBe(code);
      expect(next).toMatch(DELIVERY_CODE_PATTERN);
      code = next;
    }
  });
});

describe('access key', () => {
  it('is 32 URL-safe characters (24 random bytes)', () => {
    for (let i = 0; i < 200; i++) expect(generateAccessKey()).toMatch(ACCESS_KEY_PATTERN);
  });

  it('is different every time', () => {
    const keys = new Set(Array.from({ length: 1_000 }, generateAccessKey));
    expect(keys.size).toBe(1_000);
  });

  it('is stored as a 64-character SHA-256 hash that does not contain the key', () => {
    const key = generateAccessKey();
    const hash = hashAccessKey(key);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(key);
    expect(hashAccessKey(key)).toBe(hash); // same input, same hash
    expect(hashAccessKey(generateAccessKey())).not.toBe(hash);
  });

  it('matches only its own hash', () => {
    const key = generateAccessKey();
    const hash = hashAccessKey(key);
    expect(accessKeyMatches(key, hash)).toBe(true);
    expect(accessKeyMatches(generateAccessKey(), hash)).toBe(false);
  });

  it('never matches a missing key or a missing hash (an order from before keys existed)', () => {
    const key = generateAccessKey();
    expect(accessKeyMatches(undefined, hashAccessKey(key))).toBe(false);
    expect(accessKeyMatches('', hashAccessKey(key))).toBe(false);
    expect(accessKeyMatches(key, undefined)).toBe(false);
    expect(accessKeyMatches(key, null)).toBe(false);
    expect(accessKeyMatches(key, '')).toBe(false);
  });

  it('rejects keys of the wrong shape without throwing', () => {
    const hash = hashAccessKey(generateAccessKey());
    for (const bad of ['short', 'x'.repeat(31), 'x'.repeat(33), `${'a'.repeat(31)}!`, 'a'.repeat(5000)]) {
      expect(accessKeyMatches(bad, hash)).toBe(false);
    }
  });

  it('does not throw if the stored hash is malformed', () => {
    expect(accessKeyMatches(generateAccessKey(), 'not-hex')).toBe(false);
    expect(accessKeyMatches(generateAccessKey(), 'abcd')).toBe(false);
  });
});
