import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

// A short, anonymous record of something that went wrong (or worth knowing),
// for troubleshooting. It is NOT an audit trail of people: it never holds a
// phone number, address, delivery code or key (see events/log.ts).
export const EVENT_TYPES = [
  'order_failed', // an order could not be placed (sold out, closed, bad area...)
  'server_error', // an unhandled 5xx
  'notification_failed', // a push/email did not go out (nothing produces this yet)
  'missing_order_report', // a customer says their order is missing
  'payment_setup_failed', // a seller's Paystack payout account could not be set up
  'payment_start_failed', // a customer's Paystack payment could not be started
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_LEVELS = ['info', 'warn', 'error'] as const;
export type EventLevel = (typeof EVENT_LEVELS)[number];

// Events are deleted by the database 60 days after they were written.
export const EVENT_LOG_TTL_SECONDS = 60 * 24 * 60 * 60;

const eventLogSchema = new Schema(
  {
    type: { type: String, enum: EVENT_TYPES, required: true },
    level: { type: String, enum: EVENT_LEVELS, required: true },
    sellerId: { type: Schema.Types.ObjectId, ref: 'Seller' },
    menuId: { type: Schema.Types.ObjectId, ref: 'Menu' },
    orderRef: { type: String, maxlength: 20 },
    // The API error code (SOLD_OUT, ORDERING_CLOSED, INTERNAL_ERROR, ...).
    code: { type: String, required: true, maxlength: 60 },
    message: { type: String, required: true, maxlength: 300 },
    // Small flat facts only: strings, numbers, booleans (see safeMeta()).
    meta: { type: Schema.Types.Mixed },
  },
  // No updatedAt: an event is never edited.
  { timestamps: { createdAt: true, updatedAt: false } },
);

// The TTL index: MongoDB removes a document once createdAt is older than the
// number of seconds below (it checks about once a minute). Without it the
// collection would grow forever, and an attacker repeating failing orders could
// fill the database.
eventLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: EVENT_LOG_TTL_SECONDS, name: 'ttl_60_days' });
// "Counts in the last 24h by type" and "events of one type, newest first".
eventLogSchema.index({ type: 1, createdAt: -1 });
eventLogSchema.index({ level: 1, createdAt: -1 });
eventLogSchema.index({ sellerId: 1, createdAt: -1 });

export type EventLog = InferSchemaType<typeof eventLogSchema>;
export type EventLogDoc = HydratedDocument<EventLog>;
export const EventLogModel = model('EventLog', eventLogSchema);
