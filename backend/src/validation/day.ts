import { z } from 'zod';
import { DAY_PATTERN } from '../models/fields.js';

const LAGOS_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Africa/Lagos',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// The calendar day in Lagos at a given instant, as "YYYY-MM-DD".
// e.g. 2026-10-16T23:30:00Z is already 2026-10-17 in Lagos (UTC+1).
export function lagosDay(instant: Date): string {
  return LAGOS_DAY.format(instant); // en-CA formats as YYYY-MM-DD
}

// "2026-02-30" matches the pattern but is not a real day.
export function isRealDay(day: string): boolean {
  if (!DAY_PATTERN.test(day)) return false;
  const parsed = new Date(`${day}T00:00:00Z`);
  return parsed.toISOString().slice(0, 10) === day;
}

export const calendarDay = z
  .string()
  .refine(isRealDay, 'Use a real date in the form YYYY-MM-DD, e.g. 2026-10-17');

// An instant that must say its time zone ("...Z" or "...+01:00"). Without one,
// "18:00" would mean the server's time zone (UTC on Render), i.e. 7pm in Lagos.
export const instant = z.iso
  .datetime({ offset: true, error: 'Use a full date-time with a time zone, e.g. 2026-10-16T18:00:00+01:00' })
  .transform((value) => new Date(value));
