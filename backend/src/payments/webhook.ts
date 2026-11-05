import { createHmac, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { mongo } from 'mongoose';
import { SUBSCRIPTION_REFERENCE_PATTERN } from '../billing/subscribe.js';
import { processSubscriptionCharge } from '../billing/webhook.js';
import { AppError } from '../errors.js';
import { logEvent } from '../events/log.js';
import { OrderModel } from '../models/order.js';
import { PaymentModel, type PaymentDoc } from '../models/payment.js';
import { SellerModel } from '../models/seller.js';
import { confirmationFields, orderPaymentView, recordPaymentEvent } from '../orders/payment-state.js';
import { PaystackError, type PaystackClient } from './paystack.js';

// Our own references (see newPaymentReference in pay.ts). Anything else in a
// webhook cannot be ours, so it never reaches the database.
const REFERENCE_PATTERN = /^CLP-[0-9a-f]{24}$/;

// Paystack signs the exact bytes it sends: HMAC-SHA512 with our secret key,
// hex-encoded, in the x-paystack-signature header. It must be checked against
// the RAW body. Re-serialising parsed JSON can change a single byte (spacing,
// key order, number formatting) and the signature would no longer match.
export function signatureMatches(rawBody: Buffer, signature: string | undefined, secretKey: string): boolean {
  // A SHA-512 digest is 128 hex characters; anything else is wrong before we compute.
  if (!signature || !/^[0-9a-f]{128}$/i.test(signature)) return false;
  const expected = createHmac('sha512', secretKey).update(rawBody).digest();
  const given = Buffer.from(signature, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export type WebhookOutcome =
  | 'paid' // this delivery marked the order paid
  | 'already_processed' // an earlier or concurrent delivery already did
  | 'ignored' // a payment we have already set aside or failed
  | 'unknown_reference' // signed by Paystack, but not a payment we know
  | 'not_confirmed' // Paystack does not say it succeeded
  | 'amount_mismatch' // Paystack says a different amount or currency was paid
  | 'duplicate_payment' // the order already has a successful payment
  | 'order_not_payable'; // paid for, but the order was cancelled or settled another way

type Severity = 'warn' | 'error';

async function raise(code: string, level: Severity, message: string, payment: PaymentDoc | null, meta: Record<string, unknown> = {}) {
  await logEvent({
    type: 'payment_webhook_issue',
    level,
    code,
    message,
    sellerId: payment?.sellerId,
    orderRef: payment?.orderRef,
    // Amounts and the payment reference only: no customer or bank details.
    meta: { ...meta, ...(payment ? { reference: payment.reference } : {}) },
  });
}

// The history entry for "Paystack confirmed this order's money". Its id is the Paystack
// reference, so the same payment confirmed twice is recorded once.
function paidEvent(payment: PaymentDoc, from: 'unpaid' | 'customer_reported' | 'failed' | 'confirmed') {
  return {
    orderId: payment.orderId,
    orderRef: payment.orderRef,
    from,
    to: 'confirmed' as const,
    source: 'paystack' as const,
    eventId: `paystack:${payment.reference}`,
    at: payment.paidAt ?? new Date(),
  };
}

// Paystack says the charge failed. The order stays pending and unpaid; its payment
// record says "failed" so the customer can be told to try again. A customer's own
// "I've paid" (bank transfer) is never overwritten by this, and a later success on the
// same order still confirms it.
async function markPaymentFailed(payment: PaymentDoc): Promise<void> {
  const before = await OrderModel.findOneAndUpdate(
    { _id: payment.orderId, status: 'pending', 'payment.status': { $nin: ['customer_reported', 'confirmed', 'failed'] } },
    { $set: { 'payment.status': 'failed' } },
    { returnDocument: 'before' },
  );
  if (!before) return;
  await recordPaymentEvent({
    orderId: payment.orderId,
    orderRef: payment.orderRef,
    from: orderPaymentView(before).status,
    to: 'failed',
    source: 'paystack',
    eventId: `paystack_failed:${payment.reference}`,
  });
}

function isDuplicateKey(err: unknown): boolean {
  return err instanceof mongo.MongoServerError && err.code === 11000;
}

// Marks the order paid, once. The write only matches a PENDING order, so exactly
// one caller can win it; the winner alone adds to the seller's paid-order count.
// If nobody wins, the answer depends on why:
//   - the order was already paid through Paystack: an earlier delivery (or a
//     concurrent one) did this; nothing more to do.
//   - anything else (cancelled, paid by bank transfer, gone): the customer's
//     money arrived for an order that can no longer be fulfilled. The payment is
//     set aside as needs_review for a human to refund. It is never hidden, and
//     the seller's count is not touched.
async function finishOrder(payment: PaymentDoc): Promise<WebhookOutcome> {
  const paidAt = payment.paidAt ?? new Date();
  const set: Record<string, unknown> = {
    status: 'paid',
    paidAt,
    paymentMethod: 'paystack',
    // Paystack confirmed the money: the order's payment record says so in the same
    // write, with no click from anyone. The customer's and the seller's views both
    // read this.
    ...confirmationFields('paystack', paidAt),
    platformFeeKobo: payment.platformFeeKobo,
    paystackFeeKobo: payment.paystackFeeKobo,
  };
  // The figures of THE attempt that was paid (an order can have several).
  if (payment.serviceFee !== undefined && payment.serviceFee !== null) set.serviceFee = payment.serviceFee;
  if (payment.platformFeeBps !== undefined && payment.platformFeeBps !== null) set.platformFeeBps = payment.platformFeeBps;

  const before = await OrderModel.findOneAndUpdate({ _id: payment.orderId, status: 'pending' }, { $set: set }, { returnDocument: 'before' });
  if (before) {
    // $inc is atomic, and only the one request that flipped pending -> paid gets here.
    await SellerModel.updateOne({ _id: payment.sellerId }, { $inc: { paidOrderCount: 1 } });
    await recordPaymentEvent(paidEvent(payment, orderPaymentView(before).status));
    return 'paid';
  }

  const order = await OrderModel.findById(payment.orderId, { status: 1, paymentMethod: 1 }).lean();
  if (order?.paymentMethod === 'paystack') {
    // Already paid by an earlier delivery. If that one died before writing the
    // history entry, this retry writes it; if it exists, this changes nothing (the
    // entry is identified by the Paystack reference, so it is stored once).
    await recordPaymentEvent(paidEvent(payment, 'unpaid'));
    return 'already_processed';
  }

  await PaymentModel.updateOne({ _id: payment._id, status: 'succeeded' }, { $set: { status: 'needs_review' } });
  await raise('ORDER_NOT_PAYABLE', 'error', 'A payment arrived for an order that can no longer be paid; refund it', payment, {
    orderStatus: order?.status ?? 'missing',
    amountKobo: payment.amountKobo,
  });
  return 'order_not_payable';
}

// Handles one charge.success. Safe to run any number of times for the same
// reference, in any order, at the same time: every step below is a conditional
// write that only one caller can win.
//
// Throws PaystackError('unavailable') when Paystack cannot be asked. The route
// turns that into a 5xx so Paystack delivers the event again later; nothing has
// been changed at that point.
export async function processChargeSuccess(reference: string, paystack: PaystackClient): Promise<WebhookOutcome> {
  const payment = await PaymentModel.findOne({ reference });
  if (!payment) {
    await raise('UNKNOWN_REFERENCE', 'warn', 'Paystack confirmed a payment we have no record of', null, { reference });
    return 'unknown_reference';
  }

  // Already counted. Still try to finish the order: a crash between "payment
  // recorded" and "order marked paid" is repaired by the next delivery.
  if (payment.status === 'succeeded') return finishOrder(payment);
  if (payment.status !== 'initialized') return 'ignored';

  // The webhook only tells us WHICH payment to look at. Whether it was paid, and
  // for how much, comes from asking Paystack directly.
  let verified;
  try {
    verified = await paystack.verifyTransaction(reference);
  } catch (err) {
    if (err instanceof PaystackError && err.kind === 'rejected') {
      await raise('NOT_CONFIRMED', 'warn', 'Paystack does not recognise this payment', payment, { httpStatus: err.status ?? 0 });
      return 'not_confirmed';
    }
    throw err;
  }
  if (verified.status !== 'success' || verified.reference !== reference) {
    if (verified.status === 'failed' && verified.reference === reference) await markPaymentFailed(payment);
    await raise('NOT_CONFIRMED', 'warn', 'Paystack does not report this payment as successful', payment, { paystackStatus: verified.status });
    return 'not_confirmed';
  }
  if (verified.currency !== payment.currency || verified.amountKobo !== payment.amountKobo) {
    await PaymentModel.updateOne({ _id: payment._id, status: 'initialized' }, { $set: { status: 'needs_review' } });
    await raise('AMOUNT_MISMATCH', 'error', 'Paystack reports a different amount than we asked for', payment, {
      expectedKobo: payment.amountKobo,
      receivedKobo: verified.amountKobo,
      currency: verified.currency,
    });
    return 'amount_mismatch';
  }

  // The claim: initialized -> succeeded, won by exactly one delivery. The partial
  // unique index on succeeded payments additionally refuses a second successful
  // payment for the same order, even from a different attempt.
  let claimed: PaymentDoc | null;
  try {
    claimed = await PaymentModel.findOneAndUpdate(
      { _id: payment._id, status: 'initialized' },
      { $set: { status: 'succeeded', paidAt: new Date() } },
      { returnDocument: 'after' },
    );
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    await PaymentModel.updateOne({ _id: payment._id, status: 'initialized' }, { $set: { status: 'needs_review' } });
    await raise('DUPLICATE_PAYMENT', 'error', 'The customer paid an order that already has a successful payment; refund one', payment, {
      amountKobo: payment.amountKobo,
    });
    return 'duplicate_payment';
  }
  if (!claimed) return 'already_processed'; // another delivery claimed it a moment ago

  return finishOrder(claimed);
}

// The route. Mounted in app.ts BEFORE express.json, with express.raw on this
// route only, so req.body here is the untouched Buffer the signature covers.
export function createWebhookHandler(options: { secretKey: string | null; paystack: PaystackClient | null }): RequestHandler {
  return async (req, res) => {
    const { secretKey, paystack } = options;
    if (!secretKey || !paystack) throw new AppError(503, 'PAYMENTS_UNAVAILABLE', 'Payments are not enabled');

    // Nothing in the body is looked at, let alone trusted, until this passes.
    const raw: unknown = req.body;
    if (!Buffer.isBuffer(raw) || !signatureMatches(raw, req.get('x-paystack-signature'), secretKey)) {
      throw new AppError(401, 'INVALID_SIGNATURE', 'Invalid signature');
    }

    // From here the sender is Paystack. Anything we do not act on is still
    // answered 200: an error status only makes Paystack resend the same thing.
    let event: unknown;
    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch {
      res.json({ received: true });
      return;
    }
    const body = typeof event === 'object' && event !== null ? (event as { event?: unknown; data?: { reference?: unknown } }) : {};
    const reference = body.data?.reference;
    // Our two kinds of payment tell themselves apart by the reference's prefix: a
    // customer paying for an order ("CLP-") and a vendor paying for a plan ("CLS-").
    // The prefix is ours, chosen when the payment was started; the metadata we also
    // send is not relied on, because the reply Paystack gives when we verify does not
    // carry it.
    const isSubscription = typeof reference === 'string' && SUBSCRIPTION_REFERENCE_PATTERN.test(reference);
    const isOrder = typeof reference === 'string' && REFERENCE_PATTERN.test(reference);
    if (body.event !== 'charge.success' || typeof reference !== 'string' || !(isOrder || isSubscription)) {
      res.json({ received: true });
      return;
    }

    try {
      if (isSubscription) await processSubscriptionCharge(reference, paystack);
      else await processChargeSuccess(reference, paystack);
    } catch (err) {
      if (!(err instanceof PaystackError)) throw err; // a bug or a database failure: 500, Paystack resends
      // We could not ask Paystack. Nothing was changed, so ask for a resend.
      await logEvent({
        type: 'payment_webhook_issue',
        level: 'error',
        code: 'VERIFY_FAILED',
        message: 'Could not verify a Paystack payment; waiting for Paystack to resend',
        meta: { httpStatus: err.status ?? 0, reason: err.message },
      });
      throw new AppError(503, 'PAYMENTS_UNAVAILABLE', 'Could not verify the payment right now');
    }
    res.json({ received: true });
  };
}
