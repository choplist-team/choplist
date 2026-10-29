import { describe, expect, it } from 'vitest';
import { missingOrderBody } from '../src/support/missing-order.js';

// No database: what a customer is allowed to send.
const ok = { ref: 'CL-7KQ2M', message: 'I paid but nothing came' };

describe('missingOrderBody', () => {
  it('accepts a reference, or the last 4 digits, or both', () => {
    expect(missingOrderBody.safeParse(ok).success).toBe(true);
    expect(missingOrderBody.safeParse({ phoneLast4: '4567', message: 'Where is my food?' }).success).toBe(true);
    expect(missingOrderBody.safeParse({ ...ok, phoneLast4: '4567', menuSlug: 'mama-t' }).success).toBe(true);
  });

  it('needs at least a reference or the last 4 digits', () => {
    const result = missingOrderBody.safeParse({ message: 'I ordered yesterday' });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('order reference or the last 4 digits');
  });

  it('treats empty form fields as not given', () => {
    const parsed = missingOrderBody.parse({ ref: '', phoneLast4: '4567', menuSlug: '', message: 'Where is my food?' });
    expect(parsed.ref).toBeUndefined();
    expect(parsed.menuSlug).toBeUndefined();
    expect(missingOrderBody.safeParse({ ref: '', phoneLast4: '', message: 'Where is my food?' }).success).toBe(false);
  });

  it('upper-cases the reference and lower-cases the shop link', () => {
    const parsed = missingOrderBody.parse({ ...ok, ref: ' cl-7kq2m ', menuSlug: ' Mama-T ' });
    expect(parsed.ref).toBe('CL-7KQ2M');
    expect(parsed.menuSlug).toBe('mama-t');
  });

  it.each([['456'], ['45678'], ['abcd'], ['08031234567'], ['+2348031234567'], ['45 67']])(
    'rejects phoneLast4 %j: only exactly 4 digits, so a whole number can never be stored',
    (phoneLast4) => {
      expect(missingOrderBody.safeParse({ phoneLast4, message: 'Where is my food?' }).success).toBe(false);
    },
  );

  it.each([['CL-0O1I2'], ['nonsense'], ['CL-7KQ2'], ['CL-7KQ2MX']])('rejects reference %j', (ref) => {
    expect(missingOrderBody.safeParse({ ref, message: 'Where is my food?' }).success).toBe(false);
  });

  it('keeps the message between 5 and 500 characters', () => {
    expect(missingOrderBody.safeParse({ ...ok, message: 'abcd' }).success).toBe(false);
    expect(missingOrderBody.safeParse({ ...ok, message: '     ' }).success).toBe(false);
    expect(missingOrderBody.safeParse({ ...ok, message: 'a'.repeat(500) }).success).toBe(true);
    expect(missingOrderBody.safeParse({ ...ok, message: 'a'.repeat(501) }).success).toBe(false);
    expect(missingOrderBody.safeParse({ ref: ok.ref }).success).toBe(false);
  });

  it('rejects a shop link that is not a link', () => {
    for (const menuSlug of ['Mama T!', '../etc', 'a'.repeat(41), 'x--y']) {
      expect(missingOrderBody.safeParse({ ...ok, menuSlug }).success, menuSlug).toBe(false);
    }
  });

  it('drops fields it does not know (no way to set status or order flags)', () => {
    const parsed = missingOrderBody.parse({ ...ok, status: 'resolved', orderFound: true, sellerId: 'x', resolvedBy: 'me' });
    expect(Object.keys(parsed).sort()).toEqual(['message', 'ref']);
  });

  it('does not accept numbers for the text fields', () => {
    expect(missingOrderBody.safeParse({ phoneLast4: 4567, message: 'Where is my food?' }).success).toBe(false);
  });
});
