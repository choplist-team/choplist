
import { useEffect, useState } from "react";
import { useAuth } from "@clerk/react";
import {
  Users,
  Store,
  ShoppingBag,
  ClipboardList,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  Truck,
} from "lucide-react";

import { getAdminOverview } from "@/api/admin-api";
import { ApiError } from "@/api/api-client";

const metrics = [
  {
    key: "totalSellers",
    label: "Total sellers",
    icon: Users,
    description: "All registered sellers",
  },
  {
    key: "activeSellers",
    label: "Active sellers",
    icon: Store,
    description: "Currently active sellers",
  },
  {
    key: "publishedMenus",
    label: "Published menus",
    icon: ClipboardList,
    description: "Menus published on ChopList",
  },
  {
    key: "openMenus",
    label: "Open menus",
    icon: Store,
    description: "Menus currently open for orders",
  },
  {
    key: "totalOrders",
    label: "Total orders",
    icon: ShoppingBag,
    description: "Total orders recorded by the platform",
  },
  {
    key: "ordersLast7Days",
    label: "Orders · 7 days",
    icon: ShoppingBag,
    description: "Orders in the last 7 days",
  },
  {
    key: "ordersLast30Days",
    label: "Orders · 30 days",
    icon: ClipboardList,
    description: "Orders in the last 30 days",
  },
];

function formatNumber(value) {
  return new Intl.NumberFormat("en-NG").format(value);
}

function formatRate(value) {
  if (value === null || value === undefined) {
    return "No data yet";
  }

  return new Intl.NumberFormat("en-NG", {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(value);
}

function MetricCard({ label, value, description, icon: Icon }) {
  return (
    <article className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-muted-foreground">
          {label}
        </p>

        <span className="rounded-lg bg-soft-green p-2 text-primary">
          <Icon size={19} aria-hidden="true" />
        </span>
      </div>

      <p className="mt-5 text-2xl font-bold tracking-tight">
        {value}
      </p>

      <p className="mt-2 text-xs text-muted-foreground">
        {description}
      </p>
    </article>
  );
}

export default function AdminOverview() {
  const { getToken, isLoaded, isSignedIn } = useAuth();

  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!isLoaded || !isSignedIn) {
      return;
    }

    let cancelled = false;

    async function fetchOverview() {
      setLoading(true);
      setError(null);

      try {
        const data = await getAdminOverview(getToken);

        if (!cancelled) {
          setOverview(data);
        }
      } catch (err) {
        if (cancelled) {
          return;
        }

        setOverview(null);

        if (err instanceof ApiError && err.status === 403) {
          setError(
            "Access denied. Your account is not authorized to access the admin dashboard."
          );
        } else if (err instanceof ApiError && err.status === 401) {
          setError(
            "Your session is missing or has expired. Please sign in again."
          );
        } else {
          setError(err.message || "Unable to load dashboard data.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    fetchOverview();

    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn, getToken]);

  async function handleRefresh() {
    setLoading(true);
    setError(null);

    try {
      const data = await getAdminOverview(getToken);
      setOverview(data);
    } catch (err) {
      setOverview(null);

      if (err instanceof ApiError && err.status === 403) {
        setError(
          "Access denied. Your account is not authorized to access the admin dashboard."
        );
      } else if (err instanceof ApiError && err.status === 401) {
        setError(
          "Your session is missing or has expired. Please sign in again."
        );
      } else {
        setError(err.message || "Unable to load dashboard data.");
      }
    } finally {
      setLoading(false);
    }
  }

  if (!isLoaded) {
    return (
      <div className="flex min-h-64 items-center justify-center p-6">
        <p className="text-sm text-muted-foreground">
          Checking authentication...
        </p>
      </div>
    );
  }

  if (!isSignedIn) {
    return (
      <section className="p-6 lg:p-8">
        <div
          role="alert"
          className="max-w-2xl rounded-xl border border-border bg-card p-5"
        >
          <h1 className="font-semibold">
            Sign-in required
          </h1>

          <p className="mt-2 text-sm text-muted-foreground">
            Please sign in to access the admin dashboard.
          </p>
        </div>
      </section>
    );
  }

  if (loading && !overview) {
    return (
      <div className="flex min-h-64 items-center justify-center gap-3 p-6">
        <RefreshCw size={20} className="animate-spin" />
        <p className="text-sm text-muted-foreground">
          Loading admin overview...
        </p>
      </div>
    );
  }

  if (error && !overview) {
    return (
      <section className="p-6 lg:p-8">
        <div
          role="alert"
          className="flex max-w-2xl items-start gap-3 rounded-xl border border-border bg-card p-5"
        >
          <AlertCircle
            size={22}
            className="mt-0.5 shrink-0 text-destructive"
          />

          <div>
            <h1 className="font-semibold">
              Unable to load admin overview
            </h1>

            <p className="mt-2 text-sm text-muted-foreground">
              {error}
            </p>

            <button
              type="button"
              onClick={handleRefresh}
              disabled={loading}
              className="mt-4 inline-flex min-h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
            >
              <RefreshCw
                size={16}
                className={loading ? "animate-spin" : ""}
              />
              Try again
            </button>
          </div>
        </div>
      </section>
    );
  }

  if (!overview) {
    return null;
  }

  return (
    <section className="p-6 lg:p-8">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <p className="text-sm font-medium text-primary">
            PLATFORM OVERVIEW
          </p>

          <h1 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">
            Admin dashboard
          </h1>

          <p className="mt-2 text-sm text-muted-foreground">
            Monitor ChopList sellers, menus, and orders.
          </p>
        </div>

        <button
          type="button"
          onClick={handleRefresh}
          disabled={loading}
          className="inline-flex min-h-10 items-center justify-center gap-2 self-start rounded-lg border border-border px-4 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
        >
          <RefreshCw
            size={16}
            className={loading ? "animate-spin" : ""}
          />
          {loading ? "Refreshing..." : "Refresh data"}
        </button>
      </div>

      {error && (
        <div
          role="alert"
          className="mt-6 rounded-xl border border-border p-4 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {metrics.map((metric) => {
          const value = overview[metric.key];

          return (
            <MetricCard
              key={metric.key}
              {...metric}
              value={
                typeof value === "number"
                  ? formatNumber(value)
                  : "—"
              }
            />
          );
        })}
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
        <MetricCard
          label="Order success rate"
          value={formatRate(overview.successRate)}
          description="Based on the backend's order success definition"
          icon={CheckCircle2}
        />

        <MetricCard
          label="Fulfilment rate"
          value={formatRate(overview.fulfilmentRate)}
          description="Based on the backend's fulfilment definition"
          icon={Truck}
        />
      </div>

      {typeof overview.ordersCounted === "number" && (
        <p className="mt-5 text-xs text-muted-foreground">
          Rate calculations are based on{" "}
          {formatNumber(overview.ordersCounted)} counted orders.
        </p>
      )}

      {overview.generatedAt && (
        <p className="mt-2 text-xs text-muted-foreground">
          Last updated:{" "}
          {new Date(overview.generatedAt).toLocaleString("en-NG", {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </p>
      )}
    </section>
  );
}
