const DAY_MS = 24 * 60 * 60 * 1000;

// `days` whole days after `from`. A day is exactly 24 hours: the server works in
// UTC, which has no daylight-saving changes.
export function addDaysUTC(from: Date, days: number): Date {
  return new Date(from.getTime() + days * DAY_MS);
}

// `months` calendar months after `from`, in UTC, keeping the time of day. When the
// target month is shorter the date is pulled back to its last day, so one month
// after 31 January is 28 (or 29) February, not 3 March:
//
//   2026-01-31 + 1 month  = 2026-02-28
//   2026-11-30 + 3 months = 2027-02-28
//
// Doing this on the server in UTC keeps every vendor's expiry the same wherever
// their phone or the server happens to be.
export function addMonthsUTC(from: Date, months: number): Date {
  const result = new Date(
    Date.UTC(
      from.getUTCFullYear(),
      from.getUTCMonth() + months,
      1,
      from.getUTCHours(),
      from.getUTCMinutes(),
      from.getUTCSeconds(),
      from.getUTCMilliseconds(),
    ),
  );
  const lastDayOfTarget = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(from.getUTCDate(), lastDayOfTarget));
  return result;
}
