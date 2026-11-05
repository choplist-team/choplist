import { describe, expect, it } from 'vitest';
import { addDaysUTC, addMonthsUTC } from '../src/billing/dates.js';

const at = (iso: string) => new Date(iso);
const iso = (d: Date) => d.toISOString();

describe('addDaysUTC', () => {
  it('adds exactly 24 hours per day, with no daylight-saving drift', () => {
    expect(iso(addDaysUTC(at('2026-03-28T10:30:00.000Z'), 7))).toBe('2026-04-04T10:30:00.000Z');
    expect(iso(addDaysUTC(at('2026-10-25T00:00:00.000Z'), 7))).toBe('2026-11-01T00:00:00.000Z');
  });
});

describe('addMonthsUTC (calendar months, in UTC)', () => {
  it('adds one month on an ordinary date', () => {
    expect(iso(addMonthsUTC(at('2026-11-05T09:15:30.250Z'), 1))).toBe('2026-12-05T09:15:30.250Z');
  });

  it('keeps the time of day to the millisecond', () => {
    expect(iso(addMonthsUTC(at('2026-06-10T23:59:59.999Z'), 3))).toBe('2026-09-10T23:59:59.999Z');
  });

  it('pulls a 31st back to the last day of a shorter month', () => {
    expect(iso(addMonthsUTC(at('2026-01-31T12:00:00.000Z'), 1))).toBe('2026-02-28T12:00:00.000Z');
    expect(iso(addMonthsUTC(at('2026-08-31T12:00:00.000Z'), 1))).toBe('2026-09-30T12:00:00.000Z');
    expect(iso(addMonthsUTC(at('2026-01-31T12:00:00.000Z'), 3))).toBe('2026-04-30T12:00:00.000Z');
  });

  it('knows leap years', () => {
    expect(iso(addMonthsUTC(at('2028-01-31T00:00:00.000Z'), 1))).toBe('2028-02-29T00:00:00.000Z');
    expect(iso(addMonthsUTC(at('2027-01-31T00:00:00.000Z'), 1))).toBe('2027-02-28T00:00:00.000Z');
    // 29 February plus a month is the 29 March, not the 1st.
    expect(iso(addMonthsUTC(at('2028-02-29T00:00:00.000Z'), 1))).toBe('2028-03-29T00:00:00.000Z');
  });

  it('rolls over the year, three months at a time', () => {
    expect(iso(addMonthsUTC(at('2026-11-30T08:00:00.000Z'), 3))).toBe('2027-02-28T08:00:00.000Z');
    expect(iso(addMonthsUTC(at('2026-12-15T08:00:00.000Z'), 1))).toBe('2027-01-15T08:00:00.000Z');
    expect(iso(addMonthsUTC(at('2026-10-31T08:00:00.000Z'), 3))).toBe('2027-01-31T08:00:00.000Z');
  });

  it('is not shifted by the machine time zone (it reads and writes UTC only)', () => {
    // 23:30 UTC on 31 January is already 1 February in Lagos (UTC+1). The result
    // must still be worked out on the UTC date, so a vendor's expiry never depends
    // on which time zone the server runs in.
    expect(iso(addMonthsUTC(at('2026-01-31T23:30:00.000Z'), 1))).toBe('2026-02-28T23:30:00.000Z');
  });

  it('does not change the date it was given', () => {
    const start = at('2026-01-31T00:00:00.000Z');
    addMonthsUTC(start, 1);
    expect(iso(start)).toBe('2026-01-31T00:00:00.000Z');
  });
});
