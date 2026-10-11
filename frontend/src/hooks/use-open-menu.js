import { openMenu } from "@/api/seller-api";
import { useAuth } from "@clerk/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

export const useOpenMenu = () => {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id) => openMenu(id, getToken),

    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ["menus"],
      }),
  });
};