import { mongo, type Types } from 'mongoose';
import { z } from 'zod';
import { nextCoverWindow } from '../billing/chain.js';
import { newGrantReference } from '../billing/subscribe.js';
import { AppError } from '../errors.js';
import { recordAdminAction } from '../events/log.js';
import { notifySeller } from '../notifications/service.js';
import { SellerModel, VERIFICATION_STATUSES } from '../models/seller.js';
import { SUBSCRIPTION_PLANS, SubscriptionModel } from '../models/subscription.js';
import { objectIdText } from './query.js';
import { sellerBillingSummary } from './subscriptions.js';

// What an admin can do to a vendor's subscription. Every action writes its audit entry
// FIRST: if it cannot be recorded, the action does not happen. Money never moves from
// here: granting charges nothing, and cancelling or recording a refund only change
// ChopList's records (a refund is made in the Paystack dashboard, by hand).

export function parseSubscriptionId(raw: unknown): Types.ObjectId {
  const parsed = objectIdText('id').safeParse(raw);
  if (!parsed.success) throw new AppError(404, 'SUBSCRIPTION_NOT_FOUND', 'Subscription not found');
  return parsed.data;
}

const noteField = z.string().trim().max(300);
export const grantBody = z.object({
  plan: z.enum(SUBSCRIPTION_PLANS, { error: `plan must be one of: ${SUBSCRIPTION_PLANS.join(', ')}` }),
  // Required: a free subscription needs a reason on record (a comp, a support fix, a payment made elsewhere).
  note: noteField.min(3, 'Give a reason (at least 3 characters)'),
});
export const subscriptionNoteBody = z.object({ note: noteField.optional() });
export const verificationBody = z.object({
  status: z.enum(VERIFICATION_STATUSES, { error: `status must be one of: ${VERIFICATION_STATUSES.join(', ')}` }),
  note: noteField.optional(),
});

type SubscriptionRow = {
  _id: Types.ObjectId;
  sellerId: Types.ObjectId;
  plan: string;
  amountNaira: number;
  status: string;
  source?: string | null;
  paystackReference: string;
  paidAt?: Date | null;
  startsAt?: Date | null;
  expiresAt?: Date | null;
  createdAt: Date;
  cancelledAt?: Date | null;
  grantNote?: string | null;
  refund?: { refundedAt: Date; refundedBy: string; note?: string | null } | null;
};

export function toAdminSubscription(sub: SubscriptionRow) {
  return {
    id: sub._id.toString(),
    sellerId: sub.sellerId.toString(),
    status: sub.status,
    // 'paystack' (the vendor paid) or 'admin' (granted for free).
    source: sub.source ?? 'paystack',
    plan: sub.plan,
    amountNaira: sub.amountNaira,
    reference: sub.paystackReference,
    paidAt: sub.paidAt ?? null,
    startsAt: sub.startsAt ?? null,
    expiresAt: sub.expiresAt ?? null,
    createdAt: sub.createdAt,
    cancelledAt: sub.cancelledAt ?? null,
    grantNote: sub.grantNote ?? null,
    refund: sub.refund ? { refundedAt: sub.refund.refundedAt, refundedBy: sub.refund.refundedBy, note: sub.refund.note ?? null } : null,
  };
}

const MAX_GRANT_ATTEMPTS = 6;

// Gives a vendor a free period of cover, starting where their current cover ends (or now).
// NOT idempotent on purpose: two grants are two periods. It counts as cover but never as
// income. The same rule as a Paystack payment decides the dates (billing/chain.ts).
export async function grantSubscription(
  input: { sellerId: Types.ObjectId; adminId: string; plan: (typeof SUBSCRIPTION_PLANS)[number]; note: string },
  now: Date = new Date(),
) {
  const { sellerId, adminId, plan, note } = input;
  const seller = await SellerModel.findById(sellerId, { _id: 1 }).lean();
  if (!seller) throw new AppError(404, 'SELLER_NOT_FOUND', 'Seller not found');

  await recordAdminAction({ adminId, action: 'subscription.grant', targetId: sellerId.toString(), reason: `${plan}: ${note}`.slice(0, 300) });

  for (let attempt = 0; attempt < MAX_GRANT_ATTEMPTS; attempt += 1) {
    const window = await nextCoverWindow(sellerId, plan, now);
    try {
      const created = await SubscriptionModel.create({
        sellerId,
        plan,
        amountNaira: 0,
        status: 'active',
        source: 'admin',
        grantedBy: adminId,
        grantNote: note,
        paystackReference: newGrantReference(),
        paidAt: now,
        startsAt: window.startsAt,
        expiresAt: window.expiresAt,
        seq: window.seq,
        ...(window.renewalOf ? { renewalOf: window.renewalOf } : {}),
      });
      await notifySeller(sellerId, {
        type: 'subscription_activated',
        message: `ChopList has given you a ${plan} subscription, active until ${window.expiresAt.toISOString().slice(0, 10)}.`,
        dedupeKey: `sub_active:${created._id.toString()}`,
      });
      return toAdminSubscription(created);
    } catch (err) {
      // Another subscription for this vendor took the same position a moment ago: read the chain again.
      if (err instanceof mongo.MongoServerError && err.code === 11000) continue;
      throw err;
    }
  }
  throw new Error(`Could not grant a subscription to ${sellerId.toString()}: their chain kept changing`);
}

async function loadSubscription(id: Types.ObjectId) {
  const sub = await SubscriptionModel.findById(id).lean();
  if (!sub) throw new AppError(404, 'SUBSCRIPTION_NOT_FOUND', 'Subscription not found');
  return sub;
}

// Ends an ACTIVE subscription now: it stops covering the vendor straight away. Only an
// active one can be cancelled (a pending or failed one has nothing to end, and a payment
// might still arrive for it). Any later period already bought stays as it is. Nothing is
// refunded: that is a separate, manual step (mark-refunded).
export async function cancelSubscription(input: { id: Types.ObjectId; adminId: string; note?: string | undefined }) {
  const { id, adminId, note } = input;
  const sub = await loadSubscription(id);
  if (sub.status === 'cancelled') return toAdminSubscription(sub);
  if (sub.status !== 'active') {
    throw new AppError(409, 'SUBSCRIPTION_CANNOT_CHANGE', `Only an active subscription can be cancelled; this one is ${sub.status}`);
  }

  await recordAdminAction({ adminId, action: 'subscription.cancel', targetId: id.toString(), ...(note ? { reason: note } : {}) });
  const cancelled = await SubscriptionModel.findOneAndUpdate(
    { _id: id, status: 'active' },
    { $set: { status: 'cancelled', cancelledAt: new Date(), cancelledBy: adminId, ...(note ? { cancelNote: note } : {}) } },
    { returnDocument: 'after' },
  );
  if (cancelled) {
    await notifySeller(cancelled.sellerId, {
      type: 'subscription_cancelled',
      message: 'ChopList has ended your subscription. Contact support if you think this is a mistake.',
      dedupeKey: `sub_cancelled:${id.toString()}`,
    });
  }
  return toAdminSubscription(cancelled ?? (await loadSubscription(id)));
}

// Records that an admin refunded a subscription payment by hand in Paystack. Only a
// payment that was actually received and not honoured can be marked: one set aside for
// review (wrong amount), or one that was cancelled. A free grant has no money to refund.
export async function markSubscriptionRefunded(input: { id: Types.ObjectId; adminId: string; note?: string | undefined }) {
  const { id, adminId, note } = input;
  const sub = await loadSubscription(id);
  const eligible = (sub.status === 'needs_review' || sub.status === 'cancelled') && (sub.source ?? 'paystack') === 'paystack';
  if (!eligible) {
    throw new AppError(409, 'SUBSCRIPTION_CANNOT_CHANGE', 'Only a cancelled or needs-review Paystack payment can be marked refunded');
  }
  if (sub.refund) return toAdminSubscription(sub);

  await recordAdminAction({ adminId, action: 'subscription.mark_refunded', targetId: id.toString(), ...(note ? { reason: note } : {}) });
  await SubscriptionModel.updateOne(
    { _id: id, refund: { $exists: false } },
    { $set: { refund: { refundedAt: new Date(), refundedBy: adminId, ...(note ? { note } : {}) } } },
  );
  return toAdminSubscription(await loadSubscription(id));
}

// Records a vendor's verification status. It is only recorded: nothing in ChopList
// depends on it yet, so this blocks and unlocks nothing. Setting the status it already
// has changes nothing and adds no audit entry.
export async function setVerification(
  input: { sellerId: Types.ObjectId; adminId: string; status: (typeof VERIFICATION_STATUSES)[number]; note?: string | undefined },
  now: Date = new Date(),
) {
  const { sellerId, adminId, status, note } = input;
  const seller = await SellerModel.findById(sellerId, { billing: 1 }).lean();
  if (!seller) throw new AppError(404, 'SELLER_NOT_FOUND', 'Seller not found');
  // Verification begins after the trial, which has to exist first. Setting it must not
  // start a trial as a side effect.
  if (!seller.billing?.trialStartedAt) throw new AppError(409, 'TRIAL_NOT_STARTED', "This seller's free trial has not started yet");

  const current = seller.billing.verification;
  if ((current?.status ?? 'not_started') !== status) {
    await recordAdminAction({
      adminId,
      action: 'seller.set_verification',
      targetId: sellerId.toString(),
      reason: `${status}${note ? `: ${note}` : ''}`.slice(0, 300),
    });
    const finished = status === 'verified' || status === 'rejected';
    await SellerModel.updateOne(
      { _id: sellerId },
      {
        $set: {
          'billing.verification.status': status,
          ...(status !== 'not_started' && !current?.startedAt ? { 'billing.verification.startedAt': now } : {}),
          ...(finished ? { 'billing.verification.completedAt': now } : {}),
        },
        ...(finished ? {} : { $unset: { 'billing.verification.completedAt': '' } }),
      },
    );
  }
  return sellerBillingSummary((await SellerModel.findById(sellerId, { billing: 1 }).lean())!, now);
}
