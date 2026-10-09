import { describe, expect, it } from 'vitest';
import { menuBodySchema, toMenuFields } from '../src/menus/schema.js';
import { isRealDay, lagosDay } from '../src/validation/day.js';

// Pure checks: no database.

const DAY_MS = 86_400_000;

// A valid body relative to now, so the tests never expire.
function body(overrides: Record<string, unknown> = {}) {
  const cutoff = new Date(Date.now() + 2 * DAY_MS);
  return {
    title: 'Week menu',
    cutoffAt: cutoff.toISOString(),
    items: [
      { name: 'Jollof rice', price: 3500, qty: 20 },
      { name: 'Chapman', description: 'Large bottle', price: 1500, qty: 10 },
    ],
    areas: ['Yaba', 'Surulere'],
    deliveryDays: [lagosDay(new Date(cutoff.getTime() + 2 * DAY_MS)), lagosDay(new Date(cutoff.getTime() + DAY_MS))],
    ...overrides,
  };
}

function issues(input: unknown): string[] {
  const result = menuBodySchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

describe('lagosDay and isRealDay', () => {
  it('gives the Lagos date, which is an hour ahead of UTC', () => {
    expect(lagosDay(new Date('2026-10-16T22:59:00Z'))).toBe('2026-10-16');
    expect(lagosDay(new Date('2026-10-16T23:00:00Z'))).toBe('2026-10-17');
  });

  it('rejects days that do not exist', () => {
    expect(isRealDay('2026-02-28')).toBe(true);
    expect(isRealDay('2026-02-30')).toBe(false);
    expect(isRealDay('2026-13-01')).toBe(false);
  });
});

describe('menuBodySchema', () => {
  it('accepts a valid menu', () => {
    expect(issues(body())).toEqual([]);
  });

  it('stores qty as both qtyTotal and qtyRemaining, and sorts delivery days', () => {
    const fields = toMenuFields(menuBodySchema.parse(body()));
    expect(fields.items[0]).toMatchObject({ qtyTotal: 20, qtyRemaining: 20 });
    expect(fields.deliveryDays).toEqual([...fields.deliveryDays].sort());
  });

  it('ignores a client-sent qtyRemaining or status', () => {
    const parsed = menuBodySchema.parse(
      body({ status: 'open', items: [{ name: 'Jollof', price: 3500, qty: 5, qtyRemaining: 999 }] }),
    );
    expect(parsed).not.toHaveProperty('status');
    expect(toMenuFields(parsed).items[0]).toMatchObject({ qtyTotal: 5, qtyRemaining: 5 });
  });

  it('requires a cut-off with a time zone', () => {
    expect(issues(body({ cutoffAt: '2030-10-16T18:00:00' }))[0]).toMatch(/^cutoffAt: Use a full date-time with a time zone/);
    expect(issues(body({ cutoffAt: '2030-10-16T18:00:00+01:00', deliveryDays: ['2030-10-17'] }))).toEqual([]);
  });

  it('rejects a cut-off in the past', () => {
    expect(issues(body({ cutoffAt: '2020-01-01T12:00:00Z', deliveryDays: ['2020-01-02'] }))).toContain(
      'cutoffAt: Cut-off must be in the future',
    );
  });

  it('rejects a delivery day before the cut-off day (in Lagos time)', () => {
    // 23:30 UTC on the 16th is 00:30 on the 17th in Lagos, so the 16th is too early.
    const result = issues(body({ cutoffAt: '2030-10-16T23:30:00Z', deliveryDays: ['2030-10-16', '2030-10-17'] }));
    expect(result).toEqual(['deliveryDays.0: Delivery day 2030-10-16 is before the cut-off day 2030-10-17']);
  });

  it('rejects fractional prices and quantities, and empty lists', () => {
    expect(issues(body({ items: [{ name: 'Jollof', price: 3500.5, qty: 2.5 }] }))).toEqual([
      'items.0.price: price must be whole naira',
      'items.0.qty: qty must be a whole number',
    ]);
    expect(issues(body({ items: [], areas: [] })).map((i) => i.split(':')[0])).toEqual(['items', 'areas']);
  });

  it('rejects duplicate areas and more than 30 items', () => {
    expect(issues(body({ areas: ['Yaba', 'Yaba'] }))).toEqual(['areas: Each area should be listed once']);
    const many = Array.from({ length: 31 }, (_, i) => ({ name: `Dish ${i}`, price: 1000, qty: 1 }));
    expect(issues(body({ items: many }))[0]).toMatch(/^items:/);
  });

  it('a menu at the size limits still fits in the 20 KB body limit', () => {
    const items = Array.from({ length: 30 }, (_, i) => ({
      name: `${'N'.repeat(76)}${i}`.slice(0, 80),
      description: 'D'.repeat(300),
      price: 1_000_000,
      qty: 1_000,
    }));
    const json = JSON.stringify(body({ items, areas: Array.from({ length: 30 }, (_, i) => `Area ${i} ${'x'.repeat(50)}`) }));
    expect(issues(JSON.parse(json))).toEqual([]);
    expect(Buffer.byteLength(json)).toBeLessThan(20 * 1024);
  });
});
