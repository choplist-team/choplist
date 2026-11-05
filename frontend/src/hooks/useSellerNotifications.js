import { useAuth } from "@clerk/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getSellerNotifications, markSellerNotificationsRead } from "@/api/seller-billing-api";

// The seller's notifications (the bell). Checked again every minute, so a new paid order
// or a customer's "I've paid" shows up without reloading.
export const useSellerNotifications = () => {
  const { getToken, isLoaded, isSignedIn } = useAuth();

  return useQuery({
    queryKey: ["seller-notifications"],
    queryFn: () => getSellerNotifications(getToken, { limit: 20 }),
    enabled: isLoaded && isSignedIn,
    refetchInterval: 60_000,
    // A bell must never get in the way of the page: no retries, and the component shows
    // nothing if it cannot load.
    retry: false,
  });
};

// body is { all: true } or { ids: [...] }
export const useMarkNotificationsRead = () => {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body) => markSellerNotificationsRead(body, getToken),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["seller-notifications"] }),
  });
};
