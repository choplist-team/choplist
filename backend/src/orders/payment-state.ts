import { mongo, type Types } from 'mongoose';
import { AppError } from '../errors.js';
import { OrderModel, type OrderDoc, type OrderPaymentStatus, type PaymentConfirmer } from '../models/order.js';
import { OrderPaymentEventModel, type PaymentEventSource } from '../models/order-payment-event.js';

// An order's order-status values that mean its money has been confirmed.
const PAID_ORDER_STATUSES = new Set(['paid', 'out_for_delivery', 'delivered']);

export type OrderPaymentView = {
  status: OrderPaymentStatus;
  // When the customer said they had paid (bank transfer only), else null.
  reportedAt: Date | null;
  // When the money was confirmed, and by whom: 'seller' (bank transfer) or
  // 'paystack' (online). Null until then.
  confirmedAt: Date | null;
  confirmedBy: PaymentConfirmer | null;
};

type PaymentReadable = {
  status: string;
  paidAt?: Date | null | undefined;
  paymentMethod?: string | null | undefined;
  payment?: {
    status?: string | null | undefined;
    reportedAt?: Date | null | undefined;
    confirmedAt?: Date | null | undefined;
    confirmedBy?: string | null | undefined;
  } | null | undefined;
};

// THE way to read an order's payment state, for every response. Two cases are worked
// out here rather than trusted from the stored value:
//  - an order from before this field existed has none, and
//  - an order whose STATUS says it is paid is shown as confirmed whatever the stored
//    value says, so a view can never disagree with the status that delivery and the
//    prep sheet already use.
// A cancelled order that was paid stays "confirmed": the money was confirmed, and
// cancelling does not undo that (it also does not refund it; see docs/api.md).
export function orderPaymentView(order: PaymentReadable): OrderPaymentView {
  const stored = order.payment;
  const paid = PAID_ORDER_STATUSES.has(order.status) || (order.status === 'cancelled' && Boolean(order.paidAt));

  if (paid && stored?.status !== 'confirmed') {
    return {
      status: 'confirmed',
      reportedAt: stored?.reportedAt ?? null,
      confirmedAt: stored?.confirmedAt ?? order.paidAt ?? null,
      confirmedBy: asConfirmer(stored?.confirmedBy) ?? (order.paymentMethod === 'paystack' ? 'paystack' : 'seller'),
    };
  }
  return {
    status: asStatus(stored?.status) ?? 'unpaid',
    reportedAt: stored?.reportedAt ?? null,
    confirmedAt: stored?.confirmedAt ?? null,
    confirmedBy: asConfirmer(stored?.confirmedBy),
  };
}

function asStatus(value: string | null | undefined): OrderPaymentStatus | null {
  return value === 'unpaid' || value === 'customer_reported' || value === 'confirmed' || value === 'failed' ? value : null;
}
function asConfirmer(value: string | null | undefined): PaymentConfirmer | null {
  return value === 'seller' || value === 'paystack' ? value : null;
}

// The fields a confirmation sets, written with dotted paths so they never replace
// the rest of the payment record (reportedAt is kept).
export function confirmationFields(by: PaymentConfirmer, at: Date) {
  return { 'payment.status': 'confirmed', 'payment.confirmedAt': at, 'payment.confirmedBy': by } as const;
}

function isDuplicateKey(err: unknown): boolean {
  return err instanceof mongo.MongoServerError && err.code === 11000;
}

export type PaymentEventInput = {
  orderId: Types.ObjectId;
  orderRef: string;
  from: OrderPaymentStatus;
  to: OrderPaymentStatus;
  source: PaymentEventSource;
  eventId: string;
  at?: Date;
};

// Appends one entry to the order's payment history. The same eventId twice is
// stored once: a retried webhook, a double tap or a crash-and-retry all land here
// again and the second is a no-op. Returns whether THIS call wrote it. It throws on
// a real failure, so a caller whose retry would repair the gap (the webhook) can
// let it surface.
export async function recordPaymentEvent(input: PaymentEventInput): Promise<boolean> {
  try {
    await OrderPaymentEventModel.create({ ...input, at: input.at ?? new Date() });
    return true;
  } catch (err) {
    if (isDuplicateKey(err)) return false;
    throw err;
  }
}

// For actions where a missing audit entry must not undo or fail the action itself
// (a customer's "I've paid", a seller's confirmation): the failure is logged by name
// only and the caller carries on.
export async function recordPaymentEventBestEffort(input: PaymentEventInput): Promise<void> {
  try {
    await recordPaymentEvent(input);
  } catch (err) {
    console.error('Could not record an order payment event', err instanceof Error ? err.name : err);
  }
}

// The customer says they paid by bank transfer. This records a CLAIM with a time; it
// is not verified funds, the order stays pending and the seller still confirms. Only
// a pending order whose money is not already reported or confirmed can move, in one
// conditional write, so a double tap reports once and keeps the first time.
//   cancelled            409 ORDER_CANCELLED (nothing to pay)
//   already reported or paid   answered as it stands, nothing changes
export async function reportPaidByCustomer(
  order: { _id: Types.ObjectId; ref: string },
  now: Date = new Date(),
): Promise<{ order: OrderDoc; changed: boolean }> {
  const before = await OrderModel.findOneAndUpdate(
    { _id: order._id, status: 'pending', 'payment.status': { $nin: ['customer_reported', 'confirmed'] } },
    { $set: { 'payment.status': 'customer_reported', 'payment.reportedAt': now } },
    { returnDocument: 'before' },
  );

  if (before) {
    await recordPaymentEventBestEffort({
      orderId: order._id,
      orderRef: order.ref,
      from: orderPaymentView(before).status,
      to: 'customer_reported',
      source: 'customer',
      eventId: `customer_reported:${order._id.toString()}`,
      at: now,
    });
    const after = await OrderModel.findById(order._id);
    return { order: after ?? before, changed: true };
  }

  const current = await OrderModel.findById(order._id);
  if (!current) throw new AppError(404, 'ORDER_NOT_FOUND', 'No order matches that reference and key');
  if (current.status === 'cancelled' && !current.paidAt) {
    throw new AppError(409, 'ORDER_CANCELLED', 'This order was cancelled');
  }
  return { order: current, changed: false };
}
