import type { Types } from 'mongoose';
import { AppError } from '../errors.js';
import { SellerModel, type VerificationStatus } from '../models/seller.js';
import { SubscriptionModel, type SubscriptionPlan } from '../models/subscription.js';
import { addDaysUTC } from './dates.js';
import { buildPlans, type BillingConfig, type PlanInfo } from './plans.js';

// A vendor is in exactly one of three states, worked out from dates and the
// server clock every time it is asked. Nothing is stored, so nothing can go stale
// and no scheduled job is needed.
//
//   active   a confirmed subscription covers this moment (checked first, so a
//            vendor who pays during the trial is "active", not "trial")
//   trial    no subscription covers it, but the free trial has not ended
//   expired  the trial has ended and nothing covers it
//
// The boundaries are exact: the trial is over AT trialEndsAt (not after), and a
// subscription covers startsAt up to but NOT including expiresAt.
export const BILLING_STATES = ['trial', 'active', 'expired'] as const;
export type BillingStateName = (typeof BILLING_STATES)[number];

export type ConfirmedSubscription = {
  _id: Types.ObjectId;
  plan: SubscriptionPlan;
  startsAt: Date;
  expiresAt: Date;
};

export type BillingState = {
  state: BillingStateName;
  // The one answer the frontend greys out the share area by, and the one every
  // backend endpoint that hands out the link checks.
  canShareLink: boolean;
  trialStartedAt: Date;
  trialEndsAt: Date;
  // The subscription covering this moment, or null.
  subscription: { id: string; plan: SubscriptionPlan; startsAt: Date; expiresAt: Date } | null;
  // When paid cover ends, counting subscriptions already bought for after the
  // current one. Null when nothing covers this moment.
  accessEndsAt: Date | null;
  verification: { status: VerificationStatus; startedAt: Date | null; completedAt: Date | null };
  // True once the trial has ended and verification has not started. Nothing is
  // blocked by it; it is only the signal that verification should begin.
  verificationDue: boolean;
  plans: PlanInfo[];
};

export type BillingInput = {
  trialStartedAt: Date;
  trialEndsAt: Date;
  verification?: { status?: VerificationStatus | null; startedAt?: Date | null; completedAt?: Date | null } | null;
};

// Pure: no database, no clock. `subscriptions` are the CONFIRMED ones only.
export function computeBillingState(input: {
  billing: BillingInput;
  subscriptions: ConfirmedSubscription[];
  plans: PlanInfo[];
  now: Date;
}): BillingState {
  const { billing, subscriptions, plans, now } = input;
  const at = now.getTime();

  const covering = subscriptions
    .filter((s) => s.startsAt.getTime() <= at && at < s.expiresAt.getTime())
    .sort((a, b) => b.expiresAt.getTime() - a.expiresAt.getTime())[0];
  const trialEnded = at >= billing.trialEndsAt.getTime();

  const state: BillingStateName = covering ? 'active' : trialEnded ? 'expired' : 'trial';

  let accessEndsAt: Date | null = null;
  if (covering) {
    accessEndsAt = subscriptions.reduce((latest, s) => (s.expiresAt.getTime() > latest.getTime() ? s.expiresAt : latest), covering.expiresAt);
  }

  const verification = {
    status: billing.verification?.status ?? 'not_started',
    startedAt: billing.verification?.startedAt ?? null,
    completedAt: billing.verification?.completedAt ?? null,
  };

  return {
    state,
    canShareLink: state !== 'expired',
    trialStartedAt: billing.trialStartedAt,
    trialEndsAt: billing.trialEndsAt,
    subscription: covering ? { id: covering._id.toString(), plan: covering.plan, startsAt: covering.startsAt, expiresAt: covering.expiresAt } : null,
    accessEndsAt,
    verification,
    verificationDue: trialEnded && verification.status === 'not_started',
    plans,
  };
}

// The trial a seller starts with: `trialDays` from `now`, verification not begun.
export function startTrial(config: BillingConfig, now: Date) {
  return {
    trialStartedAt: now,
    trialEndsAt: addDaysUTC(now, config.trialDays),
    verification: { status: 'not_started' as const },
  };
}

// Gives a seller who has no trial yet one starting at `now`. The write only matches
// a seller who still has none, so it can never move a trial that has begun: not when
// two requests arrive together, and not when the backfill script has just given the
// seller a trial that this request did not know about yet.
export async function startTrialIfMissing(sellerId: Types.ObjectId, config: BillingConfig, now: Date): Promise<void> {
  await SellerModel.updateOne(
    { _id: sellerId, 'billing.trialStartedAt': { $exists: false } },
    { $set: { billing: startTrial(config, now) } },
  );
}

// Sellers from before billing existed have no trial dates. The first time their
// state is needed they get a trial starting NOW, which is the deploy date for every
// existing seller in practice, so nobody's trial is already over.
async function ensureBilling(sellerId: Types.ObjectId, config: BillingConfig, now: Date) {
  const select = { billing: 1 } as const;
  const seller = await SellerModel.findById(sellerId, select).lean();
  if (!seller) throw new AppError(403, 'PROFILE_REQUIRED', 'Create your seller profile first');
  if (seller.billing?.trialStartedAt && seller.billing.trialEndsAt) return seller.billing;

  await startTrialIfMissing(sellerId, config, now);
  const fresh = await SellerModel.findById(sellerId, select).lean();
  if (!fresh?.billing?.trialStartedAt || !fresh.billing.trialEndsAt) throw new Error(`Could not start the trial for seller ${sellerId.toString()}`);
  return fresh.billing;
}

// THE function. Every endpoint that needs to know whether a vendor may share their
// link, or what to show on the billing page, calls this and nothing else. `now`
// is the server clock; only tests pass their own.
export async function getBillingState(sellerId: Types.ObjectId, config: BillingConfig, now: Date = new Date()): Promise<BillingState> {
  const billing = await ensureBilling(sellerId, config, now);
  const subscriptions = await SubscriptionModel.find(
    { sellerId, status: 'active' },
    { plan: 1, startsAt: 1, expiresAt: 1 },
  )
    .sort({ expiresAt: -1 })
    .limit(100)
    .lean();

  return computeBillingState({
    billing: { trialStartedAt: billing.trialStartedAt, trialEndsAt: billing.trialEndsAt, verification: billing.verification },
    subscriptions: subscriptions.flatMap((s) => (s.startsAt && s.expiresAt ? [{ _id: s._id, plan: s.plan, startsAt: s.startsAt, expiresAt: s.expiresAt }] : [])),
    plans: buildPlans(config),
    now,
  });
}

// The refusal for anything that would give a vendor a link to share.
export function assertCanShare(state: BillingState): void {
  if (state.canShareLink) return;
  throw new AppError(
    403,
    'SHARING_NOT_ALLOWED',
    'Your free trial has ended and you have no active subscription. Subscribe to share your shop link.',
  );
}
