import { getMenuDeliveryList } from "@/api/seller-api";
import { useAuth } from "@clerk/react";
import { useQuery } from "@tanstack/react-query";

export const useGetMenuDeliveryList = (id, { day, paidOnly = false } = {}) => {
  const { getToken, isLoaded, isSignedIn } = useAuth();

  return useQuery({
    queryKey: ["menus", id, "delivery-list", { day, paidOnly }],
    queryFn: () => getMenuDeliveryList(id, getToken, { day, paidOnly }),
    enabled: isLoaded && isSignedIn && Boolean(id),
  });
};
