import { Link } from "react-router-dom";
import { BadgeCheck, MessageSquareWarning, Undo2, Wallet } from "lucide-react";

import { MetricCard } from "@/components/admin/admin-ui";
import { formatNaira } from "@/components/admin/admin-format";

// The money figures for the admin overview: what needs a person, and ChopList's income.
// Takes the overview response as it is. Every figure is optional, so an older backend that
// does not send them simply shows dashes.
export default function PaymentsOverviewSection({ overview }) {
  const payments = overview?.payments;
  const subs = overview?.subscriptions;
  if (!payments && !subs) return null;

  return (
    <div className="mt-10">
      <h2 className="text-lg font-semibold">Money</h2>
      <p className="mt-1 text-sm text-muted-foreground">What needs a person, and what ChopList earns.</p>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <Link to="/admin/refunds" className="block">
          <MetricCard label="Refunds still to make" value={payments?.refundsDue} description="Open the refunds page" icon={Undo2} tone={payments?.refundsDue > 0 ? "alert" : "default"} />
        </Link>
        <Link to="/admin/payment-problems" className="block">
          <MetricCard label="Open payment problems" value={payments?.openPaymentQueries} description="Reported by customers or sellers" icon={MessageSquareWarning} tone={payments?.openPaymentQueries > 0 ? "alert" : "default"} />
        </Link>
        <Link to="/admin/subscriptions" className="block">
          <MetricCard label="Vendors paying now" value={subs?.activeNow} description="Covered by a subscription at this moment" icon={BadgeCheck} />
        </Link>
        <MetricCard label="Subscription income" value={subs ? formatNaira(subs.revenue?.allTime) : undefined} description={subs ? `${formatNaira(subs.revenue?.last30Days)} in the last 30 days` : undefined} icon={Wallet} />
        <MetricCard label="Online payments" value={payments?.paidOnPlatform?.allTime?.orders} description="Orders paid through Paystack, all time" icon={Wallet} />
        <MetricCard label="Payments needing review" value={payments?.paymentsNeedingReview} description="Money that arrived but could not be applied" icon={MessageSquareWarning} tone={payments?.paymentsNeedingReview > 0 ? "alert" : "default"} />
      </div>
    </div>
  );
}
