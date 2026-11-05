import type { Types } from 'mongoose';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { mongo } from 'mongoose';
import { logEvent } from '../events/log.js';
import { notifyAdmins, notifySeller } from '../notifications/service.js';
import { PaymentQueryModel, QUERY_REASONS, type PaymentQueryDoc, type QueryRaiser } from '../models/payment-query.js';

// What a customer or a seller sends to say "something is wrong with this payment".
export const paymentQueryBody = z.object({
  reason: z.enum(QUERY_REASONS, { error: `reason must be one of: ${QUERY_REASONS.join(', ')}` }),
  message: z.string({ error: 'message is required' }).trim().min(5, 'Say a little more (at least 5 characters)').max(500),
});

// What the person who raised it gets back: their own words and where it stands, and
// once an admin has resolved it, WHEN and the note they wrote. The note is the admin's
// reply to the person, so it is shown to them (the admin console says so). Never the
// admin's identity.
export function toQueryResponse(query: PaymentQueryDoc) {
  return {
    id: query._id.toString(),
    orderRef: query.orderRef,
    raisedBy: query.raisedBy,
    reason: query.reason,
    message: query.message,
    status: query.status,
    createdAt: query.createdAt,
    resolvedAt: query.resolvedAt ?? null,
    resolutionNote: query.resolutionNote ?? null,
  };
}

// The queries on one order, newest first. `raisedBy` narrows it to one side: a
// customer sees only their own; the seller sees every query on their own order.
export async function listQueriesForOrder(orderId: Types.ObjectId, raisedBy?: QueryRaiser) {
  const rows = await PaymentQueryModel.find({ orderId, ...(raisedBy ? { raisedBy } : {}) })
    .sort({ createdAt: -1, _id: -1 })
    .limit(50);
  return rows.map(toQueryResponse);
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
    // The platform has no email or push yet, so this is how ChopList finds out: a line
    // in the event log (the admin console), and the open count on the overview. No
    // message text, no names: the reason and the order reference only.
    await logEvent({
      type: 'payment_query_raised',
      level: 'warn',
      code: input.reason.toUpperCase(),
      message: `A ${raisedBy} reported a payment problem on an order`,
      sellerId: order.sellerId,
      orderRef: order.ref,
      meta: { raisedBy },
    });
    const reason = input.reason.replace(/_/g, ' ');
    await notifyAdmins({
      type: 'payment_query_raised',
      message: `A ${raisedBy} reported a payment problem on order ${order.ref} (${reason}).`,
      orderRef: order.ref,
      dedupeKey: `query_admin:${created._id.toString()}`,
    });
    // The seller hears about a customer's report. They raised their own, so no need.
    if (raisedBy === 'customer') {
      await notifySeller(order.sellerId, {
        type: 'payment_query_raised',
        message: `A customer reported a payment problem on order ${order.ref} (${reason}). ChopList has been told.`,
        orderRef: order.ref,
        dedupeKey: `query_seller:${created._id.toString()}`,
      });
    }
    return toQueryResponse(created);
  } catch (err) {
    if (err instanceof mongo.MongoServerError && err.code === 11000) {
      throw new AppError(409, 'QUERY_ALREADY_OPEN', 'You already have an open query on this order. We will get back to you.');
    }
    throw err;
  }
}
