import { useAuth } from "@clerk/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getSellerPayments,
  retrySellerPaymentsSetup,
  updateSellerFeeMode,
} from "@/api/seller-api";

export const useSellerPayments = () => {
  const { getToken, isLoaded, isSignedIn } = useAuth();

  return useQuery({
    queryKey: ["seller-payments"],
    queryFn: () => getSellerPayments(getToken),
    enabled: isLoaded && isSignedIn,
  });
};

export const useRetrySellerPaymentsSetup = () => {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => retrySellerPaymentsSetup(getToken),
    onSuccess: (data) => {
      queryClient.setQueryData(["seller-payments"], data);
    },
  });
};

export const useUpdateSellerFeeMode = () => {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (feeMode) => updateSellerFeeMode(feeMode, getToken),
    onSuccess: (data) => {
      queryClient.setQueryData(["seller-payments"], data);
    },
  });
};
