import { useState } from "react";
import { useAuth } from "@clerk/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquareWarning, RefreshCw } from "lucide-react";

import { getAdminPaymentQueries, resolveAdminPaymentQuery } from "@/api/admin-payments-api";
import { DataTable, FilterSelect, MetricCard, NoteAction, PageHeader, Pagination, QueryStatus, StatusBadge, TableCell } from "@/components/admin/admin-ui";
import { formatDate, formatNaira } from "@/components/admin/admin-format";

const statusOptions = [
  { value: "open", label: "Open" },
  { value: "resolved", label: "Resolved" },
  { value: "", label: "All" },
];

const reasonLabels = {
  payment_not_reflected: "Paid, but the order still shows unpaid",
  payment_not_received: "Customer says they paid, seller sees nothing",
  paid_twice: "Charged more than once",
  wrong_amount: "Wrong amount",
  other: "Something else",
};

// Payment problems that a customer or a seller reported on an order. Resolving one only
// records that someone dealt with it: it does not pay, refund or change the order.
export default function AdminPaymentQueries() {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState("open");
  const [page, setPage] = useState(1);

  const query = useQuery({
    queryKey: ["admin", "payment-queries", { status, page }],
    queryFn: () => getAdminPaymentQueries(getToken, { status, page, limit: 20 }),
    enabled: isLoaded && isSignedIn,
  });

  const resolveMutation = useMutation({
    mutationFn: ({ id, note }) => resolveAdminPaymentQuery(getToken, id, note),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin", "payment-queries"] }),
        queryClient.invalidateQueries({ queryKey: ["admin", "overview"] }),
      ]),
  });

  const queries = query.data?.queries ?? [];

  return (
    <section className="space-y-6 p-6 lg:p-8">
      <PageHeader
        eyebrow="MONEY"
        title="Payment problems"
        description="Problems reported by customers and sellers. Look at the order, sort it out where the money is (Paystack, or the seller's bank), then resolve it here."
      >
        <button type="button" onClick={() => query.refetch()} disabled={query.isFetching} className="inline-flex min-h-10 items-center justify-center gap-2 self-start rounded-lg border border-border px-4 text-sm font-medium hover:bg-muted disabled:opacity-60">
          <RefreshCw size={16} className={query.isFetching ? "animate-spin" : ""} />
          Refresh
        </button>
      </PageHeader>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <MetricCard label="Open problems" value={query.data?.openCount} description="Waiting for someone at ChopList." icon={MessageSquareWarning} tone={query.data?.openCount > 0 ? "alert" : "default"} />
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

      <QueryStatus query={query} loadingText="Loading payment problems..." emptyText={status === "open" ? "No open payment problems." : "Nothing to show."} hasData={queries.length > 0} />

      {queries.length > 0 && (
        <>
          <DataTable headers={["Order", "Raised by", "Problem", "Order now", "Status", "Reply"]}>
            {queries.map((item) => (
              <tr key={item.id}>
                <TableCell className="font-medium">
                  {item.orderRef}
                  <p className="mt-1 text-xs font-normal text-muted-foreground">{item.seller?.businessName ?? "—"}</p>
                  <p className="text-xs font-normal text-muted-foreground">{formatDate(item.createdAt)}</p>
                </TableCell>
                <TableCell className="capitalize">{item.raisedBy}</TableCell>
                <TableCell>
                  <p className="font-medium">{reasonLabels[item.reason] ?? item.reason}</p>
                  <p className="mt-1 max-w-xs whitespace-pre-wrap break-words text-muted-foreground">{item.message}</p>
                </TableCell>
                <TableCell>
                  {item.order ? (
                    <div className="space-y-1">
                      <p>
                        {item.order.status.replaceAll("_", " ")} · {formatNaira(item.order.total)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Paid by {item.order.paymentMethod} · money: <StatusBadge value={item.order.payment?.status} />
                      </p>
                    </div>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell>
                  <StatusBadge value={item.status} />
                  {item.resolvedAt && <p className="mt-1 text-xs text-muted-foreground">{formatDate(item.resolvedAt)}</p>}
                </TableCell>
                <TableCell>
                  {item.status === "open" ? (
                    <NoteAction
                      label="Resolve"
                      confirmLabel="Resolve"
                      placeholder="Write a short reply"
                      noteHelp="This note is shown to the person who raised the problem, so write it as a reply."
                      busy={resolveMutation.isPending}
                      onSubmit={(note) => resolveMutation.mutateAsync({ id: item.id, note })}
                    />
                  ) : (
                    <p className="max-w-xs whitespace-pre-wrap break-words text-muted-foreground">{item.resolutionNote || "No reply was written."}</p>
                  )}
                </TableCell>
              </tr>
            ))}
          </DataTable>
          <Pagination pagination={query.data?.pagination} onPageChange={setPage} disabled={query.isFetching} />
        </>
      )}
    </section>
  );
}
