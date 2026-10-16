import { Router, type Request } from 'express';
import { z } from 'zod';
import { authenticate, currentSellerId, requireSeller } from '../auth/middleware.js';
import type { AuthProvider } from '../auth/provider.js';
import { AppError } from '../errors.js';
import { OrderModel, REF_PATTERN, type OrderDoc } from '../models/order.js';
import {
  CODE_PATTERN,
  MAX_CODE_ATTEMPTS,
  MAX_CODE_RESETS,
  codesMatch,
  generateDeliveryCode,
} from './delivery.js';
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

const confirmBody = z.object({
  code: z.string().trim().regex(CODE_PATTERN, 'Enter the 6-digit delivery code'),
});

export function createOrderRouter(auth: AuthProvider): Router {
  const router = Router();
  router.use(authenticate(auth), requireSeller);

  // pending -> paid. Idempotent: marking a paid order paid again returns it
  // unchanged (same paidAt). A cancelled order cannot be paid: its stock is
  // already back on sale.
  router.patch('/:ref/paid', async (req, res) => {
    const filter = orderFilter(req);
    const paid = await OrderModel.findOneAndUpdate(
      { ...filter, status: 'pending' },
      { $set: { status: 'paid', paidAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (paid) {
      res.json(toSellerOrder(paid));
      return;
    }

    const order = await loadOrNotFound(filter);
    if (order.status !== 'cancelled') {
      // Already paid, out for delivery or delivered: nothing to change.
      res.json(toSellerOrder(order));
      return;
    }
    throw new AppError(409, 'ORDER_CANCELLED', 'This order was cancelled and cannot be marked paid');
  });

  // paid -> out_for_delivery, and a fresh 6-digit code is made for the customer.
  // The status change is one conditional write, so two taps can't make two
  // codes. Idempotent: repeating it on an order already out for delivery (or
  // delivered) returns it unchanged and keeps the same code.
  router.patch('/:ref/out-for-delivery', async (req, res) => {
    const filter = orderFilter(req);
    const started = await OrderModel.findOneAndUpdate(
      { ...filter, status: 'paid' },
      {
        $set: {
          status: 'out_for_delivery',
          outForDeliveryAt: new Date(),
          deliveryCode: generateDeliveryCode(),
          codeAttempts: 0,
        },
      },
      { returnDocument: 'after' },
    );
    if (started) {
      res.json(toSellerOrder(started));
      return;
    }

    const order = await loadOrNotFound(filter);
    if (order.status === 'out_for_delivery' || order.status === 'delivered') {
      res.json(toSellerOrder(order));
      return;
    }
    if (order.status === 'cancelled') {
      throw new AppError(409, 'ORDER_CANCELLED', 'This order was cancelled');
    }
    throw new AppError(409, 'ORDER_NOT_PAID', 'Mark the order as paid before sending it out for delivery');
  });

  // out_for_delivery -> delivered, when the seller types the customer's code.
  //
  // An attempt is counted BEFORE the code is checked, in one conditional write
  // that only matches while attempts remain. That way, parallel guesses can't
  // sneak past the limit: each one reserves its own attempt first.
  router.patch('/:ref/confirm-delivery', async (req, res) => {
    const { code } = confirmBody.parse(req.body);
    const filter = orderFilter(req);

    const attempt = await OrderModel.findOneAndUpdate(
      { ...filter, status: 'out_for_delivery', codeAttempts: { $lt: MAX_CODE_ATTEMPTS } },
      { $inc: { codeAttempts: 1 } },
      { returnDocument: 'after' },
    ).select('+deliveryCode');

    if (!attempt) {
      const order = await loadOrNotFound(filter);
      if (order.status === 'delivered') {
        res.json(toSellerOrder(order));
        return;
      }
      if (order.status === 'out_for_delivery') {
        throw new AppError(429, 'DELIVERY_CODE_LOCKED', 'Too many wrong codes for this order. Contact support.');
      }
      throw new AppError(409, 'NOT_OUT_FOR_DELIVERY', 'This order is not out for delivery');
    }

    if (!attempt.deliveryCode || !codesMatch(code, attempt.deliveryCode)) {
      const left = MAX_CODE_ATTEMPTS - attempt.codeAttempts;
      throw new AppError(
        400,
        'WRONG_DELIVERY_CODE',
        left > 0 ? `Wrong code. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Wrong code. No tries left.',
      );
    }

    const delivered = await OrderModel.findOneAndUpdate(
      { _id: attempt._id, status: 'out_for_delivery' },
      { $set: { status: 'delivered', deliveredAt: new Date() }, $unset: { deliveryCode: '' } },
      { returnDocument: 'after' },
    );
    res.json(toSellerOrder(delivered ?? (await loadOrNotFound(filter))));
  });

  // out_for_delivery -> out_for_delivery with a NEW code and the wrong-guess
  // counter back to 0. This is how a locked order is freed, or how a seller
  // asks for a fresh code if the customer lost theirs.
  //
  // One conditional write that only matches while resets remain, so ten taps
  // at once still use at most MAX_CODE_RESETS. The response never contains the
  // code: only the customer may see it. ($exists: false covers orders that
  // went out for delivery before this field existed.)
  router.patch('/:ref/reset-delivery-code', async (req, res) => {
    const filter = orderFilter(req);
    const reset = await OrderModel.findOneAndUpdate(
      {
        ...filter,
        status: 'out_for_delivery',
        $or: [{ codeResets: { $lt: MAX_CODE_RESETS } }, { codeResets: { $exists: false } }],
      },
      {
        $set: { deliveryCode: generateDeliveryCode(), codeAttempts: 0 },
        $inc: { codeResets: 1 },
      },
      { returnDocument: 'after' },
    );
    if (reset) {
      res.json(toSellerOrder(reset));
      return;
    }

    const order = await loadOrNotFound(filter);
    if (order.status === 'out_for_delivery') {
      throw new AppError(
        409,
        'DELIVERY_RESET_LIMIT',
        'This order has used all its code resets. Contact support.',
      );
    }
    throw new AppError(409, 'NOT_OUT_FOR_DELIVERY', 'This order is not out for delivery');
  });

  // pending or paid -> cancelled, and the portions go back on sale.
  // Once an order is out for delivery it can no longer be cancelled here.
  //
  // The stock must come back exactly once, even if the seller taps twice or
  // two requests race. The status change is one conditional write that only
  // matches an order that is NOT yet cancelled, so only one request can win
  // it, and only the winner returns the stock. A repeat finds it already
  // cancelled and changes nothing.
  router.patch('/:ref/cancel', async (req, res) => {
    const filter = orderFilter(req);
    const cancelled = await OrderModel.findOneAndUpdate(
      { ...filter, status: { $in: ['pending', 'paid'] } },
      { $set: { status: 'cancelled', cancelledAt: new Date() } },
      { returnDocument: 'after' },
    );

    if (!cancelled) {
      // Not found, already cancelled, or already out for delivery / delivered
      // (idempotent: same answer, no stock change).
      res.json(toSellerOrder(await loadOrNotFound(filter)));
      return;
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
