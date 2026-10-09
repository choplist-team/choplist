import { describe, expect, it } from 'vitest';
import { slugCandidates, slugify } from '../src/sellers/slug.js';
import { normalizeNigerianPhone } from '../src/validation/phone.js';

describe('normalizeNigerianPhone', () => {
  it.each([
    ['0803 123 4567', '+2348031234567'],
    ['08031234567', '+2348031234567'],
    ['+234 803 123 4567', '+2348031234567'],
    ['2348031234567', '+2348031234567'],
    ['0907-111-2222', '+2349071112222'],
    ['(0701) 234 5678', '+2347012345678'],
  ])('normalises %j', (raw, expected) => {
    expect(normalizeNigerianPhone(raw)).toBe(expected);
  });

  it.each([
    '8031234567', // no leading 0 or country code (what a number input sends)
    '0803123456', // too short
    '080312345678', // too long
    '06031234567', // not a mobile prefix
    '+447911123456', // not Nigerian
    'call me',
  ])('rejects %j', (raw) => {
    expect(normalizeNigerianPhone(raw)).toBeNull();
  });
});

describe('slugify', () => {
  it.each([
    ["Mama T's Kitchen", 'mama-ts-kitchen'],
    ['  Ìyá Basira  ', 'iya-basira'],
    ['Suya & Grills!!', 'suya-grills'],
    ['AB', 'ab-kitchen'],
    ['***', 'kitchen'],
  ])('%j -> %j', (name, expected) => {
    expect(slugify(name)).toBe(expected);
  });

  it('leaves room for a suffix and never ends with a hyphen', () => {
    const slug = slugify('The Very Long Name Of A Lagos Food Business That Goes On');
    expect(slug.length).toBeLessThanOrEqual(37);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('lists numbered variants after the plain slug', () => {
    expect(slugCandidates('Mama T', 3)).toEqual(['mama-t', 'mama-t-2', 'mama-t-3']);
  });
});
