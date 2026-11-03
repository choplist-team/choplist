import { useState } from "react";
import { Link } from "react-router-dom";
import {
  CheckCircle2,
  Clock3,
  AlertCircle,
  Search,
  RefreshCw,
} from "lucide-react";
import CustomerHeader from "@/components/customer/Header";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/api/api-client";
import { useOrderPaymentStatus } from "@/hooks/useOrderPayment";

// Retrieve the saved payment attempt.
const getSavedPaymentAttempt = () => {
  try {
    const saved = localStorage.getItem("choplist.paymentAttempt");

    if (!saved) return null;

    const parsed = JSON.parse(saved);

    if (!parsed?.orderRef || !parsed?.paymentReference) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
};

export default function PaystackReturn() {
  const [attempt] = useState(getSavedPaymentAttempt);

  const orderRef = attempt?.orderRef;

  const {
    data: paymentStatus,
    isLoading,
    isError,
    error,
    refetch,
    isFetching,
  } = useOrderPaymentStatus(orderRef);

  const paymentState = paymentStatus?.state;

  const isPaid = paymentState === "paid";
  const isUnderReview = paymentState === "under_review";
  const isCancelled = paymentState === "cancelled";
  const isAwaitingPayment = paymentState === "awaiting_payment";

  const handleCheckAgain = () => {
    refetch();
  };

  let heading = "Checking your payment";
  let description = "Please wait while we verify your payment with ChopList.";
  let Icon = Clock3;
  let iconClass = "text-primary";

  if (isPaid) {
    heading = "Payment successful!";
    description = "Your payment has been confirmed.";
    Icon = CheckCircle2;
    iconClass = "text-primary";
  } else if (isUnderReview) {
    heading = "Payment under review";
    description =
      "We received information about your payment, but your order needs further review. ChopList is working to resolve this. Please don't make another payment.";
    Icon = AlertCircle;
    iconClass = "text-amber-600";
  } else if (isCancelled) {
    heading = "Order cancelled";
    description =
      "This order has been cancelled. If you believe this is a mistake, please contact the seller.";
    Icon = AlertCircle;
    iconClass = "text-muted-foreground";
  } else if (isAwaitingPayment) {
    heading = "Waiting for payment confirmation";
    description =
      "Your payment is not confirmed yet. We're checking with the payment service. Please don't make another payment while we verify it.";
    Icon = Clock3;
    iconClass = "text-primary";
  } else if (paymentState === "not_started") {
    heading = "Payment not confirmed";
    description =
      "We haven't received confirmation of a completed online payment. You can return to your order page to review your payment options.";
    Icon = AlertCircle;
    iconClass = "text-muted-foreground";
  }

  if (!attempt) {
    return (
      <main className="min-h-[100dvh] bg-background px-4">
        <div className="mx-auto w-full max-w-[420px] py-6">
          <CustomerHeader />

          <section className="mt-16 space-y-5 text-center">
            <AlertCircle className="mx-auto size-14 text-primary" />

            <h1 className="text-2xl font-bold text-foreground">
              Payment details unavailable
            </h1>

            <p className="text-sm leading-relaxed text-muted-foreground">
              We couldn't find the saved order details for this payment. Please
              use your order reference to check your order status.
            </p>

            <Link
              to="/order-lookup"
              className="flex items-center justify-center gap-2 text-sm font-semibold text-primary hover:underline"
            >
              <Search size={17} />
              Track your order
            </Link>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-[100dvh] bg-background px-4">
      <div className="mx-auto w-full max-w-[420px] pb-10">
        <CustomerHeader />

        <section className="mt-16 space-y-5 text-center">
          <Icon className={`mx-auto size-16 ${iconClass}`} />

          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-primary">
              ChopList payments
            </p>

            <h1 className="text-2xl font-bold tracking-tight text-foreground">
              {heading}
            </h1>

            <p className="text-sm leading-relaxed text-muted-foreground">
              {description}
            </p>
          </div>

          <div className="space-y-3 rounded-2xl border border-border bg-card p-5 text-left">
            <div>
              <p className="text-xs text-muted-foreground">Order reference</p>

              <p className="mt-1 font-bold text-primary">{orderRef}</p>
            </div>

            <div className="border-t border-border pt-3">
              <p className="text-xs text-muted-foreground">Payment status</p>

              <p className="mt-1 font-semibold capitalize text-foreground">
                {isLoading
                  ? "Checking..."
                  : paymentState?.replaceAll("_", " ") ?? "Unknown"}
              </p>
            </div>

            {paymentStatus?.amountCharged != null && (
              <div className="border-t border-border pt-3">
                <p className="text-xs text-muted-foreground">Amount charged</p>

                <p className="mt-1 font-bold text-foreground">
                  {new Intl.NumberFormat("en-NG", {
                    style: "currency",
                    currency: "NGN",
                    maximumFractionDigits: 0,
                  }).format(paymentStatus.amountCharged)}
                </p>
              </div>
            )}
          </div>

          {isError && (
            <div className="space-y-2 rounded-xl bg-muted p-4 text-left">
              <p className="text-sm font-semibold text-foreground">
                We couldn't verify your payment
              </p>

              <p className="text-sm text-muted-foreground">
                {error instanceof ApiError
                  ? error.message
                  : "Please check your internet connection and try again."}
              </p>

              {error instanceof ApiError &&
                error.code === "ORDER_NOT_FOUND" && (
                  <p className="text-xs text-muted-foreground">
                    Check that your order details are correct or contact the
                    seller for assistance.
                  </p>
                )}
            </div>
          )}

          {isAwaitingPayment && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              We will continue checking automatically for a few minutes.
            </p>
          )}

          {isUnderReview && (
            <p className="rounded-xl bg-muted p-3 text-sm text-muted-foreground">
              Do not attempt another payment. Contact the seller if you need
              assistance.
            </p>
          )}

          <div className="space-y-3 pt-2">
            {!isPaid && !isUnderReview && !isCancelled && (
              <Button
                type="button"
                className="w-full rounded-xl"
                disabled={isFetching}
                onClick={handleCheckAgain}
              >
                <RefreshCw
                  size={17}
                  className={isFetching ? "animate-spin" : ""}
                />
                {isFetching ? "Checking..." : "Check payment status"}
              </Button>
            )}

            <Link
              to="/order-lookup"
              className="flex items-center justify-center gap-2 text-sm font-semibold text-primary hover:underline"
            >
              <Search size={17} />
              Track your order
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}
