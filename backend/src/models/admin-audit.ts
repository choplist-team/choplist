import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

// Everything an admin did that changes data or reveals private data. Unlike
// EventLog this is never deleted automatically: it is the answer to "who did
// this, to what, and why?".
export const ADMIN_ACTIONS = [
  'seller.suspend',
  'seller.deactivate',
  'seller.reinstate',
  'order.reveal_phone',
  'report.resolve',
] as const;
export type AdminAction = (typeof ADMIN_ACTIONS)[number];

const adminAuditSchema = new Schema(
  {
    // The admin's Clerk user id.
    adminId: { type: String, required: true },
    action: { type: String, enum: ADMIN_ACTIONS, required: true },
    // What it was done to: a seller id, an order reference or a report id.
    targetId: { type: String, required: true, maxlength: 60 },
    reason: { type: String, trim: true, maxlength: 300 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

adminAuditSchema.index({ createdAt: -1 });
adminAuditSchema.index({ targetId: 1, createdAt: -1 });

export type AdminAuditEntry = InferSchemaType<typeof adminAuditSchema>;
export type AdminAuditDoc = HydratedDocument<AdminAuditEntry>;
export const AdminAuditModel = model('AdminAudit', adminAuditSchema);
