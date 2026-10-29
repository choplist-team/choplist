import { z } from 'zod';
import { ADMIN_ACTIONS, AdminAuditModel, type AdminAction } from '../models/admin-audit.js';
import { SellerModel } from '../models/seller.js';
import { dateRangeFilter, dateRangeQuery, paginationQuery, toPagination } from './query.js';

// "Who did what to what, and why": the trail written by every admin action that
// changes data or reveals private data (suspend, deactivate, reinstate, reveal a
// phone number, resolve a report). Read-only: nothing here writes, and reading
// the trail is not itself recorded in it.
export const auditListQuery = z.object({
  adminId: z.string().trim().min(1).max(100).optional(),
  action: z.enum(ADMIN_ACTIONS, { error: `action must be one of: ${ADMIN_ACTIONS.join(', ')}` }).optional(),
  targetId: z.string().trim().min(1).max(60).optional(),
  ...dateRangeQuery,
  ...paginationQuery,
});

// What kind of thing the action was done to, for the page to group and label by.
function targetType(action: AdminAction): 'seller' | 'order' | 'report' {
  if (action.startsWith('seller.')) return 'seller';
  if (action.startsWith('order.')) return 'order';
  return 'report';
}

export async function listAudit(query: z.infer<typeof auditListQuery>) {
  const { adminId, action, targetId, page, limit } = query;
  const createdAt = dateRangeFilter(query);
  const filter = {
    ...(adminId ? { adminId } : {}),
    ...(action ? { action } : {}),
    ...(targetId ? { targetId } : {}),
    ...(createdAt ? { createdAt } : {}),
  };

  const [entries, total] = await Promise.all([
    AdminAuditModel.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    AdminAuditModel.countDocuments(filter),
  ]);

  // A seller's id means little on its own, so name the sellers on this page: one
  // extra query for at most `limit` ids. An order's target is already its
  // reference. A seller who no longer exists simply has no label.
  const sellerIds = [...new Set(entries.filter((e) => targetType(e.action) === 'seller').map((e) => e.targetId))].filter((id) =>
    /^[0-9a-f]{24}$/i.test(id),
  );
  const sellers = sellerIds.length > 0 ? await SellerModel.find({ _id: { $in: sellerIds } }, { businessName: 1 }).lean() : [];
  const sellerNames = new Map(sellers.map((seller) => [seller._id.toString(), seller.businessName]));

  return {
    entries: entries.map((entry) => {
      const type = targetType(entry.action);
      return {
        id: entry._id.toString(),
        at: entry.createdAt,
        adminId: entry.adminId,
        action: entry.action,
        targetType: type,
        targetId: entry.targetId,
        targetLabel: type === 'seller' ? (sellerNames.get(entry.targetId) ?? null) : type === 'order' ? entry.targetId : null,
        reason: entry.reason ?? null,
      };
    }),
    pagination: toPagination(total, page, limit),
  };
}
