import { useOrderPaymentQuote } from "@/hooks/useOrderPaymentExtras";
import { formatNaira } from "@/lib/money";

// Shows what paying online will cost BEFORE the customer presses Pay, so the card fee is
// never a surprise. Shows nothing if the price cannot be worked out (online payment off,
// or the order is no longer payable): the Pay button then behaves as it always did.
export default function PaymentQuotePreview({ orderRef, enabled }) {
  const { data } = useOrderPaymentQuote(orderRef, enabled);

  if (!data || data.total == null) return null;

  const customerPaysFee = data.feePayer === "customer" && data.serviceFee > 0;

  return (
    <div className="space-y-2 rounded-xl bg-soft-green p-4 text-sm">
      <div className="flex justify-between gap-3">
        <span className="text-muted-foreground">Order amount</span>
        <span className="font-medium text-foreground">{formatNaira(data.orderTotal)}</span>
      </div>

      {customerPaysFee && (
        <div className="flex justify-between gap-3">
          <span className="text-muted-foreground">Card fee</span>
          <span className="font-medium text-foreground">{formatNaira(data.serviceFee)}</span>
        </div>
      )}

      <div className="flex justify-between gap-3 border-t border-border pt-2">
        <span className="font-semibold text-foreground">You will pay</span>
        <span className="text-lg font-bold text-primary">{formatNaira(data.total)}</span>
      </div>
    </div>
  );
}
