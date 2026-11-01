import mongoose, { Types } from 'mongoose';
import { AdminAuditModel, type AdminAction } from '../models/admin-audit.js';
import { EventLogModel, type EventLevel, type EventType } from '../models/event-log.js';

// ---- What may go into an event --------------------------------------------
// The log helps us troubleshoot; it must not become a second copy of customer
// data. So meta only keeps small plain values, and drops any key whose NAME
// suggests private data, whatever its value is.
const PRIVATE_KEY = /phone|address|code|key|token|secret|password|authorization|email|name|note/i;
const MAX_META_KEYS = 10;
const MAX_TEXT = 200;

// Paystack-style API keys (sk_test_..., sk_live_..., pk_..., rk_...). A message
// copied from a third party must never carry one into the log, even by accident.
const API_KEY_SHAPE = /\b[spr]k_(?:test|live)_[A-Za-z0-9]+/g;
export function redactKeys(text: string): string {
  return text.replace(API_KEY_SHAPE, '[redacted]');
}

export function safeMeta(input: Record<string, unknown> | undefined): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!input) return out;
  for (const [key, value] of Object.entries(input)) {
    if (Object.keys(out).length >= MAX_META_KEYS) break;
    if (PRIVATE_KEY.test(key)) continue;
    if (typeof value === 'string') out[key] = redactKeys(value).slice(0, MAX_TEXT);
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean') out[key] = value;
  }
  return out;
}

export type EventInput = {
  type: EventType;
  level: EventLevel;
  code: string;
  message: string;
  sellerId?: Types.ObjectId | string | null;
  menuId?: Types.ObjectId | string | null;
  orderRef?: string | null;
  meta?: Record<string, unknown>;
};

function asObjectId(value: Types.ObjectId | string | null | undefined): Types.ObjectId | undefined {
  if (!value) return undefined;
  if (value instanceof Types.ObjectId) return value;
  return /^[0-9a-f]{24}$/i.test(value) ? new Types.ObjectId(value) : undefined;
}

// Writes one event. It NEVER throws and never makes the caller wait on a dead
// database: logging a problem must not create a new one. If MongoDB is not
// connected (readyState 1) the event is dropped, because Mongoose would
// otherwise queue the write for 10 seconds and then fail.
export async function logEvent(event: EventInput): Promise<void> {
  if (mongoose.connection.readyState !== 1) return;
  try {
    await EventLogModel.create({
      type: event.type,
      level: event.level,
      code: event.code.slice(0, 60),
      message: redactKeys(event.message).slice(0, 300),
      sellerId: asObjectId(event.sellerId),
      menuId: asObjectId(event.menuId),
      orderRef: event.orderRef ?? undefined,
      meta: safeMeta(event.meta),
    });
  } catch (err) {
    console.error('Could not write event log', err instanceof Error ? err.name : err);
  }
}

// READY FOR SPRINT 3, NOTHING CALLS IT YET. When push or email notifications
// exist, the code that sends one calls this when the send fails, and the admin
// health page counts these. Until then the "notification failures" number there
// is always 0, which means "nothing is reporting", not "nothing is failing".
export function logNotificationFailure(input: {
  channel: string;
  reason: string;
  sellerId?: Types.ObjectId | string | null;
  orderRef?: string | null;
}): Promise<void> {
  return logEvent({
    type: 'notification_failed',
    level: 'error',
    code: 'NOTIFICATION_FAILED',
    message: `Could not send a ${input.channel} notification`,
    sellerId: input.sellerId,
    orderRef: input.orderRef,
    meta: { channel: input.channel, reason: input.reason },
  });
}

// ---- Admin audit ----------------------------------------------------------
// Unlike logEvent this DOES throw. If an admin action cannot be recorded, the
// action must not go ahead: an unaudited phone reveal or suspension is worse
// than an error.
export async function recordAdminAction(entry: {
  adminId: string;
  action: AdminAction;
  targetId: string;
  reason?: string;
}): Promise<void> {
  await AdminAuditModel.create(entry);
}
