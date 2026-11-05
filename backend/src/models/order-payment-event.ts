import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { ORDER_PAYMENT_STATUSES } from './order.js';

// The audit log of one order's payment state: every time it moved, from what, to
// what, and who or what caused it. It answers "when did this order become paid, and
// who said so?" from our own records, and is never edited or deleted by the app.
//
//   customer  the customer pressed "I've paid" (bank transfer)
//   seller    the seller confirmed the money by hand
//   paystack  Paystack confirmed (or reported failed) an online payment
export const PAYMENT_EVENT_SOURCES = ['customer', 'seller', 'paystack'] as const;
export type PaymentEventSource = (typeof PAYMENT_EVENT_SOURCES)[number];

const orderPaymentEventSchema = new Schema({
  orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
  // Copied for support lookups (the customer-facing reference, CL-XXXXX).
  orderRef: { type: String, required: true },
  from: { type: String, enum: ORDER_PAYMENT_STATUSES, required: true },
  to: { type: String, enum: ORDER_PAYMENT_STATUSES, required: true },
  source: { type: String, enum: PAYMENT_EVENT_SOURCES, required: true },
  // Identifies WHAT happened, so the same thing recorded twice is stored once. A
  // retried Paystack webhook, a double tap and a crash-and-retry all produce the
  // same eventId, and the unique index turns the repeat into a no-op:
  //   paystack:<payment reference>          customer_reported:<order id>
  //   seller_confirmed:<order id>           paystack_failed:<payment reference>
  eventId: { type: String, required: true, unique: true, maxlength: 80 },
  at: { type: Date, required: true, default: () => new Date() },
});

// "The history of this order", oldest first.
orderPaymentEventSchema.index({ orderId: 1, at: 1 });

export type OrderPaymentEvent = InferSchemaType<typeof orderPaymentEventSchema>;
export type OrderPaymentEventDoc = HydratedDocument<OrderPaymentEvent>;
export const OrderPaymentEventModel = model('OrderPaymentEvent', orderPaymentEventSchema);
