import { useState } from "react";
import { Bell } from "lucide-react";

import { useMarkNotificationsRead, useSellerNotifications } from "@/hooks/useSellerNotifications";
import { formatDateTime } from "@/lib/money";

// The seller's bell: a red number for what they have not read, and a short list when they
// press it (paid orders, "customer says they paid", payment problems, subscription news).
// `align` is which edge of the bell the list lines up with.
export default function NotificationsBell({ align = "right" }) {
  const [open, setOpen] = useState(false);
  const { data } = useSellerNotifications();
  const markRead = useMarkNotificationsRead();

  // If the notifications cannot be loaded, show no bell at all rather than a broken one.
  if (!data) return null;

  const unread = data.unreadCount ?? 0;
  const items = data.notifications ?? [];

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        aria-expanded={open}
        className="relative inline-flex size-10 items-center justify-center rounded-full border border-border bg-card hover:bg-muted"
      >
        <Bell className="size-5" />
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 min-w-5 rounded-full bg-destructive px-1 text-center text-[11px] font-semibold leading-5 text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className={`absolute top-12 z-50 w-72 rounded-xl border border-border bg-card p-2 shadow-lg ${align === "right" ? "right-0" : "left-0"}`}
        >
          <div className="flex items-center justify-between px-2 py-1">
            <p className="text-sm font-semibold text-foreground">Notifications</p>
            <button
              type="button"
              disabled={unread === 0 || markRead.isPending}
              onClick={() => markRead.mutate({ all: true })}
              className="text-xs font-semibold text-primary disabled:text-muted-foreground"
            >
              Mark all read
            </button>
          </div>

          {items.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">Nothing yet.</p>
          ) : (
            <ul className="max-h-80 space-y-1 overflow-y-auto">
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => !item.read && markRead.mutate({ ids: [item.id] })}
                    className={`w-full rounded-lg p-2 text-left text-sm hover:bg-muted ${item.read ? "text-muted-foreground" : "bg-soft-green text-foreground"}`}
                  >
                    <p>{item.message}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{formatDateTime(item.createdAt)}</p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
