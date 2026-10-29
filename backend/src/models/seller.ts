import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { PHONE_PATTERN } from './fields.js';

// active: normal. suspended: blocked by an admin, can be reinstated.
// deactivated: closed by an admin (or the owner's request), also reversible.
// Nothing is ever deleted. Sellers created before this field have no status in
// the database (a schema default only applies to NEW documents), so code must
// treat a missing status as active: use isSellerActive().
export const SELLER_STATUSES = ['active', 'suspended', 'deactivated'] as const;
export type SellerStatus = (typeof SELLER_STATUSES)[number];

export function isSellerActive(seller: { status?: string | null }): boolean {
  return !seller.status || seller.status === 'active';
}

// Lowercase words joined by single hyphens, e.g. "mama-titi-kitchen".
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Where customers send money. A required sub-schema (rather than a plain nested
// object) so TypeScript knows every seller has it.
const paymentSchema = new Schema(
  {
    bankName: { type: String, required: true, trim: true, maxlength: 60 },
    accountNumber: { type: String, required: true, match: /^\d{10}$/ }, // NUBAN
    accountName: { type: String, required: true, trim: true, maxlength: 80 },
  },
  { _id: false },
);

const sellerSchema = new Schema(
  {
    // The link to the Clerk account. Only auth code uses this; everything else
    // (menus, orders) points at the seller's own _id.
    clerkUserId: { type: String, required: true, unique: true },

    businessName: { type: String, required: true, trim: true, maxlength: 80 },

    // The seller's public link: /menu/<slug> always shows their open menu.
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      minlength: 3,
      maxlength: 40,
      match: SLUG_PATTERN,
    },

    // WhatsApp number customers can contact.
    phone: { type: String, required: true, match: PHONE_PATTERN },

    // Optional contact address, shown to admins next to the phone.
    email: { type: String, trim: true, lowercase: true, maxlength: 120 },

    // Shown to the customer with every new order.
    payment: { type: paymentSchema, required: true },

    // Account state, changed only by an admin (see admin routes).
    status: { type: String, enum: SELLER_STATUSES, required: true, default: 'active' },
    statusReason: { type: String, trim: true, maxlength: 300 },
    statusChangedAt: Date,

    // Last time this seller used a seller route. Written at most once per
    // LAST_ACTIVE_INTERVAL_MS (see auth/middleware.ts).
    lastActiveAt: Date,
  },
  { timestamps: true },
);

// Admin seller list: filter by account status, and "who was active lately".
sellerSchema.index({ status: 1 });
sellerSchema.index({ lastActiveAt: -1 });

export type Seller = InferSchemaType<typeof sellerSchema>;
export type SellerDoc = HydratedDocument<Seller>;
export const SellerModel = model('Seller', sellerSchema);
