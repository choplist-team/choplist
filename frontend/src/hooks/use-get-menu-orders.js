import { getMenuOrders } from "@/api/seller-api";
import { useAuth } from "@clerk/react";
import { useQuery } from "@tanstack/react-query";

export const useGetMenuOrders = (id, status) => {
  const { getToken, isLoaded, isSignedIn } = useAuth();

  return useQuery({
    queryKey: ["menu-orders", id, status ?? "all"],
    queryFn: () => getMenuOrders(id, getToken, status),
    enabled: isLoaded && isSignedIn && Boolean(id),
  });
};