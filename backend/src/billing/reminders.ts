import type { Types } from 'mongoose';
import { notifySeller } from '../notifications/service.js';
import { SubscriptionModel } from '../models/subscription.js';

// Tells a vendor their paid cover ends soon, so they can renew before they lose the share
// button. There is no auto-renewal (a vendor pays each period themselves), so this is the
// only warning they get.
//
// One notification per vendor per end date: the key includes the date their cover ends, so
// running every 15 minutes says it once, and a vendor who renews (a later end date) gets a
// fresh reminder for the new date when it nears. A vendor who has already bought a later
// period is not reminded: their END date is the latest one.
export const REMINDER_DAYS = 3;
const DAY_MS = 86_400_000;

export async function notifyExpiringSubscriptions(now: Date = new Date()): Promise<number> {
  const soon = new Date(now.getTime() + REMINDER_DAYS * DAY_MS);
  const ending = await SubscriptionModel.aggregate<{ _id: Types.ObjectId; endsAt: Date }>([
    { $match: { status: 'active', expiresAt: { $gt: now } } },
    { $group: { _id: '$sellerId', endsAt: { $max: '$expiresAt' } } },
    { $match: { endsAt: { $lte: soon } } },
  ]);

  for (const vendor of ending) {
    await notifySeller(vendor._id, {
      type: 'subscription_expiring',
      message: `Your subscription ends on ${vendor.endsAt.toISOString().slice(0, 10)}. Renew before then to keep sharing your shop link.`,
      dedupeKey: `sub_expiring:${vendor._id.toString()}:${vendor.endsAt.toISOString()}`,
    });
  }
  return ending.length;
}
