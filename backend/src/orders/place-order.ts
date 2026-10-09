import { Types, mongo } from 'mongoose';
import { AppError } from '../errors.js';
import { MenuModel, type MenuDoc } from '../models/menu.js';
import { OrderModel, type OrderDoc } from '../models/order.js';
import { generateRef as defaultGenerateRef } from './reference.js';
import { returnStock, takeStock, type StockLine } from './stock.js';

// Already validated by the route (Step 7): trimmed strings, phone normalised,
// qty a positive whole number.
export type PlaceOrderInput = {
  menuId: string;
  customer: { name: string; phone: string };
  delivery: { area: string; address: string; day: string };
  note?: string;
  lines: { itemId: string; qty: number }[];
};

export type PlaceOrderOptions = {
  // Injected by tests to force reference-code collisions.
  generateRef?: () => string;
};

const MAX_REF_ATTEMPTS = 5;

const OBJECT_ID = /^[0-9a-f]{24}$/i;

function menuNotFound(): AppError {
  return new AppError(404, 'MENU_NOT_FOUND', 'Menu not found');
}

function orderingClosed(): AppError {
  return new AppError(409, 'ORDERING_CLOSED', 'This menu is no longer taking orders');
}

// Same item twice ("2 jollof" + "1 jollof") becomes one line of 3. Two
// arrayFilters on the same element would make MongoDB reject the update, and
// each stock check must be against the item's total.
function mergeLines(lines: PlaceOrderInput['lines']): StockLine[] {
  if (lines.length === 0) throw new AppError(400, 'VALIDATION_ERROR', 'lines: An order needs at least one item');
  const totals = new Map<string, number>();
  for (const { itemId, qty } of lines) {
    if (!Number.isInteger(qty) || qty < 1) throw new AppError(400, 'VALIDATION_ERROR', 'lines: qty must be a whole number of at least 1');
    if (!OBJECT_ID.test(itemId)) throw new AppError(400, 'ITEM_NOT_FOUND', 'One of the items is not on this menu');
    const key = itemId.toLowerCase();
    totals.set(key, (totals.get(key) ?? 0) + qty);
  }
  return [...totals].map(([itemId, qty]) => ({ itemId: new Types.ObjectId(itemId), qty }));
}

// Why the stock update matched nothing. Read after the failed update, so it
// explains the failure; it never decides anything.
async function explainFailure(menuId: Types.ObjectId, lines: StockLine[], now: Date): Promise<AppError> {
  const menu = await MenuModel.findById(menuId).lean();
  if (!menu) return menuNotFound();
  if (menu.status !== 'open' || menu.cutoffAt <= now) return orderingClosed();

  const short = lines.flatMap(({ itemId, qty }) => {
    const item = menu.items.find((it) => it._id.equals(itemId));
    if (!item || item.qtyRemaining >= qty) return [];
    return [item.qtyRemaining === 0 ? `${item.name} is sold out` : `only ${item.qtyRemaining} ${item.name} left`];
  });
  // Empty if someone cancelled in the meantime and stock came back; asking
  // the customer to try again is still the right answer.
  const detail = short.length ? short.join('; ') : 'stock changed while ordering, please try again';
  return new AppError(409, 'SOLD_OUT', `Not enough left: ${detail}`);
}

function isRefCollision(err: unknown): boolean {
  return err instanceof mongo.MongoServerError && err.code === 11000 && Boolean(err.keyPattern?.ref);
}

export async function placeOrder(input: PlaceOrderInput, options: PlaceOrderOptions = {}): Promise<OrderDoc> {
  const generateRef = options.generateRef ?? defaultGenerateRef;

  // 1. Check the input before touching the database.
  if (!OBJECT_ID.test(input.menuId)) throw menuNotFound();
  const menuId = new Types.ObjectId(input.menuId);
  const lines = mergeLines(input.lines);

  // 2. Read the menu for names, prices, areas and days. NOT for stock.
  //    Reading prices first is safe: only drafts can be edited and the stock
  //    update below requires status "open", so these prices are the ones in
  //    force when the stock is taken.
  const menu: MenuDoc | null = await MenuModel.findById(menuId);
  if (!menu) throw menuNotFound();
  if (menu.status !== 'open' || menu.cutoffAt <= new Date()) throw orderingClosed();

  const orderLines = lines.map(({ itemId, qty }) => {
    const item = menu.items.find((it) => it._id.equals(itemId));
    if (!item) throw new AppError(400, 'ITEM_NOT_FOUND', 'One of the items is not on this menu');
    // Price and name come from the menu, never from the client.
    return { itemId, name: item.name, unitPrice: item.price, qty };
  });

  // Match the area case-insensitively, store the seller's spelling.
  const area = menu.areas.find((a) => a.toLowerCase() === input.delivery.area.trim().toLowerCase());
  if (!area) {
    throw new AppError(400, 'INVALID_AREA', `We deliver to: ${menu.areas.join(', ')}`);
  }
  if (!menu.deliveryDays.includes(input.delivery.day)) {
    throw new AppError(400, 'INVALID_DELIVERY_DAY', `Choose a delivery day: ${menu.deliveryDays.join(', ')}`);
  }

  // 3. Take the stock: one atomic, all-or-nothing update (see stock.ts).
  const now = new Date();
  if (!(await takeStock(menuId, lines, now))) {
    throw await explainFailure(menuId, lines, now);
  }

  // 4. Save the order. Only the insert is retried on a reference collision;
  //    the stock is taken exactly once.
  const total = orderLines.reduce((sum, line) => sum + line.unitPrice * line.qty, 0);
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        return await OrderModel.create({
          ref: generateRef(),
          sellerId: menu.sellerId,
          menuId,
          customer: input.customer,
          delivery: { area, address: input.delivery.address, day: input.delivery.day },
          note: input.note,
          lines: orderLines,
          total,
        });
      } catch (err) {
        if (!isRefCollision(err) || attempt >= MAX_REF_ATTEMPTS) throw err;
      }
    }
  } catch (err) {
    // 5. The order was not saved: give the stock back, then report the error.
    try {
      await returnStock(menuId, lines);
    } catch (restoreErr) {
      // Both writes failed (e.g. the database went away). The portions stay
      // held until fixed by hand; log everything needed to do that.
      console.error('STOCK NOT RETURNED after failed order insert', {
        menuId: menuId.toString(),
        lines: lines.map((l) => ({ itemId: l.itemId.toString(), qty: l.qty })),
        restoreErr,
      });
    }
    throw err;
  }
}
