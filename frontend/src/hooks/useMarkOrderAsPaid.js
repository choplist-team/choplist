import { markOrderAsPaid } from "@/api/seller-api";
import { useAuth } from "@clerk/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

export const useMarkOrderAsPaid = () => {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (ref) => markOrderAsPaid(ref, getToken),

    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ["menu-orders"],
      }),
  });
};
