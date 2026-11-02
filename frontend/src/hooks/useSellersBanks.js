import { useAuth } from "@clerk/react";
import { useQuery } from "@tanstack/react-query";
import { getSellerBanks } from "@/api/seller-api";

export const useSellersBanks = () => {
  const { getToken, isLoaded, isSignedIn } = useAuth();

  return useQuery({
    queryKey: ["seller-banks"],
    queryFn: () => getSellerBanks(getToken),
    enabled: isLoaded && isSignedIn,
    staleTime: 1000 * 60 * 60,
    retry: (failureCount, error) => {
      if (error?.status === 503 || error?.code === "PAYMENTS_UNAVAILABLE") {
        return false;
      }

      // Don't repeatedly retry authentication failures.
      if (error?.status === 401) {
        return false;
      }

      return failureCount < 2;
    },
  });
};
