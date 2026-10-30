import { useMemo, useState } from "react";
import {
  CalendarDays,
  ChefHat,
  ClipboardList,
  RefreshCw,
  Download,
  Wallet,
} from "lucide-react";

import SellerBottomNav from "@/components/seller/BottomNav";
import { useGetMenus } from "@/hooks/useGetMenus";
import { useGetMenuPrepSheet } from "@/hooks/useGetMenuPrepSheet";
import SellerHeader from "@/components/seller/Header";
import { useCurrentSeller } from "@/hooks/useCurrentSeller";


const formatPrice = (amount = 0) =>
  new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    maximumFractionDigits: 0,
  }).format(amount);

function LoadingState({ message = "Loading..." }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
      <RefreshCw className="h-4 w-4 animate-spin" />
      <span>{message}</span>
    </div>
  );
}

function ErrorState({ message, onRetry }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-5 text-center">
      <p className="text-sm text-destructive">{message}</p>

      <button
        type="button"
        onClick={onRetry}
        className="mt-4 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
      >
        Try again
      </button>
    </div>
  );
}

function SummaryCard({
  icon: Icon,
  label,
  value,
  description,
  variant = "default",
}) {
  const styles =
    variant === "primary"
      ? "bg-primary text-primary-foreground"
      : "border border-border bg-card text-foreground";

  const iconStyles =
    variant === "primary" ? "text-primary-foreground" : "text-primary";

  return (
    <div className={`min-w-0 rounded-2xl p-4 ${styles}`}>
      <div className="mb-4 flex items-center justify-between gap-2">
        <p className="text-sm opacity-90">{label}</p>
        <Icon className={`h-5 w-5 shrink-0 ${iconStyles}`} />
      </div>

      <p className="text-2xl font-bold tracking-tight">{value}</p>

      <p className="mt-1 text-xs leading-5 opacity-75">{description}</p>
    </div>
  );
}

export default function Prep() {
  const [selectedMenuId, setSelectedMenuId] = useState("");
  const [paidOnly, setPaidOnly] = useState(false);
  const [exportError, setExportError] = useState("");
  const { data: seller } = useCurrentSeller();

  const {
    data: menusData,
    isPending: menusPending,
    isError: menusError,
    error: menusErrorMessage,
    refetch: refetchMenus,
  } = useGetMenus();

  const menus = useMemo(() => menusData?.menus ?? [], [menusData]);

  const activeMenu = menus.find((menu) => menu.status === "open");

  const menuId = selectedMenuId || activeMenu?.id || menus[0]?.id || "";

  const currentMenu = menus.find((menu) => menu.id === menuId);

  const {
    data: prepData,
    isPending: prepPending,
    isError: prepError,
    error: prepErrorMessage,
    refetch: refetchPrep,
    isFetching,
  } = useGetMenuPrepSheet(menuId, paidOnly);

  const items = prepData?.items ?? [];

  const totals = prepData?.totals ?? {
    orders: 0,
    portions: 0,
    amount: 0,
  };


const handleExportPrepSheet = async () => {
  setExportError("");

  try {
    const { exportPrepSheet } = await import("@/lib/exportPrepSheet");

    await exportPrepSheet({
      businessName: seller?.businessName || "ChopList Seller",
      menuTitle: currentMenu?.title || "Preparation sheet",
      items,
      totals,
      paidOnly,
    });
  } catch (error) {
    console.error("Prep sheet export failed:", error);
    alert("Prep sheet export failed. Please try again.");
  }
};


  if (menusPending) {
    return (
      <main className="min-h-[100dvh] bg-background lg:pl-64">
        <div className="mx-auto min-h-[100dvh] w-full max-w-[420px] px-4 pt-8 md:max-w-3xl md:px-8 md:pt-10 lg:max-w-5xl">
          <LoadingState message="Loading your menus..." />
        </div>

        <SellerBottomNav />
      </main>
    );
  }

  if (menusError) {
    return (
      <main className="min-h-[100dvh] bg-background lg:pl-64">
        <div className="mx-auto min-h-[100dvh] w-full max-w-[420px] px-4 pt-8 md:max-w-3xl md:px-8 md:pt-10 lg:max-w-5xl">
          <ErrorState
            message={menusErrorMessage?.message || "Could not load your menus."}
            onRetry={() => refetchMenus()}
          />
        </div>

        <SellerBottomNav />
      </main>
    );
  }

  if (menus.length === 0) {
    return (
      <main className="min-h-[100dvh] bg-background text-foreground lg:pl-64">
        <div className="mx-auto min-h-[100dvh] w-full max-w-[420px] px-4 pb-28 pt-6 md:max-w-3xl md:px-8 md:pt-10 lg:max-w-5xl lg:pb-12">
          <header className="mb-8 lg:mb-0">
            <SellerHeader />
          </header>

          <section className="rounded-2xl border border-border bg-card px-5 py-10 text-center md:py-14">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-soft-green">
              <ChefHat className="h-7 w-7 text-primary" />
            </div>

            <h1 className="mt-4 text-xl font-bold">No menus yet</h1>

            <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
              Create a menu first. Once customers place orders, your preparation
              report will appear here.
            </p>
          </section>
        </div>

        <SellerBottomNav />
      </main>
    );
  }

  return (
    <main className="min-h-[100dvh] bg-background text-foreground lg:pl-64">
      <div className="mx-auto min-h-[100dvh] w-full max-w-[420px] px-4 pb-28 pt-6 md:max-w-3xl md:px-8 md:pt-10 lg:max-w-5xl lg:pb-12">
        <header className="mb-7 md:mb-8">
          <SellerHeader businessName={seller?.businessName || "Your prep"} />

          <div className="mt-6 lg:mt-0">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium text-primary">
              <ChefHat className="h-4 w-4" />
              <span>Preparation report</span>
            </div>

            <h1 className="text-2xl font-bold tracking-tight md:text-4xl">
              Cook the right amount.
            </h1>

            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              See what customers ordered and how many portions to prepare.
            </p>
          </div>
        </header>

        <div className="lg:grid lg:grid-cols-[20rem_minmax(0,1fr)] lg:items-start lg:gap-8">
          <div className="lg:sticky lg:top-10">
            <div className="md:grid md:grid-cols-2 md:gap-4 lg:block">
              <section className="mb-5 space-y-2">
                <label
                  htmlFor="prep-menu"
                  className="text-sm font-semibold text-foreground"
                >
                  Menu
                </label>

                <select
                  id="prep-menu"
                  value={menuId}
                  onChange={(event) => setSelectedMenuId(event.target.value)}
                  className="w-full rounded-xl border border-border bg-card px-3 py-3.5 text-sm text-foreground outline-none transition focus:ring-2 focus:ring-primary"
                >
                  {menus.map((menu) => (
                    <option key={menu.id} value={menu.id}>
                      {menu.title}
                      {menu.status === "open" ? " (Open)" : ""}
                    </option>
                  ))}
                </select>

                {currentMenu && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <CalendarDays className="h-3.5 w-3.5" />

                    <span>
                      Status:{" "}
                      <span className="font-medium capitalize">
                        {currentMenu.status}
                      </span>
                    </span>
                  </div>
                )}
              </section>

              <section className="mb-6 rounded-2xl border border-border bg-card p-4 md:mb-5 lg:mb-6">
                <label
                  htmlFor="prep-payment-filter"
                  className="text-sm font-semibold text-foreground"
                >
                  Payment filter
                </label>

                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  Choose which orders to include in your preparation report.
                </p>

                <select
                  id="prep-payment-filter"
                  value={paidOnly ? "paid" : "all"}
                  onChange={(event) => setPaidOnly(event.target.value === "paid")}
                  className="mt-3 w-full rounded-xl border border-border bg-background px-3 py-3 text-sm text-foreground outline-none transition focus:ring-2 focus:ring-primary"
                >
                  <option value="all">All non-cancelled orders</option>
                  <option value="paid">Paid orders only</option>
                </select>
              </section>
            </div>

            {!prepPending && !prepError && (
              <div className="md:grid md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] md:gap-3 lg:block">
                <section className="mb-4 grid grid-cols-2 gap-3 md:mb-7 lg:mb-4">
                  <SummaryCard
                    icon={ClipboardList}
                    label="Orders"
                    value={totals.orders ?? 0}
                    description="Orders in this report"
                    variant="primary"
                  />

                  <SummaryCard
                    icon={ChefHat}
                    label="Total portions"
                    value={totals.portions ?? 0}
                    description="Meals to prepare"
                  />
                </section>

                <section className="mb-7 rounded-2xl border border-border bg-card p-4">
                  <div className="flex items-center gap-3">
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-soft-green">
                      <Wallet className="h-5 w-5 text-primary" />
                    </div>

                    <div className="min-w-0">
                      <p className="text-sm text-muted-foreground">
                        Expected order total
                      </p>

                      <p className="mt-1 text-2xl font-bold tracking-tight">
                        {formatPrice(totals.amount)}
                      </p>
                    </div>
                  </div>
                  <p className="mt-3 text-xs leading-5 text-muted-foreground">
                    Estimated value of orders matching your payment filter.
                  </p>
                </section>
              </div>
            )}
          </div>

          <div className="min-w-0">
            {prepPending ? (
              <LoadingState message="Preparing your report..." />
            ) : prepError ? (
              <ErrorState
                message={
                  prepErrorMessage?.message || "Could not load the prep sheet."
                }
                onRetry={() => refetchPrep()}
              />
            ) : (
              <section>
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-bold">Items to prepare</h2>

                    <p className="mt-1 text-xs text-muted-foreground">
                      Portions needed for each menu item
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={() => refetchPrep()}
                    disabled={isFetching}
                    aria-label="Refresh prep sheet"
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-card text-muted-foreground transition hover:text-foreground disabled:opacity-50"
                  >
                    <RefreshCw
                      className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`}
                    />
                  </button>
                </div>

                {items.length === 0 ? (
                  <div className="rounded-2xl border border-border bg-card px-5 py-8 text-center">
                    <ChefHat className="mx-auto h-8 w-8 text-muted-foreground" />

                    <p className="mt-3 font-semibold">No items to show</p>

                    <p className="mt-1 text-sm leading-6 text-muted-foreground">
                      There are no menu items in this report yet.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3 md:grid md:grid-cols-2 md:gap-3 md:space-y-0">
                    {items.map((item) => (
                      <article
                        key={item.itemId}
                        className="flex items-center justify-between gap-4 rounded-2xl border border-border bg-card p-4"
                      >
                        <div className="min-w-0">
                          <h3 className="break-words font-semibold">
                            {item.name}
                          </h3>

                          <p className="mt-1 text-sm text-muted-foreground">
                            Across {item.orders}{" "}
                            {item.orders === 1 ? "order" : "orders"}
                          </p>
                        </div>

                        <div className="shrink-0 rounded-xl bg-soft-green px-3 py-2 text-center">
                          <p className="text-xl font-bold text-primary">
                            {item.portions}
                          </p>

                          <p className="text-xs text-primary">
                            {item.portions === 1 ? "portion" : "portions"}
                          </p>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            )}

            <div className="mt-7">
              <button
                type="button"
                onClick={handleExportPrepSheet}
                disabled={isFetching || prepPending || prepError || !prepData}
                className="flex w-full items-center justify-center gap-3 rounded-xl bg-primary px-4 py-4 font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Download className="h-5 w-5" />

                <span>Export prep sheet · {totals.portions ?? 0} portions</span>
              </button>

              {exportError && (
                <p role="alert" className="mt-3 text-sm text-destructive">
                  {exportError}
                </p>
              )}
            </div>

            <p className="mt-7 text-center text-xs leading-5 text-muted-foreground">
              {isFetching && !prepPending
                ? "Updating report..."
                : "Your report reflects the latest available order data."}
            </p>
          </div>
        </div>
      </div>

      <SellerBottomNav />
    </main>
  );
}
