import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";

// A suspended seller can be stopped by ANY seller call, not only the first one.
// When one is, re-ask for the seller profile so the seller gate (ProtectedRoute)
// shows the "account not active" screen instead of a raw error on whatever page
// they were on.
const onSuspended = (error) => {
  if (error?.code === "ACCOUNT_SUSPENDED") {
    queryClient.invalidateQueries({ queryKey: ["current-seller"] });
  }
};

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: onSuspended }),
  mutationCache: new MutationCache({ onError: onSuspended }),
});
