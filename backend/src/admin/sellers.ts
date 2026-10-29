import { Types, type PipelineStage } from 'mongoose';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { recordAdminAction } from '../events/log.js';
import { MenuModel } from '../models/menu.js';
import { ORDER_STATUSES, OrderModel } from '../models/order.js';
import { SELLER_STATUSES, SellerModel, type SellerStatus } from '../models/seller.js';
import { escapeRegex, objectIdText, paginationQuery, toPagination } from './query.js';

// ---- What an admin sees of a seller -----------------------------------------
// Contact, link, status, activity. Deliberately NOT the bank account details:
// ChopList never handles money, and an admin has no need to read them.
type SellerLean = {
  _id: Types.ObjectId;
  businessName: string;
  slug: string;
  phone: string;
  email?: string | null;
  status?: SellerStatus | null;
  statusReason?: string | null;
  statusChangedAt?: Date | null;
  lastActiveAt?: Date | null;
  createdAt: Date;
};

function toAdminSeller(seller: SellerLean) {
  return {
    id: seller._id.toString(),
    businessName: seller.businessName,
    slug: seller.slug,
    // The customer-facing link is built by the frontend from the slug; this is
    // the API path that serves it.
    publicMenuPath: `/api/public/menu/${seller.slug}`,
    phone: seller.phone,
    email: seller.email ?? null,
    // Sellers saved before statuses existed have none stored: they are active.
    status: seller.status ?? 'active',
    statusReason: seller.statusReason ?? null,
    statusChangedAt: seller.statusChangedAt ?? null,
    lastActiveAt: seller.lastActiveAt ?? null,
    registeredAt: seller.createdAt,
  };
}

// ---- List ---------------------------------------------------------------------
export const sellerListQuery = z.object({
  q: z.string().trim().max(80).optional(),
  status: z.enum(SELLER_STATUSES, { error: `status must be one of: ${SELLER_STATUSES.join(', ')}` }).optional(),
  ...paginationQuery,
});
type SellerListQuery = z.infer<typeof sellerListQuery>;

// What the search box can match: name, link, email, and the phone however it was
// typed ("0803 123", "+234 803 123", "803123").
function searchConditions(q: string) {
  const rx = new RegExp(escapeRegex(q), 'i');
  const conditions: Record<string, unknown>[] = [
    { businessName: rx },
    { slug: rx },
    { email: rx },
  ];
  const digits = q.replace(/\D/g, '');
  if (/^[\d\s+()-]+$/.test(q) && digits.length >= 3) {
    const national = digits.startsWith('234') ? digits.slice(3) : digits.startsWith('0') ? digits.slice(1) : digits;
    if (national.length >= 3) conditions.push({ phone: new RegExp(escapeRegex(national)) });
  }
  return conditions;
}

export async function listSellers(query: SellerListQuery) {
  const { q, status, page, limit } = query;
  const and: Record<string, unknown>[] = [];
  if (q) and.push({ $or: searchConditions(q) });
  if (status === 'active') and.push({ $or: [{ status: 'active' }, { status: { $exists: false } }] });
  else if (status) and.push({ status });
  const match = and.length > 0 ? { $and: and } : {};

  const pipeline: PipelineStage[] = [
    { $match: match },
    { $sort: { createdAt: -1, _id: -1 } },
    { $skip: (page - 1) * limit },
    { $limit: limit },
    // Joined AFTER the page is cut, so at most `limit` sellers pay for the lookups.
    {
      $lookup: {
        from: MenuModel.collection.name,
        localField: '_id',
        foreignField: 'sellerId',
        pipeline: [{ $match: { status: 'open' } }, { $limit: 1 }, { $project: { title: 1, cutoffAt: 1 } }],
        as: 'openMenu',
      },
    },
    {
      $lookup: {
        from: OrderModel.collection.name,
        localField: '_id',
        foreignField: 'sellerId',
        pipeline: [{ $count: 'n' }],
        as: 'orderCount',
      },
    },
  ];

  const [rows, total] = await Promise.all([
    SellerModel.aggregate<SellerLean & { openMenu: { _id: Types.ObjectId; title: string; cutoffAt: Date }[]; orderCount: { n: number }[] }>(pipeline),
    SellerModel.countDocuments(match),
  ]);

  return {
    sellers: rows.map((row) => ({
      ...toAdminSeller(row),
      openMenu: row.openMenu[0]
        ? { id: row.openMenu[0]._id.toString(), title: row.openMenu[0].title, cutoffAt: row.openMenu[0].cutoffAt }
        : null,
      totalOrders: row.orderCount[0]?.n ?? 0,
    })),
    pagination: toPagination(total, page, limit),
  };
}

// ---- One seller ---------------------------------------------------------------
function sellerNotFound(): AppError {
  return new AppError(404, 'SELLER_NOT_FOUND', 'Seller not found');
}

export const sellerIdParam = objectIdText('id');

export function parseSellerId(raw: unknown): Types.ObjectId {
  const parsed = sellerIdParam.safeParse(raw);
  if (!parsed.success) throw sellerNotFound(); // a malformed id cannot match anything
  return parsed.data;
}

export async function sellerDetail(id: Types.ObjectId) {
  const seller = await SellerModel.findById(id).lean();
  if (!seller) throw sellerNotFound();

  const [menus, byStatus] = await Promise.all([
    MenuModel.find({ sellerId: id }).sort({ createdAt: -1 }).limit(50).lean(),
    OrderModel.aggregate<{ _id: string; n: number; last: Date }>([
      { $match: { sellerId: id } },
      { $group: { _id: '$status', n: { $sum: 1 }, last: { $max: '$createdAt' } } },
    ]),
  ]);

  const orderCounts: Record<string, number> = Object.fromEntries(ORDER_STATUSES.map((s) => [s, 0]));
  let total = 0;
  let lastOrderAt: Date | null = null;
  for (const row of byStatus) {
    orderCounts[row._id] = row.n;
    total += row.n;
    if (!lastOrderAt || row.last > lastOrderAt) lastOrderAt = row.last;
  }

  return {
    ...toAdminSeller(seller),
    orders: { total, ...orderCounts, lastOrderAt },
    menus: menus.map((menu) => ({
      id: menu._id.toString(),
      title: menu.title,
      status: menu.status,
      itemCount: menu.items.length,
      cutoffAt: menu.cutoffAt,
      openedAt: menu.openedAt ?? null,
      closedAt: menu.closedAt ?? null,
      createdAt: menu.createdAt,
    })),
  };
}

// ---- Suspend, deactivate, reinstate -------------------------------------------
export const suspendBody = z.object({
  reason: z.string({ error: 'A reason is required' }).trim().min(3, 'Give a reason (at least 3 characters)').max(300),
});
export const reinstateBody = z.object({
  reason: z.string().trim().max(300).optional(),
});

type StatusChange = { action: 'seller.suspend' | 'seller.deactivate' | 'seller.reinstate'; to: SellerStatus };

export const CHANGES = {
  suspend: { action: 'seller.suspend', to: 'suspended' },
  deactivate: { action: 'seller.deactivate', to: 'deactivated' },
  reinstate: { action: 'seller.reinstate', to: 'active' },
} as const satisfies Record<string, StatusChange>;

// Nothing is deleted: only status, statusReason and statusChangedAt change.
//
// Idempotent: asking for the status the seller already has returns it as it is,
// with no write and no audit entry. Otherwise the audit entry is written FIRST:
// if it cannot be written the seller is left untouched (an unaudited suspension
// is worse than an error). The update is then conditional on the seller still
// not having that status, so two admins clicking at once change it once.
// (If the update then finds the seller already changed, the audit trail has one
// extra entry for an action that changed nothing. That is the safe direction.)
export async function changeSellerStatus(input: {
  sellerId: Types.ObjectId;
  adminId: string;
  change: StatusChange;
  reason?: string | undefined;
}) {
  const { sellerId, adminId, change, reason } = input;
  const current = await SellerModel.findById(sellerId).lean();
  if (!current) throw sellerNotFound();
  if ((current.status ?? 'active') === change.to) return toAdminSeller(current);

  await recordAdminAction({ adminId, action: change.action, targetId: sellerId.toString(), ...(reason ? { reason } : {}) });

  // Reinstating applies only to a blocked seller; suspending/deactivating to any
  // seller not already in that state (a missing status counts as "not already").
  const notAlready: Record<string, unknown> =
    change.to === 'active' ? { status: { $in: ['suspended', 'deactivated'] } } : { status: { $ne: change.to } };
  const updated = await SellerModel.findOneAndUpdate(
    { _id: sellerId, ...notAlready },
    {
      $set: { status: change.to, statusChangedAt: new Date(), ...(reason ? { statusReason: reason } : {}) },
      ...(reason ? {} : { $unset: { statusReason: '' } }),
    },
    { returnDocument: 'after', runValidators: true },
  ).lean();
  if (updated) return toAdminSeller(updated);

  const now = await SellerModel.findById(sellerId).lean();
  if (!now) throw sellerNotFound();
  return toAdminSeller(now);
}
