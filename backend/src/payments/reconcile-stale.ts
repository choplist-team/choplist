import { processSubscriptionCharge } from '../billing/webhook.js';
import { PaymentModel } from '../models/payment.js';
import { SubscriptionModel } from '../models/subscription.js';
import type { PaystackClient } from './paystack.js';
import { RECONCILE_MIN_AGE_MS } from './reconcile.js';
import { processChargeSuccess } from './webhook.js';

// The background version of the lost-webhook fallback (payments/reconcile.ts). That one
// only runs when somebody checks a payment's status; this one goes through waiting
// payments nobody is looking at, so a customer who paid and closed the page still has
// their order confirmed.
//
// It must not hammer Paystack for payments that were simply abandoned (most of them), so
// each payment is asked about a few times with growing gaps and then left alone. The first
// ask is as soon as the payment is old enough; after the Nth ask the next waits GAPS[N-1]:
//   asks at roughly: 2 min, 17 min, 1 h 17 min, 4 h 17 min, 10 h 17 min, 22 h 17 min
// That is at most six calls per payment, ever, whatever the sweep frequency. A payment
// older than the window below is not asked about (Paystack's checkout has long expired).
const MIN = 60_000;
const HOUR = 60 * MIN;
export const STALE_GAPS_MS = [15 * MIN, HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR] as const;
export const STALE_MAX_CHECKS = STALE_GAPS_MS.length + 1;
export const STALE_PAYMENT_WINDOW_MS = 48 * HOUR;
export const STALE_SUBSCRIPTION_WINDOW_MS = 7 * 24 * HOUR;
// At most this many Paystack calls per sweep, per kind.
const PER_SWEEP = 50;

export type StaleResult = { checked: number; applied: number };

type Waiting = { _id: unknown; checkCount?: number | null; lastCheckedAt?: Date | null };

// Whether this payment should be asked about now. After the Nth ask the next one waits
// GAPS[N-1]; once every gap has been used (six asks) there is no next gap and it is never
// asked again. The queries below also leave such payments out, but only as a saving: this
// is the rule.
function dueNow(w: Waiting, now: Date): boolean {
  const count = w.checkCount ?? 0;
  if (count === 0 || !w.lastCheckedAt) return true;
  const gap = STALE_GAPS_MS[count - 1];
  if (gap === undefined) return false;
  return now.getTime() - w.lastCheckedAt.getTime() >= gap;
}

// The right to ask is taken with one conditional write against exactly what we read, so
// two sweeps (two servers) cannot both ask about the same payment.
function claimFilter(w: Waiting): Record<string, unknown> {
  return {
    _id: w._id,
    checkCount: w.checkCount ?? { $exists: false },
    lastCheckedAt: w.lastCheckedAt ?? { $exists: false },
  };
}

export async function reconcileStalePayments(paystack: PaystackClient | null, now: Date = new Date()): Promise<StaleResult> {
  const result: StaleResult = { checked: 0, applied: 0 };
  if (!paystack) return result;

  const waiting = await PaymentModel.find({
    status: 'initialized',
    createdAt: { $gte: new Date(now.getTime() - STALE_PAYMENT_WINDOW_MS), $lte: new Date(now.getTime() - RECONCILE_MIN_AGE_MS) },
    $or: [{ checkCount: { $exists: false } }, { checkCount: { $lt: STALE_MAX_CHECKS } }],
  })
    .sort({ createdAt: 1 })
    .limit(PER_SWEEP * 4)
    .lean();

  for (const payment of waiting) {
    if (result.checked >= PER_SWEEP) break;
    if (!dueNow(payment, now)) continue;
    const claimed = await PaymentModel.findOneAndUpdate(
      { ...claimFilter(payment), status: 'initialized' },
      { $set: { lastCheckedAt: now }, $inc: { checkCount: 1 } },
      { returnDocument: 'after' },
    );
    if (!claimed) continue;
    result.checked += 1;
    try {
      const verified = await paystack.verifyTransaction(claimed.reference);
      if (verified.status === 'success' && verified.reference === claimed.reference) {
        if ((await processChargeSuccess(claimed.reference, paystack)) === 'paid') result.applied += 1;
      }
    } catch (err) {
      console.error('Background payment re-check failed', err instanceof Error ? err.name : err);
    }
  }
  return result;
}

export async function reconcileStaleSubscriptions(paystack: PaystackClient | null, now: Date = new Date()): Promise<StaleResult> {
  const result: StaleResult = { checked: 0, applied: 0 };
  if (!paystack) return result;

  const waiting = await SubscriptionModel.find({
    status: { $in: ['pending', 'failed'] },
    // Admin grants are never waiting; a Paystack attempt is.
    source: { $ne: 'admin' },
    createdAt: { $gte: new Date(now.getTime() - STALE_SUBSCRIPTION_WINDOW_MS), $lte: new Date(now.getTime() - RECONCILE_MIN_AGE_MS) },
    $or: [{ checkCount: { $exists: false } }, { checkCount: { $lt: STALE_MAX_CHECKS } }],
  })
    .sort({ createdAt: 1 })
    .limit(PER_SWEEP * 4)
    .lean();

  for (const sub of waiting) {
    if (result.checked >= PER_SWEEP) break;
    if (!dueNow(sub, now)) continue;
    const claimed = await SubscriptionModel.findOneAndUpdate(
      { ...claimFilter(sub), status: { $in: ['pending', 'failed'] } },
      { $set: { lastCheckedAt: now }, $inc: { checkCount: 1 } },
      { returnDocument: 'after' },
    );
    if (!claimed) continue;
    result.checked += 1;
    try {
      const verified = await paystack.verifyTransaction(claimed.paystackReference);
      if (verified.status === 'success' && verified.reference === claimed.paystackReference) {
        if ((await processSubscriptionCharge(claimed.paystackReference, paystack)) === 'activated') result.applied += 1;
      }
    } catch (err) {
      console.error('Background subscription re-check failed', err instanceof Error ? err.name : err);
    }
  }
  return result;
}
