import { useAuth } from "@clerk/react";
import { useQuery } from "@tanstack/react-query";
import { getSellerBilling } from "@/api/seller-billing-api";

// The seller's trial and subscription. Used by the dashboard (to know whether the share
// button is allowed) and by the billing page. Cached under ["seller-billing"], so both
// share one request.
export const useSellerBilling = () => {
  const { getToken, isLoaded, isSignedIn } = useAuth();

  return useQuery({
    queryKey: ["seller-billing"],
    queryFn: () => getSellerBilling(getToken),
    enabled: isLoaded && isSignedIn,
    // A suspended or profile-less seller gets an error here too; the seller gate
    // already handles those, so do not retry them.
    retry: (failureCount, error) =>
      !["PROFILE_REQUIRED", "ACCOUNT_SUSPENDED", "UNAUTHENTICATED"].includes(error?.code) && failureCount < 2,
  });
};
