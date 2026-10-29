import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { DAY_PATTERN } from './fields.js';

// How many times a seller's open menu was looked at on one day: ONE document per
// menu per day with a counter, not one document per view. A busy day costs one
// document, not thousands, and "views this month" is a sum of at most 31 rows
// per menu.
//
// It stores no visitor information at all: no IP address, no device, no phone.
// That is also why it cannot tell two visitors from one visitor refreshing; the
// numbers are "page loads", and the docs say so.
const menuViewDailySchema = new Schema(
  {
    menuId: { type: Schema.Types.ObjectId, ref: 'Menu', required: true },
    // Copied from the menu so per-seller totals need no join.
    sellerId: { type: Schema.Types.ObjectId, ref: 'Seller', required: true },
    // The calendar day in Lagos, "2026-10-29". Text, like the delivery days, so a
    // time zone can never move a view to the day before.
    day: { type: String, required: true, match: DAY_PATTERN },
    count: { type: Number, required: true, min: 1 },
  },
  // No timestamps and no __v: a counter changes only through $inc, never as a
  // whole document, so there is nothing to version.
  { timestamps: false, versionKey: false },
);

// The rule that makes "one counter per menu per day" true even when two views
// arrive at the same instant: the database refuses a second document for the
// same menu and day, so an upsert can only ever create one.
menuViewDailySchema.index({ menuId: 1, day: 1 }, { unique: true, name: 'one_counter_per_menu_per_day' });
// "Views per seller in a date range" (the analytics page).
menuViewDailySchema.index({ sellerId: 1, day: 1 });

export type MenuViewDaily = InferSchemaType<typeof menuViewDailySchema>;
export type MenuViewDailyDoc = HydratedDocument<MenuViewDaily>;
export const MenuViewDailyModel = model('MenuViewDaily', menuViewDailySchema);
