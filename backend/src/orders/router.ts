import { Router, type Request } from 'express';
import { authenticate, currentSellerId, requireSeller } from '../auth/middleware.js';
import type { AuthProvider } from '../auth/provider.js';
import { AppError } from '../errors.js';
import { OrderModel, REF_PATTERN, type OrderDoc } from '../models/order.js';
import { formatNaira, notifyAdmins } from '../notifications/service.js';
import { listQueriesForOrder, paymentQueryBody, raisePaymentQuery } from '../support/payment-query.js';
import { confirmDelivery, markOutForDelivery, resetDeliveryCode } from './delivery.js';
import { confirmationFields, orderPaymentView, paymentHistory, recordPaymentEventBestEffort } from './payment-state.js';
import { confirmDeliverySchema } from './schema.js';
import { toSellerOrder } from './seller-view.js';
import { returnStock } from './stock.js';

function orderNotFound(): AppError {
  return new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');
}

// The ref from the URL (what the seller sees in the bank transfer
// description) plus the signed-in seller. Another seller's order is a 404.
function orderFilter(req: Request) {
  const ref = String(req.params.ref ?? '').trim().toUpperCase();
  if (!REF_PATTERN.test(ref)) throw orderNotFound();
  return { ref, sellerId: currentSellerId(req) };
}

async function loadOrNotFound(filter: ReturnType<typeof orderFilter>): Promise<OrderDoc> {
  const order = await OrderModel.findOne(filter);
  if (!order) throw orderNotFound();
  return order;
}

export function createOrderRouter(auth: AuthProvider): Router {
  const router = Router();
  router.use(authenticate(auth), requireSeller);

  // pending -> paid. Idempotent: marking a paid order paid again returns it
  // unchanged (same paidAt). A cancelled order cannot be paid: its stock is
  // already back on sale.
  //
  // This is the seller CONFIRMING the money (a bank transfer): the order's payment
  // record becomes confirmed by the seller in the same write that makes it paid, and
  // a customer's earlier "I've paid" (reportedAt) is kept. Only the one request that
  // wins the pending -> paid write adds the history entry.
  router.patch('/:ref/paid', async (req, res) => {
    const filter = orderFilter(req);
    const now = new Date();
    const before = await OrderModel.findOneAndUpdate(
      { ...filter, status: 'pending' },
      { $set: { status: 'paid', paidAt: now, ...confirmationFields('seller', now) } },
      { returnDocument: 'before' },
    );
    if (before) {
      await recordPaymentEventBestEffort({
        orderId: before._id,
        orderRef: before.ref,
        from: orderPaymentView(before).status,
        to: 'confirmed',
        source: 'seller',
        eventId: `seller_confirmed:${before._id.toString()}`,
        at: now,
      });
      res.json(toSellerOrder((await OrderModel.findById(before._id)) ?? before));
      return;
    }

    const order = await loadOrNotFound(filter);
    // Already paid, or further along (so it must have been paid): nothing to do.
    if (order.status !== 'cancelled') {
      res.json(toSellerOrder(order));
      return;
    }
    throw new AppError(409, 'ORDER_CANCELLED', 'This order was cancelled and cannot be marked paid');
  });

  // paid -> out_for_delivery. Makes the code the customer will read out.
  router.patch('/:ref/out-for-delivery', async (req, res) => {
    res.json(toSellerOrder(await markOutForDelivery(orderFilter(req))));
  });

  // out_for_delivery -> delivered, with the code from the customer.
  router.patch('/:ref/confirm-delivery', async (req, res) => {
    const filter = orderFilter(req);
    const { code } = confirmDeliverySchema.parse(req.body);
    res.json(toSellerOrder(await confirmDelivery(filter, code)));
  });

  // The story of this order's money: every change, who caused it and when. Your own
  // orders only.
  router.get('/:ref/payment-history', async (req, res) => {
    const order = await loadOrNotFound(orderFilter(req));
    res.json({ ref: order.ref, payment: orderPaymentView(order), history: await paymentHistory(order._id) });
  });

  // The payment queries on this order (raised by the customer or by you), with where
  // each one stands. Your own orders only.
  router.get('/:ref/payment-queries', async (req, res) => {
    const order = await loadOrNotFound(orderFilter(req));
    res.json({ ref: order.ref, queries: await listQueriesForOrder(order._id) });
  });

  // "Something is wrong with this payment" (for example the customer says they paid
  // and no money has arrived). Recorded for ChopList to look at; it changes nothing
  // about the order or the money. The seller's own orders only.
  router.post('/:ref/payment-query', async (req, res) => {
    const order = await loadOrNotFound(orderFilter(req));
    res.status(201).json(await raisePaymentQuery(order, 'seller', paymentQueryBody.parse(req.body)));
  });

  // A new code for an order that is out for delivery (a lost code or a lockout).
  router.patch('/:ref/reset-delivery-code', async (req, res) => {
    res.json(toSellerOrder(await resetDeliveryCode(orderFilter(req))));
  });

  // pending, paid or out_for_delivery -> cancelled, and the portions go back on
  // sale. A delivered order cannot be cancelled: the food was eaten, so the
  // stock is NOT returned. Cancelling in transit also removes the code.
  //
  // The stock must come back exactly once, even if the seller taps twice or
  // two requests race. The status change is one conditional write that only
  // matches an order that is NOT yet cancelled, so only one request can win
  // it, and only the winner returns the stock. A repeat finds it already
  // cancelled and changes nothing.
  router.patch('/:ref/cancel', async (req, res) => {
    const filter = orderFilter(req);
    const cancelled = await OrderModel.findOneAndUpdate(
      { ...filter, status: { $in: ['pending', 'paid', 'out_for_delivery'] } },
      { $set: { status: 'cancelled', cancelledAt: new Date() }, $unset: { deliveryCode: '' } },
      { returnDocument: 'after' },
    );

    if (!cancelled) {
      // Not found, delivered, or already cancelled.
      const order = await loadOrNotFound(filter);
      if (order.status === 'delivered') {
        throw new AppError(409, 'ORDER_DELIVERED', 'A delivered order cannot be cancelled');
      }
      // Already cancelled: idempotent, same answer, no stock change.
      res.json(toSellerOrder(order));
      return;
    }

    // A paid online order was cancelled: the customer's money is with Paystack, so tell
    // ChopList's admins now rather than leaving it for someone to spot. (The refunds
    // list is worked out from the data either way; this only saves the looking.)
    if (cancelled.paymentMethod === 'paystack' && cancelled.paidAt) {
      await notifyAdmins({
        type: 'refund_due',
        message: `Order ${cancelled.ref} was paid online (${formatNaira(cancelled.total)}) and then cancelled by the seller. The customer needs a refund.`,
        orderRef: cancelled.ref,
        dedupeKey: `refund_due:${cancelled._id.toString()}`,
      });
    }

    // Second write: give the stock back. Known limit: if this fails (e.g. the
    // database drops between the two writes), the order is cancelled but its
    // portions stay held. Log what is needed to fix it by hand.
    const lines = cancelled.lines.map((line) => ({ itemId: line.itemId, qty: line.qty }));
    try {
      await returnStock(cancelled.menuId, lines);
    } catch (err) {
      console.error('STOCK NOT RETURNED after cancel', {
        ref: cancelled.ref,
        menuId: cancelled.menuId.toString(),
        lines: lines.map((l) => ({ itemId: l.itemId.toString(), qty: l.qty })),
        err,
      });
      throw err;
    }
    res.json(toSellerOrder(cancelled));
  });

  return router;
}
