import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

// One row per attempt to pay an order through Paystack. The order says WHAT is
// owed; this says what we asked Paystack to charge and what came back, so a
// dispute can be answered from our own records.
//
//   initialized  we created the Paystack transaction; no money seen yet
//   succeeded    Paystack confirmed it (webhook, re-verified with Paystack)
//   failed       Paystack reported the attempt failed or was abandoned
//   needs_review money arrived but the order could not be marked paid (for
//                example the seller cancelled it first): a human must refund or
//                reinstate it
export const PAYMENT_STATUSES = ['initialized', 'succeeded', 'failed', 'needs_review'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

// All amounts here are kobo (100 kobo = 1 naira): that is what Paystack uses.
const kobo = { type: Number, required: true, min: 0, validate: { validator: Number.isInteger, message: '{PATH} must be a whole number' } } as const;

const paymentSchema = new Schema(
  {
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
    // The customer-facing order reference (CL-XXXXX), copied for support lookups.
    orderRef: { type: String, required: true },
    // Copied from the order so a seller's payments and the revenue total can be
    // read without joining to orders.
    sellerId: { type: Schema.Types.ObjectId, ref: 'Seller', required: true },

    // OUR unique reference, sent to Paystack and returned by it. The webhook
    // finds the payment by this, so it must be unguessable and never reused.
    reference: { type: String, required: true, unique: true },

    status: { type: String, enum: PAYMENT_STATUSES, required: true, default: 'initialized' },

    // What the customer is charged: base + service fee, as sent to Paystack.
    amountKobo: kobo,
    // ChopList's cut as sent to Paystack (transaction_charge).
    transactionChargeKobo: kobo,
    // The fee snapshot (same figures as on the order, kept with the money).
    platformFeeKobo: kobo,
    paystackFeeKobo: kobo,
    // Also frozen here, so when this attempt is the one that gets paid the order
    // can be given exactly its figures (an order may have several attempts).
    // Optional: not needed to find or understand a payment.
    platformFeeBps: { type: Number, min: 0, validate: { validator: Number.isInteger, message: '{PATH} must be a whole number' } },
    serviceFee: { type: Number, min: 0, validate: { validator: Number.isInteger, message: '{PATH} must be a whole number' } },
    currency: { type: String, required: true, default: 'NGN', enum: ['NGN'] },
    // Who Paystack takes its processing fee from: ChopList's cut (customer pays
    // fees) or the seller's share (seller pays fees).
    bearer: { type: String, required: true, enum: ['account', 'subaccount'] },
    subaccountCode: { type: String, required: true },

    paidAt: Date,

    // Set by an admin once they have refunded this payment by hand in the Paystack
    // dashboard (ChopList does not call Paystack's refund API). Whether a payment
    // NEEDS a refund is worked out from the data (admin/refunds.ts), never stored,
    // so a crash cannot leave one unflagged; this only records that it was dealt with.
    refund: {
      type: new Schema(
        {
          refundedAt: { type: Date, required: true },
          refundedBy: { type: String, required: true }, // the admin's Clerk user id
          note: { type: String, trim: true, maxlength: 300 },
        },
        { _id: false },
      ),
    },

    // When the status route last asked Paystack about this payment, so a customer
    // polling every few seconds costs at most one Paystack call per interval.
    lastCheckedAt: Date,
    // How many times the background re-check has asked (it backs off as this grows).
    checkCount: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

// A payment is found by `reference` (the unique index above). The rest serve
// the queries that actually exist:
//  - orderId + createdAt: "the payments of this order, newest first" (the pay
//    route reuses a live attempt, the status page shows the latest).
paymentSchema.index({ orderId: 1, createdAt: -1 });
//  - sellerId + status + paidAt: a seller's successful payments over time.
paymentSchema.index({ sellerId: 1, status: 1, paidAt: -1 });
//  - status + paidAt: platform-wide revenue and counts for a date range (admin).
paymentSchema.index({ status: 1, paidAt: -1 });
// An order can be paid for at most once. This partial unique index lets any
// number of failed/initialized attempts exist per order but only ONE succeeded
// row, so even if two webhooks race past every check in code, the database
// refuses the second and the seller's paidOrderCount cannot be counted twice.
paymentSchema.index({ orderId: 1 }, { unique: true, partialFilterExpression: { status: 'succeeded' } });

export type Payment = InferSchemaType<typeof paymentSchema>;
export type PaymentDoc = HydratedDocument<Payment>;
export const PaymentModel = model('Payment', paymentSchema);
