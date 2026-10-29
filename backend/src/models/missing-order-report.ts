import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { REF_PATTERN } from './order.js';

// "My order is missing", sent by a customer from the public site. Admins work
// through these on the support page.
//
// What it holds is deliberately thin: the reference and/or the LAST 4 digits of
// the phone number (never the whole number), the shop link they came from, and
// their message. The system also records privately whether it could find a
// matching order. That is for the admin only: the customer is never told, or
// the form would become a tool for checking which references exist.
export const REPORT_STATUSES = ['open', 'resolved'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

const missingOrderReportSchema = new Schema(
  {
    ref: { type: String, match: REF_PATTERN },
    phoneLast4: { type: String, match: /^\d{4}$/ },
    menuSlug: { type: String, maxlength: 40 },
    message: { type: String, required: true, trim: true, minlength: 5, maxlength: 500 },

    // Filled in by the system when the report is received.
    sellerId: { type: Schema.Types.ObjectId, ref: 'Seller' },
    orderFound: { type: Boolean, required: true, default: false },
    // Set only when exactly one order matched; ambiguous matches leave it empty.
    matchedOrderRef: { type: String, match: REF_PATTERN },

    status: { type: String, enum: REPORT_STATUSES, required: true, default: 'open' },
    resolvedBy: String, // the admin's Clerk user id
    resolvedAt: Date,
    resolutionNote: { type: String, trim: true, maxlength: 300 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// The support list (open first, newest first) and the "open reports" count on
// the health page both filter on status.
missingOrderReportSchema.index({ status: 1, createdAt: -1 });
missingOrderReportSchema.index({ createdAt: -1 });

export type MissingOrderReport = InferSchemaType<typeof missingOrderReportSchema>;
export type MissingOrderReportDoc = HydratedDocument<MissingOrderReport>;
export const MissingOrderReportModel = model('MissingOrderReport', missingOrderReportSchema);
