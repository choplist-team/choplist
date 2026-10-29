import type { Request, RequestHandler } from 'express';
import { AppError } from '../errors.js';

// Who may use /api/admin: the Clerk user ids in ADMIN_CLERK_USER_IDS. An admin
// is a person, not a seller: nothing here looks at the sellers collection, so an
// admin needs no shop and a shop owner is not an admin unless listed.
//
// 401 if not signed in, 403 if signed in but not listed. The list is read when
// the app is built, so changing it needs a restart (a deploy on Render).
export function requireAdmin(adminIds: readonly string[]): RequestHandler {
  const allowed = new Set(adminIds);
  return (req, _res, next) => {
    if (!req.clerkUserId) {
      throw new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    }
    if (!allowed.has(req.clerkUserId)) {
      throw new AppError(403, 'FORBIDDEN', 'This area is for ChopList administrators');
    }
    next();
  };
}

// The signed-in admin's id, for the audit trail. Throws (a 500) if a route
// forgot requireAdmin, instead of recording "undefined".
export function currentAdminId(req: Request): string {
  if (!req.clerkUserId) throw new Error('currentAdminId used without requireAdmin');
  return req.clerkUserId;
}
