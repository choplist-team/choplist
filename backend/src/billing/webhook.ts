import { mongo } from 'mongoose';
import { logEvent } from '../events/log.js';
import { formatNaira, notifyAdmins, notifySeller } from '../notifications/service.js';
import { SubscriptionModel, type SubscriptionDoc } from '../models/subscription.js';
import { PaystackError, type PaystackClient } from '../payments/paystack.js';
import { nextCoverWindow } from './chain.js';

export type SubscriptionOutcome =
  | 'activated' // this delivery activated the subscription
  | 'already_processed' // an earlier or concurrent delivery already did
  | 'ignored' // a payment we have already set aside for a human
  | 'unknown_reference' // signed by Paystack, but not a subscription we know
  | 'not_confirmed' // Paystack does not say it succeeded
  | 'amount_mismatch'; // Paystack says a different amount or currency was paid

// Taking a position in the vendor's chain can lose a race to another payment
// confirmed at the same moment; each retry reads the chain again, so a few is
// plenty. More than this means something is wrong, and Paystack will resend.
const MAX_ACTIVATION_ATTEMPTS = 6;

async function raise(code: string, level: 'warn' | 'error', message: string, subscription: SubscriptionDoc | null, meta: Record<string, unknown> = {}) {
  await logEvent({
    type: 'subscription_webhook_issue',
    level,
    code,
    message,
    sellerId: subscription?.sellerId,
    // Amounts and the reference only: no vendor contact or bank details.
    meta: { ...meta, ...(subscription ? { reference: subscription.paystackReference } : {}) },
  });
}

function isDuplicateKey(err: unknown): boolean {
  return err instanceof mongo.MongoServerError && err.code === 11000;
}

// Handles one charge.success whose reference is a subscription's. Safe to run any
// number of times for the same reference, at the same time: activation is one
// conditional write that only one caller can win, so a replay changes nothing.
//
// Throws PaystackError('unavailable') when Paystack cannot be asked. The route
// turns that into a 5xx so Paystack delivers the event again; nothing has been
// changed at that point.
//
// The webhook only tells us WHICH subscription to look at. Whether it was paid,
// and for how much, comes from asking Paystack directly, and is compared with the
// price frozen on our own row when the vendor pressed Subscribe.
export async function processSubscriptionCharge(
  reference: string,
  paystack: PaystackClient,
  now: () => Date = () => new Date(),
): Promise<SubscriptionOutcome> {
  const subscription = await SubscriptionModel.findOne({ paystackReference: reference });
  if (!subscription) {
    await raise('UNKNOWN_REFERENCE', 'warn', 'Paystack confirmed a subscription payment we have no record of', null, { reference });
    return 'unknown_reference';
  }

  // Active: counted already. Cancelled: it was active (only an active one can be cancelled),
  // so a replay of its webhook is just that, a replay.
  if (subscription.status === 'active' || subscription.status === 'cancelled') return 'already_processed';
  if (subscription.status === 'needs_review') return 'ignored';

  let verified;
  try {
    verified = await paystack.verifyTransaction(reference);
  } catch (err) {
    if (err instanceof PaystackError && err.kind === 'rejected') {
      await raise('NOT_CONFIRMED', 'warn', 'Paystack does not recognise this subscription payment', subscription, { httpStatus: err.status ?? 0 });
      return 'not_confirmed';
    }
    throw err;
  }

  if (verified.status !== 'success' || verified.reference !== reference) {
    // A charge Paystack says failed is recorded as failed. It is not final: if the
    // vendor retries and it succeeds, the activation below still accepts it.
    if (verified.status === 'failed') {
      await SubscriptionModel.updateOne({ _id: subscription._id, status: 'pending' }, { $set: { status: 'failed' } });
    }
    await raise('NOT_CONFIRMED', 'warn', 'Paystack does not report this subscription payment as successful', subscription, { paystackStatus: verified.status });
    return 'not_confirmed';
  }

  if (verified.currency !== 'NGN' || verified.amountKobo !== subscription.amountNaira * 100) {
    await SubscriptionModel.updateOne({ _id: subscription._id, status: { $in: ['pending', 'failed'] } }, { $set: { status: 'needs_review' } });
    await notifyAdmins({
      type: 'subscription_needs_review',
      message: `A vendor's subscription payment arrived for the wrong amount (${formatNaira(verified.amountKobo / 100)}, the plan costs ${formatNaira(subscription.amountNaira)}). Nothing was activated; refund or investigate.`,
      dedupeKey: `sub_needs_review:${subscription._id.toString()}`,
    });
    await raise('AMOUNT_MISMATCH', 'error', 'Paystack reports a different amount than the plan costs; refund or investigate', subscription, {
      expectedKobo: subscription.amountNaira * 100,
      receivedKobo: verified.amountKobo,
      currency: verified.currency,
    });
    return 'amount_mismatch';
  }

  for (let attempt = 0; attempt < MAX_ACTIVATION_ATTEMPTS; attempt += 1) {
    // The start date is worked out from the server clock and the vendor's chain
    // of confirmed subscriptions, at the moment of confirmation:
    //   still covered -> start where the current cover ends (an early renewal
    //                    adds to it, nothing is lost)
    //   not covered   -> start now
    const paidAt = now();
    const window = await nextCoverWindow(subscription.sellerId, subscription.plan, paidAt);

    let claimed: SubscriptionDoc | null;
    try {
      claimed = await SubscriptionModel.findOneAndUpdate(
        { _id: subscription._id, status: { $in: ['pending', 'failed'] } },
        {
          $set: {
            status: 'active',
            paidAt,
            startsAt: window.startsAt,
            expiresAt: window.expiresAt,
            seq: window.seq,
            ...(window.renewalOf ? { renewalOf: window.renewalOf } : {}),
          },
        },
        { returnDocument: 'after' },
      );
    } catch (err) {
      // Another payment for this vendor took the same position a moment ago. Read
      // the chain again so this one starts after it.
      if (isDuplicateKey(err)) continue;
      throw err;
    }
    if (claimed) {
      await notifySeller(claimed.sellerId, {
        type: 'subscription_activated',
        message: `Your ${claimed.plan} subscription is active until ${claimed.expiresAt ? claimed.expiresAt.toISOString().slice(0, 10) : 'later'}. Thank you.`,
        dedupeKey: `sub_active:${claimed._id.toString()}`,
      });
    }
    return claimed ? 'activated' : 'already_processed';
  }
  throw new Error(`Could not activate subscription ${reference}: the vendor's chain kept changing`);
}
