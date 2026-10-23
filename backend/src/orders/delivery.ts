import { AppError } from '../errors.js';
import { OrderModel, type OrderDoc } from '../models/order.js';
import { MAX_CODE_ATTEMPTS, MAX_CODE_RESETS, generateDeliveryCode, generateDifferentDeliveryCode } from './delivery-code.js';

// The three delivery operations. Each one is a single conditional write on one
// order document (MongoDB applies those one at a time, never half-way), and
// each answers "why not?" only AFTER that write failed, by reading the order.
//
// Rule for all three: never decide in JavaScript from data you read earlier and
// then write. Put the condition in the write itself. The routes pass in
// `filter` = { ref, sellerId }, so another seller's order is simply not found.
//
// The documents returned here come from findOneAndUpdate/findOne, so they do not
// carry the delivery code or key hash (select:false). Routes still send them
// through toSellerOrder.

export type OrderFilter = { ref: string; sellerId: OrderDoc['sellerId'] };

function orderNotFound(): AppError {
  return new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');
}

async function loadOrNotFound(filter: OrderFilter): Promise<OrderDoc> {
  const order = await OrderModel.findOne(filter);
  if (!order) throw orderNotFound();
  return order;
}

// paid -> out_for_delivery, and the code is made here.
export async function markOutForDelivery(filter: OrderFilter): Promise<OrderDoc> {
  const updated = await OrderModel.findOneAndUpdate(
    { ...filter, status: 'paid' },
    {
      $set: {
        status: 'out_for_delivery',
        outForDeliveryAt: new Date(),
        deliveryCode: generateDeliveryCode(),
        // Set explicitly: an old order has no counters, and "$lt 5" never
        // matches a missing field, which would lock it before the first guess.
        deliveryCodeAttempts: 0,
        deliveryCodeResets: 0,
      },
    },
    { returnDocument: 'after' },
  );
  if (updated) return updated;

  const order = await loadOrNotFound(filter);
  switch (order.status) {
    case 'out_for_delivery':
      // Idempotent: a second tap (or a lost race) changes nothing, and above
      // all does NOT make a new code the customer has not seen.
      return order;
    case 'delivered':
      throw new AppError(409, 'ORDER_DELIVERED', 'This order has already been delivered');
    case 'cancelled':
      throw new AppError(409, 'ORDER_CANCELLED', 'This order was cancelled');
    default:
      throw new AppError(409, 'ORDER_NOT_PAID', 'Mark the order paid before sending it out for delivery');
  }
}

// out_for_delivery -> delivered, if and only if the code is right and the order
// is not locked. `code` is already checked to be exactly 6 digits by the route.
//
// Two writes, each atomic, and never "read, compare in JavaScript, write":
//
//  1. THE SUCCESS WRITE. One filter that must match all of:
//       ref, sellerId            -> this seller's order (else it is not found)
//       status: 'out_for_delivery' -> only an order in transit; a repeat, a
//                                    cancelled or an unpaid order cannot match
//       deliveryCode: code       -> the guess equals the stored code. The code
//                                    is select:false, but a filter may use it;
//                                    it is compared inside the database and
//                                    never sent to Node
//       deliveryCodeAttempts: { $lt: 5 }
//                                -> not locked. This is what makes the
//                                    lockout hold even for the RIGHT code
//     and in the same operation it sets status 'delivered' + deliveredAt and
//     $unset removes the code. Because check and change are one operation, two
//     requests cannot both win, and nothing can slip in between them.
//
//  2. THE WRONG-GUESS WRITE (only if 1 matched nothing). Same status and
//     attempts conditions but NOT the code, and it does $inc: 1. $inc is done by
//     the database on the current value, so 30 simultaneous wrong guesses add
//     exactly 1 each until the filter stops matching at 5. The counter can never
//     go past 5.
//
// A read-then-write version (read the order, compare, then save attempts+1)
// loses counts: 30 requests read "attempts = 0" and all write "1", so the lock
// never arrives. And it can check "attempts < 5" on a stale read, then accept a
// right code after the order locked.
export async function confirmDelivery(filter: OrderFilter, code: string): Promise<OrderDoc> {
  const delivered = await OrderModel.findOneAndUpdate(
    { ...filter, status: 'out_for_delivery', deliveryCode: code, deliveryCodeAttempts: { $lt: MAX_CODE_ATTEMPTS } },
    { $set: { status: 'delivered', deliveredAt: new Date() }, $unset: { deliveryCode: '' } },
    { returnDocument: 'after' },
  );
  if (delivered) return delivered;

  const counted = await OrderModel.findOneAndUpdate(
    { ...filter, status: 'out_for_delivery', deliveryCodeAttempts: { $lt: MAX_CODE_ATTEMPTS } },
    { $inc: { deliveryCodeAttempts: 1 } },
    { returnDocument: 'after' },
  );
  if (counted) {
    const left = MAX_CODE_ATTEMPTS - counted.deliveryCodeAttempts;
    throw new AppError(
      400,
      'INVALID_DELIVERY_CODE',
      left > 0
        ? `That code is not correct. ${left} ${left === 1 ? 'attempt' : 'attempts'} left.`
        : 'That code is not correct. No attempts left: reset the code to try again.',
    );
  }

  // Neither write matched: find out why, so the seller gets the right message.
  const order = await loadOrNotFound(filter);
  switch (order.status) {
    case 'delivered':
      return order; // idempotent: a repeat of a confirm that already worked
    case 'cancelled':
      throw new AppError(409, 'ORDER_CANCELLED', 'This order was cancelled');
    case 'out_for_delivery':
      if (order.deliveryCodeAttempts >= MAX_CODE_ATTEMPTS) {
        throw new AppError(409, 'DELIVERY_CODE_LOCKED', 'Too many wrong codes. Reset the code to continue.');
      }
      // The code was reset by another request between our two writes, so this
      // guess was against the old code. It is rejected and not counted.
      throw new AppError(400, 'INVALID_DELIVERY_CODE', 'That code is not correct.');
    default:
      throw new AppError(409, 'ORDER_NOT_OUT_FOR_DELIVERY', 'This order is not out for delivery');
  }
}

// New code, attempts back to 0, one more reset used. Only while out for
// delivery, and at most MAX_CODE_RESETS times per order.
//
// Compare-and-swap: we read the current code only to make a DIFFERENT one, and
// the write requires the stored code to still be that one. Two resets that read
// at the same moment cannot both win: the second finds the code already changed
// and changes nothing. But a reset that arrives after the first has finished is
// an ordinary second reset and counts as one, so a double tap MAY use two. What
// is guaranteed, however many requests arrive, is the cap: never more than
// MAX_CODE_RESETS resets, and every code issued is different from the last.
export async function resetDeliveryCode(filter: OrderFilter): Promise<OrderDoc> {
  const current = await OrderModel.findOne({ ...filter, status: 'out_for_delivery' }).select('+deliveryCode');

  if (current?.deliveryCode) {
    const reset = await OrderModel.findOneAndUpdate(
      {
        ...filter,
        status: 'out_for_delivery',
        deliveryCode: current.deliveryCode,
        deliveryCodeResets: { $lt: MAX_CODE_RESETS },
      },
      {
        $set: { deliveryCode: generateDifferentDeliveryCode(current.deliveryCode), deliveryCodeAttempts: 0 },
        $inc: { deliveryCodeResets: 1 },
      },
      { returnDocument: 'after' },
    );
    if (reset) return reset;
  }

  const order = await loadOrNotFound(filter);
  if (order.status !== 'out_for_delivery') {
    throw new AppError(409, 'ORDER_NOT_OUT_FOR_DELIVERY', 'The code can only be reset while the order is out for delivery');
  }
  if (order.deliveryCodeResets >= MAX_CODE_RESETS) {
    throw new AppError(
      409,
      'DELIVERY_RESET_LIMIT',
      `The code has already been reset ${MAX_CODE_RESETS} times. Contact support if the customer still cannot confirm.`,
    );
  }
  return order; // lost a race with another reset: that one did the job
}
