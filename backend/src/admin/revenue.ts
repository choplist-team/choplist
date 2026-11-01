import { MenuModel } from '../models/menu.js';
import { OrderModel } from '../models/order.js';
import { PaymentModel } from '../models/payment.js';
import { SellerModel } from '../models/seller.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Same meaning as in overview.ts: the order is going ahead (or is done). Kept
// here too so this file stands alone; a test pins the two lists together.
export const PAID_STATUSES = ['paid', 'out_for_delivery', 'delivered'] as const;

// Shown by the frontend beside each figure, so a number is never read without
// its meaning. Kept next to the code that computes it.
export const PAYMENT_DEFINITIONS = {
  gmv:
    'Gross merchandise value: the total of the order totals (the food, in naira, NOT including any service fee) of orders that reached paid, out for delivery or delivered, counted by the day they were paid. Cancelled and unpaid orders are not included. Paid by Paystack or by bank transfer.',
  revenue:
    'ChopList\'s own earnings: the sum of the platform fee on payments Paystack confirmed. After a seller\'s free orders this is the percentage of the order; it is 0 during the free orders. It is NOT the service fee (that covers Paystack\'s charge) and bank-transfer orders earn nothing. Refunds are not tracked yet, so a payment on an order that was later cancelled still counts until a person refunds it and it is removed by hand.',
  paidOnPlatform:
    'Orders that reached paid or beyond through Paystack, with their GMV. The same orders are never also counted under paidByTransfer.',
  paidByTransfer:
    'Orders that reached paid or beyond by the seller confirming a bank transfer (including every order from before Paystack), with their GMV.',
  platformShare:
    'paidOnPlatform orders divided by all paid orders, over all time. null when no order has been paid yet.',
  payingSellers:
    'Sellers who have paid ChopList at least once: at least one Paystack-confirmed payment with a platform fee above 0, i.e. past their free orders.',
  sellersOnPlatform:
    'Sellers who have received at least one Paystack-confirmed payment, including during their free orders.',
  onlinePaymentsReady: 'Sellers whose Paystack payout account is set up right now, so customers can pay them online.',
  paymentsNeedingReview:
    'Payments where the customer\'s money arrived but the order could not be completed (the seller cancelled it first, the amount was wrong, or the customer paid twice). Each one needs a person to refund or reinstate it; see the event log for the details.',
} as const;

export const FUNNEL_DEFINITIONS = {
  registered:
    'Sellers with a ChopList seller record. A record is created only when someone submits the onboarding form, so people who signed up with Clerk but never finished onboarding are NOT counted here (Clerk\'s own dashboard shows them).',
  profileComplete:
    'Registered sellers whose profile has a business name, phone number and complete bank account details. Onboarding currently requires all of these, so today this equals "registered"; it will differ if a lighter sign-up is ever added.',
  menuPublished: 'Profile-complete sellers who have opened at least one menu to customers (open now, or closed since).',
  firstOrder: 'Of those, sellers who have received at least one order from a customer, whatever its status.',
  firstPaidOrder: 'Of those, sellers who have had at least one order reach paid, out for delivery or delivered, by any payment method.',
} as const;

export type FunnelStageKey = keyof typeof FUNNEL_DEFINITIONS;

function ratio(part: number, whole: number): number | null {
  return whole === 0 ? null : Math.round((part / whole) * 10_000) / 10_000;
}

const naira = (kobo: number) => Math.round(kobo) / 100;

type Period = { allTime: number; last30Days: number };
type OrdersAndGmv = { orders: number; gmv: number };

export async function paymentsOverview(now: Date) {
  const since30 = new Date(now.getTime() - 30 * DAY_MS);

  const [orderGroups, paymentGroups, payingAll, payingRecent, onPlatformAll, onPlatformRecent, needingReview, ready] = await Promise.all([
    // Paid orders, split by how they were paid and by whether they were paid in
    // the last 30 days. Uses the { status, createdAt } index for the status match.
    OrderModel.aggregate<{ _id: { paystack: boolean; recent: boolean }; orders: number; gmv: number }>([
      { $match: { status: { $in: PAID_STATUSES } } },
      {
        $group: {
          _id: { paystack: { $eq: ['$paymentMethod', 'paystack'] }, recent: { $gte: ['$paidAt', since30] } },
          orders: { $sum: 1 },
          gmv: { $sum: '$total' },
        },
      },
    ]),
    // Confirmed Paystack payments: ChopList's fee, in kobo, by period.
    PaymentModel.aggregate<{ _id: { recent: boolean }; revenueKobo: number }>([
      { $match: { status: 'succeeded' } },
      { $group: { _id: { recent: { $gte: ['$paidAt', since30] } }, revenueKobo: { $sum: '$platformFeeKobo' } } },
    ]),
    PaymentModel.distinct('sellerId', { status: 'succeeded', platformFeeKobo: { $gt: 0 } }),
    PaymentModel.distinct('sellerId', { status: 'succeeded', platformFeeKobo: { $gt: 0 }, paidAt: { $gte: since30 } }),
    PaymentModel.distinct('sellerId', { status: 'succeeded' }),
    PaymentModel.distinct('sellerId', { status: 'succeeded', paidAt: { $gte: since30 } }),
    PaymentModel.countDocuments({ status: 'needs_review' }),
    SellerModel.countDocuments({ paymentsReady: true, paystackSubaccountCode: { $exists: true, $ne: '' } }),
  ]);

  const orders = { paystack: blank(), transfer: blank() };
  for (const group of orderGroups) {
    const bucket = group._id.paystack ? orders.paystack : orders.transfer;
    bucket.allTime.orders += group.orders;
    bucket.allTime.gmv += group.gmv;
    if (group._id.recent) {
      bucket.last30Days.orders += group.orders;
      bucket.last30Days.gmv += group.gmv;
    }
  }

  const revenueKobo = { allTime: 0, last30Days: 0 };
  for (const group of paymentGroups) {
    revenueKobo.allTime += group.revenueKobo;
    if (group._id.recent) revenueKobo.last30Days += group.revenueKobo;
  }

  const paidOrdersAllTime = orders.paystack.allTime.orders + orders.transfer.allTime.orders;
  return {
    gmv: {
      allTime: orders.paystack.allTime.gmv + orders.transfer.allTime.gmv,
      last30Days: orders.paystack.last30Days.gmv + orders.transfer.last30Days.gmv,
    },
    revenue: { allTime: naira(revenueKobo.allTime), last30Days: naira(revenueKobo.last30Days) },
    paidOnPlatform: orders.paystack,
    paidByTransfer: orders.transfer,
    platformShare: ratio(orders.paystack.allTime.orders, paidOrdersAllTime),
    payingSellers: { allTime: payingAll.length, last30Days: payingRecent.length } satisfies Period,
    sellersOnPlatform: { allTime: onPlatformAll.length, last30Days: onPlatformRecent.length } satisfies Period,
    onlinePaymentsReady: ready,
    paymentsNeedingReview: needingReview,
    definitions: PAYMENT_DEFINITIONS,
  };
}

function blank(): { allTime: OrdersAndGmv; last30Days: OrdersAndGmv } {
  return { allTime: { orders: 0, gmv: 0 }, last30Days: { orders: 0, gmv: 0 } };
}

export type FunnelStage = {
  key: FunnelStageKey;
  label: string;
  count: number;
  // Share of the PREVIOUS stage that got here (null for the first stage, and when
  // the previous stage is empty).
  fromPrevious: number | null;
  definition: string;
};

// A cohort funnel: each stage only counts sellers who also made it through every
// earlier stage, so the numbers can only shrink and a conversion never passes 100%.
export async function funnelOverview(): Promise<FunnelStage[]> {
  const text = (path: string) => ({ [path]: { $exists: true, $nin: [null, ''] } });
  const [registered, complete, published, ordered, paid] = await Promise.all([
    SellerModel.distinct('_id', {}),
    SellerModel.distinct('_id', {
      ...text('businessName'),
      ...text('phone'),
      ...text('payment.bankName'),
      ...text('payment.accountNumber'),
      ...text('payment.accountName'),
    }),
    MenuModel.distinct('sellerId', { status: { $in: ['open', 'closed'] } }),
    OrderModel.distinct('sellerId', {}),
    OrderModel.distinct('sellerId', { status: { $in: PAID_STATUSES } }),
  ]);

  const ids = (list: unknown[]) => new Set(list.map(String));
  const stage1 = ids(registered);
  const stage2 = intersect(ids(complete), stage1);
  const stage3 = intersect(ids(published), stage2);
  const stage4 = intersect(ids(ordered), stage3);
  const stage5 = intersect(ids(paid), stage4);

  const stages: [FunnelStageKey, string, number][] = [
    ['registered', 'Registered', stage1.size],
    ['profileComplete', 'Profile complete', stage2.size],
    ['menuPublished', 'Menu published', stage3.size],
    ['firstOrder', 'First order', stage4.size],
    ['firstPaidOrder', 'First paid order', stage5.size],
  ];
  return stages.map(([key, label, count], index) => ({
    key,
    label,
    count,
    fromPrevious: index === 0 ? null : ratio(count, stages[index - 1]![2]),
    definition: FUNNEL_DEFINITIONS[key],
  }));
}

function intersect(a: Set<string>, b: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const value of a) if (b.has(value)) out.add(value);
  return out;
}
