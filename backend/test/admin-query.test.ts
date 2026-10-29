import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { dateRangeFilter, dateRangeQuery, escapeRegex, maskPhone, paginationQuery, toPagination } from '../src/admin/query.js';

// No database: pure functions.

describe('maskPhone', () => {
  it('shows the first 4 and last 3 digits of the 11-digit number', () => {
    expect(maskPhone('+2348031234567')).toBe('0803****567');
    expect(maskPhone('+2347012345678')).toBe('0701****678');
  });

  it('never reveals the middle digits', () => {
    expect(maskPhone('+2348031234567')).not.toContain('1234');
  });

  it('masks everything for something that is not a stored phone number', () => {
    for (const odd of ['', 'not-a-number', '08031234567', '+23480312345']) expect(maskPhone(odd)).toBe('****');
  });
});

describe('escapeRegex', () => {
  it('makes search text literal', () => {
    const rx = new RegExp(escapeRegex('a.b(c)*'), 'i');
    expect(rx.test('A.B(C)*')).toBe(true);
    expect(rx.test('aXb(c)')).toBe(false);
  });

  it('does not throw on characters that would break a regex', () => {
    for (const text of ['(', ')', '[', '*', '+', '?', '\\', '{1,', '$^']) {
      expect(() => new RegExp(escapeRegex(text))).not.toThrow();
    }
  });
});

describe('pagination query', () => {
  const schema = z.object(paginationQuery);

  it('defaults to page 1, 20 per page', () => {
    expect(schema.parse({})).toEqual({ page: 1, limit: 20 });
  });

  it('accepts whole numbers in range', () => {
    expect(schema.parse({ page: '3', limit: '100' })).toEqual({ page: 3, limit: 100 });
  });

  it.each([['0'], ['-1'], ['2.5'], ['1e2'], [''], [' 3'], ['abc'], ['9999999']])('rejects page=%j', (page) => {
    expect(schema.safeParse({ page }).success).toBe(false);
  });

  it.each([['0'], ['101'], ['1000'], ['5.0'], ['-5']])('rejects limit=%j (maximum is 100)', (limit) => {
    expect(schema.safeParse({ limit }).success).toBe(false);
  });
});

describe('toPagination', () => {
  it('counts pages, and always has at least one', () => {
    expect(toPagination(0, 1, 20)).toEqual({ page: 1, limit: 20, total: 0, totalPages: 1 });
    expect(toPagination(20, 1, 20).totalPages).toBe(1);
    expect(toPagination(21, 1, 20).totalPages).toBe(2);
    expect(toPagination(101, 2, 100).totalPages).toBe(2);
  });
});

describe('date range (calendar days in Lagos time)', () => {
  it('from the start of the first Lagos day to the end of the last', () => {
    const filter = dateRangeFilter({ from: '2026-10-01', to: '2026-10-31' })!;
    // Lagos is UTC+1: Lagos midnight is 23:00 UTC the evening before.
    expect(filter.$gte!.toISOString()).toBe('2026-09-30T23:00:00.000Z');
    expect(filter.$lt!.toISOString()).toBe('2026-10-31T23:00:00.000Z'); // exclusive: the end of 31 Oct
  });

  it('one day (from = to) is exactly 24 hours', () => {
    const filter = dateRangeFilter({ from: '2026-10-17', to: '2026-10-17' })!;
    expect(filter.$lt!.getTime() - filter.$gte!.getTime()).toBe(24 * 3600_000);
  });

  it('either side may be missing; both missing is no filter', () => {
    expect(dateRangeFilter({ from: '2026-10-01' })).toEqual({ $gte: new Date('2026-09-30T23:00:00Z') });
    expect(dateRangeFilter({ to: '2026-10-01' })).toEqual({ $lt: new Date('2026-10-01T23:00:00Z') });
    expect(dateRangeFilter({})).toBeUndefined();
  });

  it('from after to is a 400', () => {
    expect(() => dateRangeFilter({ from: '2026-10-05', to: '2026-10-01' })).toThrow(/from: must not be after to/);
  });

  it('only real calendar days are accepted', () => {
    const schema = z.object(dateRangeQuery);
    expect(schema.safeParse({ from: '2026-10-17' }).success).toBe(true);
    for (const bad of ['2026-02-30', '17-10-2026', '2026-10-17T10:00:00Z', 'yesterday', '']) {
      expect(schema.safeParse({ from: bad }).success, bad).toBe(false);
    }
  });
});
