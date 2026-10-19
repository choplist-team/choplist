import { outForDelivery } from "@/api/seller-api";
import { useAuth } from "@clerk/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

export const useOutForDelivery = (menuId) => {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (ref) => outForDelivery(ref, getToken),

    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["menu-orders", menuId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["menus"],
        }),
      ]);
    },
  });
};
