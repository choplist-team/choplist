import { useAuth } from "@clerk/react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, RefreshCw, TriangleAlert } from "lucide-react";

import { getAdminSystem } from "@/api/admin-payments-api";
import { EmptyState, ErrorMessage, PageHeader, StatusBadge } from "@/components/admin/admin-ui";
import { formatNaira, getErrorMessage } from "@/components/admin/admin-format";

function Row({ label, children }) {
  return (
    <div className="flex flex-col justify-between gap-1 border-b border-border py-3 last:border-0 sm:flex-row sm:items-center">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium">{children}</dd>
    </div>
  );
}

const yesNo = (value) => (value ? <StatusBadge value="active" /> : <StatusBadge value="warn" />);

// How the running server is configured, with warnings. It never shows a key or a web
// address: only whether each thing is set, and whether Paystack is in test or live mode.
export default function AdminSystemCheck() {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const query = useQuery({
    queryKey: ["admin", "system"],
    queryFn: () => getAdminSystem(getToken),
    enabled: isLoaded && isSignedIn,
  });
  const system = query.data;
  const live = system?.paystack?.mode === "live";

  return (
    <section className="space-y-6 p-6 lg:p-8">
      <PageHeader eyebrow="SETUP" title="System check" description="Is this server set up the way you expect? Check this after every deploy.">
        <button type="button" onClick={() => query.refetch()} disabled={query.isFetching} className="inline-flex min-h-10 items-center gap-2 self-start rounded-lg border border-border px-4 text-sm font-medium hover:bg-muted disabled:opacity-60">
          <RefreshCw size={16} className={query.isFetching ? "animate-spin" : ""} />
          Check again
        </button>
      </PageHeader>

      {query.isPending && <p className="text-sm text-muted-foreground">Checking...</p>}
      <ErrorMessage>{query.isError ? getErrorMessage(query.error) : ""}</ErrorMessage>

      {system && (
        <>
          {live && (
            <div role="alert" className="flex items-start gap-3 rounded-xl border-2 border-destructive bg-destructive/10 p-4">
              <TriangleAlert className="mt-0.5 shrink-0 text-destructive" size={22} />
              <div>
                <p className="font-bold text-destructive">LIVE Paystack key in use</p>
                <p className="mt-1 text-sm">Real money is moving. Only keep this on if the business is verified and the test run is done.</p>
              </div>
            </div>
          )}

          <div className="rounded-xl border border-border bg-card p-5">
            <h2 className="font-semibold">Warnings</h2>
            {system.warnings.length === 0 ? (
              <p className="mt-3 flex items-center gap-2 text-sm text-primary">
                <CheckCircle2 size={18} /> Nothing to warn about.
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {system.warnings.map((warning) => (
                  <li key={warning.code} className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
                    <p className="font-medium">{warning.message}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{warning.code}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <dl className="rounded-xl border border-border bg-card px-5 py-2">
              <Row label="Online payments (Paystack)">{system.paystack.configured ? <StatusBadge value={system.paystack.mode} /> : <StatusBadge value="warn" />}</Row>
              <Row label="Customer return page set">{yesNo(system.returnPages.payment)}</Row>
              <Row label="Subscription return page set">{yesNo(system.returnPages.subscription)}</Row>
              <Row label="Share link address set">{yesNo(system.shareUrlBaseSet)}</Row>
              <Row label="Admins who can sign in">{system.adminCount}</Row>
              <Row label="Websites allowed to use the API">{system.allowedOriginCount}</Row>
            </dl>

            <dl className="rounded-xl border border-border bg-card px-5 py-2">
              <Row label="Per-order fee">{system.pricing.platformFeeBps === 0 ? "Off (ChopList earns from subscriptions)" : `${system.pricing.platformFeeBps / 100}%`}</Row>
              <Row label="Free trial">{system.billing.trialDays} days</Row>
              <Row label="Monthly plan">{formatNaira(system.billing.monthlyNaira)}</Row>
              <Row label="Quarterly plan (3 months)">{formatNaira(system.billing.quarterlyNaira)}</Row>
              <Row label="Cancel unpaid orders after">{system.orderExpiryHours > 0 ? `${system.orderExpiryHours} hours` : "Never (off)"}</Row>
            </dl>
          </div>
        </>
      )}

      {!system && !query.isPending && !query.isError && <EmptyState>No information.</EmptyState>}
    </section>
  );
}
