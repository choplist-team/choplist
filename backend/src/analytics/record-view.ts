import { mongo, type Types } from 'mongoose';
import { MenuViewDailyModel } from '../models/menu-view-daily.js';
import { lagosDay } from '../validation/day.js';

function isDuplicateKey(err: unknown): boolean {
  return err instanceof mongo.MongoServerError && err.code === 11000;
}

// Adds one to today's counter for this menu, creating it on the first view.
//
// ONE database call, and atomic: $inc adds to whatever the stored number is at
// that moment, so 50 simultaneous views add exactly 50. (Reading the count,
// adding one in JavaScript and saving it would lose views, as the delivery-code
// attempts showed.)
//
// With upsert, two FIRST views of the day arriving together can both find no
// counter and both try to create it. The unique index lets only one succeed;
// the other gets a duplicate-key error. The counter exists by then, so trying
// once more simply increments it.
export async function recordMenuView(
  menu: { _id: Types.ObjectId; sellerId: Types.ObjectId },
  now: Date = new Date(),
): Promise<void> {
  const day = lagosDay(now);
  const write = () =>
    MenuViewDailyModel.updateOne(
      { menuId: menu._id, day },
      { $inc: { count: 1 }, $setOnInsert: { sellerId: menu.sellerId } },
      { upsert: true },
    );
  try {
    await write();
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    await write();
  }
}
