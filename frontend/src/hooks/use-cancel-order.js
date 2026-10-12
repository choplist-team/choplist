import { cancelOrder } from "@/api/seller-api";
import { useAuth } from "@clerk/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

export const useCancelOrder = () => {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (ref) => cancelOrder(ref, getToken),

    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ["menu-orders"],
      }),
  });
};
