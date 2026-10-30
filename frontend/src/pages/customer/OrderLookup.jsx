import { useState } from "react";
import { Search, ClipboardList, ArrowLeft } from "lucide-react";

import CustomerHeader from "@/components/customer/Header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLookupOrder } from "@/hooks/useLookupOrder";
import { FieldError } from "@/components/field-error";
import { hasErrors, validateOrderLookup } from "@/lib/validation";
import { Link, useNavigate } from "react-router-dom";

const formatPrice = (price) =>
  new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    maximumFractionDigits: 0,
  }).format(price);

export default function OrderLookup() {
  const [reference, setReference] = useState("");
  const [phoneLast4, setPhoneLast4] = useState("");
  const [submitted, setSubmitted] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});

  const navigate = useNavigate();

  const lookup = useLookupOrder(
    submitted?.reference ?? "",
    submitted?.phoneLast4 ?? ""
  );

  const handleSubmit = (event) => {
    event.preventDefault();

    const errors = validateOrderLookup({ reference, phoneLast4 });
    setFieldErrors(errors);

    if (hasErrors(errors)) return;

    const next = {
      reference: reference.trim().toUpperCase(),
      phoneLast4: phoneLast4.trim(),
    };

    if (
      submitted?.reference === next.reference &&
      submitted?.phoneLast4 === next.phoneLast4
    ) {
      lookup.refetch();
      return;
    }

    setSubmitted(next);
  };

  const response = lookup.data;
  const order = response?.order ?? response;
  const payment = response?.payment;
  const seller = response?.seller;
  const deliveryCode = order?.deliveryCode;


  return (
    <main className="min-h-[100dvh] bg-background px-4">
      <div className="mx-auto w-full max-w-[420px] pb-10 md:max-w-xl md:pb-14">
        <CustomerHeader />

        <section className="mt-8 space-y-2 md:mt-12">
          <div className="flex size-12 items-center justify-center rounded-xl bg-soft-green text-primary">
            <ClipboardList size={25} />
          </div>

          <h1 className="text-2xl font-bold tracking-tight text-foreground md:text-4xl">
            Find your order
          </h1>

          <p className="text-sm leading-relaxed text-muted-foreground">
            Enter your order reference and the last four digits of the phone
            number you used when ordering.
          </p>
        </section>

        <form
          onSubmit={handleSubmit}
          noValidate
          className="mt-6 space-y-4 rounded-2xl border border-border bg-card p-5 md:p-6"
        >
          <div className="space-y-2">
            <Label htmlFor="reference">Order reference</Label>
            <Input
              id="reference"
              value={reference}
              onChange={(event) => {
                setReference(event.target.value);
                setFieldErrors((current) => ({ ...current, reference: "" }));
              }}
              aria-invalid={Boolean(fieldErrors.reference)}
              aria-describedby={
                fieldErrors.reference ? "reference-error" : undefined
              }
              placeholder="e.g. CL-7KQ2M"
              autoComplete="off"
              required
            />

            <FieldError id="reference-error" message={fieldErrors.reference} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="phoneLast4">Last four digits of phone number</Label>
            <Input
              id="phoneLast4"
              value={phoneLast4}
              onChange={(event) => {
                setPhoneLast4(
                  event.target.value.replace(/\D/g, "").slice(0, 4)
                );
                setFieldErrors((current) => ({ ...current, phoneLast4: "" }));
              }}
              aria-invalid={Boolean(fieldErrors.phoneLast4)}
              aria-describedby={
                fieldErrors.phoneLast4 ? "phoneLast4-error" : undefined
              }
              placeholder="e.g. 1234"
              inputMode="numeric"
              autoComplete="off"
              pattern="[0-9]{4}"
              maxLength={4}
              minLength={4}
              required
            />

            <FieldError
              id="phoneLast4-error"
              message={fieldErrors.phoneLast4}
            />
          </div>

          <Button type="submit" className="w-full" disabled={lookup.isFetching}>
            <Search size={18} />
            {lookup.isFetching ? "Searching..." : "Find my order"}
          </Button>
        </form>

        <p className="mt-4 text-center text-sm text-muted-foreground">
          Paid and nothing arrived?{" "}
          <Link
            to="/order-lookup/missing"
            className="font-semibold text-primary underline-offset-4 hover:underline"
          >
            Report a missing order
          </Link>
        </p>

        <Button
          type="button"
          variant="outline"
          className="mt-5 w-full rounded-xl"
          onClick={() => navigate(-1)}
        >
          <ArrowLeft size={18} />
          Back
        </Button>

        {lookup.isError && (
          <div
            role="alert"
            className="mt-5 rounded-xl border border-border bg-card p-4"
          >
            <p className="font-semibold text-foreground">
              We couldn't find your order
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {lookup.error?.code === "ORDER_NOT_FOUND"
                ? "No order matches that reference and phone number. Check the reference on your confirmation and make sure the last 4 digits match the phone number you ordered with."
                : lookup.error?.code === "NETWORK_ERROR"
                ? "We couldn't reach the server. Check your internet connection and try again."
                : lookup.error?.message ||
                  "Please check your order reference and phone number, then try again."}
            </p>
          </div>
        )}

        {lookup.isSuccess && order?.ref && (
          <section className="mt-6 space-y-4 rounded-2xl border border-border bg-card p-5 md:p-6">
            <div>
              <p className="text-sm text-muted-foreground">Order reference</p>
              <p className="text-xl font-bold text-primary">{order.ref}</p>
            </div>

            <div className="rounded-xl bg-soft-green p-3">
              <p className="text-sm text-muted-foreground">Order status</p>
              <p className="font-semibold capitalize text-primary">
                {order.status ?? "Unknown"}
              </p>
            </div>

            {seller?.businessName && (
              <div>
                <p className="text-sm text-muted-foreground">Kitchen</p>
                <p className="font-semibold">{seller.businessName}</p>
              </div>
            )}

            <div className="space-y-3 border-t border-border pt-4">
              <h2 className="font-semibold">Order summary</h2>

              {(order.lines ?? []).map((item, index) => (
                <div
                  key={`${item.name}-${index}`}
                  className="flex justify-between gap-3 text-sm"
                >
                  <div>
                    <p className="font-medium">{item.name}</p>
                    <p className="text-muted-foreground">
                      {item.qty} × {formatPrice(item.unitPrice)}
                    </p>
                  </div>
                  <p className="shrink-0 font-medium">
                    {formatPrice(item.qty * item.unitPrice)}
                  </p>
                </div>
              ))}

              <div className="flex justify-between border-t border-border pt-3">
                <span className="font-semibold">Total</span>
                <span className="text-lg font-bold text-primary">
                  {formatPrice(order.total ?? payment?.amount ?? 0)}
                </span>
              </div>
            </div>

            {payment && (
              <div className="space-y-3 border-t border-border pt-4">
                <h2 className="font-semibold">Payment instructions</h2>

                <p className="text-sm leading-relaxed text-muted-foreground">
                  {payment.instructions}
                </p>

                <div className="space-y-3 rounded-xl bg-soft-green p-4 text-sm md:grid md:grid-cols-2 md:gap-4 md:space-y-0">
                  <div>
                    <p className="text-muted-foreground">Bank</p>
                    <p className="font-semibold">{payment.bankName}</p>
                  </div>

                  <div>
                    <p className="text-muted-foreground">Account name</p>
                    <p className="font-semibold">{payment.accountName}</p>
                  </div>

                  <div>
                    <p className="text-muted-foreground">Account number</p>
                    <p className="break-all text-lg font-bold">
                      {payment.accountNumber}
                    </p>
                  </div>

                  <div>
                    <p className="text-muted-foreground">Transfer amount</p>
                    <p className="text-lg font-bold text-primary">
                      {formatPrice(payment.amount)}
                    </p>
                  </div>

                  <div>
                    <p className="text-muted-foreground">Transfer reference</p>
                    <p className="font-bold">
                      {payment.reference ?? order.ref}
                    </p>
                  </div>
                </div>

                <p className="text-xs text-muted-foreground">
                  Your order remains pending until the seller confirms your
                  payment.
                </p>
              </div>
            )}

            {order?.deliveryCodeHidden && (
              <div className="rounded-xl border border-border bg-card p-5 text-sm leading-relaxed text-foreground">
                Your order is out for delivery. For your safety, the delivery
                code only shows on the device you placed the order from. Open
                this page there to see it.
              </div>
            )}

            {deliveryCode != null && (
              <div className="rounded-xl border border-primary/20 bg-soft-green p-5">
                <p className="text-sm font-medium text-muted-foreground">
                  Your delivery confirmation code
                </p>

                <p className="mt-2 text-3xl font-bold tracking-[0.3em] text-primary">
                  {deliveryCode}
                </p>

                <p className="mt-3 text-sm leading-relaxed text-foreground">
                  Give this code to the rider only when your food arrives.
                </p>
              </div>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
