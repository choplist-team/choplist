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

  // The email on the user's login account, or null if there is none or it cannot
  // be looked up. Used only to give Paystack a payer address for a vendor's
  // subscription; it never throws, so a login-provider outage cannot break a
  // payment. Optional so a test fake without it still satisfies the type.
  getEmail?(userId: string): Promise<string | null>;
};
