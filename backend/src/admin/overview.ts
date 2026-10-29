import { MenuModel } from '../models/menu.js';
import { OrderModel } from '../models/order.js';
import { SellerModel } from '../models/seller.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// "Reached payment": the seller confirmed the transfer, so the order is going
// ahead (or is done). Cancelled and still-pending orders have not.
export const PAID_OR_BEYOND = ['paid', 'out_for_delivery', 'delivered'] as const;

// Shown by the frontend next to the numbers, so a figure is never read without
// its meaning. Kept here, next to the code that computes them.
export const DEFINITIONS = {
  totalSellers: 'Every seller who has created a profile, whatever their account status.',
  activeSellers:
    'Sellers whose account status is active (not suspended or deactivated) AND who used the seller app or received an order in the last 30 days.',
  publishedMenus: 'Menus that have been opened to customers at least once (open now or closed since).',
  openMenus: 'Menus open to customers right now.',
  ordersLast7Days: 'Orders placed in the last 7 days, whatever their status.',
  ordersLast30Days: 'Orders placed in the last 30 days, whatever their status.',
  successRate:
    'Of the orders whose menu cut-off has already passed, the share that reached paid, out for delivery or delivered. Payment is confirmed by the seller; ChopList never handles money.',
  fulfilmentRate:
    'Of the same orders (menu cut-off passed), the share that was delivered.',
} as const;

function rate(part: number, whole: number): number | null {
  // null (not 0) when there is nothing to divide by: "no data yet" is different
  // from "0% succeeded".
  return whole === 0 ? null : Math.round((part / whole) * 10_000) / 10_000;
}

export async function overview(now: Date = new Date()) {
  const since7 = new Date(now.getTime() - 7 * DAY_MS);
  const since30 = new Date(now.getTime() - 30 * DAY_MS);

  const [
    totalSellers,
    publishedMenus,
    openMenus,
    totalOrders,
    ordersLast7Days,
    ordersLast30Days,
    sellersWithRecentOrders,
    [outcome],
  ] = await Promise.all([
    SellerModel.countDocuments({}),
    MenuModel.countDocuments({ status: { $in: ['open', 'closed'] } }),
    MenuModel.countDocuments({ status: 'open' }),
    OrderModel.countDocuments({}),
    OrderModel.countDocuments({ createdAt: { $gte: since7 } }),
    OrderModel.countDocuments({ createdAt: { $gte: since30 } }),
    // Uses the { createdAt } index, then collapses to one id per seller.
    OrderModel.distinct('sellerId', { createdAt: { $gte: since30 } }),
    // Orders whose menu cut-off has passed, and how many of them got that far.
    // One pass over the orders, joined to their menu's cut-off.
    OrderModel.aggregate<{ denominator: number; reached: number; delivered: number }>([
      {
        $lookup: {
          from: MenuModel.collection.name,
          localField: 'menuId',
          foreignField: '_id',
          pipeline: [{ $project: { cutoffAt: 1 } }],
          as: 'menu',
        },
      },
      { $match: { 'menu.cutoffAt': { $lte: now } } },
      {
        $group: {
          _id: null,
          denominator: { $sum: 1 },
          reached: { $sum: { $cond: [{ $in: ['$status', PAID_OR_BEYOND] }, 1, 0] } },
          delivered: { $sum: { $cond: [{ $eq: ['$status', 'delivered'] }, 1, 0] }, },
        },
      },
    ]),
  ]);

  // A seller with no status stored (created before statuses) is active.
  const activeSellers = await SellerModel.countDocuments({
    $and: [
      { $or: [{ status: 'active' }, { status: { $exists: false } }] },
      { $or: [{ lastActiveAt: { $gte: since30 } }, { _id: { $in: sellersWithRecentOrders } }] },
    ],
  });

  const denominator = outcome?.denominator ?? 0;
  return {
    generatedAt: now,
    totalSellers,
    activeSellers,
    publishedMenus,
    openMenus,
    totalOrders,
    ordersLast7Days,
    ordersLast30Days,
    successRate: rate(outcome?.reached ?? 0, denominator),
    fulfilmentRate: rate(outcome?.delivered ?? 0, denominator),
    ordersCounted: denominator,
    definitions: DEFINITIONS,
  };
}
