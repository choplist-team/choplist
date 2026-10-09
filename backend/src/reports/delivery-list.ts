import type { Types } from 'mongoose';
import type { MenuDoc } from '../models/menu.js';
import { OrderModel } from '../models/order.js';
import { countedStatuses } from './prep-sheet.js';

type DeliveryStop = {
  ref: string;
  status: string;
  customer: { name: string; phone: string };
  address: string;
  day: string;
  note: string | null;
  lines: { name: string; qty: number }[];
  total: number;
};

type AreaGroup = { _id: string; orders: DeliveryStop[]; count: number };

// Orders grouped by delivery area, for the rider. Computed on every request.
export async function deliveryList(
  sellerId: Types.ObjectId,
  menu: MenuDoc,
  options: { paidOnly: boolean; day?: string },
) {
  const groups = await OrderModel.aggregate<AreaGroup>([
    {
      $match: {
        sellerId,
        menuId: menu._id,
        status: { $in: countedStatuses(options.paidOnly) },
        ...(options.day ? { 'delivery.day': options.day } : {}),
      },
    },
    // Within each area: by day, then in the order they came in.
    { $sort: { 'delivery.day': 1, createdAt: 1 } },
    {
      $group: {
        _id: '$delivery.area',
        count: { $sum: 1 },
        // $push keeps the $sort order above.
        orders: {
          $push: {
            ref: '$ref',
            status: '$status',
            customer: '$customer',
            address: '$delivery.address',
            day: '$delivery.day',
            note: { $ifNull: ['$note', null] },
            lines: {
              $map: { input: '$lines', as: 'line', in: { name: '$$line.name', qty: '$$line.qty' } },
            },
            total: '$total',
          },
        },
      },
    },
  ]);

  // Areas in the order the seller listed them on the menu; any other area
  // (shouldn't happen, placeOrder checks it) goes last.
  const position = (area: string) => {
    const i = menu.areas.indexOf(area);
    return i === -1 ? menu.areas.length : i;
  };
  groups.sort((a, b) => position(a._id) - position(b._id) || a._id.localeCompare(b._id));

  return {
    menuId: menu._id.toString(),
    title: menu.title,
    paidOnly: options.paidOnly,
    day: options.day ?? null,
    areas: groups.map((group) => ({ area: group._id, count: group.count, orders: group.orders })),
    totalOrders: groups.reduce((sum, group) => sum + group.count, 0),
  };
}
