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
import { auditListQuery, listAudit } from './audit.js';
import { listOrders, orderDetail, orderDetailQuery, orderListQuery } from './orders.js';
import { eventListQuery, health, listEvents, listReports, parseReportId, reportListQuery, resolveBody, resolveReport } from './support.js';
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

  // "Am I an admin?" for the frontend. Getting here already proves it (the guard
  // above answers 401 or 403 otherwise), so there is nothing to look up. No id
  // or other detail is returned.
  router.get('/me', (_req, res) => {
    res.json({ admin: true });
  });

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

  // ---- System health and support ----
  router.get('/health', async (_req, res) => {
    res.json(await health());
  });

  router.get('/events', async (req, res) => {
    res.json(await listEvents(eventListQuery.parse(req.query)));
  });

  router.get('/reports', async (req, res) => {
    res.json(await listReports(reportListQuery.parse(req.query)));
  });

  router.patch('/reports/:id/resolve', async (req, res) => {
    const { note } = resolveBody.parse(req.body ?? {});
    res.json(await resolveReport({ id: parseReportId(req.params.id), adminId: currentAdminId(req), note }));
  });

  // ---- Audit trail ----
  router.get('/audit', async (req, res) => {
    res.json(await listAudit(auditListQuery.parse(req.query)));
  });

  return router;
}
