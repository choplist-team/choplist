import { getMenuById } from "@/api/seller-api";
import { useAuth } from "@clerk/react";
import { useQuery } from "@tanstack/react-query";

export const useGetMenuById = (id) => {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  return useQuery({
    queryKey: ["menus", id],
    queryFn: () => getMenuById(id, getToken),
    enabled: isLoaded && isSignedIn && Boolean(id),
  });
};
