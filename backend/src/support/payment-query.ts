import type { Types } from 'mongoose';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { mongo } from 'mongoose';
import { PaymentQueryModel, QUERY_REASONS, type PaymentQueryDoc, type QueryRaiser } from '../models/payment-query.js';

// What a customer or a seller sends to say "something is wrong with this payment".
export const paymentQueryBody = z.object({
  reason: z.enum(QUERY_REASONS, { error: `reason must be one of: ${QUERY_REASONS.join(', ')}` }),
  message: z.string({ error: 'message is required' }).trim().min(5, 'Say a little more (at least 5 characters)').max(500),
});

// What the person who raised it gets back: their own words and where it stands. No
// admin identity, no internal notes.
export function toQueryResponse(query: PaymentQueryDoc) {
  return {
    id: query._id.toString(),
    orderRef: query.orderRef,
    raisedBy: query.raisedBy,
    reason: query.reason,
    message: query.message,
    status: query.status,
    createdAt: query.createdAt,
  };
}

// Records the problem. It changes nothing about the order or the money: a person at
// ChopList reads it in the admin console. One OPEN query per order per person, so
// asking again does not pile up copies (the unique index decides, not a read).
export async function raisePaymentQuery(
  order: { _id: Types.ObjectId; ref: string; sellerId: Types.ObjectId },
  raisedBy: QueryRaiser,
  input: z.infer<typeof paymentQueryBody>,
) {
  try {
    const created = await PaymentQueryModel.create({
      orderId: order._id,
      orderRef: order.ref,
      sellerId: order.sellerId,
      raisedBy,
      reason: input.reason,
      message: input.message,
    });
    return toQueryResponse(created);
  } catch (err) {
    if (err instanceof mongo.MongoServerError && err.code === 11000) {
      throw new AppError(409, 'QUERY_ALREADY_OPEN', 'You already have an open query on this order. We will get back to you.');
    }
    throw err;
  }
}
