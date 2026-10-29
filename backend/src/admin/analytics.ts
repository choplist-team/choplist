import type { Types, PipelineStage } from 'mongoose';
import { z } from 'zod';
import { MenuModel } from '../models/menu.js';
import { MenuViewDailyModel } from '../models/menu-view-daily.js';
import { OrderModel } from '../models/order.js';
import { SellerModel } from '../models/seller.js';
import { dateRangeFilter, dateRangeQuery, objectIdText, paginationQuery, toPagination } from './query.js';

type Range = { from?: string | undefined; to?: string | undefined };

// Shown by the frontend beside each figure.
export const ANALYTICS_DEFINITIONS = {
  views:
    'Times a shop\'s open menu was loaded by a customer\'s browser (once per visit, from the shop page). Not unique visitors: a visitor who comes back, or a bot, counts again.',
  orders: 'Orders placed on the menu in the period, whatever their later status (including cancelled).',
  conversion:
    'orders divided by views. An indicator, not an exact rate: views are not unique visitors and can be inflated, so it can pass 100% and is null when there were no views.',
  items:
    'Portions in non-cancelled orders, grouped by item name ignoring upper/lower case and surrounding spaces, so the same name on different sellers\' menus is added together.',
  customers:
    'Customers are identified by their normalised phone number. This is approximate: one person with two numbers counts twice, and a shared phone counts once. Cancelled orders are ignored.',
  newCustomer: 'A customer whose first order (ever) was in the period.',
  returningCustomer: 'A customer who ordered in the period and also had an earlier order before their first order in the period.',
  repeatOrder: 'An order placed by a customer who had already placed an earlier order (in the period or before). Works for any period, including all time.',
} as const;

function ratio(part: number, whole: number): number | null {
  return whole === 0 ? null : Math.round((part / whole) * 10_000) / 10_000;
}

// ---- Menus: views, orders and conversion, grouped by seller ---------------------
export const menuAnalyticsQuery = z.object({ ...dateRangeQuery, ...paginationQuery });

export async function menuAnalytics(query: z.infer<typeof menuAnalyticsQuery>) {
  const { from, to, page, limit } = query;
  const createdAt = dateRangeFilter({ from, to });
  // Days are text like "2026-10-29", and text in that form sorts in date order,
  // so a range on it is a plain string comparison. Both ends included.
  const dayFilter = from || to ? { day: { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } } : undefined;

  const [result] = await MenuModel.aggregate<{
    rows: {
      _id: Types.ObjectId;
      views: number;
      orders: number;
      menus: { id: Types.ObjectId; title: string; status: string; views: number; orders: number }[];
      seller: { _id: Types.ObjectId; businessName: string; slug: string }[];
    }[];
    totals: { views: number; orders: number }[];
    count: { n: number }[];
  }>([
    // Each menu picks up its own view count and order count. Both sides are
    // indexed ({menuId, day} and {menuId, createdAt}).
    {
      $lookup: {
        from: MenuViewDailyModel.collection.name,
        localField: '_id',
        foreignField: 'menuId',
        pipeline: [...(dayFilter ? [{ $match: dayFilter }] : []), { $group: { _id: null, views: { $sum: '$count' } } }],
        as: 'v',
      },
    },
    {
      $lookup: {
        from: OrderModel.collection.name,
        localField: '_id',
        foreignField: 'menuId',
        pipeline: [...(createdAt ? [{ $match: { createdAt } }] : []), { $count: 'n' }],
        as: 'o',
      },
    },
    { $addFields: { views: { $ifNull: [{ $first: '$v.views' }, 0] }, orders: { $ifNull: [{ $first: '$o.n' }, 0] } } },
    // Only menus that did something in the period.
    { $match: { $or: [{ views: { $gt: 0 } }, { orders: { $gt: 0 } }] } },
    { $sort: { orders: -1, views: -1, _id: 1 } }, // keeps each seller's menus in this order
    {
      $group: {
        _id: '$sellerId',
        views: { $sum: '$views' },
        orders: { $sum: '$orders' },
        menus: { $push: { id: '$_id', title: '$title', status: '$status', views: '$views', orders: '$orders' } },
      },
    },
    { $sort: { orders: -1, views: -1, _id: 1 } },
    {
      $facet: {
        count: [{ $count: 'n' }],
        totals: [{ $group: { _id: null, views: { $sum: '$views' }, orders: { $sum: '$orders' } } }],
        rows: [
          { $skip: (page - 1) * limit },
          { $limit: limit },
          {
            $lookup: {
              from: SellerModel.collection.name,
              localField: '_id',
              foreignField: '_id',
              pipeline: [{ $project: { businessName: 1, slug: 1 } }],
              as: 'seller',
            },
          },
        ],
      },
    },
  ]);

  const totals = result?.totals[0] ?? { views: 0, orders: 0 };
  return {
    range: { from: from ?? null, to: to ?? null },
    totals: { views: totals.views, orders: totals.orders, conversion: ratio(totals.orders, totals.views) },
    sellers: (result?.rows ?? []).map((row) => ({
      seller: row.seller[0]
        ? { id: row.seller[0]._id.toString(), businessName: row.seller[0].businessName, slug: row.seller[0].slug }
        : { id: row._id.toString(), businessName: null, slug: null },
      views: row.views,
      orders: row.orders,
      conversion: ratio(row.orders, row.views),
      menus: row.menus.map((menu) => ({
        id: menu.id.toString(),
        title: menu.title,
        status: menu.status,
        views: menu.views,
        orders: menu.orders,
        conversion: ratio(menu.orders, menu.views),
      })),
    })),
    pagination: toPagination(result?.count[0]?.n ?? 0, page, limit),
    definitions: {
      views: ANALYTICS_DEFINITIONS.views,
      orders: ANALYTICS_DEFINITIONS.orders,
      conversion: ANALYTICS_DEFINITIONS.conversion,
    },
  };
}

// ---- Items: most frequently ordered ---------------------------------------------
export const itemAnalyticsQuery = z.object({
  ...dateRangeQuery,
  sellerId: objectIdText('sellerId').optional(),
  ...paginationQuery,
});

export async function itemAnalytics(query: z.infer<typeof itemAnalyticsQuery>) {
  const { sellerId, page, limit } = query;
  const createdAt = dateRangeFilter(query);

  const [result] = await OrderModel.aggregate<{
    rows: { _id: string; name: string; portions: number; orders: number; revenue: number; sellers: number }[];
    count: { n: number }[];
  }>([
    {
      $match: {
        status: { $ne: 'cancelled' }, // a cancelled order's portions went back on sale
        ...(createdAt ? { createdAt } : {}),
        ...(sellerId ? { sellerId } : {}),
      },
    },
    { $unwind: '$lines' },
    {
      $group: {
        // Same item = same name ignoring case and surrounding spaces ("Jollof Rice " = "jollof rice").
        _id: { $toLower: { $trim: { input: '$lines.name' } } },
        name: { $first: '$lines.name' },
        portions: { $sum: '$lines.qty' },
        orders: { $sum: 1 }, // an order has at most one line per item, so lines = orders
        revenue: { $sum: { $multiply: ['$lines.unitPrice', '$lines.qty'] } },
        sellerIds: { $addToSet: '$sellerId' },
      },
    },
    { $addFields: { sellers: { $size: '$sellerIds' } } },
    { $sort: { portions: -1, orders: -1, _id: 1 } },
    {
      $facet: {
        count: [{ $count: 'n' }],
        rows: [{ $skip: (page - 1) * limit }, { $limit: limit }, { $project: { name: 1, portions: 1, orders: 1, revenue: 1, sellers: 1 } }],
      },
    },
  ]);

  return {
    range: { from: query.from ?? null, to: query.to ?? null },
    sellerId: sellerId ? sellerId.toString() : null,
    items: (result?.rows ?? []).map((row) => ({
      name: row.name.trim(),
      portions: row.portions,
      orders: row.orders,
      revenue: row.revenue,
      sellers: row.sellers,
    })),
    pagination: toPagination(result?.count[0]?.n ?? 0, page, limit),
    definitions: { items: ANALYTICS_DEFINITIONS.items },
  };
}

// ---- Customers: new versus returning --------------------------------------------
export const customerAnalyticsQuery = z.object({ ...dateRangeQuery });

export async function customerAnalytics(query: z.infer<typeof customerAnalyticsQuery>) {
  const createdAt = dateRangeFilter(query);
  // The "is this order in the period?" test, written for use inside $group.
  const inPeriod = createdAt
    ? {
        $and: [
          ...(createdAt.$gte ? [{ $gte: ['$createdAt', createdAt.$gte] }] : []),
          ...(createdAt.$lt ? [{ $lt: ['$createdAt', createdAt.$lt] }] : []),
        ],
      }
    : true;

  const stages: PipelineStage[] = [
    // ALL non-cancelled orders, not just the period: "returning" needs to see
    // orders from before it.
    { $match: { status: { $ne: 'cancelled' } } },
    {
      // One row per customer (normalised phone).
      $group: {
        _id: '$customer.phone',
        firstEver: { $min: '$createdAt' },
        inPeriod: { $sum: { $cond: [inPeriod, 1, 0] } },
        firstInPeriod: { $min: { $cond: [inPeriod, '$createdAt', null] } }, // $min skips null
      },
    },
    { $match: { inPeriod: { $gt: 0 } } },
    // New = their very first order is the first one in the period.
    { $addFields: { isNew: { $eq: ['$firstEver', '$firstInPeriod'] } } },
    {
      $group: {
        _id: null,
        customers: { $sum: 1 },
        newCustomers: { $sum: { $cond: ['$isNew', 1, 0] } },
        orders: { $sum: '$inPeriod' },
        // Every order is a repeat except a new customer's first one.
        repeatOrders: { $sum: { $subtract: ['$inPeriod', { $cond: ['$isNew', 1, 0] }] } },
      },
    },
  ];

  const [row] = await OrderModel.aggregate<{ customers: number; newCustomers: number; orders: number; repeatOrders: number }>(stages);
  const customers = row?.customers ?? 0;
  const newCustomers = row?.newCustomers ?? 0;
  const orders = row?.orders ?? 0;
  const repeatOrders = row?.repeatOrders ?? 0;

  // No phone number, or anything that identifies a person, is returned.
  return {
    range: { from: query.from ?? null, to: query.to ?? null },
    customers: {
      total: customers,
      new: newCustomers,
      returning: customers - newCustomers,
      returningRate: ratio(customers - newCustomers, customers),
    },
    orders: { total: orders, firstOrders: orders - repeatOrders, repeatOrders, repeatRate: ratio(repeatOrders, orders) },
    definitions: {
      customers: ANALYTICS_DEFINITIONS.customers,
      newCustomer: ANALYTICS_DEFINITIONS.newCustomer,
      returningCustomer: ANALYTICS_DEFINITIONS.returningCustomer,
      repeatOrder: ANALYTICS_DEFINITIONS.repeatOrder,
    },
  };
}
