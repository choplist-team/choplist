import { getCurrentSeller } from "@/api/seller-api";
import { useAuth } from "@clerk/react";
import { useQuery } from "@tanstack/react-query";

export const useCurrentSeller = () => {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  return useQuery({
    queryKey: ["current-seller"],
    queryFn: () => getCurrentSeller(getToken),
    enabled: isLoaded && isSignedIn,
    retry: (failureCount, error) => {
      if (error?.code === "PROFILE_REQUIRED") return false;
      return failureCount < 3;
    },
  });
};
