import type { Types } from 'mongoose';
import { SubscriptionModel, type SubscriptionPlan } from '../models/subscription.js';
import { addMonthsUTC } from './dates.js';
import { PLAN_MONTHS } from './plans.js';

// Where a vendor's NEXT period of paid cover goes, given what they already have.
// The one rule for every way a subscription can become active (Paystack confirming a
// payment, an admin granting one), so they cannot disagree:
//   still covered -> start where the current cover ends (nothing lost, nothing overlapping)
//   not covered   -> start now
// "Covered" counts only ACTIVE subscriptions, so a cancelled one never extends anything.
// `seq` is the position in the vendor's chain; a unique index lets only one active
// subscription take each position, so two arriving together cannot both start from the
// same date (the loser retries and reads the chain again).
export async function nextCoverWindow(sellerId: Types.ObjectId, plan: SubscriptionPlan, now: Date) {
  const previous = await SubscriptionModel.findOne({ sellerId, status: 'active' }).sort({ seq: -1 }).lean();
  const startsAt = previous?.expiresAt && previous.expiresAt.getTime() > now.getTime() ? previous.expiresAt : now;
  return {
    startsAt,
    expiresAt: addMonthsUTC(startsAt, PLAN_MONTHS[plan]),
    seq: (previous?.seq ?? 0) + 1,
    renewalOf: previous?._id,
  };
}
