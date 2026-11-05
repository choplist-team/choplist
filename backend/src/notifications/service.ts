import mongoose, { mongo, type Types } from 'mongoose';
import { z } from 'zod';
import { NotificationModel, type NotificationAudience, type NotificationDoc, type NotificationType } from '../models/notification.js';

// Whole naira as people read it: ₦7,500.
export const formatNaira = (n: number) => `₦${n.toLocaleString('en-NG')}`;

export type NotifyInput = {
  audience: NotificationAudience;
  sellerId?: Types.ObjectId | string | null;
  type: NotificationType;
  message: string;
  orderRef?: string | null;
  // What happened, so the same thing notified twice is stored once.
  dedupeKey: string;
};

// Writes one notification. It NEVER throws and never makes the caller wait on a dead
// database, like logEvent: telling someone about a problem must not create a new one,
// and a payment must never fail because a notification could not be saved. The same
// dedupeKey twice is stored once (the second call is a quiet no-op).
export async function notify(input: NotifyInput): Promise<void> {
  if (mongoose.connection.readyState !== 1) return;
  try {
    await NotificationModel.create({
      audience: input.audience,
      ...(input.sellerId ? { sellerId: input.sellerId } : {}),
      type: input.type,
      message: input.message.slice(0, 300),
      ...(input.orderRef ? { orderRef: input.orderRef } : {}),
      dedupeKey: input.dedupeKey.slice(0, 120),
    });
  } catch (err) {
    if (err instanceof mongo.MongoServerError && err.code === 11000) return;
    console.error('Could not save a notification', err instanceof Error ? err.name : err);
  }
}

export const notifySeller = (sellerId: Types.ObjectId | string, input: Omit<NotifyInput, 'audience' | 'sellerId'>) =>
  notify({ ...input, audience: 'seller', sellerId });

export const notifyAdmins = (input: Omit<NotifyInput, 'audience' | 'sellerId'>) => notify({ ...input, audience: 'admin' });

export function toNotificationResponse(r: NotificationDoc) {
  return {
    id: r._id.toString(),
    type: r.type,
    message: r.message,
    orderRef: r.orderRef ?? null,
    read: Boolean(r.readAt),
    createdAt: r.createdAt,
  };
}

export const notificationListQuery = z.object({
  unread: z
    .enum(['true', 'false'], { error: 'unread must be true or false' })
    .optional()
    .transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const markReadBody = z
  .object({
    // Specific notifications, or everything.
    ids: z.array(z.string().regex(/^[0-9a-f]{24}$/i, 'ids must be notification ids')).max(100).optional(),
    all: z.boolean().optional(),
  })
  .refine((body) => body.all === true || (body.ids && body.ids.length > 0), { message: 'Send ids, or all: true' });

type Scope = { audience: 'seller'; sellerId: Types.ObjectId } | { audience: 'admin' };

const scopeFilter = (scope: Scope): Record<string, unknown> => (scope.audience === 'seller' ? { audience: 'seller', sellerId: scope.sellerId } : { audience: 'admin' });

// Newest first, with how many are unread overall (not just in this page).
export async function listNotifications(scope: Scope, query: z.infer<typeof notificationListQuery>) {
  const filter = { ...scopeFilter(scope), ...(query.unread ? { readAt: { $exists: false } } : {}) };
  const [rows, unreadCount] = await Promise.all([
    NotificationModel.find(filter).sort({ createdAt: -1, _id: -1 }).limit(query.limit),
    NotificationModel.countDocuments({ ...scopeFilter(scope), readAt: { $exists: false } }),
  ]);
  return { notifications: rows.map(toNotificationResponse), unreadCount };
}

// Marks them read. Only ever the caller's own (a seller cannot touch another seller's
// or the admin inbox by sending its ids). Repeating changes nothing.
export async function markNotificationsRead(scope: Scope, body: z.infer<typeof markReadBody>) {
  const filter = {
    ...scopeFilter(scope),
    readAt: { $exists: false },
    ...(body.all === true ? {} : { _id: { $in: body.ids ?? [] } }),
  };
  const result = await NotificationModel.updateMany(filter, { $set: { readAt: new Date() } });
  const unreadCount = await NotificationModel.countDocuments({ ...scopeFilter(scope), readAt: { $exists: false } });
  return { marked: result.modifiedCount, unreadCount };
}
