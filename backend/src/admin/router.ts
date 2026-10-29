import { Router } from 'express';
import { currentAdminId, requireAdmin } from '../auth/admin.js';
import { authenticate } from '../auth/middleware.js';
import type { AuthProvider } from '../auth/provider.js';
import {
  customerAnalytics,
  customerAnalyticsQuery,
  itemAnalytics,
  itemAnalyticsQuery,
  menuAnalytics,
  menuAnalyticsQuery,
} from './analytics.js';
import { listOrders, orderDetail, orderDetailQuery, orderListQuery } from './orders.js';
import { overview } from './overview.js';
import {
  CHANGES,
  changeSellerStatus,
  listSellers,
  parseSellerId,
  reinstateBody,
  sellerDetail,
  sellerListQuery,
  suspendBody,
} from './sellers.js';

// Everything under /api/admin. The one line below is the whole access rule:
// every route added to this router is behind it, so a route cannot be added
// without the check.
export function createAdminRouter(auth: AuthProvider, adminIds: readonly string[]): Router {
  const router = Router();
  router.use(authenticate(auth), requireAdmin(adminIds));

  // Platform numbers for the dashboard, with the definitions of each.
  router.get('/overview', async (_req, res) => {
    res.json(await overview());
  });

  // ---- Sellers ----
  router.get('/sellers', async (req, res) => {
    res.json(await listSellers(sellerListQuery.parse(req.query)));
  });

  router.get('/sellers/:id', async (req, res) => {
    res.json(await sellerDetail(parseSellerId(req.params.id)));
  });

  router.patch('/sellers/:id/suspend', async (req, res) => {
    const { reason } = suspendBody.parse(req.body);
    res.json(await changeSellerStatus({ sellerId: parseSellerId(req.params.id), adminId: currentAdminId(req), change: CHANGES.suspend, reason }));
  });

  router.patch('/sellers/:id/deactivate', async (req, res) => {
    const { reason } = suspendBody.parse(req.body);
    res.json(await changeSellerStatus({ sellerId: parseSellerId(req.params.id), adminId: currentAdminId(req), change: CHANGES.deactivate, reason }));
  });

  router.patch('/sellers/:id/reinstate', async (req, res) => {
    const { reason } = reinstateBody.parse(req.body ?? {});
    res.json(await changeSellerStatus({ sellerId: parseSellerId(req.params.id), adminId: currentAdminId(req), change: CHANGES.reinstate, reason }));
  });

  // ---- Orders (all sellers) ----
  router.get('/orders', async (req, res) => {
    res.json(await listOrders(orderListQuery.parse(req.query)));
  });

  router.get('/orders/:ref', async (req, res) => {
    const { reveal } = orderDetailQuery.parse(req.query);
    res.json(await orderDetail({ ref: String(req.params.ref ?? ''), reveal, adminId: currentAdminId(req) }));
  });

  // ---- Analytics ----
  router.get('/analytics/menus', async (req, res) => {
    res.json(await menuAnalytics(menuAnalyticsQuery.parse(req.query)));
  });

  router.get('/analytics/items', async (req, res) => {
    res.json(await itemAnalytics(itemAnalyticsQuery.parse(req.query)));
  });

  router.get('/analytics/customers', async (req, res) => {
    res.json(await customerAnalytics(customerAnalyticsQuery.parse(req.query)));
  });

  return router;
}
