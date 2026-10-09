import { clerkMiddleware, getAuth } from '@clerk/express';
import type { AuthProvider } from './provider.js';

type ClerkOptions = {
  secretKey: string;
  publishableKey: string;
  // Origins allowed to have issued the token (our frontend). A valid Clerk
  // token minted for some other site is rejected.
  authorizedParties: string[];
};

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
  };
}
