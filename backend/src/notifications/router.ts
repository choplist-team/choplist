import { Router } from 'express';
import { authenticate, currentSellerId, requireSeller } from '../auth/middleware.js';
import type { AuthProvider } from '../auth/provider.js';
import { listNotifications, markNotificationsRead, markReadBody, notificationListQuery } from './service.js';

// A seller's own notifications. Mounted at /api/sellers/me/notifications, before the
// sellers router. Only their own: the seller is looked up from the sign-in, never from
// anything in the request.
export function createNotificationsRouter(auth: AuthProvider): Router {
  const router = Router();
  router.use(...authenticate(auth), requireSeller);

  router.get('/', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await listNotifications({ audience: 'seller', sellerId: currentSellerId(req) }, notificationListQuery.parse(req.query)));
  });

  router.post('/read', async (req, res) => {
    res.json(await markNotificationsRead({ audience: 'seller', sellerId: currentSellerId(req) }, markReadBody.parse(req.body ?? {})));
  });

  return router;
}
