import { OrderModel } from '../models/order.js';
import { SellerModel } from '../models/seller.js';
import { normalizeNigerianPhone } from '../validation/phone.js';
import { DUPLICATE_WINDOW_MS, orderFingerprint } from './fingerprint.js';

// Brings data written BEFORE the admin console up to date:
//   1. sellers with no status          -> status "active"
//   2. orders whose customer phone is not in the canonical +234... form
//                                        -> rewritten to the canonical form
//   3. orders with no fingerprint      -> fingerprint computed
//   4. orders sharing a fingerprint within the duplicate window
//                                        -> the later one flagged possibleDuplicate
//
// Safe to run twice: each step only touches rows that still need it. It returns
// COUNTS and the references that could not be fixed, never phone numbers.
// With apply = false nothing is written (a dry run).
export type BackfillResult = {
  applied: boolean;
  sellersWithoutStatus: number;
  phonesToNormalise: number;
  // Phones that are not a Nigerian mobile at all: left alone, listed by order ref.
  unfixablePhones: string[];
  ordersWithoutFingerprint: number;
  duplicatesFlagged: number;
};

const CANONICAL_PHONE = /^\+234[789]\d{9}$/;
const BATCH = 500;

export async function backfillAdminFields(options: { apply: boolean }): Promise<BackfillResult> {
  const { apply } = options;
  const result: BackfillResult = {
    applied: apply,
    sellersWithoutStatus: 0,
    phonesToNormalise: 0,
    unfixablePhones: [],
    ordersWithoutFingerprint: 0,
    duplicatesFlagged: 0,
  };

  // 1. Sellers. A schema default applies to new documents only, so old sellers
  //    have no status field at all.
  const noStatus = { status: { $exists: false } };
  result.sellersWithoutStatus = await SellerModel.countDocuments(noStatus);
  if (apply && result.sellersWithoutStatus > 0) {
    await SellerModel.collection.updateMany(noStatus, { $set: { status: 'active' } });
  }

  // 2 + 3. Orders needing a canonical phone or a fingerprint. Read straight from
  //    the collection (lean) in a cursor so a large collection is not loaded at once.
  const needsWork = {
    $or: [{ 'customer.phone': { $not: CANONICAL_PHONE } }, { fingerprint: { $exists: false } }],
  };
  type Op = { updateOne: { filter: { _id: unknown }; update: { $set: Record<string, string> } } };
  let ops: Op[] = [];
  const flush = async () => {
    if (apply && ops.length > 0) await OrderModel.collection.bulkWrite(ops as never);
    ops = [];
  };

  const cursor = OrderModel.find(needsWork).lean().cursor();
  for await (const order of cursor) {
    const set: Record<string, string> = {};

    let phone = order.customer.phone;
    if (!CANONICAL_PHONE.test(phone)) {
      const fixed = normalizeNigerianPhone(phone);
      if (fixed) {
        set['customer.phone'] = fixed;
        phone = fixed;
        result.phonesToNormalise += 1;
      } else {
        result.unfixablePhones.push(order.ref);
      }
    }
    if (!order.fingerprint) {
      set.fingerprint = orderFingerprint({ phone, menuId: order.menuId.toString(), lines: order.lines });
      result.ordersWithoutFingerprint += 1;
    }
    if (Object.keys(set).length > 0) ops.push({ updateOne: { filter: { _id: order._id }, update: { $set: set } } });
    if (ops.length >= BATCH) await flush();
  }
  await flush();

  // 4. Duplicates among orders that now have fingerprints. Only after a real
  //    run: a dry run has not written the fingerprints this step reads.
  if (apply) result.duplicatesFlagged = await flagHistoricalDuplicates();
  return result;
}

// Same rule as placing an order (orders/place-order.ts): an order is a possible
// duplicate when an EARLIER non-cancelled order with the same fingerprint was
// created within the window before it.
async function flagHistoricalDuplicates(): Promise<number> {
  const groups = await OrderModel.aggregate<{ orders: { id: unknown; at: Date; status: string; flagged: boolean }[] }>([
    { $match: { fingerprint: { $exists: true } } },
    { $sort: { createdAt: 1, _id: 1 } },
    {
      $group: {
        _id: '$fingerprint',
        n: { $sum: 1 },
        orders: { $push: { id: '$_id', at: '$createdAt', status: '$status', flagged: '$possibleDuplicate' } },
      },
    },
    { $match: { n: { $gt: 1 } } },
  ]);

  const toFlag: unknown[] = [];
  for (const group of groups) {
    group.orders.forEach((order, i) => {
      if (order.flagged) return;
      const hasEarlier = group.orders
        .slice(0, i)
        .some((earlier) => earlier.status !== 'cancelled' && order.at.getTime() - earlier.at.getTime() <= DUPLICATE_WINDOW_MS);
      if (hasEarlier) toFlag.push(order.id);
    });
  }
  if (toFlag.length > 0) await OrderModel.updateMany({ _id: { $in: toFlag } }, { $set: { possibleDuplicate: true } });
  return toFlag.length;
}
