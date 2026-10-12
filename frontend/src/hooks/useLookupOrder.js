import { lookupOrder } from "@/api/customer-api";
import { useQuery } from "@tanstack/react-query";

export const useLookupOrder = (ref, phoneLast4) => {
  return useQuery({
    queryKey: ["lookup-order", ref, phoneLast4],
    queryFn: () => lookupOrder(ref, phoneLast4),
    enabled: Boolean(ref && phoneLast4),
  });
};
