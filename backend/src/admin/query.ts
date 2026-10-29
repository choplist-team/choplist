import { Types } from 'mongoose';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { isRealDay } from '../validation/day.js';

// ---- Pagination -------------------------------------------------------------
// Every admin list takes ?page=1&limit=20 (limit at most 100) and answers with
// the same `pagination` block, so the frontend has one table component for all.
export const MAX_LIMIT = 100;
export const DEFAULT_LIMIT = 20;

// Query values are text. A strict whole-number check, not Number(): "2.5", "1e2",
// "" and " 3" must be rejected, not silently turned into something else.
const wholeNumberText = (name: string, min: number, max: number) =>
  z
    .string()
    .regex(/^\d{1,6}$/, `${name} must be a whole number`)
    .transform(Number)
    .refine((n) => n >= min && n <= max, `${name} must be between ${min} and ${max}`);

export const paginationQuery = {
  page: wholeNumberText('page', 1, 100_000).optional().default(1),
  limit: wholeNumberText('limit', 1, MAX_LIMIT).optional().default(DEFAULT_LIMIT),
};

export type Pagination = { page: number; limit: number; total: number; totalPages: number };

export function toPagination(total: number, page: number, limit: number): Pagination {
  return { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

// ---- Date ranges ------------------------------------------------------------
// ?from=2026-10-01&to=2026-10-31 are calendar days in Lagos time, both included.
// Lagos is UTC+1 all year (no daylight saving), so a Lagos day is exactly
// 00:00+01:00 up to the next 00:00+01:00.
const DAY_MS = 24 * 60 * 60 * 1000;

function lagosDayStart(day: string): Date {
  return new Date(`${day}T00:00:00+01:00`);
}

const dayText = (name: string) =>
  z.string().refine(isRealDay, `${name} must be a real date in the form YYYY-MM-DD, e.g. 2026-10-17`);

export const dateRangeQuery = {
  from: dayText('from').optional(),
  to: dayText('to').optional(),
};

// A MongoDB condition on a date field, or undefined for "no limit".
export function dateRangeFilter(range: { from?: string | undefined; to?: string | undefined }) {
  const gte = range.from ? lagosDayStart(range.from) : undefined;
  const lt = range.to ? new Date(lagosDayStart(range.to).getTime() + DAY_MS) : undefined;
  if (gte && lt && gte >= lt) throw new AppError(400, 'VALIDATION_ERROR', 'from: must not be after to');
  if (!gte && !lt) return undefined;
  return { ...(gte ? { $gte: gte } : {}), ...(lt ? { $lt: lt } : {}) };
}

// ---- Small helpers ----------------------------------------------------------
export const objectIdText = (name: string) =>
  z
    .string()
    .regex(/^[0-9a-f]{24}$/i, `${name} must be an id`)
    .transform((value) => new Types.ObjectId(value));

// Text typed into a search box becomes part of a regular expression, so every
// regex character must be escaped. Otherwise "(" would be a server error and
// ".*" would match everything.
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 0803 1234 567 -> 0803****567: enough for support to recognise a number, not
// enough to call it. Takes the stored +234 form.
export function maskPhone(phone: string): string {
  const match = /^\+234(\d{10})$/.exec(phone);
  if (!match) return '****';
  const national = `0${match[1]}`; // 11 digits
  return `${national.slice(0, 4)}****${national.slice(-3)}`;
}
