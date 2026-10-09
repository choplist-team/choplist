import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { PHONE_PATTERN } from './fields.js';

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

    // Shown to the customer with every new order.
    payment: { type: paymentSchema, required: true },
  },
  { timestamps: true },
);

export type Seller = InferSchemaType<typeof sellerSchema>;
export type SellerDoc = HydratedDocument<Seller>;
export const SellerModel = model('Seller', sellerSchema);
