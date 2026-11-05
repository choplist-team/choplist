import type { Types } from 'mongoose';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { recordAdminAction } from '../events/log.js';
import { notifySeller } from '../notifications/service.js';
import { OrderModel } from '../models/order.js';
import { PaymentQueryModel, QUERY_STATUSES } from '../models/payment-query.js';
import { SellerModel } from '../models/seller.js';
import { orderPaymentView } from '../orders/payment-state.js';
import { objectIdText, paginationQuery, toPagination } from './query.js';

export const paymentQueryListQuery = z.object({
  status: z.enum(QUERY_STATUSES, { error: `status must be one of: ${QUERY_STATUSES.join(', ')}` }).optional(),
  ...paginationQuery,
});

export const paymentQueryResolveBody = z.object({ note: z.string().trim().max(300).optional() });

export function parsePaymentQueryId(raw: unknown): Types.ObjectId {
  const parsed = objectIdText('id').safeParse(raw);
  if (!parsed.success) throw new AppError(404, 'PAYMENT_QUERY_NOT_FOUND', 'Payment query not found');
  return parsed.data;
}

// Joins the seller and the order, so the admin sees what the order looks like NOW
// (is it paid? by whom?) next to what was said. Never the customer's name, phone or
// address: the order reference is enough to find them where that is allowed.
function withContext(match: Record<string, unknown>) {
  return [
    { $match: match },
    {
      $lookup: {
        from: SellerModel.collection.name,
        localField: 'sellerId',
        foreignField: '_id',
        pipeline: [{ $project: { businessName: 1, slug: 1 } }],
        as: 'seller',
      },
    },
    {
      $lookup: {
        from: OrderModel.collection.name,
        localField: 'orderId',
        foreignField: '_id',
        pipeline: [{ $project: { status: 1, total: 1, paymentMethod: 1, payment: 1, paidAt: 1 } }],
        as: 'order',
      },
    },
  ];
}

type QueryRow = {
  _id: Types.ObjectId;
  orderRef: string;
  raisedBy: string;
  reason: string;
  message: string;
  status: string;
  resolvedBy?: string;
  resolvedAt?: Date;
  resolutionNote?: string;
  createdAt: Date;
  seller?: { _id: Types.ObjectId; businessName: string; slug: string }[];
  order?: { status: string; total: number; paymentMethod?: string; payment?: Record<string, any>; paidAt?: Date }[];
};

function toAdminQuery(row: Record<string, any>) {
  const r = row as QueryRow;
  const seller = r.seller?.[0];
  const order = r.order?.[0];
  return {
    id: r._id.toString(),
    status: r.status,
    createdAt: r.createdAt,
    orderRef: r.orderRef,
    raisedBy: r.raisedBy,
    reason: r.reason,
    message: r.message,
    seller: seller ? { id: seller._id.toString(), businessName: seller.businessName, slug: seller.slug } : null,
    // The order as it stands now, so the admin can see whether the problem has
    // already been fixed.
    order: order
      ? {
          status: order.status,
          total: order.total,
          paymentMethod: order.paymentMethod === 'paystack' ? 'paystack' : 'transfer',
          payment: orderPaymentView({ status: order.status, paidAt: order.paidAt, paymentMethod: order.paymentMethod, payment: order.payment }),
        }
      : null,
    resolvedBy: r.resolvedBy ?? null,
    resolvedAt: r.resolvedAt ?? null,
    resolutionNote: r.resolutionNote ?? null,
  };
}

export async function listPaymentQueries(query: z.infer<typeof paymentQueryListQuery>) {
  const { status, page, limit } = query;
  const filter = status ? { status } : {};

  const [rows, total, openCount] = await Promise.all([
    PaymentQueryModel.aggregate<Record<string, any>>([
      { $match: filter },
      // Open ones first (they need action), then newest first.
      { $addFields: { sortOpen: { $cond: [{ $eq: ['$status', 'open'] }, 0, 1] } } },
      { $sort: { sortOpen: 1, createdAt: -1, _id: -1 } },
      { $skip: (page - 1) * limit },
      { $limit: limit },
      ...withContext({}).slice(1),
    ]),
    PaymentQueryModel.countDocuments(filter),
    PaymentQueryModel.countDocuments({ status: 'open' }),
  ]);

  return { queries: rows.map(toAdminQuery), openCount, pagination: toPagination(total, page, limit) };
}

async function loadQuery(id: Types.ObjectId) {
  const [row] = await PaymentQueryModel.aggregate<Record<string, any>>(withContext({ _id: id }));
  if (!row) throw new AppError(404, 'PAYMENT_QUERY_NOT_FOUND', 'Payment query not found');
  return toAdminQuery(row);
}

// open -> resolved. Resolving records that someone dealt with it; it does not pay,
// refund or change the order (that is done where the money is: Paystack, or the
// seller marking a transfer paid). Asking again for something already done changes
// nothing and adds no audit entry; otherwise the audit entry is written FIRST and the
// update is conditional on the query still being open, so two admins resolve it once.
export async function resolvePaymentQuery(input: { id: Types.ObjectId; adminId: string; note?: string | undefined }) {
  const { id, adminId, note } = input;
  const current = await PaymentQueryModel.findById(id, { status: 1, sellerId: 1, orderRef: 1 }).lean();
  if (!current) throw new AppError(404, 'PAYMENT_QUERY_NOT_FOUND', 'Payment query not found');
  if (current.status === 'resolved') return loadQuery(id);

  await recordAdminAction({ adminId, action: 'payment_query.resolve', targetId: id.toString(), ...(note ? { reason: note } : {}) });
  await PaymentQueryModel.updateOne(
    { _id: id, status: 'open' },
    { $set: { status: 'resolved', resolvedBy: adminId, resolvedAt: new Date(), ...(note ? { resolutionNote: note } : {}) } },
  );
  // Tell the seller the order is theirs (the customer has no inbox; they see it on their
  // payment-queries page). A repeat or a lost race is the same notification, stored once.
  await notifySeller(current.sellerId, {
    type: 'payment_query_resolved',
    message: `ChopList has looked at the payment problem on order ${current.orderRef}.${note ? ` Note: ${note}` : ''}`,
    orderRef: current.orderRef,
    dedupeKey: `query_resolved:${id.toString()}`,
  });
  return loadQuery(id);
}
