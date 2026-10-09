import type { Types } from 'mongoose';
import { MenuModel } from '../models/menu.js';

// One line per distinct item (duplicates already merged).
export type StockLine = { itemId: Types.ObjectId; qty: number };

// $inc paths and arrayFilters for a set of lines. Line N updates the array
// element named "iN", and arrayFilters says which element that is (by _id).
// Identifiers must start with a lowercase letter, and every one must be used.
function perLineUpdate(lines: StockLine[], sign: 1 | -1) {
  const inc: Record<string, number> = {};
  const arrayFilters: Record<string, Types.ObjectId>[] = [];
  lines.forEach((line, i) => {
    inc[`items.$[i${i}].qtyRemaining`] = sign * line.qty;
    arrayFilters.push({ [`i${i}._id`]: line.itemId });
  });
  return { inc, arrayFilters };
}

// Takes stock for every line in ONE atomic update, or for none of them.
//
// The filter only matches the menu if, at the moment of the write:
//   - it is open,
//   - the cut-off has not passed,
//   - and for EVERY line, there is one array element with that _id AND
//     qtyRemaining >= qty ($elemMatch: both conditions on the same element).
// MongoDB checks the filter and applies the $inc as one operation on one
// document, so no other order can take the stock in between.
//
// Returns false if nothing matched (closed, too late, or not enough stock).
export async function takeStock(menuId: Types.ObjectId, lines: StockLine[], now: Date): Promise<boolean> {
  const { inc, arrayFilters } = perLineUpdate(lines, -1);
  const result = await MenuModel.updateOne(
    {
      _id: menuId,
      status: 'open',
      cutoffAt: { $gt: now },
      $and: lines.map((line) => ({
        items: { $elemMatch: { _id: line.itemId, qtyRemaining: { $gte: line.qty } } },
      })),
    },
    { $inc: inc },
    { arrayFilters },
  );
  return result.matchedCount === 1;
}

// Gives stock back (order insert failed, or later: order cancelled). No status
// or cut-off condition: the menu may have closed since the stock was taken,
// and the portions still exist.
export async function returnStock(menuId: Types.ObjectId, lines: StockLine[]): Promise<void> {
  const { inc, arrayFilters } = perLineUpdate(lines, 1);
  await MenuModel.updateOne({ _id: menuId }, { $inc: inc }, { arrayFilters });
}
