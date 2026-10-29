import { Link, useParams } from "react-router-dom";
import { useAuth } from "@clerk/react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  AlertCircle,
  RefreshCw,
  Store,
  ShoppingBag,
  CalendarDays,
  Clock3,
  Utensils,
} from "lucide-react";

import { getAdminSeller } from "@/api/admin-api";

const ORDER_STATUSES = [
  { key: "total", label: "Total orders" },
  { key: "pending", label: "Pending" },
  { key: "paid", label: "Paid" },
  { key: "out_for_delivery", label: "Out for delivery" },
  { key: "delivered", label: "Delivered" },
  { key: "cancelled", label: "Cancelled" },
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

function formatStatus(value) {
  if (!value) return "Unknown";

  return value
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function StatusBadge({ status }) {
  const styles = {
    active: "bg-green-100 text-green-800",
    suspended: "bg-amber-100 text-amber-800",
    deactivated: "bg-red-100 text-red-800",
    open: "bg-green-100 text-green-800",
    draft: "bg-gray-100 text-gray-700",
    closed: "bg-gray-100 text-gray-700",
  };

  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${
        styles[status] ?? "bg-muted text-muted-foreground"
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
    return "Your account does not have admin access. Ask the backend engineer to authorize your Clerk user ID.";
  }

  if (error?.status === 404) {
    return "This seller could not be found. They may no longer exist or the seller ID may be invalid.";
  }

  if (error?.status === 0) {
    return "Could not connect to the API. Check your connection and API base URL.";
  }

  return error?.message ?? "Unable to load seller details. Please try again.";
}

function InfoItem({ label, value }) {
  return (
    <div className="min-w-0">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 break-words font-medium text-foreground">
        {value || "—"}
      </p>
    </div>
  );
}

export default function SellerDetails() {
  const { sellerId } = useParams();
  const { getToken } = useAuth();

  const {
    data: seller,
    error,
    isPending,
    isFetching,
    isError,
    refetch,
  } = useQuery({
    queryKey: ["admin", "seller", sellerId],
    queryFn: () => getAdminSeller(getToken, sellerId),
    enabled: Boolean(sellerId),
    retry: (failureCount, queryError) => {
      if (
        queryError?.status === 401 ||
        queryError?.status === 403 ||
        queryError?.status === 404
      ) {
        return false;
      }

      return failureCount < 2;
    },
  });

  if (isPending) {
    return (
      <section className="mx-auto w-full max-w-7xl space-y-6 px-4 py-2 sm:px-6 lg:px-8">
        <Link
          to="/admin/sellers"
          className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={16} />
          Back to sellers
        </Link>

        <div className="space-y-4">
          <div className="h-8 w-56 animate-pulse rounded-md bg-muted" />
          <div className="h-4 w-72 max-w-full animate-pulse rounded-md bg-muted" />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }, (_, index) => (
              <div
                key={index}
                className="h-28 animate-pulse rounded-xl border border-border bg-card"
              />
            ))}
          </div>
        </div>
      </section>
    );
  }

  if (isError || !seller) {
    return (
      <section className="mx-auto w-full max-w-7xl space-y-6 px-4 py-2 sm:px-6 lg:px-8">
        <Link
          to="/admin/sellers"
          className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={16} />
          Back to sellers
        </Link>

        <div
          role="alert"
          className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800"
        >
          <AlertCircle size={20} className="mt-0.5 shrink-0" />

          <div className="min-w-0 flex-1">
            <h1 className="font-semibold">Could not load seller details</h1>
            <p className="mt-1">{getErrorMessage(error)}</p>

            <button
              type="button"
              onClick={() => refetch()}
              className="mt-3 inline-flex items-center gap-2 font-semibold underline underline-offset-2"
            >
              <RefreshCw size={14} />
              Try again
            </button>
          </div>
        </div>
      </section>
    );
  }

  const orders = seller.orders ?? {};
  const menus = Array.isArray(seller.menus) ? seller.menus : [];

  return (
    <section className="mx-auto w-full max-w-7xl space-y-6 px-4 py-2 sm:px-6 lg:px-8">
      {/* Breadcrumb and refresh */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Link
          to="/admin/sellers"
          className="inline-flex w-fit items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={16} />
          Back to sellers
        </Link>

        <button
          type="button"
          onClick={() => refetch()}
          disabled={isFetching}
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
        >
          <RefreshCw
            size={16}
            className={isFetching ? "animate-spin" : ""}
          />
          Refresh
        </button>
      </div>

      {/* Seller heading */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-muted p-3">
            <Store size={25} className="text-muted-foreground" />
          </div>

          <div className="min-w-0">
            <h1 className="break-words text-2xl font-semibold tracking-tight text-foreground">
              {seller.businessName || "Unnamed business"}
            </h1>

            <p className="mt-1 text-sm text-muted-foreground">
              Seller details and account activity
            </p>

            {seller.slug && (
              <p className="mt-2 text-sm text-muted-foreground">
                Shop slug: <span className="font-medium text-foreground">{seller.slug}</span>
              </p>
            )}
          </div>
        </div>

        <StatusBadge status={seller.status} />
      </div>

      {/* Seller information */}
      <div className="rounded-xl border border-border bg-card p-5 sm:p-6">
        <h2 className="font-semibold text-foreground">Seller information</h2>

        <div className="mt-5 grid gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
          <InfoItem label="Business name" value={seller.businessName} />
          <InfoItem label="Email" value={seller.email} />
          <InfoItem label="Phone" value={seller.phone} />
          <InfoItem label="Registered" value={formatDate(seller.registeredAt)} />
          <InfoItem label="Last active" value={formatDateTime(seller.lastActiveAt)} />
          <InfoItem
            label="Status last changed"
            value={formatDateTime(seller.statusChangedAt)}
          />
        </div>

        {seller.statusReason && (
          <div className="mt-5 rounded-lg bg-muted/50 p-4">
            <p className="text-sm font-medium text-foreground">Status reason</p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
              {seller.statusReason}
            </p>
          </div>
        )}
      </div>

      {/* Order summary */}
      <div>
        <div className="mb-4 flex items-center gap-2">
          <ShoppingBag size={19} className="text-muted-foreground" />
          <h2 className="font-semibold text-foreground">Order summary</h2>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {ORDER_STATUSES.map((item) => (
            <div
              key={item.key}
              className="rounded-xl border border-border bg-card p-5"
            >
              <p className="text-sm text-muted-foreground">{item.label}</p>
              <p className="mt-2 text-2xl font-semibold tabular-nums text-foreground">
                {typeof orders[item.key] === "number"
                  ? orders[item.key].toLocaleString()
                  : "—"}
              </p>
            </div>
          ))}
        </div>

        <p className="mt-3 text-sm text-muted-foreground">
          Last order: {formatDateTime(orders.lastOrderAt)}
        </p>
      </div>

      {/* Menus */}
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <Utensils size={19} className="text-muted-foreground" />
            <h2 className="font-semibold text-foreground">Seller menus</h2>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Up to the 50 most recently created menus, as returned by the API.
          </p>
        </div>

        {menus.length === 0 ? (
          <div className="flex flex-col items-center px-6 py-12 text-center">
            <div className="mb-3 rounded-full bg-muted p-3">
              <Utensils size={23} className="text-muted-foreground" />
            </div>
            <h3 className="font-semibold text-foreground">No menus found</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              The API did not return any menus for this seller.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {menus.map((menu) => (
              <article key={menu.id} className="p-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <h3 className="break-words font-medium text-foreground">
                      {menu.title || "Untitled menu"}
                    </h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {typeof menu.itemCount === "number"
                        ? `${menu.itemCount} item${menu.itemCount === 1 ? "" : "s"}`
                        : "Item count unavailable"}
                    </p>
                  </div>

                  <StatusBadge status={menu.status} />
                </div>

                <div className="mt-4 grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
                  <div>
                    <p className="flex items-center gap-2 text-muted-foreground">
                      <CalendarDays size={15} />
                      Created
                    </p>
                    <p className="mt-1 font-medium text-foreground">
                      {formatDateTime(menu.createdAt)}
                    </p>
                  </div>

                  <div>
                    <p className="flex items-center gap-2 text-muted-foreground">
                      <Clock3 size={15} />
                      Cutoff
                    </p>
                    <p className="mt-1 font-medium text-foreground">
                      {formatDateTime(menu.cutoffAt)}
                    </p>
                  </div>

                  <div>
                    <p className="text-muted-foreground">Opened</p>
                    <p className="mt-1 font-medium text-foreground">
                      {formatDateTime(menu.openedAt)}
                    </p>
                  </div>

                  <div>
                    <p className="text-muted-foreground">Closed</p>
                    <p className="mt-1 font-medium text-foreground">
                      {formatDateTime(menu.closedAt)}
                    </p>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}