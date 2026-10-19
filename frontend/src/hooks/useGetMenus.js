import { getMenus } from "@/api/seller-api";
import { useAuth } from "@clerk/react";
import { useQuery } from "@tanstack/react-query";

export const useGetMenus = (options = {}) => {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  return useQuery({
    queryKey: ["menus"],
    queryFn: () => getMenus(getToken),
    enabled: isLoaded && isSignedIn && (options.enabled ?? true),
  });
};
