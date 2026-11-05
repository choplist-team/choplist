import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

// One row per attempt by a vendor to buy a plan. Together the rows are the
// renewal history. These are payments to ChopList's own Paystack account (no
// split to the seller), and they are separate from Payment, which is a customer
// paying a vendor for an order.
//
//   pending       we created the Paystack transaction; no money confirmed yet
//   active        Paystack confirmed the payment (signed webhook, re-verified with
//                 Paystack, amount and reference checked). startsAt/expiresAt set.
//   failed        Paystack reported the charge failed. A later success on the same
//                 reference still activates it (Paystack lets a customer retry).
//   needs_review  money arrived but the subscription could not be activated (for
//                 example the amount was not the plan's price): a human decides.
//
// There is no stored "expired": a subscription is expired when expiresAt has
// passed. Storing it would go stale without a scheduled job, so the state is
// worked out from the dates every time it is asked (billing/state.ts).
export const SUBSCRIPTION_STATUSES = ['pending', 'active', 'failed', 'needs_review'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const SUBSCRIPTION_PLANS = ['monthly', 'quarterly'] as const;
export type SubscriptionPlan = (typeof SUBSCRIPTION_PLANS)[number];

const subscriptionSchema = new Schema(
  {
    sellerId: { type: Schema.Types.ObjectId, ref: 'Seller', required: true },
    plan: { type: String, enum: SUBSCRIPTION_PLANS, required: true },
    // Whole naira, as quoted when the vendor pressed Subscribe. Frozen here, so a
    // later price change never changes what an old subscription cost.
    amountNaira: { type: Number, required: true, min: 1, validate: { validator: Number.isInteger, message: '{PATH} must be a whole number' } },
    status: { type: String, enum: SUBSCRIPTION_STATUSES, required: true, default: 'pending' },

    // OUR unique reference ("CLS-" + 24 hex), sent to Paystack and returned by it.
    // The webhook finds the subscription by this. The prefix tells it apart from
    // an order payment ("CLP-").
    paystackReference: { type: String, required: true, unique: true },

    // Set together, only when the payment is confirmed, from the SERVER clock.
    paidAt: Date,
    startsAt: Date,
    expiresAt: Date,
    // Position in this vendor's chain of confirmed subscriptions (1, 2, 3...).
    // The unique index below lets only one confirmation take each position, so two
    // payments confirmed at the same moment cannot both start from the same date.
    seq: { type: Number, min: 1 },
    // The confirmed subscription this one follows (renews), if any.
    renewalOf: { type: Schema.Types.ObjectId, ref: 'Subscription' },
  },
  { timestamps: true },
);

// A vendor's history, newest first.
subscriptionSchema.index({ sellerId: 1, createdAt: -1 });
// "Is this vendor covered right now?": their confirmed subscriptions by expiry.
subscriptionSchema.index({ sellerId: 1, status: 1, expiresAt: -1 });
// At most one confirmed subscription per position per vendor.
subscriptionSchema.index({ sellerId: 1, seq: 1 }, { unique: true, partialFilterExpression: { status: 'active' } });

export type Subscription = InferSchemaType<typeof subscriptionSchema>;
export type SubscriptionDoc = HydratedDocument<Subscription>;
export const SubscriptionModel = model('Subscription', subscriptionSchema);
