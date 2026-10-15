import { useMemo, useState } from "react";
import {
  CalendarDays,
  ChevronDown,
  ClipboardList,
  MapPin,
  Package,
  Phone,
  Share2,
  Truck,
} from "lucide-react";

import SellerHeader from "@/components/seller/Header";
import SellerBottomNav from "@/components/seller/BottomNav";
import { useCurrentSeller } from "@/hooks/useCurrentSeller";
import { useGetMenus } from "@/hooks/useGetMenus";
import { useGetMenuDeliveryList } from "@/hooks/useGetMenuDeliveryList";

const formatPrice = (amount = 0) =>
  new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    maximumFractionDigits: 0,
  }).format(amount);

const formatDay = (day) => {
  if (!day) return "Date not specified";

  const date = new Date(`${day}T00:00:00`);

  if (Number.isNaN(date.getTime())) return day;

  return new Intl.DateTimeFormat("en-NG", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
};

const getPaymentLabel = (status) =>
  status?.toLowerCase() === "paid" ? "Paid" : "Payment pending";

function SelectField({ label, value, onChange, children }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
        {label}
      </span>

      <span className="relative block">
        <select
          value={value}
          onChange={onChange}
          className="h-11 w-full appearance-none rounded-xl border border-border bg-background px-3 pr-9 text-sm text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/10"
        >
          {children}
        </select>

        <ChevronDown
          size={16}
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
      </span>
    </label>
  );
}

function OrderCard({ order, index }) {
  const items = order.lines ?? [];
  const isPaid = order.status?.toLowerCase() === "paid";

  return (
    <article className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-soft-green text-primary">
            <Package size={19} />
          </div>

          <div className="min-w-0">
            <p className="font-semibold text-foreground">
              {order.customer?.name || "Customer"}
            </p>

            <p className="mt-0.5 text-xs text-muted-foreground">
              Order {order.ref || `#${index + 1}`}
            </p>
          </div>
        </div>

        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${
            isPaid ? "bg-soft-green text-primary" : "bg-warning text-foreground"
          }`}
        >
          {getPaymentLabel(order.status)}
        </span>
      </div>

      <div className="my-4 space-y-3 border-y border-border py-3">
        <div className="flex items-start gap-2.5">
          <MapPin size={17} className="mt-0.5 shrink-0 text-muted-foreground" />

          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">Delivery address</p>

            <p className="mt-0.5 text-sm leading-5 text-foreground">
              {order.address || "No delivery address provided"}
            </p>
          </div>
        </div>

        {order.customer?.phone && (
          <div className="flex items-center gap-2.5">
            <Phone size={16} className="shrink-0 text-muted-foreground" />

            <a
              href={`tel:${order.customer.phone}`}
              className="text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              {order.customer.phone}
            </a>
          </div>
        )}

        <div className="flex items-center gap-2.5">
          <CalendarDays size={16} className="shrink-0 text-muted-foreground" />

          <p className="text-sm text-foreground">{formatDay(order.day)}</p>
        </div>
      </div>

      <div>
        <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Items to deliver
        </p>

        {items.length > 0 ? (
          <div className="space-y-2.5">
            {items.map((item, itemIndex) => (
              <div
                key={`${item.name}-${itemIndex}`}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <span className="text-foreground">{item.name}</span>

                <span className="shrink-0 rounded-lg bg-soft-green px-2.5 py-1 font-semibold text-primary">
                  × {item.qty}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No items listed for this order.
          </p>
        )}
      </div>

      {order.note && (
        <div className="mt-4 rounded-xl border border-border bg-background p-3">
          <p className="text-xs font-semibold text-muted-foreground">
            Customer's note
          </p>

          <p className="mt-1 text-sm leading-5 text-foreground">{order.note}</p>
        </div>
      )}

      <div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-3">
        <span className="text-sm text-muted-foreground">Order total</span>

        <span className="text-base font-semibold text-foreground">
          {formatPrice(order.total)}
        </span>
      </div>
    </article>
  );
}

function EmptyState({ title, description }) {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-card px-5 py-10 text-center">
      <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-soft-green text-primary">
        <Truck size={23} />
      </div>

      <h3 className="mt-4 font-semibold text-foreground">{title}</h3>

      <p className="mx-auto mt-1 max-w-[260px] text-sm leading-5 text-muted-foreground">
        {description}
      </p>
    </div>
  );
}

export default function Delivery() {
  const { data: seller } = useCurrentSeller();
  const { data: menusData, isPending: menusPending } = useGetMenus();

  const menus = menusData?.menus ?? [];

  const [selectedMenuId, setSelectedMenuId] = useState("");
  const [selectedDay, setSelectedDay] = useState("");
  const [paidOnly, setPaidOnly] = useState(false);
  const [shareMessage, setShareMessage] = useState("");

  const activeMenu = menus.find((menu) => menu.id === selectedMenuId);

  const menuId = selectedMenuId || activeMenu?.id || menus[0]?.id || "";

  const {
    data: deliveryData,
    isPending: deliveryPending,
    isError: deliveryError,
    error: deliveryErrorMessage,
    refetch: refetchDelivery,
    isFetching,
  } = useGetMenuDeliveryList(menuId, {
    day: selectedDay || undefined,
    paidOnly,
  });

  const areas = useMemo(() => deliveryData?.areas ?? [], [deliveryData?.areas]);

  const orders = useMemo(
    () => areas.flatMap((area) => area.orders ?? []),
    [areas]
  );

  const shareText = useMemo(() => {
    const lines = [
      `${seller?.businessName || "ChopList"} — DELIVERY LIST`,
      `Menu: ${
        deliveryData?.title ||
        activeMenu?.title ||
        activeMenu?.name ||
        "Selected menu"
      }`,
      `Delivery date: ${
        selectedDay ? formatDay(selectedDay) : "All delivery dates"
      }`,
      `Payment filter: ${
        paidOnly ? "Paid orders only" : "All non-cancelled orders"
      }`,
      `Total orders: ${orders.length}`,
      "",
    ];

    areas.forEach((area) => {
      lines.push(`AREA: ${area.area || "Unassigned area"}`);
      lines.push("");

      (area.orders ?? []).forEach((order, index) => {
        lines.push(
          `${index + 1}. ${order.customer?.name || "Customer"} — ${
            order.ref || "No reference"
          }`
        );

        lines.push(`Address: ${order.address || "Not provided"}`);
        lines.push(`Phone: ${order.customer?.phone || "Not provided"}`);
        lines.push(`Delivery date: ${formatDay(order.day)}`);

        lines.push(
          `Items: ${
            (order.lines ?? [])
              .map((item) => `${item.name} × ${item.qty}`)
              .join(", ") || "No items listed"
          }`
        );

        if (order.note) {
          lines.push(`Note: ${order.note}`);
        }

        lines.push(`Payment: ${getPaymentLabel(order.status)}`);
        lines.push(`Order total: ${formatPrice(order.total)}`);
        lines.push("");
      });
    });

    return lines.join("\n");
  }, [
    seller?.businessName,
    deliveryData?.title,
    activeMenu?.title,
    activeMenu?.name,
    selectedDay,
    paidOnly,
    orders,
    areas,
  ]);

  const handleShare = async () => {
    setShareMessage("");

    if (orders.length === 0) {
      setShareMessage("There are no orders to share.");
      return;
    }

    try {
      if (typeof navigator.share === "function") {
        await navigator.share({
          title: `${seller?.businessName || "ChopList"} delivery list`,
          text: shareText,
        });

        return;
      }

      await navigator.clipboard.writeText(shareText);

      setShareMessage(
        "Delivery list copied. You can now send it to your rider."
      );
    } catch (error) {
      if (error?.name === "AbortError") return;

      try {
        await navigator.clipboard.writeText(shareText);

        setShareMessage(
          "Delivery list copied. You can now send it to your rider."
        );
      } catch {
        setShareMessage(
          "Unable to share automatically. Please try again in your browser."
        );
      }
    }
  };

  return (
    <main className="min-h-[100dvh] bg-background pb-28">
      <div className="mx-auto w-full max-w-[420px] px-4 pb-6 pt-4">
        <SellerHeader businessName={seller?.businessName || "Your business"} />

        <section className="mt-7">
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
            Delivery list
          </h1>

          <p className="mt-1 text-sm leading-5 text-muted-foreground">
            Organise orders by delivery area and prepare your rider's list.
          </p>
        </section>

        <section className="mt-6 rounded-2xl border border-border bg-background p-4">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold text-foreground">
                Delivery settings
              </h2>

              <p className="mt-1 text-xs text-muted-foreground">
                Choose which orders to include
              </p>
            </div>

            <button
              type="button"
              onClick={() => refetchDelivery()}
              disabled={!menuId || isFetching}
              aria-label="Refresh delivery list"
              className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-card text-foreground transition hover:bg-soft-green hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ClipboardList size={18} />
            </button>
          </div>

          <div className="space-y-4">
            <SelectField
              label="Menu"
              value={menuId}
              onChange={(event) => setSelectedMenuId(event.target.value)}
            >
              {menus.length === 0 && (
                <option value="">No menus available</option>
              )}

              {menus.map((menu) => (
                <option key={menu.id} value={menu.id}>
                  {menu.title || menu.name || "Untitled menu"}
                </option>
              ))}
            </SelectField>

            <div className="grid grid-cols-2 gap-3">
              <label className="block min-w-0">
                <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
                  Delivery date
                </span>

                <input
                  type="date"
                  value={selectedDay}
                  onChange={(event) => setSelectedDay(event.target.value)}
                  className="h-11 w-full min-w-0 rounded-xl border border-border bg-background px-2 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/10"
                />
              </label>

              <SelectField
                label="Payment"
                value={paidOnly ? "paid" : "all"}
                onChange={(event) => setPaidOnly(event.target.value === "paid")}
              >
                <option value="all">All orders</option>
                <option value="paid">Paid only</option>
              </SelectField>
            </div>
          </div>
        </section>

        <section className="mt-5 rounded-2xl bg-primary p-5 text-white">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm text-white/80">Orders to deliver</p>

              <p className="mt-1 text-4xl font-semibold tabular-nums">
                {deliveryPending ? "—" : orders.length}
              </p>

              <p className="mt-1 text-sm text-white/80">
                Across {areas.length} {areas.length === 1 ? "area" : "areas"}
              </p>
            </div>

            <div className="flex size-14 shrink-0 items-center justify-center rounded-2xl border border-white/15 bg-white/10">
              <Truck size={25} />
            </div>
          </div>
        </section>

        <div className="mb-4 mt-7 flex items-center justify-between gap-3"></div>
        {menusPending || deliveryPending ? (
          <div className="rounded-2xl border border-border bg-card p-6 text-center">
            <div className="mx-auto size-6 animate-spin rounded-full border-2 border-border border-t-primary" />

            <p className="mt-3 text-sm text-muted-foreground">
              Loading delivery list…
            </p>
          </div>
        ) : deliveryError ? (
          <div className="rounded-2xl border border-border bg-card p-5">
            <p className="font-semibold text-foreground">
              Could not load delivery list
            </p>

            <p className="mt-1 text-sm text-muted-foreground">
              {deliveryErrorMessage?.message ||
                "Please check your connection and try again."}
            </p>

            <button
              type="button"
              onClick={() => refetchDelivery()}
              className="mt-4 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-white"
            >
              Try again
            </button>
          </div>
        ) : !menuId ? (
          <EmptyState
            title="No menu selected"
            description="Create a menu first to see its delivery orders here."
          />
        ) : orders.length === 0 ? (
          <EmptyState
            title="No deliveries to show"
            description="Try another delivery date or payment filter. Matching orders will appear here."
          />
        ) : (
          <div className="space-y-6">
            {areas
              .filter((area) => (area.orders ?? []).length > 0)
              .map((area, areaIndex) => (
                <section key={`${area.area}-${areaIndex}`}>
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-soft-green text-primary">
                        <MapPin size={18} />
                      </div>

                      <div className="min-w-0">
                        <h3 className="truncate font-semibold text-foreground">
                          {area.area || "Unassigned area"}
                        </h3>

                        <p className="text-xs text-muted-foreground">
                          Delivery destination
                        </p>
                      </div>
                    </div>

                    <span className="shrink-0 rounded-full border border-border bg-card px-3 py-1 text-xs font-semibold text-foreground">
                      {area.orders.length}{" "}
                      {area.orders.length === 1 ? "order" : "orders"}
                    </span>
                  </div>

                  <div className="space-y-4">
                    {area.orders.map((order, orderIndex) => (
                      <OrderCard
                        key={order.ref || `${areaIndex}-${orderIndex}`}
                        order={order}
                        index={orderIndex}
                      />
                    ))}
                  </div>
                </section>
              ))}
          </div>
        )}

        <section className="mt-8 border-t border-border pt-5">
          {shareMessage && (
            <p
              role="status"
              className="mb-3 rounded-xl border border-border bg-card p-3 text-sm text-foreground"
            >
              {shareMessage}
            </p>
          )}

          <button
            type="button"
            onClick={handleShare}
            disabled={deliveryPending || deliveryError || orders.length === 0}
            className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Share2 size={18} />
            Share delivery list with rider
          </button>

          <p className="mt-2 text-center text-xs leading-5 text-muted-foreground">
            Share customer addresses, contact numbers and order details with
            your rider.
          </p>
        </section>
      </div>

      <SellerBottomNav />
    </main>
  );
}
