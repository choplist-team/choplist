
import { useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  CheckCircle2,
  ClipboardCopy,
  Clock3,
  Phone,
  Search,
} from "lucide-react";

import CustomerHeader from "@/components/customer/Header";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/api/api-client";
import {
  useOrderPaymentStatus,
  useStartOrderPayment,
} from "@/hooks/useOrderPayment";

const formatPrice = (price) =>
  new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    maximumFractionDigits: 0,
  }).format(price ?? 0);

// Save the order reference and Paystack reference before redirecting.
const savePaymentAttempt = (orderRef, paymentReference) => {
  try {
    localStorage.setItem(
      "choplist.paymentAttempt",
      JSON.stringify({ orderRef, paymentReference })
    );
  } catch {
    throw new Error(
      "We couldn't save your payment details on this device. Please check your browser storage and try again."
    );
  }
};

export default function CustomerConfirmation() {
  const navigate = useNavigate();
  const location = useLocation();
  const { slug } = useParams();

  const response = location.state?.order;
  const orderDetails = response?.order ?? response;
  const paymentDetails = response?.payment;
  const sellerDetails = location.state?.seller ?? response?.seller;

  const orderRef = orderDetails?.ref;

  // Payment status and automatic polling are managed by the hook.
  const {
    data: paymentStatus,
    error: statusError,
    isError: isStatusError,
    isLoading: isStatusLoading,
    refetch: refetchPaymentStatus,
  } = useOrderPaymentStatus(orderRef);

  // Handles starting a new Paystack payment attempt.
  const startPaymentMutation = useStartOrderPayment();

  const [paymentQuote, setPaymentQuote] = useState(null);
  const [paymentError, setPaymentError] = useState("");
  const [onlinePaymentDisabled, setOnlinePaymentDisabled] =
    useState(false);

  const paymentLoading = startPaymentMutation.isPending;

  const currentPaymentState = paymentStatus?.state;

  const onlinePaymentAvailable =
    Boolean(paymentStatus?.onlinePaymentAvailable) &&
    !onlinePaymentDisabled;

  const copyReference = async () => {
    if (!orderRef) return;

    try {
      await navigator.clipboard.writeText(orderRef);
    } catch {
      // The reference remains visible for manual copying.
    }
  };

  const handleStartPayment = async () => {
    if (!orderRef || paymentLoading) return;

    setPaymentError("");
    setPaymentQuote(null);

    try {
      const result = await startPaymentMutation.mutateAsync(orderRef);

      if (!result?.authorizationUrl || !result?.reference) {
        throw new Error(
          "The payment service returned an invalid response."
        );
      }

      // Save both references before the customer leaves for Paystack.
      savePaymentAttempt(orderRef, result.reference);

      setPaymentQuote(result);

      // Refresh status so the hook can begin polling awaiting_payment.
      await refetchPaymentStatus();
    } catch (error) {
      if (error instanceof ApiError) {
        switch (error.code) {
          case "PAYMENTS_NOT_READY":
          case "PAYMENTS_UNAVAILABLE":
            setOnlinePaymentDisabled(true);
            setPaymentError(
              "Online payment is currently unavailable. You can complete your order using the bank transfer instructions below."
            );
            break;

          case "ORDER_ALREADY_PAID":
            await refetchPaymentStatus();
            setPaymentError(
              "This order has already been paid. You don't need to make another payment."
            );
            break;

          case "ORDER_CANCELLED":
            await refetchPaymentStatus();
            setPaymentError(
              "This order has been cancelled. Please contact the seller if you need help."
            );
            break;

          case "RATE_LIMITED":
            setPaymentError(
              "Too many payment attempts. Please wait a little and try again."
            );
            break;

          case "ORDER_NOT_FOUND":
            setPaymentError(
              "We couldn't verify this order. Please use the order lookup page or contact the seller."
            );
            break;

          default:
            setPaymentError(error.message);
        }
      } else {
        setPaymentError(
          error.message || "Unable to start payment. Please try again."
        );
      }
    }
  };

  const continueToPaystack = () => {
    if (!paymentQuote?.authorizationUrl) return;

    window.location.assign(paymentQuote.authorizationUrl);
  };

  if (!orderDetails?.ref) {
    return (
      <main className="min-h-[100dvh] bg-background px-4">
        <div className="mx-auto w-full max-w-[420px] py-6 md:max-w-2xl md:px-4">
          <CustomerHeader />

          <section className="mt-12 space-y-4 text-center">
            <h1 className="text-xl font-bold text-foreground">
              Order details unavailable
            </h1>

            <p className="text-sm text-muted-foreground">
              We couldn't find your order details on this page. If you just
              placed an order, check your previous page before trying again.
            </p>

            <Link
              to="/order-lookup"
              className="flex items-center justify-center gap-2 text-sm font-semibold text-primary hover:underline"
            >
              <Search size={16} />
              Track your order
            </Link>

            <Button onClick={() => navigate(`/shop/${slug ?? ""}`)}>
              Return to menu
            </Button>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-[100dvh] bg-background px-4">
      <div className="mx-auto w-full max-w-[420px] pb-10 md:max-w-2xl md:px-4 md:pb-14 lg:max-w-5xl">
        <CustomerHeader />

        <section className="mx-auto mt-8 space-y-4 text-center md:mt-10 md:max-w-xl">
          <CheckCircle2 className="mx-auto size-14 text-primary" />

          <p className="text-sm font-semibold uppercase tracking-wider text-primary">
            Order received
          </p>

          <h1 className="text-2xl font-bold tracking-tight text-foreground md:text-4xl">
            Thank you for your order!
          </h1>

          <p className="text-sm leading-relaxed text-muted-foreground">
            Your order has been sent to{" "}
            {sellerDetails?.businessName ?? "the kitchen"}. Complete your
            payment using one of the available options below.
          </p>
        </section>

        <div className="lg:mt-10 lg:grid lg:grid-cols-2 lg:items-start lg:gap-6">
          {/* Order details */}
          <section className="mt-8 space-y-4 rounded-2xl border border-border bg-card p-5 md:p-6 lg:mt-0">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm text-muted-foreground">
                  Order reference
                </p>

                <p className="mt-1 text-xl font-bold text-primary">
                  {orderRef}
                </p>
              </div>

              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Copy order reference"
                onClick={copyReference}
              >
                <ClipboardCopy size={18} />
              </Button>
            </div>

            <div className="flex items-center gap-2 rounded-xl bg-soft-green p-3 text-sm text-primary">
              <Clock3 size={18} />

              <span>
                Payment status:{" "}
                <strong>
                  {currentPaymentState ??
                    orderDetails.status ??
                    (isStatusLoading ? "checking..." : "pending")}
                </strong>
              </span>
            </div>

            {currentPaymentState === "under_review" && (
              <p className="rounded-xl bg-muted p-3 text-sm text-muted-foreground">
                Your payment is being reviewed by ChopList. Please don't
                make another payment. Contact the seller if you need help.
              </p>
            )}

            {currentPaymentState === "paid" && (
              <p className="rounded-xl bg-soft-green p-3 text-sm text-primary">
                Payment confirmed. Your order has been paid successfully.
              </p>
            )}

            {currentPaymentState === "cancelled" && (
              <p className="rounded-xl bg-muted p-3 text-sm text-muted-foreground">
                This order has been cancelled.
              </p>
            )}

            {currentPaymentState === "awaiting_payment" && (
              <p className="rounded-xl bg-muted p-3 text-sm text-muted-foreground">
                We are waiting for payment confirmation. If you have been
                charged, please don't make another payment while we check.
              </p>
            )}

            <div className="space-y-3 border-t border-border pt-4">
              <h2 className="font-semibold text-foreground">
                Order summary
              </h2>

              {(orderDetails.lines ?? []).map((item, index) => (
                <div
                  key={`${item.name}-${index}`}
                  className="flex justify-between gap-3 text-sm"
                >
                  <div>
                    <p className="font-medium text-foreground">
                      {item.name}
                    </p>

                    <p className="text-muted-foreground">
                      {item.qty} × {formatPrice(item.unitPrice)}
                    </p>
                  </div>

                  <p className="shrink-0 font-medium text-foreground">
                    {formatPrice(item.qty * item.unitPrice)}
                  </p>
                </div>
              ))}

              <div className="flex justify-between border-t border-border pt-3">
                <span className="font-semibold">Total</span>

                <span className="text-lg font-bold text-primary">
                  {formatPrice(orderDetails.total ?? paymentDetails?.amount)}
                </span>
              </div>
            </div>
          </section>

          {/* Payment options */}
          <div className="mt-5 space-y-5 lg:mt-0">
            {/* Paystack payment */}
            {onlinePaymentAvailable &&
              !["paid", "under_review", "cancelled"].includes(
                currentPaymentState
              ) && (
                <section className="space-y-4 rounded-2xl border border-border bg-card p-5 md:p-6">
                  <h2 className="text-lg font-bold text-foreground">
                    Pay online
                  </h2>

                  <p className="text-sm leading-relaxed text-muted-foreground">
                    Pay securely online using Paystack. Your payment will
                    be confirmed automatically.
                  </p>

                  {!paymentQuote ? (
                    <Button
                      type="button"
                      className="w-full rounded-xl"
                      disabled={
                        paymentLoading ||
                        currentPaymentState === "awaiting_payment"
                      }
                      onClick={handleStartPayment}
                    >
                      {paymentLoading
                        ? "Preparing payment..."
                        : currentPaymentState === "awaiting_payment"
                          ? "Payment awaiting confirmation"
                          : "Pay online"}
                    </Button>
                  ) : (
                    <div className="space-y-4">
                      <div className="space-y-3 rounded-xl bg-soft-green p-4">
                        <div className="flex justify-between gap-3 text-sm">
                          <span className="text-muted-foreground">
                            Order amount
                          </span>

                          <span className="font-medium text-foreground">
                            {formatPrice(orderDetails.total)}
                          </span>
                        </div>

                        <div className="flex justify-between gap-3 text-sm">
                          <span className="text-muted-foreground">
                            Service fee
                          </span>

                          <span className="font-medium text-foreground">
                            {formatPrice(paymentQuote.serviceFee)}
                          </span>
                        </div>

                        <div className="flex justify-between gap-3 border-t border-border pt-3">
                          <span className="font-semibold text-foreground">
                            Total to pay
                          </span>

                          <span className="text-lg font-bold text-primary">
                            {formatPrice(paymentQuote.total)}
                          </span>
                        </div>
                      </div>

                      <Button
                        type="button"
                        className="w-full rounded-xl"
                        onClick={continueToPaystack}
                      >
                        Continue to Paystack
                      </Button>

                      <Button
                        type="button"
                        variant="outline"
                        className="w-full rounded-xl"
                        onClick={() => setPaymentQuote(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  )}

                  {paymentError && (
                    <p className="rounded-xl bg-muted p-3 text-sm text-muted-foreground">
                      {paymentError}
                    </p>
                  )}

                  {currentPaymentState === "awaiting_payment" && (
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      If you left Paystack without completing payment,
                      wait for the status check before trying again.
                    </p>
                  )}
                </section>
              )}

            {/* Bank transfer */}
            {paymentDetails &&
              !["paid", "under_review", "cancelled"].includes(
                currentPaymentState
              ) && (
                <section className="space-y-4 rounded-2xl border border-border bg-card p-5 md:p-6">
                  <h2 className="text-lg font-bold text-foreground">
                    Complete your bank transfer
                  </h2>

                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {paymentDetails.instructions}
                  </p>

                  <div className="space-y-3 rounded-xl bg-soft-green p-4 md:grid md:grid-cols-2 md:gap-4 md:space-y-0">
                    <div>
                      <p className="text-xs text-muted-foreground">Bank</p>

                      <p className="font-semibold text-foreground">
                        {paymentDetails.bankName}
                      </p>
                    </div>

                    <div>
                      <p className="text-xs text-muted-foreground">
                        Account name
                      </p>

                      <p className="font-semibold text-foreground">
                        {paymentDetails.accountName}
                      </p>
                    </div>

                    <div>
                      <p className="text-xs text-muted-foreground">
                        Account number
                      </p>

                      <p className="break-all text-lg font-bold text-foreground">
                        {paymentDetails.accountNumber}
                      </p>
                    </div>

                    <div>
                      <p className="text-xs text-muted-foreground">
                        Transfer amount
                      </p>

                      <p className="text-xl font-bold text-primary">
                        {formatPrice(paymentDetails.amount)}
                      </p>
                    </div>

                    <div>
                      <p className="text-xs text-muted-foreground">
                        Transfer description
                      </p>

                      <p className="font-bold text-foreground">
                        {paymentDetails.reference ?? orderRef}
                      </p>
                    </div>
                  </div>

                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Your order remains pending until the seller confirms
                    your transfer. ChopList does not transfer money.
                  </p>
                </section>
              )}

            {/* Status refresh error */}
            {isStatusError && (
              <div className="space-y-2 rounded-xl bg-muted p-3">
                <p className="text-sm text-muted-foreground">
                  We couldn't refresh your payment status. You can still
                  use your order reference to track your order.
                </p>

                <p className="text-xs text-muted-foreground">
                  {statusError instanceof ApiError
                    ? statusError.message
                    : "Please check your connection and try again."}
                </p>

                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => refetchPaymentStatus()}
                >
                  Check status again
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* Contact and navigation */}
        <div className="md:mx-auto md:mt-4 md:max-w-sm">
          {sellerDetails?.phone && (
            <a
              href={`tel:${sellerDetails.phone}`}
              className="mt-5 flex items-center justify-center gap-2 rounded-xl border border-border p-3 text-sm font-medium text-foreground hover:bg-muted"
            >
              <Phone size={18} />
              Contact {sellerDetails.businessName ?? "the kitchen"}
            </a>
          )}

          <Link
            to="/order-lookup"
            className="mt-4 flex items-center justify-center gap-2 text-sm font-semibold text-primary hover:underline"
          >
            <Search size={16} />
            Track your order
          </Link>

          <Button
            type="button"
            variant="outline"
            className="mt-5 w-full rounded-xl"
            onClick={() => navigate(`/shop/${slug}`)}
          >
            <ArrowLeft size={18} />
            Back to menu
          </Button>
        </div>
      </div>
    </main>
  );
}
