import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  getMyPaymentProblems,
  getPaymentQuote,
  raisePaymentProblem,
  reportPaid,
} from "@/api/customer-payments-api";

// Hooks for the extra payment features on the order confirmation page. The page's main
// payment status hook is in useOrderPayment.js.

// The price of paying online, before pressing Pay. Only asked when online payment is on.
export const useOrderPaymentQuote = (ref, enabled) =>
  useQuery({
    queryKey: ["order-payment-quote", ref],
    queryFn: () => getPaymentQuote(ref),
    enabled: Boolean(ref) && Boolean(enabled),
    retry: false,
  });

// "I've paid". Afterwards the payment status is read again so the page shows it.
export const useReportPaid = (ref) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => reportPaid(ref),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["order-payment-status", ref] }),
  });
};

export const usePaymentProblems = (ref) =>
  useQuery({
    queryKey: ["order-payment-problems", ref],
    queryFn: () => getMyPaymentProblems(ref),
    enabled: Boolean(ref),
    retry: false,
  });

export const useRaisePaymentProblem = (ref) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (problem) => raisePaymentProblem(ref, problem),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["order-payment-problems", ref] }),
  });
};
