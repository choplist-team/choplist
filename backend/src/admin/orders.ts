import { Types, type PipelineStage } from 'mongoose';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { recordAdminAction } from '../events/log.js';
import { MenuModel } from '../models/menu.js';
import { OrderModel, REF_PATTERN, orderPaymentMethod } from '../models/order.js';
import { PaymentModel } from '../models/payment.js';
import { SellerModel } from '../models/seller.js';
import { DUPLICATE_WINDOW_MS } from '../orders/fingerprint.js';
import { orderPaymentView, paymentHistory } from '../orders/payment-state.js';
import { statusFilterSchema } from '../orders/status-filter.js';
import { dateRangeFilter, dateRangeQuery, escapeRegex, maskPhone, objectIdText, paginationQuery, toPagination } from './query.js';

// ---- Payment status -----------------------------------------------------------
// The SELLER confirms payment by hand after seeing the bank transfer; ChopList
// never handles money and cannot check it. So this is "the seller says it is
// paid", and the response says so (paymentConfirmedBy).
//   unpaid               not confirmed yet
//   paid                 confirmed (and the order is going ahead or done)
//   paid_then_cancelled  confirmed, then the order was cancelled: a refund may be owed
function paymentStatus(order: { paidAt?: Date | null; status: string }) {
  if (!order.paidAt) return 'unpaid' as const;
  return order.status === 'cancelled' ? ('paid_then_cancelled' as const) : ('paid' as const);
}

// "Failed" in the orders list means: placed, but never paid, and the menu's
// cut-off has passed, so it can no longer be paid or fulfilled in practice.
// (An order that could not be PLACED does not exist; those are in the event log.)
function isFailed(order: { status: string }, menu: { cutoffAt: Date } | null | undefined, now: Date) {
  return order.status === 'pending' && Boolean(menu) && menu!.cutoffAt <= now;
}

const FLAGS = ['duplicate', 'failed', 'cancelled'] as const;

export const orderListQuery = z.object({
  // Exact reference or the start of one ("CL-7K"), any case.
  ref: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{2,12}$/, 'ref looks like CL-7KQ2M (or the first few characters of it)')
    .optional(),
  sellerId: objectIdText('sellerId').optional(),
  status: statusFilterSchema,
  flag: z.enum(FLAGS, { error: `flag must be one of: ${FLAGS.join(', ')}` }).optional(),
  ...dateRangeQuery,
  ...paginationQuery,
});
type OrderListQuery = z.infer<typeof orderListQuery>;

export async function listOrders(query: OrderListQuery, now: Date = new Date()) {
  const { ref, sellerId, status, flag, page, limit } = query;
  const createdAt = dateRangeFilter(query);

  const and: Record<string, unknown>[] = [];
  if (ref) and.push({ ref: new RegExp(`^${escapeRegex(ref)}`) }); // anchored prefix: can use the ref index
  if (sellerId) and.push({ sellerId });
  if (createdAt) and.push({ createdAt });
  if (status) and.push({ status: { $in: status } });
  if (flag === 'duplicate') and.push({ possibleDuplicate: true });
  if (flag === 'cancelled') and.push({ status: 'cancelled' });
  if (flag === 'failed') and.push({ status: 'pending' });
  const match = and.length > 0 ? { $and: and } : {};

  const menuLookup: PipelineStage = {
    $lookup: {
      from: MenuModel.collection.name,
      localField: 'menuId',
      foreignField: '_id',
      pipeline: [{ $project: { title: 1, cutoffAt: 1 } }],
      as: 'menu',
    },
  };

  // "failed" needs the menu's cut-off to decide, so it is joined before paging.
  // Otherwise the join happens after the page is cut, for at most `limit` rows.
  const failedOnly = flag === 'failed';
  const beforePaging: PipelineStage[] = failedOnly
    ? [menuLookup, { $match: { 'menu.cutoffAt': { $lte: now } } }]
    : [];

  const [result] = await OrderModel.aggregate<{
    rows: Record<string, any>[];
    total: { n: number }[];
  }>([
    { $match: match },
    ...beforePaging,
    { $sort: { createdAt: -1, _id: -1 } },
    {
      $facet: {
        total: [{ $count: 'n' }],
        rows: [
          { $skip: (page - 1) * limit },
          { $limit: limit },
          // An aggregation returns whatever fields it is given and IGNORES the
          // model's select:false. So say exactly which fields may leave the
          // database: never the delivery code, the key hash or the fingerprint.
          {
            $project: {
              ref: 1,
              status: 1,
              total: 1,
              createdAt: 1,
              paidAt: 1,
              possibleDuplicate: 1,
              sellerId: 1,
              menuId: 1,
              menu: 1,
              'customer.name': 1,
              'customer.phone': 1,
              'delivery.area': 1,
              'delivery.day': 1,
              portions: { $sum: '$lines.qty' },
            },
          },
          ...(failedOnly ? [] : [menuLookup]),
          {
            $lookup: {
              from: SellerModel.collection.name,
              localField: 'sellerId',
              foreignField: '_id',
              pipeline: [{ $project: { businessName: 1, slug: 1 } }],
              as: 'seller',
            },
          },
        ],
      },
    },
  ]);

  const total = result?.total[0]?.n ?? 0;
  const orders = (result?.rows ?? []).map((row) => {
    const menu = row.menu?.[0] as { _id: Types.ObjectId; title: string; cutoffAt: Date } | undefined;
    const seller = row.seller?.[0] as { _id: Types.ObjectId; businessName: string; slug: string } | undefined;
    return {
      ref: row.ref as string,
      status: row.status as string,
      total: row.total as number,
      portions: row.portions as number,
      paymentStatus: paymentStatus(row as { paidAt?: Date | null; status: string }),
      paymentConfirmedBy: 'seller' as const,
      createdAt: row.createdAt as Date,
      paidAt: (row.paidAt as Date | undefined) ?? null,
      seller: seller ? { id: seller._id.toString(), businessName: seller.businessName, slug: seller.slug } : null,
      menu: menu ? { id: menu._id.toString(), title: menu.title, cutoffAt: menu.cutoffAt } : null,
      customer: { name: row.customer.name as string, phone: maskPhone(row.customer.phone as string) },
      delivery: { area: row.delivery.area as string, day: row.delivery.day as string },
      flags: {
        possibleDuplicate: row.possibleDuplicate === true,
        cancelled: row.status === 'cancelled',
        failed: isFailed(row as { status: string }, menu, now),
      },
    };
  });

  return { orders, pagination: toPagination(total, page, limit) };
}

// ---- One order ----------------------------------------------------------------
export const orderDetailQuery = z.object({
  reveal: z
    .enum(['true', 'false'], { error: 'reveal must be true or false' })
    .optional()
    .transform((value) => value === 'true'),
});

function orderNotFound(): AppError {
  return new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');
}

// The order as an admin may see it. Built field by field (never by spreading the
// document), so the delivery code, the access key hash and the fingerprint cannot
// appear here even by accident. The full phone number, the address and the note
// come only with reveal=true, and the reveal is written to the audit trail
// BEFORE they are returned: if the audit entry cannot be saved, nothing is shown.
export async function orderDetail(input: { ref: string; reveal: boolean; adminId: string }, now: Date = new Date()) {
  const ref = input.ref.trim().toUpperCase();
  if (!REF_PATTERN.test(ref)) throw orderNotFound();

  const order = await OrderModel.findOne({ ref }).lean();
  if (!order) throw orderNotFound();

  if (input.reveal) {
    await recordAdminAction({ adminId: input.adminId, action: 'order.reveal_phone', targetId: ref });
  }

  const [seller, menu, similar, history, attempts] = await Promise.all([
    SellerModel.findById(order.sellerId, { businessName: 1, slug: 1 }).lean(),
    MenuModel.findById(order.menuId, { title: 1, cutoffAt: 1 }).lean(),
    order.fingerprint
      ? OrderModel.find(
          {
            fingerprint: order.fingerprint,
            _id: { $ne: order._id },
            createdAt: {
              $gte: new Date(order.createdAt.getTime() - DUPLICATE_WINDOW_MS),
              $lte: new Date(order.createdAt.getTime() + DUPLICATE_WINDOW_MS),
            },
          },
          { ref: 1, status: 1, createdAt: 1 },
        )
          .sort({ createdAt: 1 })
          .limit(5)
          .lean()
      : [],
    paymentHistory(order._id),
    // Every Paystack attempt on this order, newest first. Never the seller's payout
    // account code or anything about the customer.
    PaymentModel.find({ orderId: order._id }).sort({ createdAt: -1, _id: -1 }).limit(20).lean(),
  ]);

  return {
    ref: order.ref,
    status: order.status,
    total: order.total,
    paymentStatus: paymentStatus(order),
    paymentConfirmedBy: 'seller' as const,
    // The order's payment record (see docs/api.md, Order payment state), how it is
    // paid, and why it was cancelled if the seller did not do it.
    paymentMethod: orderPaymentMethod(order),
    payment: orderPaymentView(order),
    cancelReason: order.cancelReason ?? null,
    // What changed, when, and who caused it (customer, seller or paystack), oldest first.
    paymentHistory: history,
    // The Paystack payments on this order. amounts are naira. refund is set once an
    // admin has recorded refunding it by hand (see /api/admin/refunds).
    onlinePayments: attempts.map((p) => ({
      reference: p.reference,
      status: p.status,
      amountNaira: p.amountKobo / 100,
      serviceFee: p.serviceFee ?? 0,
      platformFeeNaira: p.platformFeeKobo / 100,
      paystackFeeEstimateNaira: p.paystackFeeKobo / 100,
      feePayer: p.bearer === 'subaccount' ? ('seller' as const) : ('customer' as const),
      createdAt: p.createdAt,
      paidAt: p.paidAt ?? null,
      refund: p.refund ? { refundedAt: p.refund.refundedAt, refundedBy: p.refund.refundedBy, note: p.refund.note ?? null } : null,
    })),
    seller: seller ? { id: seller._id.toString(), businessName: seller.businessName, slug: seller.slug } : null,
    menu: menu ? { id: menu._id.toString(), title: menu.title, cutoffAt: menu.cutoffAt } : null,
    lines: order.lines.map((line) => ({ name: line.name, unitPrice: line.unitPrice, qty: line.qty })),
    customer: { name: order.customer.name, phone: input.reveal ? order.customer.phone : maskPhone(order.customer.phone) },
    delivery: {
      area: order.delivery.area,
      day: order.delivery.day,
      ...(input.reveal ? { address: order.delivery.address } : {}),
    },
    ...(input.reveal ? { note: order.note ?? null } : {}),
    revealed: input.reveal,
    timeline: {
      createdAt: order.createdAt,
      paidAt: order.paidAt ?? null,
      outForDeliveryAt: order.outForDeliveryAt ?? null,
      deliveredAt: order.deliveredAt ?? null,
      cancelledAt: order.cancelledAt ?? null,
    },
    flags: {
      possibleDuplicate: order.possibleDuplicate === true,
      cancelled: order.status === 'cancelled',
      failed: isFailed(order, menu, now),
    },
    // Other orders with the same customer, menu and items within 10 minutes.
    similarOrders: similar.map((other) => ({ ref: other.ref, status: other.status, createdAt: other.createdAt })),
  };
}
