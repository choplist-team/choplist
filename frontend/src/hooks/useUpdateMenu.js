import { updateMenu } from "@/api/seller-api";
import { useAuth } from "@clerk/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

export const useUpdateMenu = () => {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, menu }) => updateMenu(id, menu, getToken),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["menus"] }),
  });
};
