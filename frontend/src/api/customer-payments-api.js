import { getOrderKey } from "@/lib/order-keys";
import { apiRequest } from "./api-client";

// What a customer can do about the payment on their own order, beyond paying online
// (that is in customer-api.js). Every call proves it is the customer by sending the
// order's secret key, which this browser saved when the order was placed. Without the key
// the server answers 404 ORDER_NOT_FOUND. See docs/api.md for what each route returns.

const keyHeader = (ref) => {
  const key = getOrderKey(ref);
  return key ? { "X-Order-Key": key } : {};
};

const path = (ref, tail) => `/public/orders/${encodeURIComponent(ref)}/${tail}`;

// What paying online WOULD cost, before the customer commits. Changes nothing.
// { onlinePaymentAvailable, payable, orderTotal, serviceFee, total, feePayer }
export const getPaymentQuote = (ref) => apiRequest(path(ref, "payment-quote"), { headers: keyHeader(ref) });

// "I've paid" after a bank transfer. It records the customer's word and nothing more: the
// order stays pending until the seller confirms the money.
export const reportPaid = (ref) => apiRequest(path(ref, "report-paid"), { method: "POST", headers: keyHeader(ref) });

// "There is a problem with my payment". reason is one of: payment_not_reflected,
// paid_twice, wrong_amount, other. message is 5 to 500 characters.
export const raisePaymentProblem = (ref, { reason, message }) =>
  apiRequest(path(ref, "payment-query"), {
    method: "POST",
    headers: keyHeader(ref),
    body: { reason, message },
  });

// The problems this customer reported on this order, and what ChopList replied.
export const getMyPaymentProblems = (ref) => apiRequest(path(ref, "payment-queries"), { headers: keyHeader(ref) });
