import { useState } from "react";
import { useAuth } from "@clerk/react";
import { useQuery } from "@tanstack/react-query";
import { getAdminOrder, getAdminOrders } from "@/api/admin-api";

const PAGE_SIZE = 20;

const ORDER_STATUSES = [
  "pending",
  "paid",
  "out_for_delivery",
  "delivered",
  "cancelled",
];

const STATUS_LABELS = {
  pending: "Pending",
  paid: "Paid",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

function formatDate(value) {
  if (!value) return "—";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "—";

  return date.toLocaleString("en-NG", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatMoney(value) {
  const amount = Number(value);

  if (!Number.isFinite(amount)) return "—";

  return new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    maximumFractionDigits: 2,
  }).format(amount);
}

function getErrorMessage(error) {
  if (error?.status === 401) {
    return "Your session may have expired. Please sign in again.";
  }

  if (error?.status === 403) {
    return "You do not have permission to access admin orders.";
  }

  return error?.message || "Something went wrong. Please try again.";
}

function StatusBadge({ status }) {
  const styles = {
    pending: "bg-amber-100 text-amber-800",
    paid: "bg-green-100 text-green-800",
    out_for_delivery: "bg-blue-100 text-blue-800",
    delivered: "bg-emerald-100 text-emerald-800",
    cancelled: "bg-red-100 text-red-800",
  };

  return (
    <span
      className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium ${
        styles[status] || "bg-gray-100 text-gray-700"
      }`}
    >
      {STATUS_LABELS[status] || status || "Unknown"}
    </span>
  );
}

function OrderFlags({ flags }) {
  if (!flags) return <span className="text-muted-foreground">—</span>;

  const labels = [];

  if (flags.possibleDuplicate) labels.push("Possible duplicate");
  if (flags.cancelled) labels.push("Cancelled");
  if (flags.failed) labels.push("Failed");

  if (labels.length === 0) {
    return <span className="text-muted-foreground">None</span>;
  }

  return (
    <div className="flex flex-wrap gap-1">
      {labels.map((label) => (
        <span
          key={label}
          className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800"
        >
          {label}
        </span>
      ))}
    </div>
  );
}

function DetailRow({ label, children }) {
  return (
    <div className="grid gap-1 border-b border-border py-3 last:border-b-0 sm:grid-cols-[150px_1fr]">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-sm font-medium">
        {children ?? "—"}
      </dd>
    </div>
  );
}

export default function AdminOrders() {
  const { getToken } = useAuth();

  const [refInput, setRefInput] = useState("");
  const [ref, setRef] = useState("");
  const [sellerId, setSellerId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [status, setStatus] = useState("");
  const [flag, setFlag] = useState("");
  const [page, setPage] = useState(1);

  const [selectedRef, setSelectedRef] = useState("");
  const [revealPrivateInfo, setRevealPrivateInfo] = useState(false);

  const ordersQuery = useQuery({
    queryKey: [
      "admin",
      "orders",
      { ref, sellerId, from, to, status, flag, page },
    ],
    queryFn: () =>
      getAdminOrders(getToken, {
        ref,
        sellerId,
        from,
        to,
        status: status ? [status] : [],
        flag,
        page,
        limit: PAGE_SIZE,
      }),
  });

  const detailQuery = useQuery({
    queryKey: ["admin", "order", selectedRef, revealPrivateInfo],
    queryFn: () =>
      getAdminOrder(getToken, selectedRef, {
        reveal: revealPrivateInfo,
      }),
    enabled: Boolean(selectedRef),
  });

  const orders = ordersQuery.data?.orders ?? [];
  const pagination = ordersQuery.data?.pagination;

  const totalPages = Math.max(1, pagination?.totalPages ?? 1);
  const currentPage = pagination?.page ?? page;

  function applyFilters(event) {
    event.preventDefault();
    setRef(refInput.trim());
    setPage(1);
    setSelectedRef("");
    setRevealPrivateInfo(false);
  }

  function clearFilters() {
    setRefInput("");
    setRef("");
    setSellerId("");
    setFrom("");
    setTo("");
    setStatus("");
    setFlag("");
    setPage(1);
    setSelectedRef("");
    setRevealPrivateInfo(false);
  }

  function openOrder(orderRef) {
    setSelectedRef(orderRef);
    setRevealPrivateInfo(false);
  }

  function closeOrder() {
    setSelectedRef("");
    setRevealPrivateInfo(false);
  }

  async function revealDetails() {
    // This deliberately triggers the audited reveal=true request.
    setRevealPrivateInfo(true);
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 px-4 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Orders
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Review orders, investigate flags, and inspect order details.
          </p>
        </div>

        <button
          type="button"
          onClick={() => ordersQuery.refetch()}
          disabled={ordersQuery.isFetching}
          className="inline-flex items-center justify-center rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
        >
          {ordersQuery.isFetching ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      <form
        onSubmit={applyFilters}
        className="space-y-4 rounded-xl border border-border bg-card p-4"
      >
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <label className="space-y-1.5">
            <span className="text-sm font-medium">Order reference</span>
            <input
              value={refInput}
              onChange={(event) => setRefInput(event.target.value)}
              placeholder="Search by order reference"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
            />
          </label>

          <label className="space-y-1.5">
            <span className="text-sm font-medium">Seller ID</span>
            <input
              value={sellerId}
              onChange={(event) => setSellerId(event.target.value)}
              placeholder="Enter seller ID"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
            />
          </label>

          <label className="space-y-1.5">
            <span className="text-sm font-medium">Order status</span>
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
            >
              <option value="">All statuses</option>
              {ORDER_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {STATUS_LABELS[value]}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-1.5">
            <span className="text-sm font-medium">From date</span>
            <input
              type="date"
              value={from}
              max={to || undefined}
              onChange={(event) => setFrom(event.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
            />
          </label>

          <label className="space-y-1.5">
            <span className="text-sm font-medium">To date</span>
            <input
              type="date"
              value={to}
              min={from || undefined}
              onChange={(event) => setTo(event.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
            />
          </label>

          <label className="space-y-1.5">
            <span className="text-sm font-medium">Order flag</span>
            <select
              value={flag}
              onChange={(event) => setFlag(event.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
            >
              <option value="">All orders</option>
              <option value="duplicate">Possible duplicates</option>
              <option value="cancelled">Cancelled orders</option>
              <option value="failed">Failed orders</option>
            </select>
          </label>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
          >
            Apply filters
          </button>
          <button
            type="button"
            onClick={clearFilters}
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-muted"
          >
            Clear filters
          </button>
        </div>
      </form>

      {ordersQuery.isPending ? (
        <div className="rounded-xl border border-border p-10 text-center text-sm text-muted-foreground">
          Loading orders…
        </div>
      ) : ordersQuery.isError ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-5">
          <h2 className="font-semibold text-red-900">Could not load orders</h2>
          <p className="mt-1 text-sm text-red-800">
            {getErrorMessage(ordersQuery.error)}
          </p>
          <button
            type="button"
            onClick={() => ordersQuery.refetch()}
            className="mt-3 rounded-lg border border-red-300 px-3 py-2 text-sm font-medium text-red-900 hover:bg-red-100"
          >
            Try again
          </button>
        </div>
      ) : (
        <>
          <section className="overflow-hidden rounded-xl border border-border bg-card">
            <div className="flex flex-col gap-1 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="font-semibold">Order records</h2>
              <p className="text-sm text-muted-foreground">
                {pagination?.total ?? orders.length} total orders
                {ordersQuery.isFetching ? " · Updating…" : ""}
              </p>
            </div>

            {orders.length === 0 ? (
              <div className="px-4 py-12 text-center">
                <h3 className="font-semibold">No orders found</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Try changing or clearing your filters.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1000px] text-left text-sm">
                  <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3 font-medium">Reference</th>
                      <th className="px-4 py-3 font-medium">Customer</th>
                      <th className="px-4 py-3 font-medium">Seller</th>
                      <th className="px-4 py-3 font-medium">Total</th>
                      <th className="px-4 py-3 font-medium">Status</th>
                      <th className="px-4 py-3 font-medium">Payment</th>
                      <th className="px-4 py-3 font-medium">Flags</th>
                      <th className="px-4 py-3 font-medium">Created</th>
                      <th className="px-4 py-3 font-medium">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {orders.map((order) => (
                      <tr key={order.ref} className="align-top">
                        <td className="px-4 py-4 font-medium">{order.ref}</td>
                        <td className="px-4 py-4">
                          <p className="font-medium">
                            {order.customer?.name || "Unknown"}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {order.customer?.phone || "—"}
                          </p>
                        </td>
                        <td className="px-4 py-4">
                          <p>{order.seller?.businessName || "—"}</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {order.seller?.slug || ""}
                          </p>
                        </td>
                        <td className="whitespace-nowrap px-4 py-4">
                          {formatMoney(order.total)}
                        </td>
                        <td className="px-4 py-4">
                          <StatusBadge status={order.status} />
                        </td>
                        <td className="px-4 py-4">
                          {order.paymentStatus || "—"}
                        </td>
                        <td className="px-4 py-4">
                          <OrderFlags flags={order.flags} />
                        </td>
                        <td className="whitespace-nowrap px-4 py-4 text-muted-foreground">
                          {formatDate(order.createdAt)}
                        </td>
                        <td className="px-4 py-4">
                          <button
                            type="button"
                            onClick={() => openOrder(order.ref)}
                            className="whitespace-nowrap rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted"
                          >
                            View details
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="flex flex-col gap-3 border-t border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground">
                Page {currentPage} of {totalPages}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setPage((value) => Math.max(1, value - 1))}
                  disabled={currentPage <= 1 || ordersQuery.isFetching}
                  className="rounded-lg border border-border px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Previous
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setPage((value) => Math.min(totalPages, value + 1))
                  }
                  disabled={currentPage >= totalPages || ordersQuery.isFetching}
                  className="rounded-lg border border-border px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Next
                </button>
              </div>
            </div>
          </section>
        </>
      )}

      {selectedRef && (
        <section className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-sm text-muted-foreground">Order details</p>
              <h2 className="mt-1 break-all text-xl font-bold">
                {selectedRef}
              </h2>
            </div>
            <button
              type="button"
              onClick={closeOrder}
              className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-muted"
            >
              Close
            </button>
          </div>

          {detailQuery.isPending ? (
            <p className="py-6 text-sm text-muted-foreground">
              Loading order details…
            </p>
          ) : detailQuery.isError ? (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4">
              <p className="text-sm text-red-800">
                {getErrorMessage(detailQuery.error)}
              </p>
              <button
                type="button"
                onClick={() => detailQuery.refetch()}
                className="mt-3 rounded-lg border border-red-300 px-3 py-2 text-sm"
              >
                Try again
              </button>
            </div>
          ) : detailQuery.data ? (
            <OrderDetails
              order={detailQuery.data}
              revealPrivateInfo={revealPrivateInfo}
              onReveal={revealDetails}
              isRevealing={detailQuery.isFetching && revealPrivateInfo}
            />
          ) : null}
        </section>
      )}
    </div>
  );
}

function OrderDetails({ order, revealPrivateInfo, onReveal, isRevealing }) {
  const lines = order.lines ?? [];
  const timeline = order.timeline ?? {};

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-border p-3">
          <p className="text-xs text-muted-foreground">Order total</p>
          <p className="mt-1 font-semibold">{formatMoney(order.total)}</p>
        </div>
        <div className="rounded-lg border border-border p-3">
          <p className="text-xs text-muted-foreground">Order status</p>
          <div className="mt-2">
            <StatusBadge status={order.status} />
          </div>
        </div>
        <div className="rounded-lg border border-border p-3">
          <p className="text-xs text-muted-foreground">Payment status</p>
          <p className="mt-1 font-semibold">{order.paymentStatus || "—"}</p>
        </div>
        <div className="rounded-lg border border-border p-3">
          <p className="text-xs text-muted-foreground">Payment confirmed by</p>
          <p className="mt-1 break-words text-sm font-semibold">
            {order.paymentConfirmedBy || "—"}
          </p>
        </div>
      </div>

      <div>
        <h3 className="font-semibold">Customer and delivery</h3>
        <dl className="mt-2">
          <DetailRow label="Customer">{order.customer?.name || "—"}</DetailRow>
          <DetailRow label="Phone">
            {order.customer?.phone || "Not provided"}
          </DetailRow>
          <DetailRow label="Delivery area">
            {order.delivery?.area || "—"}
          </DetailRow>
          <DetailRow label="Delivery day">
            {order.delivery?.day || "—"}
          </DetailRow>
          <DetailRow label="Delivery address">
            {order.delivery?.address || "Hidden for privacy"}
          </DetailRow>
          <DetailRow label="Customer note">
            {order.note || "No note available"}
          </DetailRow>
        </dl>

        {!revealPrivateInfo && (
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4">
            <p className="text-sm text-amber-900">
              Full phone number, delivery address, and customer note are
              private. Revealing them is recorded in the admin audit log.
            </p>
            <button
              type="button"
              onClick={onReveal}
              disabled={isRevealing}
              className="mt-3 rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm font-semibold text-amber-900 disabled:opacity-60"
            >
              {isRevealing ? "Revealing…" : "Reveal private details"}
            </button>
          </div>
        )}
      </div>

      <div>
        <h3 className="font-semibold">Items ordered</h3>
        {lines.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            No line items were returned.
          </p>
        ) : (
          <div className="mt-2 overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[400px] text-left text-sm">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Item</th>
                  <th className="px-3 py-2 font-medium">Unit price</th>
                  <th className="px-3 py-2 font-medium">Quantity</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {lines.map((line, index) => (
                  <tr key={`${line.name}-${index}`}>
                    <td className="px-3 py-3">{line.name}</td>
                    <td className="px-3 py-3">{formatMoney(line.unitPrice)}</td>
                    <td className="px-3 py-3">{line.qty}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div>
        <h3 className="font-semibold">Order timeline</h3>
        <dl className="mt-2">
          <DetailRow label="Created">
            {formatDate(timeline.createdAt)}
          </DetailRow>
          <DetailRow label="Paid">{formatDate(timeline.paidAt)}</DetailRow>
          <DetailRow label="Out for delivery">
            {formatDate(timeline.outForDeliveryAt)}
          </DetailRow>
          <DetailRow label="Delivered">
            {formatDate(timeline.deliveredAt)}
          </DetailRow>
          <DetailRow label="Cancelled">
            {formatDate(timeline.cancelledAt)}
          </DetailRow>
        </dl>
      </div>

      {order.similarOrders?.length > 0 && (
        <div>
          <h3 className="font-semibold">Similar orders</h3>
          <ul className="mt-2 space-y-2">
            {order.similarOrders.map((similar) => (
              <li
                key={similar.ref}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3 text-sm"
              >
                <span className="font-medium">{similar.ref}</span>
                <StatusBadge status={similar.status} />
                <span className="text-muted-foreground">
                  {formatDate(similar.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h3 className="font-semibold">Order flags</h3>
        <div className="mt-2">
          <OrderFlags flags={order.flags} />
        </div>
      </div>
    </div>
  );
}
