import { randomBytes } from 'node:crypto';
import { logEvent } from '../events/log.js';
import { AppError } from '../errors.js';
import { OrderModel, type OrderDoc } from '../models/order.js';
import { PaymentModel } from '../models/payment.js';
import { sellerFeeMode, sellerPaidOrderCount, sellerPaymentsReady, isSellerActive, type SellerDoc } from '../models/seller.js';
import { calculateFees } from './fees.js';
import { PaystackError, type PaystackClient } from './paystack.js';

export type PayOptions = {
  paystack: PaystackClient | null;
  pricing: { freeOrders: number; platformFeeBps: number };
  // Where Paystack sends the customer after paying. Unset = Paystack's default.
  callbackUrl?: string;
};

export type StartedPayment = {
  authorizationUrl: string;
  reference: string;
  // Whole naira the customer pays on top of the order total (0 when the seller
  // pays the fees), and the whole amount they pay.
  serviceFee: number;
  total: number;
};

// Customers give a name and phone number, not an email, but Paystack needs one.
// This address belongs to the order, not the person. It means Paystack's receipt
// emails go nowhere; collecting a real email is a follow-up.
const PAYER_EMAIL_DOMAIN = 'orders.choplistafrica.com';

// Unguessable and never reused: the webhook finds the payment by this, and
// Paystack refuses a reference it has already seen.
export function newPaymentReference(): string {
  return `CLP-${randomBytes(12).toString('hex')}`;
}

// A customer can only start paying for an order that is still waiting for
// payment. The wording differs so the page can say the right thing.
function assertPayable(status: string): void {
  if (status === 'pending') return;
  if (status === 'cancelled') throw new AppError(409, 'ORDER_CANCELLED', 'This order was cancelled and cannot be paid');
  throw new AppError(409, 'ORDER_ALREADY_PAID', 'This order is already paid');
}

// Works out what this payment costs, freezes that on the order, asks Paystack to
// set up the split payment and records it. Nothing is marked paid here: only the
// webhook does that, after Paystack confirms the money.
export async function startPayment(order: OrderDoc, seller: SellerDoc, options: PayOptions): Promise<StartedPayment> {
  const { paystack, pricing, callbackUrl } = options;
  if (!paystack) throw new AppError(503, 'PAYMENTS_UNAVAILABLE', 'Online payment is not available right now. Pay by bank transfer instead.');

  assertPayable(order.status);
  // The same answer for "suspended" and "not set up": a customer needs to know
  // only that this seller takes bank transfer.
  if (!isSellerActive(seller) || !sellerPaymentsReady(seller) || !seller.paystackSubaccountCode) {
    throw new AppError(409, 'PAYMENTS_NOT_READY', 'This seller does not take online payments yet. Pay by bank transfer instead.');
  }

  // The tier is decided now, from the seller's paid-order count at this moment,
  // and frozen on the order below (later config changes never touch it).
  const quote = calculateFees({
    baseNaira: order.total,
    feeMode: sellerFeeMode(seller),
    paidOrderCount: sellerPaidOrderCount(seller),
    freeOrders: pricing.freeOrders,
    platformFeeBps: pricing.platformFeeBps,
  });

  // The write that decides whether this order can still be paid. It only matches
  // a pending order, so a seller cancelling at the same moment cannot be missed.
  const gate = await OrderModel.updateOne(
    { _id: order._id, status: 'pending' },
    {
      $set: {
        serviceFee: quote.serviceFee,
        platformFeeBps: quote.platformFeeBps,
        platformFeeKobo: quote.platformFeeKobo,
        paystackFeeKobo: quote.paystackFeeKobo,
      },
    },
  );
  if (gate.matchedCount === 0) {
    const current = await OrderModel.findById(order._id, { status: 1 }).lean();
    assertPayable(current?.status ?? 'cancelled');
    throw new AppError(409, 'ORDER_ALREADY_PAID', 'This order is already paid');
  }

  const reference = newPaymentReference();
  let authorizationUrl: string;
  try {
    ({ authorizationUrl } = await paystack.initializeTransaction({
      email: `${order.ref.toLowerCase()}@${PAYER_EMAIL_DOMAIN}`,
      amountKobo: quote.totalKobo,
      reference,
      subaccountCode: seller.paystackSubaccountCode,
      transactionChargeKobo: quote.transactionChargeKobo,
      bearer: quote.bearer,
      callbackUrl,
      // The order ref only: no name, phone or address leaves our system.
      metadata: { orderRef: order.ref },
    }));
  } catch (err) {
    const paystackError = err instanceof PaystackError ? err : null;
    await logEvent({
      type: 'payment_start_failed',
      level: 'error',
      code: paystackError?.kind === 'rejected' ? 'PAYSTACK_REJECTED' : 'PAYSTACK_UNAVAILABLE',
      message: 'Could not start a Paystack payment',
      sellerId: seller._id,
      menuId: order.menuId,
      orderRef: order.ref,
      meta: { httpStatus: paystackError?.status ?? 0, reason: paystackError?.message ?? 'unexpected error' },
    });
    throw new AppError(503, 'PAYMENTS_UNAVAILABLE', 'Could not start the payment. Try again, or pay by bank transfer instead.');
  }

  // Saved only after Paystack accepted it: a failed attempt leaves no row, and
  // the customer cannot pay before we return the address below, so there is no
  // way to receive money for a reference we have not recorded.
  await PaymentModel.create({
    orderId: order._id,
    orderRef: order.ref,
    sellerId: seller._id,
    reference,
    status: 'initialized',
    amountKobo: quote.totalKobo,
    transactionChargeKobo: quote.transactionChargeKobo,
    platformFeeKobo: quote.platformFeeKobo,
    paystackFeeKobo: quote.paystackFeeKobo,
    platformFeeBps: quote.platformFeeBps,
    serviceFee: quote.serviceFee,
    bearer: quote.bearer,
    subaccountCode: seller.paystackSubaccountCode,
  });

  return { authorizationUrl, reference, serviceFee: quote.serviceFee, total: quote.totalNaira };
}
