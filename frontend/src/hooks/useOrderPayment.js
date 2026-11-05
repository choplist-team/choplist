import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import {
  getOrderPaymentStatus,
  startOrderPayment,
} from "@/api/customer-api";

const FAST_POLL = 3000;
const SLOW_POLL = 10000;
const FAST_POLL_DURATION = 30 * 1000;
const MAX_POLL_DURATION = 5 * 60 * 1000;

const getPollingInterval = (state, startedAt) => {
  if (state !== "awaiting_payment" || !startedAt) {
    return false;
  }

  const elapsed = Date.now() - startedAt;
  const remaining = MAX_POLL_DURATION - elapsed;

  if (remaining <= 0) return false;

  return Math.min(
    elapsed < FAST_POLL_DURATION ? FAST_POLL : SLOW_POLL,
    remaining
  );
};

export const useOrderPaymentStatus = (ref) => {
  const [polling, setPolling] = useState({
    ref: null,
    startedAt: null,
  });

  const startedAt =
    polling.ref === ref ? polling.startedAt : null;

  const query = useQuery({
    queryKey: ["order-payment-status", ref],

    queryFn: async () => {
      const result = await getOrderPaymentStatus(ref);

      if (result.state === "awaiting_payment" && !startedAt) {
        setPolling({
          ref,
          startedAt: Date.now(),
        });
      }

      return result;
    },

    enabled: Boolean(ref),

    refetchInterval: (query) =>
      getPollingInterval(query.state.data?.state, startedAt),

    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
  });

  return query;
};

export const useStartOrderPayment = () => {
  return useMutation({
    // { ref, email }: the email is optional.
    mutationFn: ({ ref, email }) => startOrderPayment(ref, email),
  });
};
