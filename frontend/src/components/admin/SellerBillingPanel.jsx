import { useState } from "react";
import { useAuth } from "@clerk/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck } from "lucide-react";

import { grantAdminSubscription, setAdminVerification } from "@/api/admin-payments-api";
import { ErrorMessage, StatusBadge } from "@/components/admin/admin-ui";
import { formatDate, getErrorMessage } from "@/components/admin/admin-format";

const verificationOptions = [
  { value: "not_started", label: "Not started" },
  { value: "pending", label: "Pending" },
  { value: "verified", label: "Verified" },
  { value: "rejected", label: "Rejected" },
];

function Fact({ label, children }) {
  return (
    <div>
      <p className="text-sm text-muted-foreground">{label}</p>
      <div className="mt-1 text-sm font-medium">{children}</div>
    </div>
  );
}

// On a vendor's own page: their trial and subscription at a glance, a way to GIVE them a
// free subscription (a reason is required and is kept in the audit log), and their
// verification status. Verification is only recorded: it blocks and unlocks nothing yet.
export default function SellerBillingPanel({ sellerId, billing }) {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();

  const [plan, setPlan] = useState("monthly");
  const [reason, setReason] = useState("");
  const [grantMessage, setGrantMessage] = useState("");
  const [verifyStatus, setVerifyStatus] = useState(billing?.verification?.status ?? "not_started");
  const [verifyNote, setVerifyNote] = useState("");
  const [verifyMessage, setVerifyMessage] = useState("");

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["admin", "seller", sellerId] }),
      queryClient.invalidateQueries({ queryKey: ["admin", "subscriptions"] }),
      queryClient.invalidateQueries({ queryKey: ["admin", "overview"] }),
    ]);

  const grant = useMutation({
    mutationFn: () => grantAdminSubscription(getToken, sellerId, { plan, note: reason }),
    onSuccess: async () => {
      setReason("");
      setGrantMessage("Free subscription given.");
      await refresh();
    },
    onError: () => setGrantMessage(""),
  });

  const verify = useMutation({
    mutationFn: () => setAdminVerification(getToken, sellerId, { status: verifyStatus, note: verifyNote }),
    onSuccess: async () => {
      setVerifyNote("");
      setVerifyMessage("Verification saved.");
      await refresh();
    },
    onError: () => setVerifyMessage(""),
  });

  const trialNotStarted = !billing || billing.state === null;

  return (
    <div className="rounded-xl border border-border bg-card p-5 sm:p-6">
      <div className="flex items-center gap-2">
        <BadgeCheck size={19} className="text-muted-foreground" />
        <h2 className="font-semibold text-foreground">Trial, subscription and verification</h2>
      </div>

      {trialNotStarted ? (
        <p className="mt-4 text-sm text-muted-foreground">This seller is from before billing existed. Their free trial starts the first time they use the app, or when the backfill is run. You can't give them a subscription or set verification until then.</p>
      ) : (
        <>
          <div className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            <Fact label="State">
              <StatusBadge value={billing.state} />
              <p className="mt-1 text-xs font-normal text-muted-foreground">{billing.canShareLink ? "Can share their shop link" : "Cannot share their shop link"}</p>
            </Fact>
            <Fact label="Free trial ends">{formatDate(billing.trialEndsAt)}</Fact>
            <Fact label="Paid cover ends">{billing.accessEndsAt ? formatDate(billing.accessEndsAt) : "No paid cover"}</Fact>
            <Fact label="Current subscription">{billing.subscription ? `${billing.subscription.plan}, until ${formatDate(billing.subscription.expiresAt)}` : "None"}</Fact>
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                setGrantMessage("");
                grant.mutate();
              }}
              className="space-y-3 rounded-xl bg-muted/50 p-4"
            >
              <h3 className="text-sm font-semibold">Give a free subscription</h3>
              <p className="text-xs text-muted-foreground">Starts when their current cover ends, or now. It is not counted as income. Giving twice gives two periods.</p>
              <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
                Plan
                <select value={plan} onChange={(event) => setPlan(event.target.value)} className="min-h-10 rounded-lg border border-border bg-background px-3 text-sm text-foreground">
                  <option value="monthly">Monthly (1 month)</option>
                  <option value="quarterly">Quarterly (3 months)</option>
                </select>
              </label>
              <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
                Reason (required, kept in the audit log)
                <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} maxLength={300} className="rounded-lg border border-border bg-background p-2 text-sm text-foreground" />
              </label>
              <ErrorMessage>{grant.isError ? getErrorMessage(grant.error) : ""}</ErrorMessage>
              {grantMessage && <p className="text-sm text-primary">{grantMessage}</p>}
              <button type="submit" disabled={grant.isPending || reason.trim().length < 3} className="min-h-10 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50">
                {grant.isPending ? "Giving..." : "Give subscription"}
              </button>
            </form>

            <form
              onSubmit={(event) => {
                event.preventDefault();
                setVerifyMessage("");
                verify.mutate();
              }}
              className="space-y-3 rounded-xl bg-muted/50 p-4"
            >
              <h3 className="text-sm font-semibold">Verification</h3>
              <p className="text-xs text-muted-foreground">
                Currently <StatusBadge value={billing.verification?.status} />
                {billing.verificationDue && " (the trial has ended: verification is due)"}. This is only recorded for now: it does not block or unlock anything.
              </p>
              <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
                Set to
                <select value={verifyStatus} onChange={(event) => setVerifyStatus(event.target.value)} className="min-h-10 rounded-lg border border-border bg-background px-3 text-sm text-foreground">
                  {verificationOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
                Note (optional)
                <textarea value={verifyNote} onChange={(event) => setVerifyNote(event.target.value)} rows={2} maxLength={300} className="rounded-lg border border-border bg-background p-2 text-sm text-foreground" />
              </label>
              <ErrorMessage>{verify.isError ? getErrorMessage(verify.error) : ""}</ErrorMessage>
              {verifyMessage && <p className="text-sm text-primary">{verifyMessage}</p>}
              <button type="submit" disabled={verify.isPending || verifyStatus === (billing.verification?.status ?? "not_started")} className="min-h-10 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50">
                {verify.isPending ? "Saving..." : "Save verification"}
              </button>
            </form>
          </div>
        </>
      )}
    </div>
  );
}
