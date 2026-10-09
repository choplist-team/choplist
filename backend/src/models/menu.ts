import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { DAY_PATTERN, wholeNumber } from './fields.js';

export const MENU_STATUSES = ['draft', 'open', 'closed'] as const;
export type MenuStatus = (typeof MENU_STATUSES)[number];

// Items are embedded in the menu, not a separate collection, so one updateOne
// on one menu document can check and decrement stock for every line of an
// order at once. MongoDB makes a single-document update all-or-nothing.
// Each item keeps its own _id: order lines and the stock update refer to it.
const menuItemSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  description: { type: String, trim: true, maxlength: 300 },
  price: wholeNumber(0),
  qtyTotal: wholeNumber(1),
  // Set equal to qtyTotal while the menu is a draft; only orders and
  // cancellations change it after the menu opens.
  qtyRemaining: wholeNumber(0),
});

menuItemSchema.path('qtyRemaining').validate(function (this: { qtyTotal: number }, value: number) {
  return value <= this.qtyTotal;
}, 'qtyRemaining cannot be more than qtyTotal');

function nonEmpty(list: unknown[]) {
  return list.length > 0;
}

const menuSchema = new Schema(
  {
    sellerId: { type: Schema.Types.ObjectId, ref: 'Seller', required: true },
    title: { type: String, required: true, trim: true, maxlength: 80 },
    status: { type: String, enum: MENU_STATUSES, required: true, default: 'draft' },

    // The moment ordering stops (a UTC instant).
    cutoffAt: { type: Date, required: true },

    items: {
      type: [menuItemSchema],
      validate: { validator: nonEmpty, message: 'A menu needs at least one item' },
    },

    // Areas the seller delivers to this week, e.g. ["Yaba", "Surulere"].
    areas: {
      type: [{ type: String, trim: true, maxlength: 60 }],
      validate: { validator: nonEmpty, message: 'A menu needs at least one delivery area' },
    },

    // Calendar days customers can pick, e.g. ["2026-10-17", "2026-10-18"].
    deliveryDays: {
      type: [{ type: String, match: DAY_PATTERN }],
      validate: { validator: nonEmpty, message: 'A menu needs at least one delivery day' },
    },

    openedAt: Date,
    closedAt: Date,
  },
  { timestamps: true },
);

// A seller's public link shows "their open menu", so there can only be one.
// The partial filter means the rule only applies to open menus: any number of
// drafts and closed menus are fine.
menuSchema.index(
  { sellerId: 1 },
  { unique: true, partialFilterExpression: { status: 'open' }, name: 'one_open_menu_per_seller' },
);

// The seller's menu list, newest first.
menuSchema.index({ sellerId: 1, createdAt: -1 });

export type Menu = InferSchemaType<typeof menuSchema>;
export type MenuDoc = HydratedDocument<Menu>;
export const MenuModel = model('Menu', menuSchema);
