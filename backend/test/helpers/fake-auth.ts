import type { AuthProvider } from '../../src/auth/provider.js';

// Test-only stand-in for Clerk. "Authorization: Bearer test:<userId>" signs in
// as <userId>; anything else is anonymous. Lives under test/, so it is never
// part of the built server.
export const fakeAuth: AuthProvider = {
  middleware: (_req, _res, next) => next(),
  getUserId: (req) => {
    const match = /^Bearer test:(\S+)$/.exec(req.headers.authorization ?? '');
    return match?.[1] ?? null;
  },
};

export function bearer(userId: string): string {
  return `Bearer test:${userId}`;
}
