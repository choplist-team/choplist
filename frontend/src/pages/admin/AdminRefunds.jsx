import { useState } from "react";
import { useAuth } from "@clerk/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Undo2 } from "lucide-react";

import { getAdminRefunds, markAdminRefunded } from "@/api/admin-payments-api";
import { DataTable, EmptyState, FilterSelect, MetricCard, NoteAction, PageHeader, Pagination, QueryStatus, StatusBadge, TableCell } from "@/components/admin/admin-ui";
import { formatDate, formatNaira } from "@/components/admin/admin-format";

const statusOptions = [
  { value: "due", label: "Still to refund" },
  { value: "refunded", label: "Already refunded" },
  { value: "", label: "All" },
];

const kindLabels = {
  cancelled_after_payment: "Paid, then the order was cancelled",
  money_held: "Money arrived but could not be applied",
};

// Customer money that ChopList owes back. ChopList does NOT send refunds itself: a
// person refunds in the Paystack dashboard, then records it here so nothing is forgotten.
export default function AdminRefunds() {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState("due");
  const [page, setPage] = useState(1);

  const query = useQuery({
    queryKey: ["admin", "refunds", { status, page }],
    queryFn: () => getAdminRefunds(getToken, { status, page, limit: 20 }),
    enabled: isLoaded && isSignedIn,
  });

  const markMutation = useMutation({
    mutationFn: ({ id, note }) => markAdminRefunded(getToken, id, note),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin", "refunds"] }),
        queryClient.invalidateQueries({ queryKey: ["admin", "overview"] }),
      ]),
  });

  const refunds = query.data?.refunds ?? [];

  return (
    <section className="space-y-6 p-6 lg:p-8">
      <PageHeader
        eyebrow="MONEY"
        title="Refunds"
        description="Customer money that ChopList owes back. Refund each one in the Paystack dashboard first, then mark it refunded here. ChopList does not send refunds by itself."
      >
        <button type="button" onClick={() => query.refetch()} disabled={query.isFetching} className="inline-flex min-h-10 items-center justify-center gap-2 self-start rounded-lg border border-border px-4 text-sm font-medium hover:bg-muted disabled:opacity-60">
          <RefreshCw size={16} className={query.isFetching ? "animate-spin" : ""} />
          Refresh
        </button>
      </PageHeader>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <MetricCard label="Still to refund" value={query.data?.dueCount} description={query.data?.definitions?.due} icon={Undo2} tone={query.data?.dueCount > 0 ? "alert" : "default"} />
      </div>

      <div className="max-w-xs">
        <FilterSelect
          label="Show"
          value={status}
          onChange={(value) => {
            setStatus(value);
            setPage(1);
          }}
          options={statusOptions}
        />
      </div>

      <QueryStatus query={query} loadingText="Loading refunds..." emptyText={status === "due" ? "Nothing to refund. Good." : "No refunds to show."} hasData={refunds.length > 0} />

      {refunds.length > 0 && (
        <>
          <DataTable headers={["Order", "What happened", "Amount", "Seller", "Paid", "Status", "Action"]}>
            {refunds.map((refund) => (
              <tr key={refund.id}>
                <TableCell className="font-medium">{refund.orderRef}</TableCell>
                <TableCell>
                  <p>{kindLabels[refund.kind] ?? refund.kind}</p>
                  <p className="mt-1 break-all text-xs text-muted-foreground">Paystack ref: {refund.paystackReference}</p>
                </TableCell>
                <TableCell className="whitespace-nowrap font-medium">{formatNaira(refund.amountNaira)}</TableCell>
                <TableCell>{refund.seller?.businessName ?? "—"}</TableCell>
                <TableCell className="whitespace-nowrap">{formatDate(refund.paidAt)}</TableCell>
                <TableCell>
                  <StatusBadge value={refund.status} />
                  {refund.refundedAt && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatDate(refund.refundedAt)}
                      {refund.note ? ` · ${refund.note}` : ""}
                    </p>
                  )}
                </TableCell>
                <TableCell>
                  {refund.status === "due" ? (
                    <NoteAction
                      label="Mark refunded"
                      confirmLabel="Mark refunded"
                      placeholder="Paystack refund reference (optional)"
                      busy={markMutation.isPending}
                      onSubmit={(note) => markMutation.mutateAsync({ id: refund.id, note })}
                    />
                  ) : (
                    "—"
                  )}
                </TableCell>
              </tr>
            ))}
          </DataTable>
          <Pagination pagination={query.data?.pagination} onPageChange={setPage} disabled={query.isFetching} />
        </>
      )}

      {!query.isPending && !query.isError && refunds.length === 0 && status !== "due" && <EmptyState>Nothing here yet.</EmptyState>}
    </section>
  );
}
