import { getShop } from "@/api/customer-api";
import { useQuery } from "@tanstack/react-query";

export const useGetShop = (slug) => {
  return useQuery({
    queryKey: ["get-shop", slug],
    queryFn: () => getShop(slug),
    enabled: Boolean(slug)
  });
};
