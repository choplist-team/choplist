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

export const FEE_MODES = ['customer', 'seller'] as const;
export type FeeMode = (typeof FEE_MODES)[number];

// Sellers created before the payment fields existed have none of them in the
// database (a schema default only applies to NEW documents, and lean() queries
// skip defaults entirely). Code reads these three through the helpers so an old
// seller behaves exactly like a new one: customer pays the fee, no paid orders,
// payments not ready.
export function sellerFeeMode(seller: { feeMode?: string | null }): FeeMode {
  return seller.feeMode === 'seller' ? 'seller' : 'customer';
}
export function sellerPaidOrderCount(seller: { paidOrderCount?: number | null }): number {
  return seller.paidOrderCount ?? 0;
}
export function sellerPaymentsReady(seller: { paymentsReady?: boolean | null; paystackSubaccountCode?: string | null }): boolean {
  return seller.paymentsReady === true && Boolean(seller.paystackSubaccountCode);
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
    // Paystack's code for the bank ("058"), chosen from the bank list. Needed to
    // pay the seller through Paystack; sellers from before it have none and stay
    // on bank transfer until they pick their bank.
    bankCode: { type: String, match: /^\d{2,6}$/ },
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

    // ---- Paystack payments (see payments/) ----
    // Who pays Paystack's processing fee and ChopList's fee: the customer (shown
    // as a service fee line) or the seller (taken out of what they receive).
    // A seller setting; the customer never chooses.
    feeMode: { type: String, enum: FEE_MODES, required: true, default: 'customer' },
    // Orders this seller has been paid for through Paystack. Only the webhook
    // changes it, and only with $inc, so two payments arriving together both count.
    paidOrderCount: { type: Number, required: true, default: 0, min: 0 },
    // Paystack's code (ACCT_...) for this seller's settlement account. Paystack
    // pays the seller directly; ChopList never holds the money.
    paystackSubaccountCode: { type: String, trim: true, maxlength: 40 },
    // True only while the seller has a working subaccount. The pay route refuses
    // otherwise, and manual bank transfer keeps working.
    paymentsReady: { type: Boolean, required: true, default: false },
  },
  { timestamps: true },
);

// Admin seller list: filter by account status, and "who was active lately".
sellerSchema.index({ status: 1 });
sellerSchema.index({ lastActiveAt: -1 });

export type Seller = InferSchemaType<typeof sellerSchema>;
export type SellerDoc = HydratedDocument<Seller>;
export const SellerModel = model('Seller', sellerSchema);
