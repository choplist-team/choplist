import { postMenu } from "@/api/seller-api";
import { useAuth } from "@clerk/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

export const usePostMenu = () => {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (menu) => postMenu(menu, getToken),
    onSuccess: () => queryClient.invalidateQueries({queryKey: ["menus"]}),
  });
};
