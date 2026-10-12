import { placeOrder } from "@/api/customer-api";
import { useMutation } from "@tanstack/react-query";

export const usePlaceOrder = () => {
  return useMutation({ mutationFn: (order) => placeOrder(order) });
};
