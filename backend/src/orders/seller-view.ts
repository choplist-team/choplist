import { orderPaymentMethod, type OrderDoc } from '../models/order.js';

// What the seller sees for an order: everything needed to cook, deliver and
// match payment, including the customer's phone and address.
//
// This is the ONLY place a seller response is shaped, and it is a whitelist: a
// field appears only if it is written out below. So the delivery code, the
// access key hash and the attempt counters can never leak by being added to the
// schema or selected by a query. Do not spread the document (...order) here.
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
    // How it was paid: 'paystack' (settled to the seller's bank by Paystack) or
    // 'transfer' (the customer paid the seller's bank directly). Nothing about
    // fees, the service fee or Paystack's internals is shown to the seller here.
    paymentMethod: orderPaymentMethod(order),
    paidAt: order.paidAt ?? null,
    cancelledAt: order.cancelledAt ?? null,
    outForDeliveryAt: order.outForDeliveryAt ?? null,
    deliveredAt: order.deliveredAt ?? null,
    createdAt: order.createdAt,
  };
}
