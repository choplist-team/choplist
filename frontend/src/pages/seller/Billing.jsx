import { useState } from "react";
import { useAuth } from "@clerk/react";
import { useMutation, useQuery } from "@tanstack/react-query";

import { ApiError } from "@/api/api-client";
import { getSubscriptionHistory, startSubscription } from "@/api/seller-billing-api";
import SellerBottomNav from "@/components/seller/BottomNav";
import SellerHeader from "@/components/seller/Header";
import { useCurrentSeller } from "@/hooks/useCurrentSeller";
import { useSellerBilling } from "@/hooks/useSellerBilling";
import { formatDateTime, formatDay, formatNaira } from "@/lib/money";

// Where the seller sees their free trial, picks a plan and pays. Paying happens on
// Paystack's page; Paystack then sends the seller to /seller/billing/done, which waits
// for the payment to be confirmed. This page never activates anything itself.

const PLAN_NAMES = { monthly: "Monthly", quarterly: "3 months" };

const STATUS_LABELS = {
  pending: "Waiting for payment",
  active: "Active",
  failed: "Payment failed",
  needs_review: "Being checked by ChopList",
  cancelled: "Ended by ChopList",
};

// Remember which payment we sent the seller to pay, in case Paystack's return link
// loses it. (It normally also adds ?reference=... to the return address.)
const ATTEMPT_KEY = "choplist.subscriptionAttempt";
const saveAttempt = (reference) => {
  try {
    localStorage.setItem(ATTEMPT_KEY, reference);
  } catch {
    // Not a problem: the return address carries the reference too.
  }
};

function StateCard({ billing }) {
  if (billing.state === "active") {
    return (
      <div className="rounded-xl border border-primary/40 bg-soft-green p-4">
        <h2 className="font-semibold text-foreground">Your subscription is active</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Paid until {formatDay(billing.accessEndsAt)}. You can share your shop link.
        </p>
      </div>
    );
  }

  if (billing.state === "trial") {
    return (
      <div className="rounded-xl border border-border bg-card p-4">
        <h2 className="font-semibold text-foreground">You are on your free trial</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          It ends on {formatDay(billing.trialEndsAt)}. Subscribe before then to keep sharing your shop link.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
      <h2 className="font-semibold text-foreground">Your free trial has ended</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Subscribe to share your shop link again. Customers who already have your link can still order from you.
      </p>
    </div>
  );
}

export default function Billing() {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const { data: seller } = useCurrentSeller();
  const billing = useSellerBilling();
  const [error, setError] = useState("");

  const history = useQuery({
    queryKey: ["seller-subscriptions"],
    queryFn: () => getSubscriptionHistory(getToken),
    enabled: isLoaded && isSignedIn,
  });

  const subscribe = useMutation({
    mutationFn: (plan) => startSubscription(plan, getToken),
    onSuccess: (result) => {
      saveAttempt(result.reference);
      // Off to Paystack to pay. Nothing is active until they confirm it to ChopList.
      window.location.assign(result.authorizationUrl);
    },
    onError: (err) => {
      setError(
        err instanceof ApiError && err.code === "PAYMENTS_UNAVAILABLE"
          ? "Online payment is not available right now. Please try again in a few minutes."
          : err?.message || "Could not start the payment. Please try again."
      );
    },
  });

  const plans = billing.data?.plans ?? [];

  return (
    <main className="min-h-[100dvh] bg-background px-4 py-6 pb-28 md:px-8 md:pt-10 lg:pb-12 lg:pl-72 lg:pr-8">
      <div className="mx-auto flex w-full max-w-[420px] flex-col md:max-w-3xl lg:max-w-5xl">
        <SellerHeader businessName={seller?.businessName} />

        <header className="mt-8 lg:mt-0">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground md:text-4xl">Billing</h1>
          <p className="mt-2 text-sm leading-5 text-muted-foreground">
            Your free trial and subscription. A subscription lets you share your shop link.
          </p>
        </header>

        {billing.isPending && <p className="mt-6 text-sm text-muted-foreground">Loading...</p>}

        {billing.isError && (
          <div className="mt-6 rounded-xl border border-border bg-card p-4">
            <p className="text-sm text-destructive">{billing.error?.message || "Could not load your billing details."}</p>
            <button type="button" onClick={() => billing.refetch()} className="mt-3 rounded-lg border border-border px-3 py-2 text-sm font-semibold">
              Try again
            </button>
          </div>
        )}

        {billing.data && (
          <>
            <section className="mt-6">
              <StateCard billing={billing.data} />
            </section>

            <section className="mt-6">
              <h2 className="font-semibold text-foreground">Choose a plan</h2>
              {billing.data.state === "active" && (
                <p className="mt-1 text-sm text-muted-foreground">Subscribing again adds time after your current period ends. Nothing is lost.</p>
              )}

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {plans.map((plan) => (
                  <div key={plan.id} className="rounded-xl border border-border bg-card p-4">
                    <p className="text-sm text-muted-foreground">{PLAN_NAMES[plan.id] ?? plan.id}</p>
                    <p className="mt-1 text-2xl font-bold text-foreground">{formatNaira(plan.priceNaira)}</p>
                    <p className="text-xs text-muted-foreground">
                      for {plan.months} {plan.months === 1 ? "month" : "months"}
                    </p>
                    <button
                      type="button"
                      disabled={subscribe.isPending}
                      onClick={() => {
                        setError("");
                        subscribe.mutate(plan.id);
                      }}
                      className="mt-4 w-full rounded-lg bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {subscribe.isPending && subscribe.variables === plan.id ? "Opening Paystack..." : "Subscribe"}
                    </button>
                  </div>
                ))}
              </div>

              {error && (
                <p role="alert" className="mt-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                  {error}
                </p>
              )}
              <p className="mt-3 text-xs text-muted-foreground">You pay on Paystack's secure page. Your subscription starts once Paystack confirms the payment.</p>
            </section>

            <section className="mt-8">
              <h2 className="font-semibold text-foreground">Your payments</h2>

              {history.isPending && <p className="mt-2 text-sm text-muted-foreground">Loading...</p>}
              {history.isError && <p className="mt-2 text-sm text-destructive">Could not load your payments.</p>}
              {history.data?.subscriptions?.length === 0 && <p className="mt-2 text-sm text-muted-foreground">No payments yet.</p>}

              <ul className="mt-3 space-y-2">
                {(history.data?.subscriptions ?? []).map((sub) => (
                  <li key={sub.id} className="rounded-xl border border-border bg-card p-3 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium text-foreground">
                        {PLAN_NAMES[sub.plan] ?? sub.plan} · {sub.source === "admin" ? "Free (given by ChopList)" : formatNaira(sub.amountNaira)}
                      </span>
                      <span className="text-xs font-semibold text-muted-foreground">{STATUS_LABELS[sub.status] ?? sub.status}</span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {sub.startsAt ? `${formatDay(sub.startsAt)} to ${formatDay(sub.expiresAt)}` : `Started ${formatDateTime(sub.createdAt)}`}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}

        <SellerBottomNav />
      </div>
    </main>
  );
}
