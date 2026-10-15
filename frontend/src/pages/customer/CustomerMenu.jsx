import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { AlertCircle, LoaderCircle, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import CustomerHeader from "@/components/customer/Header";
import MenuItemCard from "@/components/customer/MenuItemCard";
import OrderSummary from "@/components/customer/OrderSummary";
import { useGetShop } from "@/hooks/useGetShop";

const formatCutoff = (cutoffAt) => {
  if (!cutoffAt) return null;

  const date = new Date(cutoffAt);

  if (Number.isNaN(date.getTime())) return null;

  return date.toLocaleString("en-NG", {
    timeZone: "Africa/Lagos",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
};

export default function CustomerMenu() {
  const { slug } = useParams();
  const navigate = useNavigate();

  const [quantities, setQuantities] = useState({});

  const { data, isPending, isError, error, refetch, isFetching } =
    useGetShop(slug);

  if (isPending) {
    return (
      <main className="min-h-[100dvh] bg-background">
        <div className="mx-auto w-full max-w-[420px] px-4 md:max-w-3xl md:px-8 lg:max-w-5xl">
          <CustomerHeader />

          <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
            <LoaderCircle className="animate-spin text-primary" size={32} />
            <p className="font-medium text-foreground">Loading the menu...</p>
            <p className="text-sm text-muted-foreground">
              Please wait while we fetch the latest menu.
            </p>
          </div>
        </div>
      </main>
    );
  }

  if (isError) {
    return (
      <main className="min-h-[100dvh] bg-background">
        <div className="mx-auto w-full max-w-[420px] px-4 md:max-w-3xl md:px-8 lg:max-w-5xl">
          <CustomerHeader />

          <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 text-center">
            <AlertCircle className="text-destructive" size={36} />

            <h1 className="text-xl font-bold text-foreground">
              Couldn't load this shop
            </h1>

            <p className="text-sm text-muted-foreground">
              {error?.message || "Please check your connection and try again."}
            </p>

            <Button
              type="button"
              onClick={() => refetch()}
              disabled={isFetching}
            >
              <RefreshCw
                className={isFetching ? "animate-spin" : ""}
                size={16}
              />
              Try again
            </Button>
          </div>
        </div>
      </main>
    );
  }

  const seller = data?.seller;
  const menu = data?.menu;

  if (!seller) {
    return (
      <main className="min-h-[100dvh] bg-background">
        <div className="mx-auto w-full max-w-[420px] px-4 md:max-w-3xl md:px-8 lg:max-w-5xl">
          <CustomerHeader />

          <div className="py-16 text-center">
            <h1 className="text-xl font-bold text-foreground">
              Shop not found
            </h1>

            <p className="mt-2 text-sm text-muted-foreground">
              This shop link doesn't exist. Please check the link and try again.
            </p>
          </div>
        </div>
      </main>
    );
  }

  const menuItems = menu?.items ?? [];
  const acceptingOrders = Boolean(menu?.acceptingOrders);
  const cutoff = formatCutoff(menu?.cutoffAt);

  const selectedItems = menuItems
    .filter((item) => (quantities[item.id] ?? 0) > 0)
    .map((item) => ({
      ...item,
      quantity: quantities[item.id],
    }));

  const handleQuantityChange = (item, quantity) => {
    setQuantities((previous) => ({
      ...previous,
      [item.id]: quantity,
    }));
  };

  const handleCheckout = () => {
    navigate(`/shop/${slug}/checkout`, {
      state: {
        seller,
        menu,
        selectedItems,
      },
    });
  };

  return (
    <main className="min-h-[100dvh] bg-background">
      <div className="mx-auto flex min-h-[100dvh] w-full max-w-[420px] flex-col px-4 pb-8 md:max-w-3xl md:px-8 md:pb-12 lg:max-w-5xl">
        <CustomerHeader />

        <section className="space-y-2 py-4 md:py-6">
          <p className="text-xs font-semibold uppercase tracking-widest text-primary">
            Today's menu
          </p>

          <h1 className="text-2xl font-bold tracking-tight text-foreground md:text-4xl">
            {seller.businessName}
          </h1>

          {menu ? (
            <>
              <h2 className="text-base font-medium text-foreground">
                {menu.title}
              </h2>

              {cutoff && (
                <p className="text-sm text-muted-foreground">
                  Order before {cutoff}
                </p>
              )}
            </>
          ) : (
            <div className="rounded-xl border border-border bg-card p-4 md:max-w-lg">
              <h2 className="font-semibold text-foreground">
                No menu available
              </h2>

              <p className="mt-1 text-sm text-muted-foreground">
                This shop doesn't have an open menu right now. Please check back
                later.
              </p>
            </div>
          )}
        </section>

        {menu && (
          <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:gap-8">
            <div className="min-w-0">
              {!acceptingOrders && (
                <div className="mb-4 rounded-xl border border-border bg-muted/50 p-3">
                  <p className="text-sm font-medium text-foreground">
                    Ordering is closed
                  </p>

                  <p className="mt-1 text-sm text-muted-foreground">
                    You can browse the menu, but you cannot place an order right
                    now.
                  </p>
                </div>
              )}

              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-semibold text-foreground">
                    Menu items
                  </h2>

                  <span className="text-sm text-muted-foreground">
                    {menuItems.length} {menuItems.length === 1 ? "item" : "items"}
                  </span>
                </div>

                <div className="space-y-3 md:grid md:grid-cols-2 md:gap-3 md:space-y-0 lg:grid-cols-1 lg:space-y-0">
                  {menuItems.length > 0 ? (
                    menuItems.map((item) => (
                      <MenuItemCard
                        key={item.id}
                        item={item}
                        quantity={quantities[item.id] ?? 0}
                        acceptingOrders={acceptingOrders}
                        onQuantityChange={(quantity) =>
                          handleQuantityChange(item, quantity)
                        }
                      />
                    ))
                  ) : (
                    <p className="rounded-xl border border-border p-4 text-sm text-muted-foreground">
                      There are no food items on this menu yet.
                    </p>
                  )}
                </div>
              </section>
            </div>

            {acceptingOrders && (
              <section className="mt-6 lg:sticky lg:top-6 lg:mt-0">
                <OrderSummary
                  items={selectedItems}
                  onCheckout={handleCheckout}
                  checkoutDisabled={!menu.id}
                />
              </section>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
