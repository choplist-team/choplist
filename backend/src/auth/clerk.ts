import { clerkMiddleware, createClerkClient, getAuth } from '@clerk/express';
import type { AuthProvider } from './provider.js';

type ClerkOptions = {
  secretKey: string;
  publishableKey: string;
  // Origins allowed to have issued the token (our frontend). A valid Clerk
  // token minted for some other site is rejected.
  authorizedParties: string[];
};

// Looks up the email on a Clerk account (the primary one, else the first). Any
// failure gives null: the caller has a fallback, and a payment must never fail
// because Clerk was slow. Reads only; it never changes the account.
export function createClerkEmailLookup(secretKey: string): (userId: string) => Promise<string | null> {
  const client = createClerkClient({ secretKey });
  return async (userId) => {
    try {
      const user = await client.users.getUser(userId);
      const primary = user.emailAddresses.find((address) => address.id === user.primaryEmailAddressId) ?? user.emailAddresses[0];
      return primary?.emailAddress ?? null;
    } catch {
      return null;
    }
  };
}

export function createClerkAuth(options: ClerkOptions): AuthProvider {
  return {
    // Reads "Authorization: Bearer <token>" and checks its signature against
    // Clerk's public keys (fetched once and cached), not a call per request.
    // Keys are passed explicitly so Clerk never silently falls back to env vars.
    middleware: clerkMiddleware({
      secretKey: options.secretKey,
      publishableKey: options.publishableKey,
      authorizedParties: options.authorizedParties,
    }),
    getUserId: (req) => getAuth(req).userId ?? null,
    getEmail: createClerkEmailLookup(options.secretKey),
  };
}
