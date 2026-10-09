import type { Types } from 'mongoose';
import type { MenuDoc } from '../models/menu.js';
import { OrderModel } from '../models/order.js';

// Which orders count: never cancelled ones. paidOnly narrows to paid.
export function countedStatuses(paidOnly: boolean) {
  return paidOnly ? ['paid'] : ['pending', 'paid'];
}

type ItemTotal = { _id: Types.ObjectId; portions: number; orders: number };
type Summary = { orders: number; amount: number };

// Portions to cook per item, computed from the orders on every request.
//
// Note: aggregate() skips Mongoose's schema casting, so ids in $match must
// already be ObjectIds (they are: they come from the menu document).
export async function prepSheet(sellerId: Types.ObjectId, menu: MenuDoc, paidOnly: boolean) {
  const [result] = await OrderModel.aggregate<{ items: ItemTotal[]; summary: Summary[] }>([
    // Uses the { sellerId, menuId, createdAt } index.
    { $match: { sellerId, menuId: menu._id, status: { $in: countedStatuses(paidOnly) } } },
    {
      // Two answers from one pass over the matched orders.
      $facet: {
        items: [
          // One document per order line: { ..., lines: { itemId, qty, ... } }
          { $unwind: '$lines' },
          // Add up per item. Each order has at most one line per item (placeOrder
          // merges duplicates), so counting lines counts orders.
          { $group: { _id: '$lines.itemId', portions: { $sum: '$lines.qty' }, orders: { $sum: 1 } } },
        ],
        summary: [{ $group: { _id: null, orders: { $sum: 1 }, amount: { $sum: '$total' } } }],
      },
    },
  ]);

  const byItem = new Map((result?.items ?? []).map((row) => [row._id.toString(), row]));
  const summary = result?.summary[0];

  return {
    menuId: menu._id.toString(),
    title: menu.title,
    paidOnly,
    // In menu order, including items nobody ordered (0 to cook).
    items: menu.items.map((item) => {
      const row = byItem.get(item._id.toString());
      return {
        itemId: item._id.toString(),
        name: item.name,
        portions: row?.portions ?? 0,
        orders: row?.orders ?? 0,
      };
    }),
    totals: {
      orders: summary?.orders ?? 0,
      portions: (result?.items ?? []).reduce((sum, row) => sum + row.portions, 0),
      // Naira expected from these orders (paid, or paid + pending).
      amount: summary?.amount ?? 0,
    },
  };
}
