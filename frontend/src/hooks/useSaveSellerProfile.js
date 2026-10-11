import { saveSellerProfile } from "@/api/seller-api";
import { useAuth } from "@clerk/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

export const useSaveSellerProfile = () => {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (profile) => saveSellerProfile(profile, getToken),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["current-seller"] }),
  });
};
