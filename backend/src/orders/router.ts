import { Router, type Request } from 'express';
import { authenticate, currentSellerId, requireSeller } from '../auth/middleware.js';
import type { AuthProvider } from '../auth/provider.js';
import { AppError } from '../errors.js';
import { OrderModel, REF_PATTERN, type OrderDoc } from '../models/order.js';
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
    if (order.status === 'paid') {
      res.json(toSellerOrder(order));
      return;
    }
    throw new AppError(409, 'ORDER_CANCELLED', 'This order was cancelled and cannot be marked paid');
  });

  // pending or paid -> cancelled, and the portions go back on sale.
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
      // Not found, or already cancelled (idempotent: same answer, no stock change).
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
