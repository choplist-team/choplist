import { useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "@clerk/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, CalendarClock, Clock3, RefreshCw, Users, Wallet, XCircle } from "lucide-react";

import { getAdminOverview } from "@/api/admin-api";
import {
  cancelAdminSubscription,
  getAdminSubscriptions,
  markAdminSubscriptionRefunded,
} from "@/api/admin-payments-api";
import { DataTable, FilterSelect, MetricCard, NoteAction, PageHeader, Pagination, QueryStatus, StatusBadge, TableCell } from "@/components/admin/admin-ui";
import { formatDate, formatNaira } from "@/components/admin/admin-format";

const statusOptions = [
  { value: "", label: "All" },
  { value: "active", label: "Active" },
  { value: "pending", label: "Waiting for payment" },
  { value: "needs_review", label: "Needs review" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
];

const planOptions = [
  { value: "", label: "Both plans" },
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly (3 months)" },
];

// Vendor subscriptions: how many are on the trial, paying or lapsed, the income, and every
// payment. To GIVE a vendor a free subscription, or to set verification, open the seller.
export default function AdminSubscriptions() {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const queryClient = useQueryClient();
  const enabled = isLoaded && isSignedIn;
  const [status, setStatus] = useState("");
  const [plan, setPlan] = useState("");
  const [page, setPage] = useState(1);

  const overview = useQuery({
    queryKey: ["admin", "overview"],
    queryFn: () => getAdminOverview(getToken),
    enabled,
  });
  const list = useQuery({
    queryKey: ["admin", "subscriptions", { status, plan, page }],
    queryFn: () => getAdminSubscriptions(getToken, { status, plan, page, limit: 20 }),
    enabled,
  });

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["admin", "subscriptions"] }),
      queryClient.invalidateQueries({ queryKey: ["admin", "overview"] }),
      queryClient.invalidateQueries({ queryKey: ["admin", "seller"] }),
    ]);
  const cancelMutation = useMutation({ mutationFn: ({ id, note }) => cancelAdminSubscription(getToken, id, note), onSuccess: refresh });
  const refundMutation = useMutation({ mutationFn: ({ id, note }) => markAdminSubscriptionRefunded(getToken, id, note), onSuccess: refresh });

  const figures = overview.data?.subscriptions;
  const rows = list.data?.subscriptions ?? [];

  return (
    <section className="space-y-6 p-6 lg:p-8">
      <PageHeader
        eyebrow="MONEY"
        title="Subscriptions"
        description="ChopList earns from vendor subscriptions. Free ones granted by an admin are counted as cover but never as income."
      >
        <button type="button" onClick={refresh} className="inline-flex min-h-10 items-center justify-center gap-2 self-start rounded-lg border border-border px-4 text-sm font-medium hover:bg-muted">
          <RefreshCw size={16} />
          Refresh
        </button>
      </PageHeader>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Paying now" value={figures?.activeNow} description={figures?.definitions?.activeNow} icon={BadgeCheck} />
        <MetricCard label="On free trial" value={figures?.onTrial} description={figures?.definitions?.onTrial} icon={Clock3} />
        <MetricCard label="Expired" value={figures?.expired} description={figures?.definitions?.expired} icon={XCircle} tone={figures?.expired > 0 ? "alert" : "default"} />
        <MetricCard label="Ending in 7 days" value={figures?.expiringIn7Days} description={figures?.definitions?.expiringIn7Days} icon={CalendarClock} />
        <MetricCard label="Income, all time" value={figures ? formatNaira(figures.revenue?.allTime) : undefined} description={figures?.definitions?.revenue} icon={Wallet} />
        <MetricCard label="Income, last 30 days" value={figures ? formatNaira(figures.revenue?.last30Days) : undefined} description="Subscriptions confirmed by Paystack in the last 30 days." icon={Wallet} />
        <MetricCard label="Vendors who have paid" value={figures?.payingVendors?.allTime} description={figures?.definitions?.payingVendors} icon={Users} />
        <MetricCard label="Needs review" value={figures?.needsReview} description={figures?.definitions?.needsReview} icon={XCircle} tone={figures?.needsReview > 0 ? "alert" : "default"} />
      </div>
      {figures?.notStarted > 0 && <p className="text-xs text-muted-foreground">{figures.notStarted} seller(s) from before billing have not had their trial start yet. It starts the first time they use the app, or when the backfill is run.</p>}

      <div className="grid max-w-xl gap-4 sm:grid-cols-2">
        <FilterSelect label="Status" value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={statusOptions} />
        <FilterSelect label="Plan" value={plan} onChange={(v) => { setPlan(v); setPage(1); }} options={planOptions} />
      </div>

      <QueryStatus query={list} loadingText="Loading subscriptions..." emptyText="No subscriptions match." hasData={rows.length > 0} />

      {rows.length > 0 && (
        <>
          <DataTable headers={["Vendor", "Plan", "Paid", "Status", "Cover", "Action"]}>
            {rows.map((sub) => {
              const canRefund = (sub.status === "needs_review" || sub.status === "cancelled") && sub.source === "paystack" && !sub.refunded;
              return (
                <tr key={sub.id}>
                  <TableCell>
                    {sub.seller ? (
                      <Link to={`/admin/sellers/${sub.seller.id}`} className="font-medium text-primary hover:underline">
                        {sub.seller.businessName}
                      </Link>
                    ) : (
                      "—"
                    )}
                    <p className="mt-1 text-xs text-muted-foreground">{formatDate(sub.createdAt)}</p>
                  </TableCell>
                  <TableCell className="capitalize">
                    {sub.plan}
                    <p className="mt-1 text-xs text-muted-foreground">{sub.source === "admin" ? "Granted by ChopList" : "Paid by the vendor"}</p>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{sub.source === "admin" ? "Free" : formatNaira(sub.amountNaira)}</TableCell>
                  <TableCell>
                    <StatusBadge value={sub.status} />
                    {sub.refunded && <p className="mt-1 text-xs text-muted-foreground">Refunded</p>}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {sub.startsAt ? (
                      <>
                        <p>From {formatDate(sub.startsAt)}</p>
                        <p>To {formatDate(sub.expiresAt)}</p>
                      </>
                    ) : (
                      "Not active"
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="space-y-2">
                      {sub.status === "active" && (
                        <NoteAction label="Cancel" tone="danger" confirmLabel="Cancel subscription" placeholder="Why? (optional)" noteHelp="Ends their cover now. It does not refund anything." busy={cancelMutation.isPending} onSubmit={(note) => cancelMutation.mutateAsync({ id: sub.id, note })} />
                      )}
                      {canRefund && (
                        <NoteAction label="Mark refunded" confirmLabel="Mark refunded" placeholder="Paystack refund reference (optional)" noteHelp="Refund it in the Paystack dashboard first." busy={refundMutation.isPending} onSubmit={(note) => refundMutation.mutateAsync({ id: sub.id, note })} />
                      )}
                      {sub.status !== "active" && !canRefund && "—"}
                    </div>
                  </TableCell>
                </tr>
              );
            })}
          </DataTable>
          <Pagination pagination={list.data?.pagination} onPageChange={setPage} disabled={list.isFetching} />
        </>
      )}
    </section>
  );
}
