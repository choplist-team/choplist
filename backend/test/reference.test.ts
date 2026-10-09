import { describe, expect, it } from 'vitest';
import { REF_PATTERN } from '../src/models/order.js';
import { REF_ALPHABET, REF_LENGTH, generateRef } from '../src/orders/reference.js';

describe('reference codes', () => {
  it('uses 32 distinct characters and none of 0, O, 1, I', () => {
    expect(REF_ALPHABET).toHaveLength(32);
    expect(new Set(REF_ALPHABET).size).toBe(32);
    for (const confusing of ['0', 'O', '1', 'I']) expect(REF_ALPHABET).not.toContain(confusing);
  });

  it('agrees with the Order model pattern for every character', () => {
    // Guards against the generator and the model's validator drifting apart.
    for (const ch of REF_ALPHABET) expect(`CL-${ch.repeat(REF_LENGTH)}`).toMatch(REF_PATTERN);
    for (const ch of ['0', 'O', '1', 'I', 'a']) expect(`CL-${ch.repeat(REF_LENGTH)}`).not.toMatch(REF_PATTERN);
  });

  it('generates codes like CL-7KQ2M that match the pattern', () => {
    const refs = Array.from({ length: 2_000 }, () => generateRef());
    for (const ref of refs) expect(ref).toMatch(REF_PATTERN);
    // 10,000 random characters: every one of the 32 should show up. (Checking
    // the 2,000 codes are all different would fail ~6% of the time by pure
    // chance: the birthday problem.)
    const used = new Set(refs.flatMap((ref) => [...ref.slice(3)]));
    expect(used.size).toBe(32);
  });
});
