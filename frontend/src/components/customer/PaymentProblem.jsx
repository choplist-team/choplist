import { useState } from "react";

import { ApiError } from "@/api/api-client";
import { Button } from "@/components/ui/button";
import { usePaymentProblems, useRaisePaymentProblem } from "@/hooks/useOrderPaymentExtras";
import { formatDateTime } from "@/lib/money";

const REASONS = [
  { value: "payment_not_reflected", label: "I paid, but my order still shows unpaid" },
  { value: "paid_twice", label: "I was charged more than once" },
  { value: "wrong_amount", label: "The amount is wrong" },
  { value: "other", label: "Something else" },
];

// "Something wrong with your payment?" The customer describes the problem; ChopList looks
// at it and replies here. Reporting changes nothing about the order or the money by itself.
export default function PaymentProblem({ orderRef }) {
  const problems = usePaymentProblems(orderRef);
  const raise = useRaisePaymentProblem(orderRef);

  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState(REASONS[0].value);
  const [message, setMessage] = useState("");

  const list = problems.data?.queries ?? [];

  const submit = async (event) => {
    event.preventDefault();
    try {
      await raise.mutateAsync({ reason, message: message.trim() });
      setMessage("");
      setOpen(false);
    } catch {
      // The error is shown below from raise.error.
    }
  };

  const errorText =
    raise.error instanceof ApiError && raise.error.code === "QUERY_ALREADY_OPEN"
      ? "You already have an open report on this order. We will get back to you."
      : raise.error?.message;

  return (
    <section className="space-y-3 rounded-2xl border border-border bg-card p-5 md:p-6">
      <h2 className="text-lg font-bold text-foreground">Something wrong with your payment?</h2>

      {list.map((item) => (
        <div key={item.id} className="rounded-xl bg-muted p-3 text-sm">
          <p className="text-xs text-muted-foreground">
            Reported {formatDateTime(item.createdAt)} · {item.status === "resolved" ? "Answered" : "We are looking into it"}
          </p>
          <p className="mt-1 whitespace-pre-wrap break-words text-foreground">{item.message}</p>
          {item.status === "resolved" && (
            <p className="mt-2 border-t border-border pt-2 text-foreground">
              <span className="font-semibold">ChopList: </span>
              {item.resolutionNote || "We have looked at this."}
            </p>
          )}
        </div>
      ))}

      {!open ? (
        <Button type="button" variant="outline" className="w-full rounded-xl" onClick={() => setOpen(true)}>
          Report a payment problem
        </Button>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <label className="block text-sm font-medium text-foreground">
            What happened?
            <select value={reason} onChange={(event) => setReason(event.target.value)} className="mt-1 w-full rounded-lg border border-border bg-background p-2 text-sm">
              {REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-sm font-medium text-foreground">
            Tell us more
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              rows={3}
              maxLength={500}
              className="mt-1 w-full rounded-lg border border-border bg-background p-2 text-sm"
              placeholder="For example: I transferred at 2pm and the order still says unpaid."
            />
          </label>

          {errorText && (
            <p role="alert" className="text-sm text-destructive">
              {errorText}
            </p>
          )}

          <div className="flex gap-2">
            <Button type="submit" className="flex-1 rounded-xl" disabled={raise.isPending || message.trim().length < 5}>
              {raise.isPending ? "Sending..." : "Send"}
            </Button>
            <Button type="button" variant="outline" className="rounded-xl" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
