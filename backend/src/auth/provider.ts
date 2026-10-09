import type { Request, RequestHandler } from 'express';

// The only thing routes need from a login system: "which user sent this
// request?". Production uses Clerk; tests plug in a fake (test/helpers), so no
// test-only login path exists in the shipped code.
export type AuthProvider = {
  // Runs before getUserId. Must not reject anonymous requests itself;
  // requireUser decides that.
  middleware: RequestHandler;

  // The signed-in user's id, or null if there is no valid token.
  getUserId(req: Request): string | null;
};
