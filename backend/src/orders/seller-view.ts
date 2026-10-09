import type { OrderDoc } from '../models/order.js';

// What the seller sees for an order: everything needed to cook, deliver and
// match payment, including the customer's phone and address.
export function toSellerOrder(order: OrderDoc) {
  return {
    id: order._id.toString(),
    ref: order.ref,
    status: order.status,
    customer: { name: order.customer.name, phone: order.customer.phone },
    delivery: { area: order.delivery.area, address: order.delivery.address, day: order.delivery.day },
    note: order.note ?? null,
    lines: order.lines.map((line) => ({
      itemId: line.itemId.toString(),
      name: line.name,
      unitPrice: line.unitPrice,
      qty: line.qty,
    })),
    total: order.total,
    paidAt: order.paidAt ?? null,
    cancelledAt: order.cancelledAt ?? null,
    createdAt: order.createdAt,
  };
}
