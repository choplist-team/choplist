import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

// Messages inside the app: a seller's bell, and a shared inbox for ChopList's admins.
// There is no email or push yet; this is the place those would plug in (each
// notification is a row, so a sender can read the unsent ones later).
//
// A notification carries what a person needs to act (an order reference, an amount),
// never a customer's name, phone or address, and never a secret.
export const NOTIFICATION_AUDIENCES = ['seller', 'admin'] as const;
export type NotificationAudience = (typeof NOTIFICATION_AUDIENCES)[number];

export const NOTIFICATION_TYPES = [
  // for sellers
  'order_paid_online', // an order was paid through Paystack
  'customer_reported_paid', // a customer says they paid by transfer; confirm it
  'payment_query_raised', // a payment problem was reported on their order
  'payment_query_resolved', // ChopList replied to a payment problem on their order
  'subscription_activated', // their subscription is active
  'subscription_expiring', // their paid cover ends soon
  'subscription_cancelled', // ChopList ended their subscription
  // for admins
  'refund_due', // a paid online order was cancelled: the customer needs a refund
  'payment_needs_review', // money arrived that could not be applied
  'subscription_needs_review', // a subscription payment arrived but could not be activated
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

const notificationSchema = new Schema(
  {
    audience: { type: String, enum: NOTIFICATION_AUDIENCES, required: true },
    // Set for a seller's notification; absent for the admin inbox.
    sellerId: { type: Schema.Types.ObjectId, ref: 'Seller' },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    // Plain English, ready to show.
    message: { type: String, required: true, maxlength: 300 },
    orderRef: { type: String, maxlength: 20 },
    // Identifies WHAT happened, so the same thing notified twice is stored once (a
    // retried webhook, a sweep running again). Unique.
    dedupeKey: { type: String, required: true, unique: true, maxlength: 120 },
    readAt: Date,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// A seller's feed, newest first, and their unread count.
notificationSchema.index({ sellerId: 1, createdAt: -1 });
notificationSchema.index({ sellerId: 1, readAt: 1 });
// The admin inbox.
notificationSchema.index({ audience: 1, createdAt: -1 });
notificationSchema.index({ audience: 1, readAt: 1 });

export type Notification = InferSchemaType<typeof notificationSchema>;
export type NotificationDoc = HydratedDocument<Notification>;
export const NotificationModel = model('Notification', notificationSchema);
