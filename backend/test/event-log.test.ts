import { describe, expect, it } from 'vitest';
import { logEvent, safeMeta } from '../src/events/log.js';
import { orderFingerprint } from '../src/orders/fingerprint.js';

// No database.

describe('safeMeta keeps the log free of private data', () => {
  it('drops keys whose NAME suggests private data, whatever the value', () => {
    const meta = safeMeta({
      phone: '+2348031234567',
      customerPhone: '08031234567',
      address: '12 Herbert Macaulay Way',
      deliveryCode: '482915',
      accessKey: 'abc',
      token: 'x',
      Authorization: 'Bearer y',
      email: 'a@b.co',
      customerName: 'Ada',
      note: 'extra pepper',
      route: '/api/public/orders',
      count: 3,
    });
    expect(meta).toEqual({ route: '/api/public/orders', count: 3 });
  });

  it('keeps only strings, numbers and booleans; no objects, arrays, null or NaN', () => {
    expect(safeMeta({ a: 'x', b: 2, c: true, d: { nested: 1 }, e: [1], f: null, g: undefined, h: Number.NaN })).toEqual({
      a: 'x',
      b: 2,
      c: true,
    });
  });

  it('truncates long text and caps the number of keys', () => {
    expect(safeMeta({ long: 'x'.repeat(5000) }).long).toHaveLength(200);
    const many = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i]));
    expect(Object.keys(safeMeta(many))).toHaveLength(10);
  });

  it('handles nothing at all', () => {
    expect(safeMeta(undefined)).toEqual({});
  });
});

describe('logEvent when the database is not connected', () => {
  it('returns quickly and does not throw (logging must never cause a failure)', async () => {
    const started = Date.now();
    await expect(
      logEvent({ type: 'order_failed', level: 'warn', code: 'SOLD_OUT', message: 'An order was refused: SOLD_OUT' }),
    ).resolves.toBeUndefined();
    // Mongoose would otherwise hold the write for 10 seconds before failing.
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('orderFingerprint', () => {
  const menuId = '6710b2d3e4b0a1b2c3d4e5f7';
  const jollof = '6710b2d3e4b0a1b2c3d4e5f8';
  const chapman = '6710b2d3e4b0a1b2c3d4e5fa';
  const base = { phone: '+2348031234567', menuId, lines: [{ itemId: jollof, qty: 2 }, { itemId: chapman, qty: 1 }] };

  it('is a 64-character hash that does not contain the phone number', () => {
    const fp = orderFingerprint(base);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(fp).not.toContain('8031234567');
  });

  it('is the same however the lines are ordered, and for the same canonical phone', () => {
    const reversed = { ...base, lines: [...base.lines].reverse() };
    expect(orderFingerprint(reversed)).toBe(orderFingerprint(base));
  });

  it('differs when the phone, menu, an item or a quantity differs', () => {
    const fp = orderFingerprint(base);
    expect(orderFingerprint({ ...base, phone: '+2348031234568' })).not.toBe(fp);
    expect(orderFingerprint({ ...base, menuId: '6710b2d3e4b0a1b2c3d4e5f9' })).not.toBe(fp);
    expect(orderFingerprint({ ...base, lines: [{ itemId: jollof, qty: 3 }, { itemId: chapman, qty: 1 }] })).not.toBe(fp);
    expect(orderFingerprint({ ...base, lines: [{ itemId: jollof, qty: 2 }] })).not.toBe(fp);
  });

  it('cannot be confused by moving a digit between the quantity and the next id', () => {
    const a = orderFingerprint({ ...base, lines: [{ itemId: jollof, qty: 12 }] });
    const b = orderFingerprint({ ...base, lines: [{ itemId: jollof, qty: 1 }, { itemId: '2' + chapman.slice(1), qty: 2 }] });
    expect(a).not.toBe(b);
  });
});
