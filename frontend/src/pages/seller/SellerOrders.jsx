import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@clerk/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ClipboardList,
  Phone,
  MapPin,
  CalendarDays,
  Clock,
  Wallet,
  XCircle,
  RefreshCw,
} from "lucide-react";

import { ApiError } from "@/api/api-client";
import { markOrderAsPaid, cancelOrder } from "@/api/seller-api";
import SellerHeader from "@/components/seller/Header";
import SellerBottomNav from "@/components/seller/BottomNav";

import { useCurrentSeller } from "@/hooks/useCurrentSeller";
import { useGetMenus } from "@/hooks/useGetMenus";
import { useGetMenuOrders } from "@/hooks/use-get-menu-orders";
import { useOutForDelivery } from "@/hooks/useOutForDelivery";
import { useConfirmDelivery } from "@/hooks/useConfirmDelivery";
import { useResetDeliveryCode } from "@/hooks/useResetDelivery";

const formatPrice = (amount) =>
  new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    maximumFractionDigits: 0,
  }).format(amount);

const formatDateTime = (timestamp) =>
  new Intl.DateTimeFormat("en-NG", {
    timeZone: "Africa/Lagos",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));

const formatDeliveryDay = (day) =>
  new Intl.DateTimeFormat("en-NG", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(`${day}T00:00:00Z`));

const statusStyles = {
  pending: "bg-warning text-foreground",
  paid: "bg-soft-green text-primary",
  out_for_delivery: "bg-blue-100 text-blue-800",
  delivered: "bg-green-100 text-green-800",
  cancelled: "bg-muted text-muted-foreground",
};

function OrderStatus({ status }) {
  return (
    <span
      className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold capitalize ${
        statusStyles[status] ?? "bg-muted text-muted-foreground"
      }`}
    >
      {status}
    </span>
  );
}

function EmptyState({ title, description }) {
  return (
    <div className="rounded-xl border border-border bg-card px-5 py-10 text-center">
      <ClipboardList className="mx-auto h-9 w-9 text-muted-foreground" />

      <h2 className="mt-3 font-semibold text-foreground">{title}</h2>

      <p className="mt-2 text-sm leading-6 text-muted-foreground">
        {description}
      </p>
    </div>
  );
}

function OrderCard({
  order,
  onMarkPaid,
  onCancel,
  onOutForDelivery,
  onConfirmDelivery,
  onResetDeliveryCode,
  busy,
  deliveryLocked,
  resetLimitReached,
}) {
  const [deliveryCode, setDeliveryCode] = useState("");
  const canMarkPaid = order.status === "pending";
  const canCancel = order.status === "pending" || order.status === "paid";
  const canSendForDelivery = order.status === "paid";
  const isOutForDelivery = order.status === "out_for_delivery";

  const handleCancel = () => {
    const confirmed = window.confirm(
      `Cancel order ${order.ref}? Its portions will be returned to the menu. ${
        order.status === "paid"
          ? "If payment was received, handle any refund separately."
          : ""
      }`
    );

    if (confirmed) onCancel(order.ref);
  };

  return (
    <article className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Order reference
          </p>

          <h2 className="mt-1 text-lg font-bold text-foreground">
            {order.ref}
          </h2>
        </div>

        <OrderStatus status={order.status} />
      </div>

      <div className="mt-4 border-t border-border pt-4">
        <h3 className="font-semibold text-foreground">
          {order.customer?.name ?? "Customer"}
        </h3>

        {order.customer?.phone && (
          <a
            href={`tel:${order.customer.phone}`}
            className="mt-2 inline-flex items-center gap-2 text-sm text-primary"
          >
            <Phone className="h-4 w-4" />
            {order.customer.phone}
          </a>
        )}
      </div>

      <div className="mt-4 rounded-lg bg-background p-3">
        <p className="text-sm font-semibold text-foreground">Order items</p>

        <div className="mt-2 space-y-3">
          {(order.lines ?? []).map((line, index) => (
            <div
              key={`${line.itemId ?? line.name}-${index}`}
              className="flex items-start justify-between gap-3 text-sm"
            >
              <div className="min-w-0">
                <p className="text-foreground">{line.name}</p>

                <p className="mt-1 text-xs text-muted-foreground">
                  {formatPrice(line.unitPrice)} × {line.qty}
                </p>
              </div>

              <p className="shrink-0 font-medium text-foreground">
                {formatPrice(line.unitPrice * line.qty)}
              </p>
            </div>
          ))}
        </div>

        <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
          <span className="text-sm font-semibold text-foreground">Total</span>

          <span className="text-lg font-bold text-primary">
            {formatPrice(order.total)}
          </span>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        {order.delivery?.area && (
          <div className="flex items-start gap-2 text-sm">
            <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />

            <div>
              <p className="font-medium text-foreground">
                {order.delivery.area}
              </p>

              {order.delivery.address && (
                <p className="mt-1 text-muted-foreground">
                  {order.delivery.address}
                </p>
              )}
            </div>
          </div>
        )}

        {order.delivery?.day && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <CalendarDays className="h-4 w-4 shrink-0" />
            {formatDeliveryDay(order.delivery.day)}
          </div>
        )}

        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Clock className="h-4 w-4 shrink-0" />
          Ordered {formatDateTime(order.createdAt)}
        </div>

        {order.paidAt && (
          <p className="text-xs text-muted-foreground">
            Payment recorded: {formatDateTime(order.paidAt)}
          </p>
        )}

        {order.note && (
          <div className="rounded-lg border border-border p-3">
            <p className="text-xs font-semibold text-muted-foreground">
              Customer note
            </p>

            <p className="mt-1 text-sm text-foreground">{order.note}</p>
          </div>
        )}
      </div>

      {(canMarkPaid || canCancel || canSendForDelivery || isOutForDelivery) && (
        <div className="mt-5 space-y-2 border-t border-border pt-4">
          {canMarkPaid && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onMarkPaid(order.ref)}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Wallet className="h-4 w-4" />
              Mark as paid
            </button>
          )}

          {canCancel && (
            <button
              type="button"
              disabled={busy}
              onClick={handleCancel}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-destructive/40 px-4 py-3 text-sm font-semibold text-destructive hover:bg-destructive/5 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <XCircle className="h-4 w-4" />
              Cancel order
            </button>
          )}

          {canSendForDelivery && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onOutForDelivery(order.ref)}
              className="w-full rounded-lg bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              Mark out for delivery
            </button>
          )}

          {isOutForDelivery && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Enter the delivery code provided by the customer to confirm that
                the order has arrived.
              </p>

              <label
                htmlFor={`delivery-code-${order.ref}`}
                className="block text-sm font-medium text-foreground"
              >
                Customer delivery code
              </label>

              <input
                id={`delivery-code-${order.ref}`}
                type="text"
                inputMode="numeric"
                autoComplete="off"
                maxLength={6}
                value={deliveryCode}
                onChange={(event) =>
                  setDeliveryCode(event.target.value.replace(/\D/g, ""))
                }
                placeholder="Enter 6-digit code"
                className="w-full rounded-lg border border-border bg-background px-3 py-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
              />

              <button
                type="button"
                disabled={busy || deliveryCode.length !== 6}
                onClick={() => {
                  onConfirmDelivery(order.ref, deliveryCode);
                  setDeliveryCode("");
                }}
                className="w-full rounded-lg bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                Confirm delivery
              </button>

              {deliveryLocked && (
                <p className="text-sm text-destructive">
                  Delivery code attempts are locked. Reset the code before
                  trying again.
                </p>
              )}

              {resetLimitReached ? (
                <p className="text-sm text-destructive">
                  You have reached the delivery-code reset limit. Contact
                  support.
                </p>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    const confirmed = window.confirm(
                      `Reset the delivery code for order ${order.ref}?`
                    );

                    if (confirmed) {
                      onResetDeliveryCode(order.ref);
                    }
                  }}
                  className="w-full rounded-lg border border-border px-4 py-3 text-sm font-semibold text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Reset delivery code
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

export default function SellerOrders() {
  const navigate = useNavigate();
  const { getToken } = useAuth();
  const queryClient = useQueryClient();

  const sellerQuery = useCurrentSeller();

  const [selectedMenuId, setSelectedMenuId] = useState("");
  const [status, setStatus] = useState("all");
  const [actionError, setActionError] = useState("");
  const [actionSuccess, setActionSuccess] = useState("");
  const [deliveryLockedOrders, setDeliveryLockedOrders] = useState([]);
  const [resetLimitOrders, setResetLimitOrders] = useState([]);

  const {
    data: menusData,
    isPending: menusPending,
    isError: menusIsError,
    error: menusError,
    refetch: refetchMenus,
  } = useGetMenus();

  const menus = menusData?.menus ?? [];

  const menuId =
    selectedMenuId ||
    menus.find((menu) => menu.status === "open")?.id ||
    menus[0]?.id ||
    "";

  const outForDeliveryMutation = useOutForDelivery(menuId);
  const confirmDeliveryMutation = useConfirmDelivery(menuId);
  const resetDeliveryCodeMutation = useResetDeliveryCode(menuId);

  const selectedMenu = menus.find((menu) => menu.id === menuId);

  const statusFilter = status === "all" ? undefined : status;

  const {
    data: ordersData,
    isPending: ordersPending,
    isError: ordersIsError,
    error: ordersError,
    refetch: refetchOrders,
  } = useGetMenuOrders(menuId, statusFilter);

  const markPaidMutation = useMutation({
    mutationFn: (ref) => markOrderAsPaid(ref, getToken),

    onSuccess: async () => {
      setActionError("");
      setActionSuccess("Order marked as paid.");

      await queryClient.invalidateQueries({
        queryKey: ["menu-orders", menuId],
      });
    },

    onError: (error) => {
      setActionSuccess("");
      setActionError(
        error instanceof ApiError
          ? error.message
          : "Could not update the payment status. Please try again."
      );
    },
  });

  const cancelMutation = useMutation({
    mutationFn: (ref) => cancelOrder(ref, getToken),

    onSuccess: async () => {
      setActionError("");
      setActionSuccess("Order cancelled. Its portions have been returned.");

      await queryClient.invalidateQueries({
        queryKey: ["menu-orders", menuId],
      });

      await queryClient.invalidateQueries({
        queryKey: ["menus"],
      });
    },

    onError: (error) => {
      setActionSuccess("");
      setActionError(
        error instanceof ApiError
          ? error.message
          : "Could not cancel the order. Please try again."
      );
    },
  });

  const busy =
    markPaidMutation.isPending ||
    cancelMutation.isPending ||
    outForDeliveryMutation.isPending ||
    confirmDeliveryMutation.isPending ||
    resetDeliveryCodeMutation.isPending;

  const orders = ordersData?.orders ?? [];

  const handleMarkPaid = (ref) => {
    setActionError("");
    setActionSuccess("");
    markPaidMutation.mutate(ref);
  };

  const handleCancel = (ref) => {
    setActionError("");
    setActionSuccess("");
    cancelMutation.mutate(ref);
  };

  const handleOutForDelivery = (ref) => {
    setActionError("");
    setActionSuccess("");

    outForDeliveryMutation.mutate(ref, {
      onSuccess: () => {
        setActionSuccess(`Order ${ref} is now out for delivery.`);
      },
      onError: (error) => {
        setActionError(
          error instanceof ApiError
            ? error.message
            : "Could not mark the order out for delivery."
        );
      },
    });
  };

  const handleConfirmDelivery = (ref, code) => {
    setActionError("");
    setActionSuccess("");

    confirmDeliveryMutation.mutate(
      { ref, code },
      {
        onSuccess: () => {
          setDeliveryLockedOrders((previous) =>
            previous.filter((orderRef) => orderRef !== ref)
          );

          setResetLimitOrders((previous) =>
            previous.filter((orderRef) => orderRef !== ref)
          );

          setActionSuccess(`Delivery confirmed for order ${ref}.`);
        },
        onError: (error) => {
          setActionError(
            error instanceof ApiError
              ? error.message
              : "Could not confirm delivery."
          );

          if (error?.code === "DELIVERY_CODE_LOCKED") {
            setDeliveryLockedOrders((previous) =>
              previous.includes(ref) ? previous : [...previous, ref]
            );
          }
        },
      }
    );
  };

  const handleResetDeliveryCode = (ref) => {
    setActionError("");
    setActionSuccess("");

    resetDeliveryCodeMutation.mutate(ref, {
      onSuccess: () => {
        setDeliveryLockedOrders((previous) =>
          previous.filter((orderRef) => orderRef !== ref)
        );

        setResetLimitOrders((previous) =>
          previous.filter((orderRef) => orderRef !== ref)
        );

        setActionSuccess(
          `Delivery code reset for order ${ref}. Ask the customer to refresh their order page.`
        );
      },
      onError: (error) => {
        setActionError(
          error instanceof ApiError
            ? error.message
            : "Could not reset the delivery code."
        );

        if (error?.code === "DELIVERY_RESET_LIMIT") {
          setResetLimitOrders((previous) =>
            previous.includes(ref) ? previous : [...previous, ref]
          );
        }
      },
    });
  };

  const handleFilterChange = (nextStatus) => {
    setStatus(nextStatus);
    setActionError("");
    setActionSuccess("");
  };

  const handleMenuChange = (event) => {
    setSelectedMenuId(event.target.value);
    setActionError("");
    setActionSuccess("");
  };

  return (
    <main className="min-h-[100dvh] bg-background px-4 pb-28 pt-6 md:px-8 md:pt-10 lg:pb-12 lg:pl-72 lg:pr-8">
      <div className="mx-auto flex w-full max-w-[420px] flex-col md:max-w-3xl lg:max-w-5xl">
        <SellerHeader businessName={sellerQuery.data?.businessName} />

        <section className="mt-8 lg:mt-0">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground md:text-4xl">
            Orders
          </h1>

          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Review customer orders, confirm transfers, and manage cancellations.
          </p>
        </section>

        {menusPending ? (
          <p className="mt-8 text-center text-sm text-muted-foreground">
            Loading your menus...
          </p>
        ) : menusIsError ? (
          <div className="mt-8 rounded-xl border border-border bg-card p-5">
            <p className="text-sm text-destructive">
              {menusError?.message ?? "Unable to load your menus."}
            </p>

            <button
              type="button"
              onClick={() => refetchMenus()}
              className="mt-3 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
            >
              Try again
            </button>
          </div>
        ) : menus.length === 0 ? (
          <div className="mt-8 md:text-center">
            <EmptyState
              title="No menus yet"
              description="Create a menu and publish it before customers can place orders."
            />

            <button
              type="button"
              onClick={() => navigate("/seller/menu/new")}
              className="mt-4 w-full rounded-lg bg-primary px-4 py-3 font-semibold text-primary-foreground md:w-auto md:px-8"
            >
              Create a menu
            </button>
          </div>
        ) : (
          <>
            <section className="mt-6 space-y-2 md:max-w-md">
              <label
                htmlFor="orders-menu"
                className="text-sm font-medium text-foreground"
              >
                Select menu
              </label>

              <select
                id="orders-menu"
                value={menuId}
                onChange={handleMenuChange}
                className="w-full rounded-lg border border-border bg-card px-3 py-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                {menus.map((menu) => (
                  <option key={menu.id} value={menu.id}>
                    {menu.title} — {menu.status}
                  </option>
                ))}
              </select>

              {selectedMenu && (
                <p className="text-xs text-muted-foreground">
                  {selectedMenu.status === "open"
                    ? "This menu is open for orders."
                    : selectedMenu.status === "draft"
                    ? "This menu is a draft."
                    : "This menu is closed. You can still review the orders."}
                </p>
              )}
            </section>

            <section className="mt-6">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-lg font-semibold text-foreground">
                  Customer orders
                </h2>

                <button
                  type="button"
                  onClick={() => refetchOrders()}
                  disabled={ordersPending}
                  aria-label="Refresh orders"
                  className="rounded-lg border border-border p-2 text-muted-foreground hover:bg-muted disabled:opacity-50"
                >
                  <RefreshCw
                    className={`h-4 w-4 ${ordersPending ? "animate-spin" : ""}`}
                  />
                </button>
              </div>

              <div className="mt-4 grid grid-cols-3 gap-1 rounded-xl bg-muted p-1 md:max-w-md">
                {[
                  { label: "All", value: "all" },
                  { label: "Pending", value: "pending" },
                  { label: "Paid", value: "paid" },
                  { label: "Out for delivery", value: "out_for_delivery" },
                  { label: "Delivered", value: "delivered" },
                  { label: "Cancelled", value: "cancelled" },
                ].map((filter) => (
                  <button
                    key={filter.value}
                    type="button"
                    onClick={() => handleFilterChange(filter.value)}
                    aria-pressed={status === filter.value}
                    className={`rounded-lg px-1 py-2 text-xs font-medium ${
                      status === filter.value
                        ? "bg-card text-foreground shadow-sm"
                        : "text-muted-foreground"
                    }`}
                  >
                    {filter.label}
                  </button>
                ))}
              </div>

              {actionSuccess && (
                <p
                  role="status"
                  className="mt-4 rounded-lg bg-soft-green p-3 text-sm text-primary"
                >
                  {actionSuccess}
                </p>
              )}

              {actionError && (
                <p
                  role="alert"
                  className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
                >
                  {actionError}
                </p>
              )}

              {ordersPending ? (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  Loading orders...
                </p>
              ) : ordersIsError ? (
                <div className="mt-4 rounded-xl border border-border bg-card p-5">
                  <p className="text-sm text-destructive">
                    {ordersError?.message ?? "Unable to load orders."}
                  </p>

                  <button
                    type="button"
                    onClick={() => refetchOrders()}
                    className="mt-3 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
                  >
                    Try again
                  </button>
                </div>
              ) : orders.length === 0 ? (
                <div className="mt-4">
                  <EmptyState
                    title={
                      status === "all" ? "No orders yet" : `No ${status} orders`
                    }
                    description={
                      status === "all"
                        ? "Customer orders will appear here when someone orders from this menu."
                        : `There are currently no orders with the ${status} status for this menu.`
                    }
                  />
                </div>
              ) : (
                <div className="mt-4 space-y-4 md:grid md:grid-cols-2 md:items-start md:gap-4 md:space-y-0">
                  {orders.map((order) => (
                    <OrderCard
                      key={order.ref}
                      order={order}
                      onMarkPaid={handleMarkPaid}
                      onCancel={handleCancel}
                      onOutForDelivery={handleOutForDelivery}
                      onConfirmDelivery={handleConfirmDelivery}
                      onResetDeliveryCode={handleResetDeliveryCode}
                      deliveryLocked={deliveryLockedOrders.includes(order.ref)}
                      resetLimitReached={resetLimitOrders.includes(order.ref)}
                      busy={busy}
                    />
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>

      <SellerBottomNav />
    </main>
  );
}
