import type { Types } from 'mongoose';
import { z } from 'zod';
import { computeBillingState } from '../billing/state.js';
import { SellerModel } from '../models/seller.js';
import { SUBSCRIPTION_PLANS, SUBSCRIPTION_STATUSES, SubscriptionModel } from '../models/subscription.js';
import { objectIdText, paginationQuery, toPagination } from './query.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Shown by the frontend beside each figure, so a number is never read without its
// meaning. Kept next to the code that computes it.
export const SUBSCRIPTION_DEFINITIONS = {
  activeNow: 'Vendors covered by a confirmed subscription at this moment. A vendor with two subscriptions queued is counted once.',
  onTrial: 'Vendors whose free trial has not ended and who are not covered by a subscription.',
  expired: 'Vendors whose free trial has ended and who are not covered by a subscription. These cannot get a share link from the app (their shop still works for customers).',
  notStarted:
    'Sellers from before billing existed whose trial has not started yet. It starts the first time their billing state is read, or when the backfill script is run.',
  expiringIn7Days: 'Vendors whose paid cover ends within the next 7 days and who have no later subscription bought.',
  revenue:
    'Money from subscriptions that Paystack confirmed, in naira, by the day it was confirmed. This is ChopList\'s income now that it takes no cut of each order. Paystack\'s own charges are not deducted, and refunds are not tracked.',
  purchases: 'Confirmed subscription payments, by plan.',
  needsReview:
    'Subscription payments where money arrived but nothing was activated (for example the amount was not the plan\'s price). A person must refund or decide; see the event log for the details.',
} as const;

const naira = (n: number) => Math.round(n * 100) / 100;

type Group = { _id: string | null; n: number; total: number };

// Everything is counted from the same dates the vendor-facing billing state uses, at
// this moment, so the numbers here and on a vendor's own screen cannot disagree.
export async function subscriptionsOverview(now: Date) {
  const since30 = new Date(now.getTime() - 30 * DAY_MS);
  const in7 = new Date(now.getTime() + 7 * DAY_MS);

  // Vendors covered right now.
  const activeIds = await SubscriptionModel.distinct('sellerId', { status: 'active', startsAt: { $lte: now }, expiresAt: { $gt: now } });

  const [onTrial, expired, notStarted, revenueAll, revenueRecent, byPlan, needsReview, expiring] = await Promise.all([
    SellerModel.countDocuments({ 'billing.trialEndsAt': { $gt: now }, _id: { $nin: activeIds } }),
    SellerModel.countDocuments({ 'billing.trialEndsAt': { $lte: now }, _id: { $nin: activeIds } }),
    SellerModel.countDocuments({ 'billing.trialStartedAt': { $exists: false } }),
    SubscriptionModel.aggregate<Group>([{ $match: { status: 'active' } }, { $group: { _id: null, n: { $sum: 1 }, total: { $sum: '$amountNaira' } } }]),
    SubscriptionModel.aggregate<Group>([
      { $match: { status: 'active', paidAt: { $gte: since30 } } },
      { $group: { _id: null, n: { $sum: 1 }, total: { $sum: '$amountNaira' } } },
    ]),
    SubscriptionModel.aggregate<Group>([{ $match: { status: 'active' } }, { $group: { _id: '$plan', n: { $sum: 1 }, total: { $sum: '$amountNaira' } } }]),
    SubscriptionModel.countDocuments({ status: 'needs_review' }),
    // Each vendor's latest paid-to date, if it falls in the next 7 days.
    SubscriptionModel.aggregate<{ _id: Types.ObjectId }>([
      { $match: { status: 'active', expiresAt: { $gt: now } } },
      { $group: { _id: '$sellerId', endsAt: { $max: '$expiresAt' } } },
      { $match: { endsAt: { $lte: in7 } } },
    ]),
  ]);

  const plan = (id: string) => byPlan.find((g) => g._id === id);
  return {
    activeNow: activeIds.length,
    onTrial,
    expired,
    notStarted,
    expiringIn7Days: expiring.length,
    revenue: {
      allTime: naira(revenueAll[0]?.total ?? 0),
      last30Days: naira(revenueRecent[0]?.total ?? 0),
    },
    purchases: {
      allTime: revenueAll[0]?.n ?? 0,
      last30Days: revenueRecent[0]?.n ?? 0,
      monthly: plan('monthly')?.n ?? 0,
      quarterly: plan('quarterly')?.n ?? 0,
    },
    needsReview,
    definitions: SUBSCRIPTION_DEFINITIONS,
  };
}

// One vendor's billing state, for their admin detail page. Read-only: it never starts a
// trial (unlike the vendor's own billing call), so looking at a vendor cannot change
// them. A seller whose trial has not started yet has state null.
export async function sellerBillingSummary(
  seller: { _id: Types.ObjectId; billing?: { trialStartedAt?: Date | null; trialEndsAt?: Date | null; verification?: { status?: string | null; startedAt?: Date | null; completedAt?: Date | null } | null } | null },
  now: Date,
) {
  const billing = seller.billing;
  if (!billing?.trialStartedAt || !billing.trialEndsAt) {
    return { state: null, canShareLink: null, trialStartedAt: null, trialEndsAt: null, accessEndsAt: null, subscription: null, verification: { status: 'not_started', startedAt: null, completedAt: null }, verificationDue: false };
  }
  const subs = await SubscriptionModel.find({ sellerId: seller._id, status: 'active' }, { plan: 1, startsAt: 1, expiresAt: 1 }).sort({ expiresAt: -1 }).limit(100).lean();
  const state = computeBillingState({
    billing: { trialStartedAt: billing.trialStartedAt, trialEndsAt: billing.trialEndsAt, verification: billing.verification as never },
    subscriptions: subs.flatMap((s) => (s.startsAt && s.expiresAt ? [{ _id: s._id, plan: s.plan, startsAt: s.startsAt, expiresAt: s.expiresAt }] : [])),
    plans: [],
    now,
  });
  const { plans: _plans, ...rest } = state;
  return rest;
}

// ---- The list ---------------------------------------------------------------------
export const subscriptionListQuery = z.object({
  status: z.enum(SUBSCRIPTION_STATUSES, { error: `status must be one of: ${SUBSCRIPTION_STATUSES.join(', ')}` }).optional(),
  plan: z.enum(SUBSCRIPTION_PLANS, { error: `plan must be one of: ${SUBSCRIPTION_PLANS.join(', ')}` }).optional(),
  sellerId: objectIdText('sellerId').optional(),
  ...paginationQuery,
});

export async function listSubscriptions(query: z.infer<typeof subscriptionListQuery>) {
  const { status, plan, sellerId, page, limit } = query;
  const filter = { ...(status ? { status } : {}), ...(plan ? { plan } : {}), ...(sellerId ? { sellerId } : {}) };

  const [rows, total] = await Promise.all([
    SubscriptionModel.aggregate<Record<string, any>>([
      { $match: filter },
      { $sort: { createdAt: -1, _id: -1 } },
      { $skip: (page - 1) * limit },
      { $limit: limit },
      {
        $lookup: {
          from: SellerModel.collection.name,
          localField: 'sellerId',
          foreignField: '_id',
          pipeline: [{ $project: { businessName: 1, slug: 1 } }],
          as: 'seller',
        },
      },
    ]),
    SubscriptionModel.countDocuments(filter),
  ]);

  return {
    subscriptions: rows.map((r) => {
      const seller = (r.seller as { _id: Types.ObjectId; businessName: string; slug: string }[] | undefined)?.[0];
      return {
        id: String(r._id),
        status: r.status as string,
        plan: r.plan as string,
        amountNaira: r.amountNaira as number,
        reference: r.paystackReference as string,
        paidAt: (r.paidAt as Date | undefined) ?? null,
        startsAt: (r.startsAt as Date | undefined) ?? null,
        expiresAt: (r.expiresAt as Date | undefined) ?? null,
        createdAt: r.createdAt as Date,
        seller: seller ? { id: seller._id.toString(), businessName: seller.businessName, slug: seller.slug } : null,
      };
    }),
    pagination: toPagination(total, page, limit),
  };
}
