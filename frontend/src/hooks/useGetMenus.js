import { getMenus } from "@/api/seller-api";
import { useAuth } from "@clerk/react";
import { useQuery } from "@tanstack/react-query";

export const useGetMenus = () => {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  return useQuery({
    queryKey: ["menus"],
    queryFn: () => getMenus(getToken),
    enabled: isLoaded && isSignedIn,
  });
};
