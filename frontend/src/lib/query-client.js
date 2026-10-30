import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";

// A suspended seller can be stopped by ANY seller call, not only the first one.
// When another call is, re-ask for the seller profile so the seller gate
// (ProtectedRoute) shows the "account not active" screen instead of a raw error
// on whatever page they were on.
//
// The profile query is skipped here: it IS the check. Re-running it because it
// failed would fail again, fire this handler again, and loop forever (and with
// no data yet, each retry flips the page back to "Checking your session...").
const SELLER_QUERY = "current-seller";

const refreshSeller = (error) => {
  if (error?.code === "ACCOUNT_SUSPENDED") {
    queryClient.invalidateQueries({ queryKey: [SELLER_QUERY] });
  }
};

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => {
      if (query.queryKey[0] === SELLER_QUERY) return;
      refreshSeller(error);
    },
  }),
  mutationCache: new MutationCache({ onError: refreshSeller }),
});
