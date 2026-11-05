import { logEvent } from '../events/log.js';
import { OrderModel } from '../models/order.js';
import { PaymentModel } from '../models/payment.js';
import { returnStock } from './stock.js';

// An order that was never paid keeps its portions off sale until someone cancels it.
// This cancels the ones nobody paid for, after `olderThanHours`, and puts the portions
// back on sale, using the same atomic steps as a seller cancelling.
//
// It is careful, because cancelling a real customer's order is worse than holding stock:
//  - an order where the customer said they paid by transfer is never touched (the seller
//    still has to look at the bank);
//  - an order with money from Paystack (confirmed, or set aside for review) is never
//    touched, and neither is one where a Paystack payment was started in the last
//    `PAYING_GRACE_MS` (the customer may be on Paystack's page right now);
//  - the write that cancels only matches an order that is STILL pending and unreported,
//    so a payment confirmed a moment before wins. If a payment is confirmed a moment
//    AFTER, the webhook finds the order cancelled and sets the money aside for refund
//    (docs/api.md, Refunds), as it would for a seller's cancellation.
export const PAYING_GRACE_MS = 2 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
// A sweep handles this many at a time; the next one picks up the rest.
const BATCH = 200;

export type ExpireResult = {
  // Unpaid orders older than the cut-off (before the checks above).
  candidates: number;
  // Cancelled by this run (always 0 on a dry run).
  expired: number;
  // Would be cancelled (counted on a dry run; equals expired when applied).
  wouldExpire: number;
  // Left alone because money or a payment in progress was found.
  skipped: number;
};

export async function expireUnpaidOrders(options: { olderThanHours: number; apply: boolean; now?: Date }): Promise<ExpireResult> {
  const { olderThanHours, apply } = options;
  const now = options.now ?? new Date();
  const result: ExpireResult = { candidates: 0, expired: 0, wouldExpire: 0, skipped: 0 };
  if (olderThanHours <= 0) return result;

  const cutoff = new Date(now.getTime() - olderThanHours * HOUR_MS);
  // Still pending, and the customer has not said they paid. A missing payment record
  // (an order from before it existed) counts as unpaid.
  const unpaid = { status: 'pending', 'payment.status': { $nin: ['customer_reported', 'confirmed'] } } as const;

  const candidates = await OrderModel.find({ ...unpaid, createdAt: { $lt: cutoff } }, { ref: 1, menuId: 1, lines: 1 })
    .sort({ createdAt: 1 })
    .limit(BATCH)
    .lean();
  result.candidates = candidates.length;

  for (const order of candidates) {
    const inFlight = await PaymentModel.exists({
      orderId: order._id,
      $or: [{ status: { $in: ['succeeded', 'needs_review'] } }, { status: 'initialized', createdAt: { $gte: new Date(now.getTime() - PAYING_GRACE_MS) } }],
    });
    if (inFlight) {
      result.skipped += 1;
      continue;
    }

    if (!apply) {
      result.wouldExpire += 1;
      continue;
    }

    const cancelled = await OrderModel.findOneAndUpdate(
      { _id: order._id, ...unpaid },
      { $set: { status: 'cancelled', cancelledAt: now, cancelReason: 'expired' }, $unset: { deliveryCode: '' } },
      { returnDocument: 'after' },
    );
    if (!cancelled) {
      result.skipped += 1; // paid, reported or cancelled in the meantime
      continue;
    }
    result.expired += 1;
    result.wouldExpire += 1;

    // Give the portions back, exactly once (only the request that won the write above
    // gets here). If this fails the order stays cancelled with its portions held, the
    // same known limit as a seller's cancel: log what is needed to fix it by hand.
    const lines = cancelled.lines.map((line) => ({ itemId: line.itemId, qty: line.qty }));
    try {
      await returnStock(cancelled.menuId, lines);
    } catch (err) {
      console.error('STOCK NOT RETURNED after expiry', {
        ref: cancelled.ref,
        menuId: cancelled.menuId.toString(),
        lines: lines.map((l) => ({ itemId: l.itemId.toString(), qty: l.qty })),
        err,
      });
    }
  }

  if (result.expired > 0) {
    await logEvent({
      type: 'orders_expired',
      level: 'info',
      code: 'ORDERS_EXPIRED',
      message: `${result.expired} unpaid order(s) were cancelled and their portions put back on sale`,
      meta: { expired: result.expired, olderThanHours },
    });
  }
  return result;
}

// Runs the sweep on a timer inside the server. Safe with more than one server running:
// the cancelling write only matches an order that is still pending, so each order is
// expired once. A failed sweep is logged and the next one tries again.
export function startExpirySweep(olderThanHours: number, everyMs = 15 * 60 * 1000): { stop(): void } | null {
  if (olderThanHours <= 0) return null;
  const run = async () => {
    try {
      await expireUnpaidOrders({ olderThanHours, apply: true });
    } catch (err) {
      console.error('Order expiry sweep failed', err instanceof Error ? err.name : err);
    }
  };
  // The first run is a minute after start, not during start-up.
  const first = setTimeout(run, 60_000);
  const timer = setInterval(run, everyMs);
  first.unref();
  timer.unref();
  return {
    stop() {
      clearTimeout(first);
      clearInterval(timer);
    },
  };
}
