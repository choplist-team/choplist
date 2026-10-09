import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { DAY_PATTERN, PHONE_PATTERN, wholeNumber } from './fields.js';

export const ORDER_STATUSES = ['pending', 'paid', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

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

export type Order = InferSchemaType<typeof orderSchema>;
export type OrderDoc = HydratedDocument<Order>;
export const OrderModel = model('Order', orderSchema);
