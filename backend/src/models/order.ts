import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { DELIVERY_CODE_PATTERN } from '../orders/delivery-code.js';
import { DAY_PATTERN, PHONE_PATTERN, wholeNumber } from './fields.js';

// The life of an order: pending -> paid -> out_for_delivery -> delivered, and
// cancelled from any of them except delivered. The spellings are part of the API
// (the frontend sends and shows them), so they use underscores, not hyphens.
// The model's enum, the ?status= filter and the docs all read this one list.
export const ORDER_STATUSES = ['pending', 'paid', 'out_for_delivery', 'delivered', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export function isOrderStatus(value: string): value is OrderStatus {
  return (ORDER_STATUSES as readonly string[]).includes(value);
}

// "CL-" plus 5 characters with no 0/O/1/I, so a customer reading it out on
// WhatsApp can't confuse them.
export const REF_PATTERN = /^CL-[2-9A-HJ-NP-Z]{5}$/;

// Name and price are copied from the menu when the order is placed, so later
// menu edits never change what this customer was told to pay.
const orderLineSchema = new Schema(
  {
    itemId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true },
    unitPrice: wholeNumber(0),
    qty: wholeNumber(1),
  },
  { _id: false },
);

// Required sub-schemas (not plain nested objects) so TypeScript knows every
// order has them, as with Seller.payment.
const customerSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    phone: { type: String, required: true, match: PHONE_PATTERN },
  },
  { _id: false },
);

const deliverySchema = new Schema(
  {
    area: { type: String, required: true, trim: true, maxlength: 60 },
    address: { type: String, required: true, trim: true, maxlength: 300 },
    day: { type: String, required: true, match: DAY_PATTERN },
  },
  { _id: false },
);

const orderSchema = new Schema(
  {
    // The code the customer quotes when paying. Unique, enforced by the database.
    ref: { type: String, required: true, unique: true, match: REF_PATTERN },

    // sellerId is copied from the menu so every seller query can filter on it
    // directly, without looking up the menu first.
    sellerId: { type: Schema.Types.ObjectId, ref: 'Seller', required: true },
    menuId: { type: Schema.Types.ObjectId, ref: 'Menu', required: true },

    customer: { type: customerSchema, required: true },
    delivery: { type: deliverySchema, required: true },

    note: { type: String, trim: true, maxlength: 300 },

    lines: {
      type: [orderLineSchema],
      validate: { validator: (lines: unknown[]) => lines.length > 0, message: 'An order needs at least one line' },
    },

    // Sum of unitPrice * qty, in whole naira. Stored because it is what the
    // customer was told to pay.
    total: wholeNumber(0),

    status: { type: String, enum: ORDER_STATUSES, required: true, default: 'pending' },
    paidAt: Date,
    cancelledAt: Date,
    outForDeliveryAt: Date,
    deliveredAt: Date,

    // Delivery confirmation (see orders/delivery-code.ts). The two secrets are
    // select:false: a normal query leaves them out, and only code that asks for
    // them by name (.select('+deliveryCode')) can read them. That is a safety
    // net against leaking by accident; the real guarantee is that the seller's
    // response is built from an explicit list of fields (orders/seller-view.ts).
    deliveryCode: { type: String, select: false, match: DELIVERY_CODE_PATTERN },
    // Wrong codes entered since the code was made or last reset.
    deliveryCodeAttempts: { type: Number, default: 0, min: 0 },
    // Times the seller has reset the code for this order.
    deliveryCodeResets: { type: Number, default: 0, min: 0 },
    // SHA-256 of the key given to the customer when they ordered. Never the key.
    accessKeyHash: { type: String, select: false },

    // Hash of phone + menu + items (orders/fingerprint.ts). Missing on orders
    // placed before it existed; the backfill script fills it in.
    fingerprint: { type: String, match: /^[0-9a-f]{64}$/ },
    // Set once, right after the order is saved, when an earlier order with the
    // same fingerprint exists within DUPLICATE_WINDOW_MS. Admin list only.
    possibleDuplicate: { type: Boolean, default: false },
  },
  { timestamps: true },
);

// Safety net: refuse to save an order whose total disagrees with its lines.
orderSchema.pre('validate', function () {
  const sum = this.lines.reduce((acc, line) => acc + line.unitPrice * line.qty, 0);
  if (this.total !== sum) {
    this.invalidate('total', `total ${this.total} does not match the lines (${sum})`);
  }
});

// A seller's orders for one menu, newest first. Also the first filter of the
// prep sheet and delivery list.
orderSchema.index({ sellerId: 1, menuId: 1, createdAt: -1 });

// Admin console (all sellers at once). Each index matches one query shape:
//  - createdAt:            "newest orders", and counting orders in the last 7/30 days.
//  - sellerId + createdAt: "orders of one seller, newest first" without a menu.
//  - status + createdAt:   "all cancelled/paid orders", newest first.
//  - fingerprint + createdAt: the duplicate check, which looks for the same
//    fingerprint within a few minutes either side of an order.
// (ref already has a unique index, so a search by reference is a direct lookup.)
orderSchema.index({ createdAt: -1 });
orderSchema.index({ sellerId: 1, createdAt: -1 });
orderSchema.index({ status: 1, createdAt: -1 });
orderSchema.index({ fingerprint: 1, createdAt: 1 });
// Orders per menu in a date range (menu analytics joins each menu to its orders).
orderSchema.index({ menuId: 1, createdAt: 1 });

export type Order = InferSchemaType<typeof orderSchema>;
export type OrderDoc = HydratedDocument<Order>;
export const OrderModel = model('Order', orderSchema);
