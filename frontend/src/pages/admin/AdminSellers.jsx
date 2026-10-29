import { useDeferredValue, useState } from "react";
import { useAuth } from "@clerk/react";
import { useQuery } from "@tanstack/react-query";
import {
  Search,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  Store,
  AlertCircle,
} from "lucide-react";

import { getAdminSellers } from "@/api/admin-api";
import { Link } from "react-router-dom";

const PAGE_SIZE = 20;

const STATUS_OPTIONS = [
  { label: "All statuses", value: "" },
  { label: "Active", value: "active" },
  { label: "Suspended", value: "suspended" },
  { label: "Deactivated", value: "deactivated" },
];

function formatDate(value) {
  if (!value) return "—";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "—";

  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

function formatDateTime(value) {
  if (!value) return "—";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "—";

  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatStatus(status) {
  if (!status) return "Unknown";

  return status.charAt(0).toUpperCase() + status.slice(1);
}

function StatusBadge({ status }) {
  const styles = {
    active: "bg-green-100 text-green-800",
    suspended: "bg-amber-100 text-amber-800",
    deactivated: "bg-red-100 text-red-800",
  };

  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${
        styles[status] ?? "bg-gray-100 text-gray-700"
      }`}
    >
      {formatStatus(status)}
    </span>
  );
}

function getErrorMessage(error) {
  if (error?.status === 401) {
    return "Your session is not authenticated. Please sign in again.";
  }

  if (error?.status === 403) {
    return "Your account does not have admin access yet. Ask the backend engineer to authorize your Clerk user ID.";
  }

  if (error?.status === 0) {
    return "Could not connect to the API. Check your connection and API base URL.";
  }

  return error?.message ?? "Unable to load sellers. Please try again.";
}

export default function AdminSellers() {
  const { getToken } = useAuth();

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);

  const deferredSearch = useDeferredValue(search.trim());

  const { data, error, isPending, isFetching, isError, refetch } = useQuery({
    queryKey: ["admin", "sellers", deferredSearch, status, page],
    queryFn: () =>
      getAdminSellers(getToken, {
        q: deferredSearch,
        status,
        page,
        limit: PAGE_SIZE,
      }),
    retry: (failureCount, queryError) => {
      if (queryError?.status === 401 || queryError?.status === 403) {
        return false;
      }

      return failureCount < 2;
    },
  });

  const sellers = Array.isArray(data?.sellers) ? data.sellers : [];
  const pagination = data?.pagination;

  const total = pagination?.total ?? 0;
  const totalPages = Math.max(pagination?.totalPages ?? 1, 1);
  const currentPage = pagination?.page ?? page;

  function handleSearchChange(event) {
    setSearch(event.target.value);
    setPage(1);
  }

  function handleStatusChange(event) {
    setStatus(event.target.value);
    setPage(1);
  }

  function handlePreviousPage() {
    setPage((current) => Math.max(1, current - 1));
  }

  function handleNextPage() {
    setPage((current) => Math.min(totalPages, current + 1));
  }

  return (
    <section className="mx-auto w-full max-w-7xl space-y-6 px-4 sm:px-6 lg:px-8">
      {/* Page heading */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Sellers
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            View seller accounts and their activity on ChopList.
          </p>
        </div>

        <button
          type="button"
          onClick={() => refetch()}
          disabled={isFetching}
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
        >
          <RefreshCw size={16} className={isFetching ? "animate-spin" : ""} />
          Refresh
        </button>
      </div>

      {/* Search and status filter */}
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_190px]">
        <label className="relative block">
          <span className="sr-only">Search sellers</span>
          <Search
            size={18}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="search"
            value={search}
            onChange={handleSearchChange}
            placeholder="Search business, shop link, email or phone"
            className="w-full rounded-lg border border-border bg-background py-2.5 pl-10 pr-3 text-sm outline-none transition placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
        </label>

        <label>
          <span className="sr-only">Filter by seller status</span>
          <select
            value={status}
            onChange={handleStatusChange}
            className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* API error */}
      {isError && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800"
        >
          <AlertCircle size={20} className="mt-0.5 shrink-0" />

          <div className="min-w-0 flex-1">
            <p className="font-semibold">Could not load sellers</p>
            <p className="mt-1">{getErrorMessage(error)}</p>

            <button
              type="button"
              onClick={() => refetch()}
              className="mt-3 font-semibold underline underline-offset-2"
            >
              Try again
            </button>
          </div>
        </div>
      )}

      {/* Seller directory */}
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
          <div>
            <h2 className="font-semibold text-foreground">Seller directory</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {isPending
                ? "Loading seller records…"
                : `${total.toLocaleString()} seller${
                    total === 1 ? "" : "s"
                  } found`}
            </p>
          </div>

          {isFetching && !isPending && (
            <span className="text-xs text-muted-foreground">Updating…</span>
          )}
        </div>

        {isPending ? (
          <div className="space-y-4 p-5" aria-label="Loading sellers">
            {Array.from({ length: 5 }, (_, index) => (
              <div
                key={index}
                className="h-12 animate-pulse rounded-md bg-muted"
              />
            ))}
          </div>
        ) : !isError && sellers.length === 0 ? (
          <div className="flex flex-col items-center px-6 py-14 text-center">
            <div className="mb-3 rounded-full bg-muted p-3">
              <Store size={24} className="text-muted-foreground" />
            </div>

            <h3 className="font-semibold text-foreground">No sellers found</h3>

            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              {search || status
                ? "Try changing your search or status filter."
                : "No seller records were returned by the API."}
            </p>
          </div>
        ) : !isError ? (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1050px] text-left text-sm">
                <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-5 py-3 font-medium">Business</th>
                    <th className="px-5 py-3 font-medium">Contact</th>
                    <th className="px-5 py-3 font-medium">Status</th>
                    <th className="px-5 py-3 font-medium">Orders</th>
                    <th className="px-5 py-3 font-medium">Last active</th>
                    <th className="px-5 py-3 font-medium">Registered</th>
                    <th className="px-5 py-3 font-medium">Open menu</th>
                    <th className="px-5 py-3 font-medium">Shop slug</th>
                  </tr>
                </thead>

                <tbody className="divide-y divide-border">
                  {sellers.map((seller) => (
                    <tr
                      key={seller.id}
                      className="transition hover:bg-muted/30"
                    >
                      <td className="px-5 py-4">
                        <Link
                          to={`/admin/sellers/${encodeURIComponent(seller.id)}`}
                          className="font-medium text-primary hover:underline"
                        >
                          {seller.businessName || "Unnamed business"}
                        </Link>

                        {seller.statusReason && (
                          <p
                            className="mt-1 max-w-xs truncate text-xs text-muted-foreground"
                            title={seller.statusReason}
                          >
                            Reason: {seller.statusReason}
                          </p>
                        )}
                      </td>

                      <td className="px-5 py-4">
                        <p className="text-foreground">{seller.email || "—"}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {seller.phone || "—"}
                        </p>
                      </td>

                      <td className="px-5 py-4">
                        <StatusBadge status={seller.status} />

                        {seller.statusChangedAt && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            Updated {formatDate(seller.statusChangedAt)}
                          </p>
                        )}
                      </td>

                      <td className="px-5 py-4 tabular-nums text-foreground">
                        {typeof seller.totalOrders === "number"
                          ? seller.totalOrders.toLocaleString()
                          : "—"}
                      </td>

                      <td className="px-5 py-4 text-muted-foreground">
                        {formatDateTime(seller.lastActiveAt)}
                      </td>

                      <td className="px-5 py-4 text-muted-foreground">
                        {formatDate(seller.registeredAt)}
                      </td>

                      <td className="px-5 py-4">
                        {seller.openMenu ? (
                          <div>
                            <p className="font-medium text-foreground">
                              {seller.openMenu.title || "Untitled menu"}
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              Cutoff: {formatDateTime(seller.openMenu.cutoffAt)}
                            </p>
                          </div>
                        ) : (
                          <span className="text-muted-foreground">
                            No open menu
                          </span>
                        )}
                      </td>

                      <td className="px-5 py-4">
                        <span className="text-foreground">
                          {seller.slug || "—"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <div className="flex flex-col gap-3 border-t border-border px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
              <p className="text-sm text-muted-foreground">
                Page {currentPage} of {totalPages}
              </p>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handlePreviousPage}
                  disabled={currentPage <= 1 || isFetching}
                  className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <ChevronLeft size={16} />
                  Previous
                </button>

                <button
                  type="button"
                  onClick={handleNextPage}
                  disabled={currentPage >= totalPages || isFetching}
                  className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Next
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}
