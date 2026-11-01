import type { OrderDoc } from '../models/order.js';
import { orderPaymentMethod } from '../models/order.js';
import type { Payment } from '../models/payment.js';

// Where the customer stands on paying, in words the page can switch on.
//   not_started      nobody has started an online payment (bank transfer is still open)
//   awaiting_payment an online payment was started and Paystack has not confirmed it yet
//                    (keep polling, or the customer abandoned it)
//   paid             the order is paid and being prepared; paymentMethod says how
//   under_review     money arrived but the order could not be completed (e.g. the
//                    seller cancelled it first); ChopList will sort it out
//   cancelled        the order was cancelled and nothing was taken
export const PAYMENT_STATES = ['not_started', 'awaiting_payment', 'paid', 'under_review', 'cancelled'] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];

type PaymentRow = Pick<Payment, 'status' | 'reference' | 'amountKobo' | 'serviceFee' | 'paidAt' | 'createdAt'>;

export type PaymentStatusView = {
  ref: string;
  orderStatus: string;
  paymentMethod: 'transfer' | 'paystack';
  state: PaymentState;
  // True once the order is paid (by either method) and moving through preparation.
  paid: boolean;
  // The order total in whole naira, as always.
  total: number;
  // From the attempt this answer is about; null before any online attempt.
  serviceFee: number | null;
  amountCharged: number | null;
  reference: string | null;
  paidAt: Date | null;
  // Whether the Pay button should be offered right now.
  onlinePaymentAvailable: boolean;
};

const PAID_STATUSES = new Set(['paid', 'out_for_delivery', 'delivered']);

// Works out what to tell the customer from the order and its payment attempts.
// Pure: no database, no clock.
export function buildPaymentStatus(order: OrderDoc, attempts: PaymentRow[], onlinePaymentAvailable: boolean): PaymentStatusView {
  const byNewest = [...attempts].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const succeeded = byNewest.find((p) => p.status === 'succeeded');
  const flagged = byNewest.find((p) => p.status === 'needs_review');
  const orderPaid = PAID_STATUSES.has(order.status);
  const method = orderPaymentMethod(order);

  let state: PaymentState;
  let about: PaymentRow | undefined;
  if (succeeded || (orderPaid && method === 'paystack')) {
    state = 'paid';
    about = succeeded;
  } else if (flagged) {
    state = 'under_review';
    about = flagged;
  } else if (orderPaid) {
    state = 'paid'; // by bank transfer
    about = undefined;
  } else if (order.status === 'cancelled') {
    state = 'cancelled';
    about = undefined;
  } else if (byNewest[0]?.status === 'initialized') {
    state = 'awaiting_payment';
    about = byNewest[0];
  } else {
    state = 'not_started';
    about = undefined;
  }

  return {
    ref: order.ref,
    orderStatus: order.status,
    paymentMethod: method,
    state,
    paid: orderPaid,
    total: order.total,
    serviceFee: about?.serviceFee ?? (about ? Math.max(0, about.amountKobo / 100 - order.total) : null),
    amountCharged: about ? about.amountKobo / 100 : null,
    reference: about?.reference ?? null,
    paidAt: order.paidAt ?? about?.paidAt ?? null,
    onlinePaymentAvailable,
  };
}
