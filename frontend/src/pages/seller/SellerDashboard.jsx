import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, Copy, Send } from "lucide-react";
import { ApiError } from "@/api/api-client";
import SellerHeader from "@/components/seller/Header";
import SellerBottomNav from "@/components/seller/BottomNav";
import { ChopListLogo } from "@/components/choplist-logo";
import { useCurrentSeller } from "@/hooks/useCurrentSeller";
import { useGetMenus } from "@/hooks/useGetMenus";
import { useOpenMenu } from "@/hooks/use-open-menu";
import { useCloseMenu } from "@/hooks/use-close-menu";

const formatPrice = (amount) =>
  new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    maximumFractionDigits: 0,
  }).format(amount);

const formatLagosDateTime = (timestamp) =>
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

const getMenuStatus = (status) => {
  const statuses = {
    draft: "Draft",
    open: "Open for orders",
    closed: "Closed",
  };

  return statuses[status] ?? status;
};

function LoadingState() {
  return (
    <p className="py-10 text-center text-sm text-muted-foreground">
      Loading your dashboard...
    </p>
  );
}

function ErrorState({ message, onRetry }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5 text-center">
      <p className="text-sm text-destructive">{message}</p>

      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
        >
          Try again
        </button>
      )}
    </div>
  );
}

function MenuStatus({ status }) {
  const styles = {
    draft: "bg-warning text-foreground",
    open: "bg-soft-green text-primary",
    closed: "bg-muted text-muted-foreground",
  };

  return (
    <span
      className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${
        styles[status] ?? "bg-muted text-muted-foreground"
      }`}
    >
      {getMenuStatus(status)}
    </span>
  );
}

function MenuItemCard({ item }) {
  return (
    <article className="flex items-center justify-between gap-4 rounded-xl border border-border bg-card p-4">
      <div className="min-w-0 flex-1">
        <h3 className="font-semibold text-foreground">{item.name}</h3>

        {item.description && (
          <p className="mt-1 text-sm text-muted-foreground">
            {item.description}
          </p>
        )}

        <p className="mt-2 font-semibold text-primary">
          {formatPrice(item.price)}
        </p>
      </div>

      <div className="shrink-0 text-right">
        <p className="text-lg font-bold text-foreground">{item.qtyRemaining}</p>

        <p className="text-xs text-muted-foreground">
          of {item.qtyTotal} portions left
        </p>
      </div>
    </article>
  );
}

export default function SellerDashboard() {
  const navigate = useNavigate();

  const [actionError, setActionError] = useState("");
  const [copied, setCopied] = useState(false);

  const {
    data: seller,
    isPending: isSellerPending,
    isError: isSellerError,
    error: sellerError,
    refetch: refetchSeller,
  } = useCurrentSeller();

  const openMenuMutation = useOpenMenu();
  const closeMenuMutation = useCloseMenu();

  const isBusy = openMenuMutation.isPending || closeMenuMutation.isPending;

  const needsProfile =
    sellerError instanceof ApiError && sellerError.code === "PROFILE_REQUIRED";

  const {
    data: menusData,
    isPending: areMenusPending,
    isError: areMenusError,
    error: menusError,
    refetch: refetchMenus,
  } = useGetMenus({
    enabled: !isSellerPending && !needsProfile && !isSellerError && Boolean(seller)
  });

  const menusNeedProfile =
    menusError instanceof ApiError && menusError.code === "PROFILE_REQUIRED";

  if (isSellerPending) {
    return (
      <main className="min-h-[100dvh] bg-background px-4 py-8">
        <div className="mx-auto w-full max-w-[420px]">
          <div className="flex items-center justify-center">
            <ChopListLogo />
          </div>

          <LoadingState />
        </div>
      </main>
    );
  }

  if (isSellerError && !needsProfile) {
    return (
      <main className="min-h-[100dvh] bg-background px-4 py-8">
        <div className="mx-auto w-full max-w-[420px] space-y-5">
          <ErrorState
            message={sellerError?.message || "Unable to load your profile."}
            onRetry={refetchSeller}
          />
        </div>
      </main>
    );
  }

  const menus = menusData?.menus ?? [];

  const activeMenu =
    menus.find((menu) => menu.status === "open") ??
    menus.find((menu) => menu.status === "draft") ??
    null;

  const menuItems = activeMenu?.items ?? [];

  const totalPortions = menuItems.reduce(
    (total, item) => total + (item.qtyRemaining ?? 0),
    0
  );

  const shareUrl =
    activeMenu?.status === "open" && seller?.slug
      ? `${window.location.origin}/shop/${encodeURIComponent(seller.slug)}`
      : "";

  const handlePublish = async () => {
    if (!activeMenu || activeMenu.status !== "draft") return;

    setActionError("");
    setCopied(false);

    try {
      await openMenuMutation.mutateAsync(activeMenu.id);
    } catch (error) {
      if (error instanceof ApiError) {
        const messages = {
          ANOTHER_MENU_OPEN:
            "Another menu is already open. Close it before publishing this menu.",
          CUTOFF_PASSED:
            "The cutoff time has passed. Edit your draft and choose a future cutoff time.",
          MENU_CLOSED:
            "This menu is closed permanently. Create a new menu instead.",
        };

        setActionError(messages[error.code] ?? error.message);
      } else {
        setActionError("Unable to publish your menu. Please try again.");
      }
    }
  };

  const handleCopyLink = async () => {
    if (!shareUrl) return;

    setActionError("");

    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
    } catch {
      setActionError(
        "Unable to copy automatically. Please select and copy the link manually."
      );
    }
  };

  const handleCloseMenu = async () => {
    if (!activeMenu || activeMenu.status !== "open") return;

    const confirmed = window.confirm(
      "Close this menu? Customers will no longer be able to order from it, and it cannot be reopened."
    );

    if (!confirmed) return;

    setActionError("");
    setCopied(false);

    try {
      await closeMenuMutation.mutateAsync(activeMenu.id);
    } catch (error) {
      setActionError(
        error instanceof ApiError
          ? error.message
          : "Unable to close your menu. Please try again."
      );
    }
  };

  return (
    <main className="min-h-[100dvh] bg-background px-4 py-6 pb-28 md:px-8 md:pt-10 lg:pb-12 lg:pl-72 lg:pr-8">
      <div className="mx-auto flex w-full max-w-[420px] flex-col md:max-w-3xl lg:max-w-5xl">
        <SellerHeader businessName={seller?.businessName || "Your shop"} />

        <section className="mt-8 lg:mt-0">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground md:text-4xl">
            What's cooking?
          </h1>

          <p className="mt-2 text-sm text-muted-foreground">
            Manage your menu and keep your customers hungry for more.
          </p>
        </section>

        {needsProfile && (
          <section className="mt-6 rounded-xl border border-border bg-card p-4 md:flex md:items-center md:justify-between md:gap-6 md:p-5">
            <div>
              <h2 className="font-semibold text-foreground">
                Complete your shop profile
              </h2>

              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                You skipped setup. You can complete your business and payment
                details whenever you're ready.
              </p>
            </div>

            <button
              type="button"
              onClick={() => navigate("/seller/profile/edit")}
              className="mt-4 w-full rounded-lg bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground hover:opacity-90 md:mt-0 md:w-auto md:shrink-0 md:px-6"
            >
              Complete profile
            </button>
          </section>
        )}

        {areMenusPending && !needsProfile ? (
          <div className="mt-8">
            <LoadingState />
          </div>
        ) : areMenusError && !menusNeedProfile ? (
          <div className="mt-8">
            <ErrorState
              message={menusError?.message || "Unable to load your menus."}
              onRetry={refetchMenus}
            />
          </div>
        ) : !activeMenu ? (
          <section className="mt-8 rounded-xl border border-border bg-card p-6 text-center md:px-10 md:py-12">
            <h2 className="text-lg font-semibold text-foreground">
              {needsProfile ? "Your dashboard is ready" : "No menu yet"}
            </h2>

            <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
              {needsProfile
                ? "Your account is ready. Complete your profile when convenient, then create your first menu to start accepting orders."
                : "Create your first menu to add dishes, set your delivery schedule, and start accepting orders."}
            </p>

            {!needsProfile && (
              <button
                type="button"
                onClick={() => navigate("/seller/menu/new")}
                className="mt-5 w-full rounded-lg bg-primary px-4 py-3 font-semibold text-primary-foreground hover:opacity-90 md:w-auto md:px-8"
              >
                Create your first menu
              </button>
            )}

            {needsProfile && (
              <button
                type="button"
                onClick={() => navigate("/seller/profile/edit")}
                className="mt-5 w-full rounded-lg border border-border px-4 py-3 font-semibold text-foreground hover:bg-muted md:w-auto md:px-8"
              >
                Update your profile
              </button>
            )}
          </section>
        ) : (
          <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start lg:gap-8">
            <div className="min-w-0">
              <section className="mt-8 rounded-xl border border-border bg-card p-4 md:p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Current menu
                    </p>

                    <h2 className="mt-1 text-lg font-medium text-foreground">
                      {activeMenu.title}
                    </h2>
                  </div>

                  <MenuStatus status={activeMenu.status} />
                </div>

                <p className="mt-3 text-sm text-muted-foreground">
                  Order cutoff: {formatLagosDateTime(activeMenu.cutoffAt)}
                </p>
              </section>

              <section className="mt-8">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <h2 className="text-lg font-semibold text-foreground">
                    Your Menu
                  </h2>

                  <span className="text-sm text-muted-foreground">
                    {menuItems.length}{" "}
                    {menuItems.length === 1 ? "dish" : "dishes"}
                  </span>
                </div>

                {menuItems.length === 0 ? (
                  <p className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
                    This menu has no dishes yet.
                  </p>
                ) : (
                  <div className="space-y-3 md:grid md:grid-cols-2 md:gap-3 md:space-y-0">
                    {menuItems.map((item) => (
                      <MenuItemCard key={item.id} item={item} />
                    ))}
                  </div>
                )}

                {activeMenu.status === "draft" && (
                  <button
                    type="button"
                    onClick={() =>
                      navigate(`/seller/menu/${activeMenu.id}/edit`)
                    }
                    className="mt-3 w-full rounded-lg border border-border px-4 py-3 text-sm font-semibold text-foreground hover:bg-muted"
                  >
                    Edit menu and delivery schedule
                  </button>
                )}
              </section>
            </div>

            <div className="lg:sticky lg:top-10 lg:mt-8">
              <section className="mt-6 lg:mt-0">
                <h2 className="text-lg font-bold text-foreground">
                  Delivery details
                </h2>

                <div className="mt-3 rounded-xl border border-border bg-card p-4">
                  <p className="text-sm font-medium text-foreground">
                    Delivery days
                  </p>

                  <div className="mt-2 flex flex-wrap gap-2">
                    {(activeMenu.deliveryDays ?? []).map((day) => (
                      <span
                        key={day}
                        className="rounded-md bg-muted px-2 py-1 text-xs text-foreground"
                      >
                        {formatDeliveryDay(day)}
                      </span>
                    ))}
                  </div>

                  <p className="mt-4 text-sm font-medium text-foreground">
                    Delivery areas
                  </p>

                  <div className="mt-2 flex flex-wrap gap-2">
                    {(activeMenu.areas ?? []).map((area) => (
                      <span
                        key={area}
                        className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground"
                      >
                        {area}
                      </span>
                    ))}
                  </div>
                </div>
              </section>

              {activeMenu.status === "draft" && (
                <button
                  type="button"
                  onClick={handlePublish}
                  disabled={isBusy || menuItems.length === 0}
                  className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-4 font-semibold text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Send className="h-5 w-5" />

                  {openMenuMutation.isPending
                    ? "Publishing menu..."
                    : `Publish menu · ${totalPortions} portions`}
                </button>
              )}

              {activeMenu.status === "open" && (
                <section className="mt-6 rounded-xl border border-border bg-card p-4">
                  <div className="flex items-center gap-2">
                    <Check className="h-5 w-5 text-primary" />
                    <h2 className="font-semibold text-foreground">
                      Your menu is published
                    </h2>
                  </div>

                  <p className="mt-2 text-sm text-muted-foreground">
                    Share this link with your customers so they can view your
                    menu.
                  </p>

                  <div className="mt-3 break-all rounded-lg bg-muted p-3 text-sm text-foreground">
                    {shareUrl ||
                      "Your customer link is unavailable because the shop slug is missing."}
                  </div>

                  <button
                    type="button"
                    onClick={handleCopyLink}
                    disabled={!shareUrl}
                    className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3 font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {copied ? (
                      <Check className="h-4 w-4" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                    {copied ? "Link copied" : "Copy shareable link"}
                  </button>

                  <button
                    type="button"
                    onClick={handleCloseMenu}
                    disabled={isBusy}
                    className="mt-8 w-full rounded-lg border border-border px-4 py-3 text-sm font-semibold text-destructive/70 hover:border-destructive disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {closeMenuMutation.isPending
                      ? "Closing menu..."
                      : "Close menu"}
                  </button>
                </section>
              )}
            </div>
          </div>
        )}

        {actionError && (
          <div
            role="alert"
            className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
          >
            {actionError}
          </div>
        )}
      </div>
      <SellerBottomNav />
    </main>
  );
}
