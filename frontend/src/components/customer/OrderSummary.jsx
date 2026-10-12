
import { Button } from "@/components/ui/button";

const formatPrice = (price) =>
  new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    maximumFractionDigits: 0,
  }).format(price);

export default function OrderSummary({
  items = [],
  onCheckout,
  checkoutDisabled = false,
  showItems = true,
}) {
  const selectedItems = items.filter((item) => item.quantity > 0);

  const totalPortions = selectedItems.reduce(
    (total, item) => total + item.quantity,
    0
  );

  const totalPrice = selectedItems.reduce(
    (total, item) => total + item.price * item.quantity,
    0
  );

  return (
    <section className="space-y-4 rounded-2xl border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-foreground">
          Your basket
        </h2>

        <span className="rounded-full bg-soft-green px-3 py-1 text-sm font-medium text-primary">
          {totalPortions}{" "}
          {totalPortions === 1 ? "portion" : "portions"}
        </span>
      </div>

      {showItems && (
        <div className="space-y-3">
          {selectedItems.length > 0 ? (
            selectedItems.map((item) => (
              <div
                key={item.id}
                className="flex items-start justify-between gap-4 text-sm"
              >
                <div className="min-w-0">
                  <p className="font-medium text-foreground">
                    {item.name}
                  </p>

                  <p className="text-muted-foreground">
                    {item.quantity} × {formatPrice(item.price)}
                  </p>
                </div>

                <p className="shrink-0 font-medium text-foreground">
                  {formatPrice(item.price * item.quantity)}
                </p>
              </div>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">
              Your basket is empty. Add some food to get started.
            </p>
          )}
        </div>
      )}

      <div className="flex items-center justify-between border-t border-border pt-4">
        <span className="font-semibold text-foreground">
          Total
        </span>

        <span className="text-xl font-bold text-primary">
          {formatPrice(totalPrice)}
        </span>
      </div>

      {onCheckout && (
        <Button
          type="button"
          className="w-full rounded-xl"
          disabled={checkoutDisabled || totalPortions === 0}
          onClick={onCheckout}
        >
          Continue to checkout
        </Button>
      )}
    </section>
  );
}
