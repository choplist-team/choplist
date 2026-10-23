import { z } from 'zod';
import { ORDER_STATUSES, isOrderStatus, type OrderStatus } from '../models/order.js';

// What ?status= looks like once Express has parsed the query string:
//   ?status=paid                            "paid"
//   ?status=paid,out_for_delivery           "paid,out_for_delivery"   one string with a comma
//   ?status=paid&status=delivered           ["paid", "delivered"]     an array
// All three mean the same thing: a list of statuses. Missing or empty means
// "no filter". Pure, so it is tested without a server or a database.
export function splitStatusFilter(value: string | string[] | undefined): string[] {
  const raw = value === undefined ? [] : Array.isArray(value) ? value : [value];
  const parts = raw
    .flatMap((item) => item.split(','))
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return [...new Set(parts)]; // "paid,paid" is the same as "paid"
}

// zod schema for the ?status= query value. Produces a list of valid statuses, or
// undefined for "no filter". Anything that is not a real status ("all",
// "out-for-delivery", "PAID") is a 400 VALIDATION_ERROR naming the bad value and
// the allowed ones: guessing what the caller meant would hide frontend typos.
export const statusFilterSchema = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform(splitStatusFilter)
  .superRefine((values, ctx) => {
    for (const value of values) {
      if (!isOrderStatus(value)) {
        ctx.addIssue({
          code: 'custom',
          message: `"${value}" is not a valid status. Use one or more of: ${ORDER_STATUSES.join(', ')}`,
        });
      }
    }
  })
  .transform((values): OrderStatus[] | undefined => {
    const statuses = values.filter(isOrderStatus); // all of them, after the check above
    return statuses.length > 0 ? statuses : undefined;
  });
