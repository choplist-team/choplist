import { confirmDelivery } from "@/api/seller-api";
import { useAuth } from "@clerk/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";


export const useConfirmDelivery = (menuId) => {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ref, code}) => confirmDelivery(ref, code, getToken),

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
