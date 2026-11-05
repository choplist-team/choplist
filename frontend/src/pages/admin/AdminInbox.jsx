import { useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "@clerk/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCheck, RefreshCw } from "lucide-react";

import { getAdminNotifications, markAdminNotificationsRead } from "@/api/admin-payments-api";
import { EmptyState, ErrorMessage, PageHeader } from "@/components/admin/admin-ui";
import { formatDate, getErrorMessage } from "@/components/admin/admin-format";

// What each kind of notification is, and where to go to deal with it.
const kinds = {
  refund_due: { label: "Refund due", to: "/admin/refunds" },
  payment_needs_review: { label: "Money to look at", to: "/admin/refunds" },
  payment_query_raised: { label: "Payment problem", to: "/admin/payment-problems" },
  subscription_needs_review: { label: "Subscription payment", to: "/admin/subscriptions" },
};

export default function AdminInbox() {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const queryClient = useQueryClient();
  const [unreadOnly, setUnreadOnly] = useState(false);

  const query = useQuery({
    queryKey: ["admin", "notifications", { unreadOnly }],
    queryFn: () => getAdminNotifications(getToken, { unread: unreadOnly, limit: 50 }),
    enabled: isLoaded && isSignedIn,
    refetchInterval: 60_000,
  });

  const readMutation = useMutation({
    mutationFn: (body) => markAdminNotificationsRead(getToken, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "notifications"] }),
  });

  const items = query.data?.notifications ?? [];
  const unreadCount = query.data?.unreadCount ?? 0;

  return (
    <section className="space-y-6 p-6 lg:p-8">
      <PageHeader eyebrow="INBOX" title="Needs your attention" description="Things the platform wants a person to look at. This inbox is shared by every admin.">
        <div className="flex flex-wrap gap-2 self-start">
          <button type="button" onClick={() => query.refetch()} disabled={query.isFetching} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-border px-4 text-sm font-medium hover:bg-muted disabled:opacity-60">
            <RefreshCw size={16} className={query.isFetching ? "animate-spin" : ""} />
            Refresh
          </button>
          <button type="button" disabled={unreadCount === 0 || readMutation.isPending} onClick={() => readMutation.mutate({ all: true })} className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50">
            <CheckCheck size={16} />
            Mark all read
          </button>
        </div>
      </PageHeader>

      <label className="flex w-fit items-center gap-2 text-sm">
        <input type="checkbox" checked={unreadOnly} onChange={(event) => setUnreadOnly(event.target.checked)} />
        Show unread only ({unreadCount} unread)
      </label>

      <ErrorMessage>{query.isError ? getErrorMessage(query.error) : readMutation.isError ? getErrorMessage(readMutation.error) : ""}</ErrorMessage>
      {query.isPending && <p className="text-sm text-muted-foreground">Loading...</p>}
      {!query.isPending && !query.isError && items.length === 0 && <EmptyState>{unreadOnly ? "Nothing unread." : "Nothing here yet."}</EmptyState>}

      <ul className="space-y-3">
        {items.map((item) => {
          const kind = kinds[item.type] ?? { label: item.type.replaceAll("_", " "), to: null };
          return (
            <li key={item.id} className={`flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-start sm:justify-between ${item.read ? "border-border bg-card" : "border-primary/40 bg-soft-green"}`}>
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {kind.label} · {formatDate(item.createdAt)}
                </p>
                <p className="mt-1 text-sm">{item.message}</p>
                {item.orderRef && <p className="mt-1 text-xs text-muted-foreground">Order {item.orderRef}</p>}
              </div>
              <div className="flex shrink-0 gap-2">
                {kind.to && (
                  <Link to={kind.to} className="min-h-9 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted">
                    Open
                  </Link>
                )}
                {!item.read && (
                  <button type="button" onClick={() => readMutation.mutate({ ids: [item.id] })} disabled={readMutation.isPending} className="min-h-9 rounded-lg border border-border px-3 text-sm hover:bg-muted disabled:opacity-60">
                    Mark read
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
