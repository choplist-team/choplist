import { useState } from "react";
import { Search, ClipboardList, ArrowLeft } from "lucide-react";

import CustomerHeader from "@/components/customer/Header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLookupOrder } from "@/hooks/useLookupOrder";
import { useNavigate } from "react-router-dom";

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

  const navigate = useNavigate();

  const lookup = useLookupOrder(
    submitted?.reference ?? "",
    submitted?.phoneLast4 ?? ""
  );

  const handleSubmit = (event) => {
    event.preventDefault();

    const next = {
      reference: reference.trim(),
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

  return (
    <main className="min-h-[100dvh] bg-background px-4">
      <div className="mx-auto w-full max-w-[420px] pb-10">
        <CustomerHeader />

        <section className="mt-8 space-y-2">
          <div className="flex size-12 items-center justify-center rounded-xl bg-soft-green text-primary">
            <ClipboardList size={25} />
          </div>

          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Find your order
          </h1>

          <p className="text-sm leading-relaxed text-muted-foreground">
            Enter your order reference and the last four digits of the phone
            number you used when ordering.
          </p>
        </section>

        <form
          onSubmit={handleSubmit}
          className="mt-6 space-y-4 rounded-2xl border border-border bg-card p-5"
        >
          <div className="space-y-2">
            <Label htmlFor="reference">Order reference</Label>
            <Input
              id="reference"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              placeholder="e.g. CL-7KQ2M"
              autoComplete="off"
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="phoneLast4">Last four digits of phone number</Label>
            <Input
              id="phoneLast4"
              value={phoneLast4}
              onChange={(event) =>
                setPhoneLast4(event.target.value.replace(/\D/g, "").slice(0, 4))
              }
              placeholder="e.g. 1234"
              inputMode="numeric"
              autoComplete="off"
              pattern="[0-9]{4}"
              maxLength={4}
              minLength={4}
              required
            />
          </div>

          <Button type="submit" className="w-full" disabled={lookup.isFetching}>
            <Search size={18} />
            {lookup.isFetching ? "Searching..." : "Find my order"}
          </Button>
        </form>

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
              {lookup.error?.message ||
                "Please check your order reference and phone number, then try again."}
            </p>
          </div>
        )}

        {lookup.isSuccess && order?.ref && (
          <section className="mt-6 space-y-4 rounded-2xl border border-border bg-card p-5">
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

                <div className="space-y-3 rounded-xl bg-soft-green p-4 text-sm">
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
          </section>
        )}
      </div>
    </main>
  );
}
