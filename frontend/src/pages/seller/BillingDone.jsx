import { useAuth } from "@clerk/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, Navigate, useLocation, useSearchParams } from "react-router-dom";
import { CheckCircle2, Clock3, TriangleAlert } from "lucide-react";

import { getSubscriptionStatus } from "@/api/seller-billing-api";
import SuspendedAccount from "@/components/seller/SuspendedAccount";
import { formatDay } from "@/lib/money";

// The page Paystack sends a seller back to after paying a subscription
// (SUBSCRIPTION_CALLBACK_URL on the server = https://<site>/seller/billing/done).
//
// Arriving here proves NOTHING: the subscription only starts when Paystack confirms the
// payment to ChopList's server. So this page asks the server until it says "active".
// It asks every 3 seconds for the first 30 seconds, then every 10, and stops after about
// 5 minutes (the confirmation can still arrive later; the Billing page will show it). After
// 30 seconds it says "still confirming" with a button to check again. It never polls after a
// 4xx answer (the answer would not change), and stops when the seller leaves the page.

const ATTEMPT_KEY = "choplist.subscriptionAttempt";
const FAST = 3000;
const SLOW = 10000;
const FAST_FOR = 30_000;
const GIVE_UP_AFTER = 5 * 60_000;

// Paystack adds ?reference=... (and ?trxref=...) to the return address. A subscription's
// reference is the same one ChopList created, so it is enough on its own. If it is
// missing we fall back to the one saved just before leaving for Paystack.
function usePaymentReference() {
  const [params] = useSearchParams();
  const fromAddress = params.get("reference") || params.get("trxref");
  if (fromAddress) return fromAddress;
  try {
    return localStorage.getItem(ATTEMPT_KEY);
  } catch {
    return null;
  }
}

export default function BillingDone() {
  const reference = usePaymentReference();
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const queryClient = useQueryClient();
  const location = useLocation();
  const [startedAt] = useState(() => Date.now());

  const query = useQuery({
    queryKey: ["subscription-status", reference],
    queryFn: () => getSubscriptionStatus(reference, getToken),
    enabled: Boolean(reference) && isLoaded && isSignedIn,
    retry: false,
    refetchInterval: (q) => {
      const failedWith = q.state.error?.status;
      if (failedWith >= 400 && failedWith < 500) return false;
      const status = q.state.data?.status;
      // Stop once it is settled one way or the other.
      if (status === "active" || status === "needs_review" || status === "cancelled") return false;
      const elapsed = Date.now() - startedAt;
      if (elapsed > GIVE_UP_AFTER) return false;
      return elapsed < FAST_FOR ? FAST : SLOW;
    },
  });

  const status = query.data?.status;

  // Once active, the Billing page and the share button should see it straight away.
  useEffect(() => {
    if (status === "active") {
      queryClient.invalidateQueries({ queryKey: ["seller-billing"] });
      queryClient.invalidateQueries({ queryKey: ["seller-subscriptions"] });
    }
  }, [status, queryClient]);

  // After 30 seconds we stop saying "confirming" and say it is taking longer (not a failure).
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setTimedOut(true), FAST_FOR);
    return () => clearTimeout(timer);
  }, []);

  // The answer is decided by the error CODE, not the HTTP status.
  const code = query.error?.code;
  if (code === "ACCOUNT_SUSPENDED") return <SuspendedAccount />;
  if (code === "UNAUTHENTICATED") {
    const back = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/seller/sign-in?redirect_url=${back}`} replace />;
  }

  return (
    <main className="min-h-[100dvh] bg-background px-4 py-10">
      <div className="mx-auto w-full max-w-md space-y-5 text-center">
        {!reference && (
          <>
            <TriangleAlert className="mx-auto size-12 text-amber-600" />
            <h1 className="text-2xl font-bold text-foreground">We could not find your payment</h1>
            <p className="text-sm text-muted-foreground">Open your Billing page to see whether your subscription is active.</p>
          </>
        )}

        {reference && query.isError && (
          <>
            <TriangleAlert className="mx-auto size-12 text-amber-600" />
            <h1 className="text-2xl font-bold text-foreground">
              {code === "SUBSCRIPTION_NOT_FOUND" ? "We could not find that payment" : "We could not check your payment"}
            </h1>
            <p className="text-sm text-muted-foreground">
              {code === "SUBSCRIPTION_NOT_FOUND"
                ? "Open your Billing page to see whether your subscription is active, or start again."
                : query.error?.message || "Please check your Billing page in a moment."}
            </p>
          </>
        )}

        {reference && !query.isError && status === "active" && (
          <>
            <CheckCircle2 className="mx-auto size-14 text-primary" />
            <h1 className="text-2xl font-bold text-foreground">Subscription active</h1>
            <p className="text-sm text-muted-foreground">Thank you. You can share your shop link until {formatDay(query.data.expiresAt)}.</p>
          </>
        )}

        {reference && !query.isError && status === "needs_review" && (
          <>
            <TriangleAlert className="mx-auto size-12 text-amber-600" />
            <h1 className="text-2xl font-bold text-foreground">We are checking your payment</h1>
            <p className="text-sm text-muted-foreground">Your payment needs a quick look from ChopList. Please do not pay again. We will sort it out.</p>
          </>
        )}

        {reference && !query.isError && status === "failed" && (
          <>
            <TriangleAlert className="mx-auto size-12 text-amber-600" />
            <h1 className="text-2xl font-bold text-foreground">Your payment did not go through</h1>
            <p className="text-sm text-muted-foreground">You have not been subscribed. If you were charged, please wait a moment and check your Billing page, or try again.</p>
          </>
        )}

        {reference && !query.isError && status !== "active" && status !== "needs_review" && status !== "failed" && (
          <>
            <Clock3 className="mx-auto size-12 text-primary" />
            <h1 className="text-2xl font-bold text-foreground">{timedOut ? "Still waiting for confirmation" : "Confirming your payment..."}</h1>
            <p className="text-sm text-muted-foreground">
              {timedOut
                ? "If you have been charged, please do not pay again. Your subscription will appear on your Billing page once Paystack confirms it."
                : "This usually takes a few seconds. Please keep this page open."}
            </p>
            {timedOut && (
              <button
                type="button"
                onClick={() => query.refetch()}
                disabled={query.isFetching}
                className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-foreground disabled:opacity-60"
              >
                {query.isFetching ? "Checking..." : "Check again"}
              </button>
            )}
          </>
        )}

        <div className="flex flex-col gap-2 pt-2">
          <Link to="/seller/billing" className="rounded-lg bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground">
            {status === "failed" ? "Try again" : "Go to Billing"}
          </Link>
          <Link to="/seller/dashboard" className="rounded-lg border border-border px-4 py-3 text-sm font-semibold text-foreground">
            Back to my menu
          </Link>
        </div>
      </div>
    </main>
  );
}
