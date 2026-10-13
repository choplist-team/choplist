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

const formatPrice = (price) =>
  new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    maximumFractionDigits: 0,
  }).format(price);

export default function CustomerConfirmation() {
  const navigate = useNavigate();
  const location = useLocation();
  const { slug } = useParams();

  const response = location.state?.order;
  const orderDetails = response?.order ?? response;
  const paymentDetails = response?.payment;
  const sellerDetails = location.state?.seller ?? response?.seller;

  const copyReference = async () => {
    if (!orderDetails?.ref) return;

    try {
      await navigator.clipboard.writeText(orderDetails.ref);
    } catch {
      // The reference remains visible for manual copying.
    }
  };

  if (!orderDetails?.ref) {
    return (
      <main className="min-h-[100dvh] bg-background px-4">
        <div className="mx-auto w-full max-w-[420px] py-6">
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
              Look up an order
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
      <div className="mx-auto w-full max-w-[420px] pb-10">
        <CustomerHeader />

        <section className="mt-8 space-y-4 text-center">
          <CheckCircle2 className="mx-auto size-14 text-primary" />

          <p className="text-sm font-semibold uppercase tracking-wider text-primary">
            Order received
          </p>

          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Thank you for your order!
          </h1>

          <p className="text-sm leading-relaxed text-muted-foreground">
            Your order has been sent to{" "}
            {sellerDetails?.businessName ?? "the kitchen"}. Complete your
            payment using the instructions below.
          </p>
        </section>

        <section className="mt-8 space-y-4 rounded-2xl border border-border bg-card p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm text-muted-foreground">Order reference</p>
              <p className="mt-1 text-xl font-bold text-primary">
                {orderDetails.ref}
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
              <strong>{orderDetails.status ?? "pending"}</strong>
            </span>
          </div>

          <div className="space-y-3 border-t border-border pt-4">
            <h2 className="font-semibold text-foreground">Order summary</h2>

            {(orderDetails.lines ?? []).map((item, index) => (
              <div
                key={`${item.name}-${index}`}
                className="flex justify-between gap-3 text-sm"
              >
                <div>
                  <p className="font-medium text-foreground">{item.name}</p>
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
                {formatPrice(orderDetails.total ?? paymentDetails?.amount ?? 0)}
              </span>
            </div>
          </div>
        </section>

        {paymentDetails && (
          <section className="mt-5 space-y-4 rounded-2xl border border-border bg-card p-5">
            <h2 className="text-lg font-bold text-foreground">
              Complete your payment
            </h2>

            <p className="text-sm leading-relaxed text-muted-foreground">
              {paymentDetails.instructions}
            </p>

            <div className="space-y-3 rounded-xl bg-soft-green p-4">
              <div>
                <p className="text-xs text-muted-foreground">Bank</p>
                <p className="font-semibold text-foreground">
                  {paymentDetails.bankName}
                </p>
              </div>

              <div>
                <p className="text-xs text-muted-foreground">Account name</p>
                <p className="font-semibold text-foreground">
                  {paymentDetails.accountName}
                </p>
              </div>

              <div>
                <p className="text-xs text-muted-foreground">Account number</p>
                <p className="break-all text-lg font-bold text-foreground">
                  {paymentDetails.accountNumber}
                </p>
              </div>

              <div>
                <p className="text-xs text-muted-foreground">Transfer amount</p>
                <p className="text-xl font-bold text-primary">
                  {formatPrice(paymentDetails.amount)}
                </p>
              </div>

              <div>
                <p className="text-xs text-muted-foreground">
                  Transfer description
                </p>
                <p className="font-bold text-foreground">
                  {paymentDetails.reference ?? orderDetails.ref}
                </p>
              </div>
            </div>

            <p className="text-xs leading-relaxed text-muted-foreground">
              Your order remains pending until the seller confirms your payment.
              ChopList does not transfer money.
            </p>
          </section>
        )}

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
          Look up an order
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
    </main>
  );
}
