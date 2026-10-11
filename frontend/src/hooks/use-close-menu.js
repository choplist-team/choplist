import { closeMenu } from "@/api/seller-api";
import { useAuth } from "@clerk/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

export const useCloseMenu = () => {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id) => closeMenu(id, getToken),

    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ["menus"],
      }),
  });
};
