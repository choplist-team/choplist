import type { Types } from 'mongoose';
import { z } from 'zod';
import { logEvent } from '../events/log.js';
import { MissingOrderReportModel } from '../models/missing-order-report.js';
import { OrderModel, REF_PATTERN } from '../models/order.js';
import { SLUG_PATTERN, SellerModel } from '../models/seller.js';

// "" from an empty form field means "not given", not "invalid".
const optional = <T extends z.ZodType>(schema: T) => z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

export const missingOrderBody = z
  .object({
    ref: optional(z.string().trim().toUpperCase().regex(REF_PATTERN, 'Reference looks like CL-7KQ2M')),
    phoneLast4: optional(z.string().trim().regex(/^\d{4}$/, 'Enter exactly the last 4 digits of your phone number')),
    menuSlug: optional(z.string().trim().toLowerCase().max(40).regex(SLUG_PATTERN, 'That shop link does not look right')),
    message: z.string({ error: 'Tell us what happened' }).trim().min(5, 'Please say a little more (at least 5 characters)').max(500),
  })
  .refine((body) => body.ref || body.phoneLast4, {
    message: 'Give the order reference or the last 4 digits of your phone number',
    path: ['ref'],
  });
export type MissingOrderBody = z.infer<typeof missingOrderBody>;

// Searching by the last 4 digits alone is a scan, so it only looks at recent
// orders (and, with a shop link, only that shop's). A missing order is, by
// nature, a recent one.
const SEARCH_WINDOW_DAYS = 7;
const SEARCH_WINDOW_WITH_SHOP_DAYS = 30;
const DAY_MS = 86_400_000;

type Match = { found: boolean; orderRef: string | null; sellerId: Types.ObjectId | null };

// Is there an order that fits what the customer said? Used ONLY to help the
// admin: the customer is never told the result.
//   ref given         -> that order must exist (and, if digits were also given,
//                        its phone must end with them)
//   digits only       -> orders in the recent window whose phone ends with them;
//                        exactly one match names it, several leave it ambiguous
async function findMatch(input: { ref?: string | undefined; phoneLast4?: string | undefined; sellerId: Types.ObjectId | null }, now: Date): Promise<Match> {
  if (input.ref) {
    const order = await OrderModel.findOne({ ref: input.ref }, { ref: 1, sellerId: 1, customer: 1 }).lean();
    if (!order) return { found: false, orderRef: null, sellerId: input.sellerId };
    if (input.phoneLast4 && !order.customer.phone.endsWith(input.phoneLast4)) {
      return { found: false, orderRef: null, sellerId: input.sellerId };
    }
    return { found: true, orderRef: order.ref, sellerId: order.sellerId };
  }

  const days = input.sellerId ? SEARCH_WINDOW_WITH_SHOP_DAYS : SEARCH_WINDOW_DAYS;
  const matches = await OrderModel.find(
    {
      createdAt: { $gte: new Date(now.getTime() - days * DAY_MS) },
      'customer.phone': new RegExp(`${input.phoneLast4}$`), // digits only, checked by the schema
      ...(input.sellerId ? { sellerId: input.sellerId } : {}),
    },
    { ref: 1, sellerId: 1 },
  )
    .limit(2)
    .lean();
  if (matches.length === 0) return { found: false, orderRef: null, sellerId: input.sellerId };
  if (matches.length === 1) return { found: true, orderRef: matches[0]!.ref, sellerId: matches[0]!.sellerId };
  return { found: true, orderRef: null, sellerId: input.sellerId };
}

export async function submitMissingOrderReport(body: MissingOrderBody, now: Date = new Date()): Promise<void> {
  // The shop link only narrows the search. An unknown link is not an error (that
  // would tell a stranger which shop links exist); it is simply not used.
  const seller = body.menuSlug ? await SellerModel.findOne({ slug: body.menuSlug }, { _id: 1 }).lean() : null;
  const match = await findMatch({ ref: body.ref, phoneLast4: body.phoneLast4, sellerId: seller?._id ?? null }, now);

  await MissingOrderReportModel.create({
    ...(body.ref ? { ref: body.ref } : {}),
    ...(body.phoneLast4 ? { phoneLast4: body.phoneLast4 } : {}),
    ...(body.menuSlug ? { menuSlug: body.menuSlug } : {}),
    message: body.message,
    ...(match.sellerId ? { sellerId: match.sellerId } : {}),
    orderFound: match.found,
    ...(match.orderRef ? { matchedOrderRef: match.orderRef } : {}),
  });

  // A line for the troubleshooting log. Not the customer's message, not the
  // digits: only that a report arrived and whether it matched an order.
  await logEvent({
    type: 'missing_order_report',
    level: 'warn',
    code: 'MISSING_ORDER_REPORT',
    message: 'A customer reported a missing order',
    sellerId: match.sellerId,
    orderRef: match.orderRef,
    meta: { orderFound: match.found },
  });
}
