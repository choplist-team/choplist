import { getMenuPrepSheet } from "@/api/seller-api";
import { useAuth } from "@clerk/react";
import { useQuery } from "@tanstack/react-query";

export const useGetMenuPrepSheet = (id, paidOnly = false) => {
  const { getToken, isLoaded, isSignedIn } = useAuth();

  return useQuery({
    queryKey: ["menus", id, "prep-sheet", paidOnly],
    queryFn: () => getMenuPrepSheet(id, getToken, paidOnly),
    enabled: isLoaded && isSignedIn && Boolean(id),
  });
};
