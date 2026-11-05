import { ApiError } from "@/api/api-client";
import { Button } from "@/components/ui/button";
import { useReportPaid } from "@/hooks/useOrderPaymentExtras";
import { formatDateTime } from "@/lib/money";

// "I've paid", for customers who paid by bank transfer. It only records that the customer
// SAYS they paid. It does not mark the order paid: the seller checks their bank and
// confirms it. The wording says so, so nobody thinks pressing it is enough.
export default function ReportPaidButton({ orderRef, payment }) {
  const report = useReportPaid(orderRef);

  // The status from the server is the truth: once reported, show that instead of the button.
  if (payment?.status === "customer_reported") {
    return (
      <p className="rounded-xl bg-muted p-3 text-sm text-muted-foreground">
        You told us you paid{payment.reportedAt ? ` on ${formatDateTime(payment.reportedAt)}` : ""}. We are waiting for the
        seller to confirm they received it.
      </p>
    );
  }

  const message =
    report.error instanceof ApiError && report.error.code === "ORDER_CANCELLED"
      ? "This order was cancelled."
      : report.error?.message;

  return (
    <div className="space-y-2">
      <Button type="button" variant="outline" className="w-full rounded-xl" disabled={report.isPending} onClick={() => report.mutate()}>
        {report.isPending ? "Saving..." : "I've paid"}
      </Button>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Only press this after you have made the transfer. The seller still has to confirm it before your order is marked paid.
      </p>
      {message && (
        <p role="alert" className="text-sm text-destructive">
          {message}
        </p>
      )}
    </div>
  );
}
