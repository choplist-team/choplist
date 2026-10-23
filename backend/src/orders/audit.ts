import { OrderModel } from '../models/order.js';

// Orders that are out for delivery but cannot work the normal way:
//   no-code  the order has no delivery code at all, so nobody can confirm it
//   no-key   it has a code, but no access key was ever stored (the order was
//            placed before keys existed), so no browser can show the code
//
// Read-only, and it returns references only: never a code or a key hash. Filters
// may use the select:false fields; they just never come back in the result.
export type DeliveryProblem = { ref: string; problem: 'no-code' | 'no-key' };

const missing = (field: string) => ({ $or: [{ [field]: { $exists: false } }, { [field]: null }, { [field]: '' }] });

export async function findUnconfirmableOrders(): Promise<DeliveryProblem[]> {
  const [noCode, noKey] = await Promise.all([
    OrderModel.find({ status: 'out_for_delivery', ...missing('deliveryCode') }).select('ref').sort({ createdAt: 1 }),
    OrderModel.find({ status: 'out_for_delivery', ...missing('accessKeyHash'), deliveryCode: { $exists: true, $nin: [null, ''] } })
      .select('ref')
      .sort({ createdAt: 1 }),
  ]);
  return [
    ...noCode.map((o) => ({ ref: o.ref, problem: 'no-code' as const })),
    ...noKey.map((o) => ({ ref: o.ref, problem: 'no-key' as const })),
  ];
}
