
import { useMemo, useState } from "react";
import { useAuth } from "@clerk/react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  BarChart3,
  CalendarDays,
  RefreshCw,
  ShoppingBag,
  Users,
  X,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  getAdminCustomerAnalytics,
  getAdminItemAnalytics,
  getAdminMenuAnalytics,
} from "@/api/admin-api";

const MENU_PAGE_SIZE = 20;
const ITEM_PAGE_SIZE = 10;

const COLORS = {
  primary: "#315B40",
  secondary: "#91B69A",
  soft: "#E8EEE2",
  muted: "#72766B",
  border: "#E1E1D6",
  text: "#242B24",
  background: "#FFFDF8",
  accent: "#C9A56A",
};

function formatMoney(value) {
  if (value == null || !Number.isFinite(Number(value))) return "—";

  return new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    maximumFractionDigits: 0,
  }).format(Number(value));
}

function formatNumber(value) {
  if (value == null || !Number.isFinite(Number(value))) return "—";

  return new Intl.NumberFormat("en-NG").format(Number(value));
}

function formatPercent(value) {
  if (value == null || !Number.isFinite(Number(value))) return "—";

  return `${(Number(value) * 100).toFixed(1)}%`;
}

function getErrorMessage(error) {
  if (error?.status === 401) {
    return "Your session may have expired. Please sign in again.";
  }

  if (error?.status === 403) {
    return "You do not have permission to access admin analytics.";
  }

  return error?.message || "Something went wrong. Please try again.";
}

function Panel({ children, className = "" }) {
  return (
    <div
      className={`min-w-0 rounded-2xl border border-border bg-card ${className}`}
    >
      {children}
    </div>
  );
}

function PanelHeading({ title, description, action }) {
  return (
    <div className="flex flex-col gap-2 px-5 pt-5 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h2 className="font-semibold tracking-tight text-foreground">
          {title}
        </h2>
        {description && (
          <p className="mt-1 text-sm leading-5 text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {action}
    </div>
  );
}

function MetricCard({
  label,
  value,
  description,
  icon: Icon,
  tone = "green",
}) {
  const iconStyle =
    tone === "gold"
      ? "bg-[#FAEDD7] text-[#8B5A20]"
      : tone === "neutral"
        ? "bg-[#F0F0E9] text-[#72766B]"
        : "bg-[#E8EEE2] text-[#315B40]";

  return (
    <div className="min-w-0 rounded-2xl border border-border bg-card p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-muted-foreground">{label}</p>

        {Icon && (
          <div className={`rounded-xl p-2 ${iconStyle}`}>
            <Icon size={18} strokeWidth={1.8} />
          </div>
        )}
      </div>

      <p className="mt-4 break-words text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
        {value}
      </p>

      {description && (
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          {description}
        </p>
      )}
    </div>
  );
}

function SectionState({ query, onRetry }) {
  if (query.isPending) {
    return (
      <div className="flex min-h-48 flex-col items-center justify-center gap-3 p-6 text-center">
        <RefreshCw
          className="animate-spin text-primary"
          size={22}
        />
        <p className="text-sm text-muted-foreground">
          Loading analytics...
        </p>
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="p-5">
        <p className="text-sm text-red-700">
          {getErrorMessage(query.error)}
        </p>

        <button
          type="button"
          onClick={onRetry}
          className="mt-3 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted"
        >
          Try again
        </button>
      </div>
    );
  }

  return null;
}

function EmptyChart({ message }) {
  return (
    <div className="flex min-h-64 items-center justify-center px-6 text-center">
      <div>
        <BarChart3
          className="mx-auto text-muted-foreground"
          size={30}
          strokeWidth={1.5}
        />
        <p className="mt-3 text-sm text-muted-foreground">{message}</p>
      </div>
    </div>
  );
}

function ChartTooltip({ active, payload, label, formatter }) {
  if (!active || !payload?.length) return null;

  return (
    <div className="rounded-xl border border-border bg-white p-3 shadow-lg">
      {label != null && (
        <p className="mb-2 max-w-56 truncate text-sm font-semibold text-foreground">
          {label}
        </p>
      )}

      <div className="space-y-1.5">
        {payload.map((entry, index) => (
          <div
            key={`${entry.dataKey}-${index}`}
            className="flex items-center justify-between gap-5 text-xs"
          >
            <span className="flex items-center gap-2 text-muted-foreground">
              <span
                className="h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: entry.color || entry.fill }}
              />
              {entry.name}
            </span>

            <span className="font-semibold text-foreground">
              {formatter
                ? formatter(entry.value, entry.name)
                : formatNumber(entry.value)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Pagination({ pagination, page, setPage, isFetching }) {
  const currentPage = pagination?.page ?? page;
  const totalPages = Math.max(1, pagination?.totalPages ?? 1);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
      <p className="text-xs text-muted-foreground sm:text-sm">
        {formatNumber(pagination?.total ?? 0)} records · Page{" "}
        {currentPage} of {totalPages}
      </p>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setPage((current) => Math.max(1, current - 1))}
          disabled={currentPage <= 1 || isFetching}
          className="rounded-lg border border-border px-3 py-2 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
        >
          Previous
        </button>

        <button
          type="button"
          onClick={() =>
            setPage((current) => Math.min(totalPages, current + 1))
          }
          disabled={currentPage >= totalPages || isFetching}
          className="rounded-lg border border-border px-3 py-2 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </div>
  );
}

function ChartLegend({ items }) {
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-2 px-5 pb-4 pt-2">
      {items.map((item) => (
        <div key={item.label} className="flex items-center gap-2">
          <span
            className="h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: item.color }}
          />
          <span className="text-xs text-muted-foreground">
            {item.label}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function AdminAnalytics() {
  const { getToken } = useAuth();

  const [fromInput, setFromInput] = useState("");
  const [toInput, setToInput] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sellerInput, setSellerInput] = useState("");
  const [sellerId, setSellerId] = useState("");
  const [menuPage, setMenuPage] = useState(1);
  const [itemPage, setItemPage] = useState(1);

  const menuQuery = useQuery({
    queryKey: ["admin", "analytics", "menus", { from, to, menuPage }],
    queryFn: () =>
      getAdminMenuAnalytics(getToken, {
        from,
        to,
        page: menuPage,
        limit: MENU_PAGE_SIZE,
      }),
  });

  const itemQuery = useQuery({
    queryKey: [
      "admin",
      "analytics",
      "items",
      { from, to, sellerId, itemPage },
    ],
    queryFn: () =>
      getAdminItemAnalytics(getToken, {
        from,
        to,
        sellerId,
        page: itemPage,
        limit: ITEM_PAGE_SIZE,
      }),
  });

  const customerQuery = useQuery({
    queryKey: ["admin", "analytics", "customers", { from, to }],
    queryFn: () => getAdminCustomerAnalytics(getToken, { from, to }),
  });

  const menuData = menuQuery.data;
  const itemData = itemQuery.data;
  const customerData = customerQuery.data;

  const menuChartData = useMemo(() => {
    return (menuData?.sellers ?? [])
      .map((entry) => ({
        name: entry.seller?.businessName || "Unnamed seller",
        views: Number(entry.views) || 0,
        orders: Number(entry.orders) || 0,
      }))
      .sort((a, b) => b.views - a.views);
  }, [menuData]);

  const itemChartData = useMemo(() => {
    return (itemData?.items ?? [])
      .map((item) => ({
        name: item.name || "Unnamed item",
        portions: Number(item.portions) || 0,
      }))
      .sort((a, b) => b.portions - a.portions);
  }, [itemData]);

  const customerChartData = useMemo(() => {
    const newCustomers = Number(customerData?.customers?.new) || 0;
    const returningCustomers =
      Number(customerData?.customers?.returning) || 0;

    return [
      { name: "New customers", value: newCustomers, color: COLORS.primary },
      {
        name: "Returning customers",
        value: returningCustomers,
        color: COLORS.secondary,
      },
    ];
  }, [customerData]);

  const orderChartData = useMemo(() => {
    return [
      {
        name: "First orders",
        orders: Number(customerData?.orders?.firstOrders) || 0,
      },
      {
        name: "Repeat orders",
        orders: Number(customerData?.orders?.repeatOrders) || 0,
      },
    ];
  }, [customerData]);

  const isRefreshing =
    menuQuery.isFetching ||
    itemQuery.isFetching ||
    customerQuery.isFetching;

  async function handleRefresh() {
    await Promise.all([
      menuQuery.refetch(),
      itemQuery.refetch(),
      customerQuery.refetch(),
    ]);
  }

  function applyFilters(event) {
    event.preventDefault();

    setFrom(fromInput);
    setTo(toInput);
    setSellerId(sellerInput.trim());
    setMenuPage(1);
    setItemPage(1);
  }

  function clearFilters() {
    setFromInput("");
    setToInput("");
    setFrom("");
    setTo("");
    setSellerInput("");
    setSellerId("");
    setMenuPage(1);
    setItemPage(1);
  }

  const hasActiveFilters = Boolean(from || to || sellerId);

  return (
    <div className="mx-auto w-full max-w-7xl space-y-7 px-4 pb-10 pt-2 sm:px-6 lg:px-8">
      {/* Page heading */}
      <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-primary">
            <span className="h-2 w-2 rounded-full bg-primary" />
            ChopList insights
          </div>

          <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
            Analytics overview
          </h1>

          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Understand seller performance, discover popular menu items,
            and track customer retention.
          </p>
        </div>

        <button
          type="button"
          onClick={handleRefresh}
          disabled={isRefreshing}
          className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl border border-border bg-card px-4 py-2.5 text-sm font-semibold text-foreground transition hover:bg-muted disabled:cursor-wait disabled:opacity-60"
        >
          <RefreshCw
            size={16}
            className={isRefreshing ? "animate-spin" : ""}
          />
          {isRefreshing ? "Refreshing..." : "Refresh data"}
        </button>
      </header>

      {/* Filters */}
      <Panel className="p-4 sm:p-5">
        <div className="mb-4 flex items-center gap-2">
          <CalendarDays size={18} className="text-primary" />
          <h2 className="font-semibold text-foreground">Analytics filters</h2>
          {hasActiveFilters && (
            <span className="rounded-full bg-soft-green px-2.5 py-1 text-xs font-medium text-primary">
              Filters applied
            </span>
          )}
        </div>

        <form onSubmit={applyFilters} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <label className="min-w-0 space-y-1.5">
              <span className="text-sm font-medium text-foreground">
                From date
              </span>
              <input
                type="date"
                value={fromInput}
                max={toInput || undefined}
                onChange={(event) => setFromInput(event.target.value)}
                className="w-full min-w-0 rounded-xl border border-border bg-background px-3 py-2.5 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15"
              />
            </label>

            <label className="min-w-0 space-y-1.5">
              <span className="text-sm font-medium text-foreground">
                To date
              </span>
              <input
                type="date"
                value={toInput}
                min={fromInput || undefined}
                onChange={(event) => setToInput(event.target.value)}
                className="w-full min-w-0 rounded-xl border border-border bg-background px-3 py-2.5 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15"
              />
            </label>

            <label className="min-w-0 space-y-1.5">
              <span className="text-sm font-medium text-foreground">
                Seller ID
              </span>
              <input
                value={sellerInput}
                onChange={(event) => setSellerInput(event.target.value)}
                placeholder="Filter popular items by seller"
                className="w-full min-w-0 rounded-xl border border-border bg-background px-3 py-2.5 text-sm outline-none transition placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/15"
              />
            </label>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              className="rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-90"
            >
              Apply filters
            </button>

            <button
              type="button"
              onClick={clearFilters}
              className="inline-flex items-center gap-1.5 rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-foreground transition hover:bg-muted"
            >
              <X size={15} />
              Clear filters
            </button>
          </div>

          <p className="text-xs leading-5 text-muted-foreground">
            Dates use calendar days in Lagos time and include both selected
            dates. Leave dates empty to view all-time analytics. Seller ID
            filters popular items only.
          </p>
        </form>
      </Panel>

      {/* Menu performance */}
      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-bold tracking-tight text-foreground">
            Menu performance
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Compare menu views and orders across sellers.
          </p>
        </div>

        <SectionState
          query={menuQuery}
          onRetry={() => menuQuery.refetch()}
        />

        {menuData && (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <MetricCard
                label="Total menu views"
                value={formatNumber(menuData.totals?.views)}
                description="Page loads across all sellers"
                icon={Activity}
              />
              <MetricCard
                label="Orders placed"
                value={formatNumber(menuData.totals?.orders)}
                description="Includes orders later cancelled"
                icon={ShoppingBag}
                tone="gold"
              />
              <MetricCard
                label="Indicative conversion"
                value={formatPercent(menuData.totals?.conversion)}
                description="Orders divided by menu views"
                icon={BarChart3}
                tone="neutral"
              />
            </div>

            <Panel>
              <PanelHeading
                title="Seller engagement"
                description="Sellers ranked by menu views. Hover over a bar for exact values."
              />

              {menuChartData.length ? (
                <>
                  <div className="px-2 pb-2 pt-5 sm:px-5">
                    <ResponsiveContainer
                      width="100%"
                      height={Math.max(280, menuChartData.length * 48)}
                    >
                      <BarChart
                        data={menuChartData}
                        layout="vertical"
                        margin={{ top: 4, right: 16, left: 4, bottom: 4 }}
                        barGap={5}
                      >
                        <CartesianGrid
                          stroke={COLORS.border}
                          strokeDasharray="3 3"
                          horizontal={false}
                        />
                        <XAxis
                          type="number"
                          axisLine={false}
                          tickLine={false}
                          tick={{ fill: COLORS.muted, fontSize: 11 }}
                          tickFormatter={formatNumber}
                        />
                        <YAxis
                          type="category"
                          dataKey="name"
                          width={105}
                          axisLine={false}
                          tickLine={false}
                          tick={{
                            fill: COLORS.text,
                            fontSize: 11,
                          }}
                          tickFormatter={(value) =>
                            value.length > 16
                              ? `${value.slice(0, 15)}…`
                              : value
                          }
                        />
                        <Tooltip
                          content={
                            <ChartTooltip
                              formatter={(value) => formatNumber(value)}
                            />
                          }
                          cursor={{ fill: COLORS.soft, opacity: 0.6 }}
                        />
                        <Bar
                          dataKey="views"
                          name="Views"
                          fill={COLORS.primary}
                          radius={[0, 5, 5, 0]}
                          maxBarSize={15}
                        />
                        <Bar
                          dataKey="orders"
                          name="Orders"
                          fill={COLORS.secondary}
                          radius={[0, 5, 5, 0]}
                          maxBarSize={15}
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>

                  <ChartLegend
                    items={[
                      { label: "Menu views", color: COLORS.primary },
                      { label: "Orders placed", color: COLORS.secondary },
                    ]}
                  />
                </>
              ) : (
                <EmptyChart message="No seller performance data for this period." />
              )}
            </Panel>

            <Panel className="overflow-hidden">
              <PanelHeading
                title="Seller breakdown"
                description="Detailed menu activity for each seller."
              />

              {menuData.sellers?.length ? (
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full min-w-[720px] text-left text-sm">
                    <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="px-5 py-3 font-medium">Seller</th>
                        <th className="px-5 py-3 font-medium">Views</th>
                        <th className="px-5 py-3 font-medium">Orders</th>
                        <th className="px-5 py-3 font-medium">Conversion</th>
                        <th className="px-5 py-3 font-medium">Menus</th>
                      </tr>
                    </thead>

                    <tbody className="divide-y divide-border">
                      {menuData.sellers.map((entry, index) => (
                        <tr
                          key={entry.seller?.id ?? index}
                          className="transition hover:bg-muted/20"
                        >
                          <td className="px-5 py-4">
                            <p className="font-semibold text-foreground">
                              {entry.seller?.businessName || "Unnamed seller"}
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {entry.seller?.slug || entry.seller?.id || "—"}
                            </p>
                          </td>

                          <td className="px-5 py-4 tabular-nums">
                            {formatNumber(entry.views)}
                          </td>
                          <td className="px-5 py-4 tabular-nums">
                            {formatNumber(entry.orders)}
                          </td>
                          <td className="px-5 py-4">
                            <span className="rounded-full bg-soft-green px-2.5 py-1 text-xs font-semibold text-primary">
                              {formatPercent(entry.conversion)}
                            </span>
                          </td>
                          <td className="px-5 py-4">
                            <div className="min-w-44 space-y-2">
                              {(entry.menus ?? []).map((menu) => (
                                <div
                                  key={menu.id}
                                  className="rounded-xl border border-border p-3"
                                >
                                  <p className="font-medium text-foreground">
                                    {menu.title || "Untitled menu"}
                                  </p>
                                  <p className="mt-1 text-xs text-muted-foreground">
                                    {formatNumber(menu.views)} views ·{" "}
                                    {formatNumber(menu.orders)} orders
                                  </p>
                                  <p className="mt-1 text-xs text-muted-foreground">
                                    Conversion: {formatPercent(menu.conversion)}
                                  </p>
                                  <p className="mt-1 text-xs text-muted-foreground">
                                    Status: {menu.status || "—"}
                                  </p>
                                </div>
                              ))}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyChart message="No menu performance records for this period." />
              )}

              <Pagination
                pagination={menuData.pagination}
                page={menuPage}
                setPage={setMenuPage}
                isFetching={menuQuery.isFetching}
              />
            </Panel>
          </>
        )}
      </section>

      {/* Popular items */}
      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-bold tracking-tight text-foreground">
            Popular items
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            See which menu items account for the most portions ordered.
          </p>
        </div>

        <SectionState
          query={itemQuery}
          onRetry={() => itemQuery.refetch()}
        />

        {itemData && (
          <>
            <Panel>
              <PanelHeading
                title="Top items by portions"
                description="Ranked by portions on the current page. Cancelled orders are excluded."
              />

              {itemChartData.length ? (
                <>
                  <div className="px-2 pb-5 pt-5 sm:px-5">
                    <ResponsiveContainer
                      width="100%"
                      height={Math.max(260, itemChartData.length * 42)}
                    >
                      <BarChart
                        data={itemChartData}
                        layout="vertical"
                        margin={{ top: 4, right: 20, left: 4, bottom: 4 }}
                      >
                        <CartesianGrid
                          stroke={COLORS.border}
                          strokeDasharray="3 3"
                          horizontal={false}
                        />
                        <XAxis
                          type="number"
                          axisLine={false}
                          tickLine={false}
                          tick={{ fill: COLORS.muted, fontSize: 11 }}
                          tickFormatter={formatNumber}
                        />
                        <YAxis
                          type="category"
                          dataKey="name"
                          width={112}
                          axisLine={false}
                          tickLine={false}
                          tick={{
                            fill: COLORS.text,
                            fontSize: 11,
                          }}
                          tickFormatter={(value) =>
                            value.length > 18
                              ? `${value.slice(0, 17)}…`
                              : value
                          }
                        />
                        <Tooltip
                          content={
                            <ChartTooltip
                              formatter={(value) => formatNumber(value)}
                            />
                          }
                          cursor={{ fill: COLORS.soft, opacity: 0.6 }}
                        />
                        <Bar
                          dataKey="portions"
                          name="Portions"
                          fill={COLORS.primary}
                          radius={[0, 6, 6, 0]}
                          maxBarSize={24}
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </>
              ) : (
                <EmptyChart message="No popular-item data for this period." />
              )}
            </Panel>

            <Panel className="overflow-hidden">
              <PanelHeading
                title="Item details"
                description="Portions, orders, estimated value, and seller reach."
              />

              {itemData.items?.length ? (
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full min-w-[650px] text-left text-sm">
                    <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="px-5 py-3 font-medium">Item</th>
                        <th className="px-5 py-3 font-medium">Portions</th>
                        <th className="px-5 py-3 font-medium">Orders</th>
                        <th className="px-5 py-3 font-medium">Value ordered</th>
                        <th className="px-5 py-3 font-medium">Sellers</th>
                      </tr>
                    </thead>

                    <tbody className="divide-y divide-border">
                      {itemData.items.map((item, index) => (
                        <tr
                          key={`${item.name}-${index}`}
                          className="transition hover:bg-muted/20"
                        >
                          <td className="px-5 py-4 font-medium text-foreground">
                            {item.name || "Unnamed item"}
                          </td>
                          <td className="px-5 py-4 tabular-nums">
                            {formatNumber(item.portions)}
                          </td>
                          <td className="px-5 py-4 tabular-nums">
                            {formatNumber(item.orders)}
                          </td>
                          <td className="px-5 py-4 tabular-nums">
                            {formatMoney(item.revenue)}
                          </td>
                          <td className="px-5 py-4 tabular-nums">
                            {formatNumber(item.sellers)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyChart message="No popular-item records for this period." />
              )}

              <Pagination
                pagination={itemData.pagination}
                page={itemPage}
                setPage={setItemPage}
                isFetching={itemQuery.isFetching}
              />

              <p className="border-t border-border px-5 py-3 text-xs leading-5 text-muted-foreground">
                Value ordered is calculated from item prices and portions. It
                is not a confirmed total of money received.
              </p>
            </Panel>
          </>
        )}
      </section>

      {/* Customer analytics */}
      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-bold tracking-tight text-foreground">
            Customer insights
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Understand customer retention and repeat-order activity.
          </p>
        </div>

        <SectionState
          query={customerQuery}
          onRetry={() => customerQuery.refetch()}
        />

        {customerData && (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <MetricCard
                label="Total customers"
                value={formatNumber(customerData.customers?.total)}
                description="Identified by phone number"
                icon={Users}
              />
              <MetricCard
                label="Returning customers"
                value={formatNumber(customerData.customers?.returning)}
                description={`${formatPercent(customerData.customers?.returningRate)} of identified customers`}
                icon={Activity}
              />
              <MetricCard
                label="Total orders"
                value={formatNumber(customerData.orders?.total)}
                description="Orders in the selected period"
                icon={ShoppingBag}
                tone="gold"
              />
              <MetricCard
                label="Repeat-order rate"
                value={formatPercent(customerData.orders?.repeatRate)}
                description="Share of orders classified as repeat orders"
                icon={BarChart3}
                tone="neutral"
              />
            </div>

            <div className="grid min-w-0 gap-4 lg:grid-cols-2">
              <Panel>
                <PanelHeading
                  title="Customer mix"
                  description="New versus returning identified customers."
                />

                {customerChartData.some((entry) => entry.value > 0) ? (
                  <div className="grid items-center gap-2 px-4 pb-5 pt-3 sm:grid-cols-2">
                    <div className="h-60 min-w-0">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={customerChartData}
                            dataKey="value"
                            nameKey="name"
                            innerRadius={65}
                            outerRadius={92}
                            paddingAngle={4}
                            stroke="none"
                          >
                            {customerChartData.map((entry) => (
                              <Cell
                                key={entry.name}
                                fill={entry.color}
                              />
                            ))}
                          </Pie>
                          <Tooltip
                            content={
                              <ChartTooltip
                                formatter={(value) => formatNumber(value)}
                              />
                            }
                          />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>

                    <div className="space-y-4 px-2">
                      {customerChartData.map((entry) => {
                        const total = customerChartData.reduce(
                          (sum, item) => sum + item.value,
                          0
                        );
                        const share =
                          total > 0 ? (entry.value / total) * 100 : 0;

                        return (
                          <div key={entry.name}>
                            <div className="flex items-center justify-between gap-3">
                              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                                <span
                                  className="h-2.5 w-2.5 rounded-full"
                                  style={{ backgroundColor: entry.color }}
                                />
                                {entry.name}
                              </span>
                              <span className="text-sm font-semibold text-foreground">
                                {formatNumber(entry.value)}
                              </span>
                            </div>

                            <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
                              <div
                                className="h-full rounded-full transition-all"
                                style={{
                                  width: `${share}%`,
                                  backgroundColor: entry.color,
                                }}
                              />
                            </div>

                            <p className="mt-1 text-right text-xs text-muted-foreground">
                              {share.toFixed(1)}%
                            </p>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <EmptyChart message="No customer mix data for this period." />
                )}
              </Panel>

              <Panel>
                <PanelHeading
                  title="Order type breakdown"
                  description="First orders compared with repeat orders."
                />

                {orderChartData.some((entry) => entry.orders > 0) ? (
                  <div className="px-2 pb-5 pt-5 sm:px-4">
                    <ResponsiveContainer width="100%" height={260}>
                      <BarChart
                        data={orderChartData}
                        margin={{ top: 10, right: 16, left: 4, bottom: 4 }}
                      >
                        <CartesianGrid
                          stroke={COLORS.border}
                          strokeDasharray="3 3"
                          vertical={false}
                        />
                        <XAxis
                          dataKey="name"
                          axisLine={false}
                          tickLine={false}
                          tick={{ fill: COLORS.muted, fontSize: 11 }}
                        />
                        <YAxis
                          allowDecimals={false}
                          axisLine={false}
                          tickLine={false}
                          tick={{ fill: COLORS.muted, fontSize: 11 }}
                          tickFormatter={formatNumber}
                        />
                        <Tooltip
                          content={
                            <ChartTooltip
                              formatter={(value) => formatNumber(value)}
                            />
                          }
                          cursor={{ fill: COLORS.soft, opacity: 0.6 }}
                        />
                        <Bar
                          dataKey="orders"
                          name="Orders"
                          radius={[6, 6, 0, 0]}
                          maxBarSize={64}
                        >
                          {orderChartData.map((entry) => (
                            <Cell
                              key={entry.name}
                              fill={
                                entry.name === "First orders"
                                  ? COLORS.secondary
                                  : COLORS.primary
                              }
                            />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <EmptyChart message="No order breakdown data for this period." />
                )}
              </Panel>
            </div>

            <p className="text-xs leading-5 text-muted-foreground">
              Customer analytics are approximate because customers are
              identified by phone number. First and repeat orders use the
              classifications returned by the API.
            </p>
          </>
        )}
      </section>
    </div>
  );
}
