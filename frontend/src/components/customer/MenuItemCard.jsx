
import { Card, CardContent } from "@/components/ui/card";
import QuantityStepper from "./QuantityStepper";

const formatPrice = (price) =>
  new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    maximumFractionDigits: 0,
  }).format(price);

export default function MenuItemCard({
  item,
  quantity = 0,
  onQuantityChange,
  acceptingOrders = true,
}) {
  const soldOut = item.soldOut || item.qtyRemaining <= 0;

  return (
    <Card className="overflow-hidden rounded-2xl border-border bg-card shadow-sm">
      <CardContent className="flex items-center justify-between gap-4 p-4">
        <div className="min-w-0 flex-1 space-y-2">
          <h3 className="font-semibold text-foreground">
            {item.name}
          </h3>

          {item.description && (
            <p className="text-sm leading-relaxed text-muted-foreground">
              {item.description}
            </p>
          )}

          <p className="font-bold text-primary">
            {formatPrice(item.price)}
          </p>

          {soldOut ? (
            <p className="text-sm font-medium text-destructive">
              Sold out
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {item.qtyRemaining}{" "}
              {item.qtyRemaining === 1 ? "portion" : "portions"} left
            </p>
          )}

          {!acceptingOrders && !soldOut && (
            <p className="text-sm font-medium text-muted-foreground">
              Ordering is closed
            </p>
          )}
        </div>

        <div className="shrink-0">
          {!soldOut && (
            <QuantityStepper
              quantity={quantity}
              max={item.qtyRemaining}
              disabled={!acceptingOrders}
              onChange={onQuantityChange}
            />
          )}
        </div>
      </CardContent>
    </Card>
  );
}
