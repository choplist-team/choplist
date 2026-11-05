import { useAuth } from "@clerk/react";
import { useQuery } from "@tanstack/react-query";

import { getAdminNotifications } from "@/api/admin-payments-api";

// The unread count next to "Inbox" in the admin menu. Quiet when there is nothing unread,
// and when the count cannot be loaded (a badge must never get in the way of the menu).
export default function InboxBadge() {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const { data } = useQuery({
    queryKey: ["admin", "notifications", "badge"],
    queryFn: () => getAdminNotifications(getToken, { unread: true, limit: 1 }),
    enabled: isLoaded && isSignedIn,
    refetchInterval: 60_000,
    retry: false,
  });

  const count = data?.unreadCount ?? 0;
  if (count === 0) return null;

  return (
    <span className="ml-auto inline-flex min-w-6 items-center justify-center rounded-full bg-destructive px-1.5 py-0.5 text-xs font-semibold text-white" aria-label={`${count} unread`}>
      {count > 99 ? "99+" : count}
    </span>
  );
}
