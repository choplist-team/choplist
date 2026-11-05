import type { Types } from 'mongoose';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { recordAdminAction } from '../events/log.js';
import { OrderModel } from '../models/order.js';
import { PaymentModel } from '../models/payment.js';
import { SellerModel } from '../models/seller.js';
import { objectIdText, paginationQuery, toPagination } from './query.js';

// Refunds ChopList owes a customer. ChopList does NOT call Paystack's refund API:
// money moving back is irreversible and has never been tried against real Paystack,
// so a person refunds in the Paystack dashboard and then records it here. What this
// does is make sure nothing is forgotten.
//
// A payment needs a refund when the customer's money reached Paystack and the order
// cannot be fulfilled:
//   cancelled_after_payment  Paystack confirmed it, then the seller cancelled the order
//   money_held               the money arrived but could not be applied (the order was
//                            cancelled first, the amount was wrong, or it was paid twice)
//
// Which payments need one is worked out from the data every time, never stored when
// the order is cancelled. So a crash between "order cancelled" and "refund noted"
// cannot lose one, and the cancel route itself is untouched. The only thing stored is
// that a person dealt with it (payment.refund).
export const REFUND_KINDS = ['cancelled_after_payment', 'money_held'] as const;
export type RefundKind = (typeof REFUND_KINDS)[number];
export const REFUND_STATUSES = ['due', 'refunded'] as const;

export const REFUND_DEFINITIONS = {
  due: 'Payments where the customer\'s money is with Paystack and the order cannot go ahead, and nobody has recorded a refund yet. Each needs a person to refund it in the Paystack dashboard and then mark it refunded here.',
  cancelled_after_payment: 'Paystack confirmed the payment, then the order was cancelled.',
  money_held: 'The money arrived but could not be applied to the order: it was cancelled first, the amount was wrong, or the customer paid twice.',
  refunded: 'An admin has recorded that they refunded this payment by hand.',
} as const;

export const refundListQuery = z.object({
  status: z.enum(REFUND_STATUSES, { error: `status must be one of: ${REFUND_STATUSES.join(', ')}` }).optional(),
  ...paginationQuery,
});

export const refundMarkBody = z.object({ note: z.string().trim().max(300).optional() });

export function parseRefundId(raw: unknown): Types.ObjectId {
  const parsed = objectIdText('id').safeParse(raw);
  if (!parsed.success) throw new AppError(404, 'REFUND_NOT_FOUND', 'Refund not found');
  return parsed.data;
}

// Paystack-paid orders that have since been cancelled. Their payments are the first
// kind. (An order whose payment could not be applied keeps paymentMethod 'transfer',
// and its payment is the second kind, found by its own status.)
async function cancelledPaidOrderIds(): Promise<Types.ObjectId[]> {
  const orders = await OrderModel.find({ status: 'cancelled', paymentMethod: 'paystack' }, { _id: 1 }).lean();
  return orders.map((o) => o._id);
}

async function refundFilter(): Promise<Record<string, unknown>> {
  const ids = await cancelledPaidOrderIds();
  return { $or: [{ status: 'needs_review' }, ...(ids.length > 0 ? [{ status: 'succeeded', orderId: { $in: ids } }] : [])] };
}

type Row = {
  _id: Types.ObjectId;
  orderRef: string;
  reference: string;
  status: string;
  amountKobo: number;
  serviceFee?: number;
  createdAt: Date;
  paidAt?: Date;
  refund?: { refundedAt: Date; refundedBy: string; note?: string };
  seller?: { _id: Types.ObjectId; businessName: string; slug: string }[];
};

function toRefund(row: Record<string, any>) {
  const r = row as Row;
  const seller = r.seller?.[0];
  return {
    id: r._id.toString(),
    kind: (r.status === 'succeeded' ? 'cancelled_after_payment' : 'money_held') as RefundKind,
    status: r.refund ? ('refunded' as const) : ('due' as const),
    orderRef: r.orderRef,
    // What the customer paid, in naira (kobo / 100).
    amountNaira: r.amountKobo / 100,
    paystackReference: r.reference,
    paidAt: r.paidAt ?? null,
    createdAt: r.createdAt,
    seller: seller ? { id: seller._id.toString(), businessName: seller.businessName, slug: seller.slug } : null,
    refundedAt: r.refund?.refundedAt ?? null,
    refundedBy: r.refund?.refundedBy ?? null,
    note: r.refund?.note ?? null,
  };
}

const withSeller = [
  {
    $lookup: {
      from: SellerModel.collection.name,
      localField: 'sellerId',
      foreignField: '_id',
      pipeline: [{ $project: { businessName: 1, slug: 1 } }],
      as: 'seller',
    },
  },
];

export async function listRefunds(query: z.infer<typeof refundListQuery>) {
  const { status, page, limit } = query;
  const base = await refundFilter();
  const filter =
    status === 'refunded' ? { $and: [base, { refund: { $exists: true } }] } : status === 'due' ? { $and: [base, { refund: { $exists: false } }] } : base;

  const [rows, total, dueCount] = await Promise.all([
    PaymentModel.aggregate<Record<string, any>>([
      { $match: filter },
      // Not yet refunded first (they need action), then newest first.
      { $addFields: { sortDue: { $cond: [{ $ifNull: ['$refund', false] }, 1, 0] } } },
      { $sort: { sortDue: 1, createdAt: -1, _id: -1 } },
      { $skip: (page - 1) * limit },
      { $limit: limit },
      ...withSeller,
    ]),
    PaymentModel.countDocuments(filter),
    countRefundsDue(),
  ]);

  return { refunds: rows.map(toRefund), dueCount, definitions: REFUND_DEFINITIONS, pagination: toPagination(total, page, limit) };
}

// Used by the admin overview.
export async function countRefundsDue(): Promise<number> {
  return PaymentModel.countDocuments({ $and: [await refundFilter(), { refund: { $exists: false } }] });
}

async function loadRefund(id: Types.ObjectId) {
  const [row] = await PaymentModel.aggregate<Record<string, any>>([{ $match: { _id: id } }, ...withSeller]);
  if (!row) throw new AppError(404, 'REFUND_NOT_FOUND', 'Refund not found');
  return toRefund(row);
}

// Records that an admin refunded this payment by hand. It does NOT refund anything:
// the money moved in the Paystack dashboard. Only a payment that really needs a
// refund can be marked, so this cannot be used to annotate an ordinary payment.
// Asking again for something already done changes nothing and adds no audit entry;
// otherwise the audit entry is written FIRST and the update is conditional on there
// being no refund yet, so two admins marking it at once mark it once.
export async function markRefunded(input: { id: Types.ObjectId; adminId: string; note?: string | undefined }) {
  const { id, adminId, note } = input;
  const candidate = await PaymentModel.findOne({ $and: [{ _id: id }, await refundFilter()] }, { refund: 1 }).lean();
  if (!candidate) throw new AppError(404, 'REFUND_NOT_FOUND', 'Refund not found');
  if (candidate.refund) return loadRefund(id);

  await recordAdminAction({ adminId, action: 'refund.mark_refunded', targetId: id.toString(), ...(note ? { reason: note } : {}) });
  await PaymentModel.updateOne(
    { _id: id, refund: { $exists: false } },
    { $set: { refund: { refundedAt: new Date(), refundedBy: adminId, ...(note ? { note } : {}) } } },
  );
  return loadRefund(id);
}
