import { Router } from 'express';
import { requireAdmin } from '../auth/admin.js';
import { authenticate } from '../auth/middleware.js';
import type { AuthProvider } from '../auth/provider.js';

// Everything under /api/admin. The one line below is the whole access rule:
// every route added to this router is behind it, so a route cannot be added
// without the check.
export function createAdminRouter(auth: AuthProvider, adminIds: readonly string[]): Router {
  const router = Router();
  router.use(authenticate(auth), requireAdmin(adminIds));
  return router;
}
