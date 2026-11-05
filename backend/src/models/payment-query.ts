import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { REF_PATTERN } from './order.js';

// "There is a problem with the payment on this order", raised by the customer (with
// their order key) or by the seller (on their own order), and worked through by an
// admin in the console. It records the problem; it moves no money and changes no
// order. Who at ChopList receives and resolves these, and how fast, is a decision
// the team has not made yet (see docs/api.md).
export const QUERY_RAISERS = ['customer', 'seller'] as const;
export type QueryRaiser = (typeof QUERY_RAISERS)[number];

export const QUERY_REASONS = [
  'payment_not_reflected', // I paid, but the order still shows unpaid
  'payment_not_received', // the customer says they paid, but I see no money
  'paid_twice', // the customer was charged more than once
  'wrong_amount', // the amount charged or received is not what the order says
  'other',
] as const;
export type QueryReason = (typeof QUERY_REASONS)[number];

export const QUERY_STATUSES = ['open', 'resolved'] as const;
export type QueryStatus = (typeof QUERY_STATUSES)[number];

const paymentQuerySchema = new Schema(
  {
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
    orderRef: { type: String, required: true, match: REF_PATTERN },
    // Copied from the order so a seller's or an admin's list needs no join.
    sellerId: { type: Schema.Types.ObjectId, ref: 'Seller', required: true },
    raisedBy: { type: String, enum: QUERY_RAISERS, required: true },
    reason: { type: String, enum: QUERY_REASONS, required: true },
    message: { type: String, required: true, trim: true, minlength: 5, maxlength: 500 },

    status: { type: String, enum: QUERY_STATUSES, required: true, default: 'open' },
    resolvedBy: String, // the admin's Clerk user id
    resolvedAt: Date,
    resolutionNote: { type: String, trim: true, maxlength: 300 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// The admin list: open first, newest first, and the open count.
paymentQuerySchema.index({ status: 1, createdAt: -1 });
// One OPEN query per order per person: asking again does not pile up copies.
paymentQuerySchema.index({ orderId: 1, raisedBy: 1 }, { unique: true, partialFilterExpression: { status: 'open' } });

export type PaymentQuery = InferSchemaType<typeof paymentQuerySchema>;
export type PaymentQueryDoc = HydratedDocument<PaymentQuery>;
export const PaymentQueryModel = model('PaymentQuery', paymentQuerySchema);
