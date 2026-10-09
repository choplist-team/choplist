import { z } from 'zod';

// Turns the ways people type a Nigerian mobile number into one stored form:
//   "0803 123 4567", "+234 803 123 4567", "2348031234567"  ->  "+2348031234567"
// Returns null if it is not a Nigerian mobile number (10 digits after the
// country code, starting with 7, 8 or 9).
export function normalizeNigerianPhone(raw: string): string | null {
  const compact = raw.replace(/[\s\-().]/g, '');

  let national: string;
  if (/^\+234\d{10}$/.test(compact)) national = compact.slice(4);
  else if (/^234\d{10}$/.test(compact)) national = compact.slice(3);
  else if (/^0\d{10}$/.test(compact)) national = compact.slice(1);
  else return null;

  return /^[789]\d{9}$/.test(national) ? `+234${national}` : null;
}

// zod field: accepts any of the forms above, outputs the normalised one.
// Must be a string: a JSON number would already have lost the leading 0.
export const nigerianPhone = z
  .string({ error: 'Phone must be text, e.g. "0803 123 4567"' })
  .transform((raw, ctx) => {
    const phone = normalizeNigerianPhone(raw);
    if (!phone) {
      ctx.addIssue({ code: 'custom', message: 'Enter a Nigerian mobile number, e.g. 0803 123 4567' });
      return z.NEVER;
    }
    return phone;
  });
