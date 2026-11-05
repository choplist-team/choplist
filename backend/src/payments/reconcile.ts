import type { Types } from 'mongoose';
import { processSubscriptionCharge } from '../billing/webhook.js';
import { PaymentModel } from '../models/payment.js';
import { SubscriptionModel } from '../models/subscription.js';
import type { PaystackClient } from './paystack.js';
import { processChargeSuccess } from './webhook.js';

// The fallback for a webhook that never arrives. Paystack normally tells us a payment
// succeeded within seconds; if that call is lost, the customer would stay on "waiting"
// for good. So when someone checks the status of a payment that is still waiting, the
// server asks Paystack ITSELF, and if Paystack says it succeeded, runs the very same
// code the webhook runs. That code verifies, compares the amount and applies the
// payment exactly once, so it does not matter whether the webhook, this check or both
// get there: the first one wins and the rest change nothing.
//
// Two limits keep it from spending Paystack calls:
//  - it waits MIN_AGE_MS after the payment was started (the webhook is usually quicker,
//    and a customer is still on Paystack's page), and
//  - it asks about one payment at most once per CHECK_INTERVAL_MS, however often the
//    page polls. The right to ask is taken with one conditional write, so two polls at
//    once ask once.
export const RECONCILE_MIN_AGE_MS = 20_000;
export const RECONCILE_INTERVAL_MS = 15_000;
// A customer who tries again leaves several waiting attempts; this many are checked.
const MAX_ATTEMPTS_CHECKED = 3;

type Quiet = (err: unknown) => void;
const logQuietly: Quiet = (err) => console.error('Payment re-check failed', err instanceof Error ? err.name : err);

// Never throws: this runs inside a page that is only trying to show a status, and the
// answer it gives is still correct if Paystack could not be asked (the payment simply
// stays "waiting" until the next poll or the webhook).
export async function reconcileOrderPayment(orderId: Types.ObjectId, paystack: PaystackClient | null, now: Date = new Date()): Promise<void> {
  if (!paystack) return;
  try {
    const waiting = await PaymentModel.find({ orderId, status: 'initialized', createdAt: { $lte: new Date(now.getTime() - RECONCILE_MIN_AGE_MS) } })
      .sort({ createdAt: -1 })
      .limit(MAX_ATTEMPTS_CHECKED)
      .lean();

    for (const attempt of waiting) {
      const claimed = await PaymentModel.findOneAndUpdate(
        {
          _id: attempt._id,
          status: 'initialized',
          $or: [{ lastCheckedAt: { $exists: false } }, { lastCheckedAt: { $lte: new Date(now.getTime() - RECONCILE_INTERVAL_MS) } }],
        },
        { $set: { lastCheckedAt: now } },
        { returnDocument: 'after' },
      );
      if (!claimed) continue;

      try {
        const verified = await paystack.verifyTransaction(attempt.reference);
        // Only a success changes anything. Anything else (still open, abandoned, failed)
        // is left alone so a poll never writes an event on every check.
        if (verified.status === 'success' && verified.reference === attempt.reference) {
          await processChargeSuccess(attempt.reference, paystack);
        }
      } catch (err) {
        logQuietly(err);
      }
    }
  } catch (err) {
    logQuietly(err);
  }
}

// The same for a vendor's subscription payment.
export async function reconcileSubscription(subscriptionId: Types.ObjectId, paystack: PaystackClient | null, now: Date = new Date()): Promise<void> {
  if (!paystack) return;
  try {
    const claimed = await SubscriptionModel.findOneAndUpdate(
      {
        _id: subscriptionId,
        status: { $in: ['pending', 'failed'] },
        createdAt: { $lte: new Date(now.getTime() - RECONCILE_MIN_AGE_MS) },
        $or: [{ lastCheckedAt: { $exists: false } }, { lastCheckedAt: { $lte: new Date(now.getTime() - RECONCILE_INTERVAL_MS) } }],
      },
      { $set: { lastCheckedAt: now } },
      { returnDocument: 'after' },
    );
    if (!claimed) return;

    const verified = await paystack.verifyTransaction(claimed.paystackReference);
    if (verified.status === 'success' && verified.reference === claimed.paystackReference) {
      await processSubscriptionCharge(claimed.paystackReference, paystack);
    }
  } catch (err) {
    logQuietly(err);
  }
}
