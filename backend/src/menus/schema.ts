import { z } from 'zod';
import type { MenuDoc } from '../models/menu.js';
import { calendarDay, instant, lagosDay } from '../validation/day.js';

// 30 items x (80-char name + 300-char description) stays well under the 20 KB
// body limit, and is more than a home kitchen's weekly menu.
const MAX_ITEMS = 30;

const itemSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).optional(),
  price: z.number().int('price must be whole naira').min(1).max(1_000_000),
  // Portions available. Stored as qtyTotal, and qtyRemaining starts equal to it.
  qty: z.number().int('qty must be a whole number').min(1).max(1_000),
});

const uniqueStrings = (values: string[]) => new Set(values).size === values.length;

// Create and edit take the same body: PUT replaces the whole draft.
export const menuBodySchema = z
  .object({
    title: z.string().trim().min(1).max(80),
    cutoffAt: instant,
    items: z.array(itemSchema).min(1).max(MAX_ITEMS),
    areas: z
      .array(z.string().trim().min(1).max(60))
      .min(1)
      .max(30)
      .refine(uniqueStrings, 'Each area should be listed once'),
    deliveryDays: z
      .array(calendarDay)
      .min(1)
      .max(14)
      .refine(uniqueStrings, 'Each delivery day should be listed once'),
  })
  .superRefine((menu, ctx) => {
    // zod still runs this when a field above already failed, with that field
    // unconverted (cutoffAt still a string). Its own error is already reported.
    if (!(menu.cutoffAt instanceof Date) || !Array.isArray(menu.deliveryDays)) return;

    if (menu.cutoffAt.getTime() <= Date.now()) {
      ctx.addIssue({ code: 'custom', path: ['cutoffAt'], message: 'Cut-off must be in the future' });
    }
    // Delivering before ordering closes makes no sense. Compare Lagos calendar
    // days: a 6pm Friday cut-off allows Friday delivery but not Thursday.
    const cutoffDay = lagosDay(menu.cutoffAt);
    menu.deliveryDays.forEach((day, i) => {
      if (day < cutoffDay) {
        ctx.addIssue({
          code: 'custom',
          path: ['deliveryDays', i],
          message: `Delivery day ${day} is before the cut-off day ${cutoffDay}`,
        });
      }
    });
  });

export type MenuBody = z.infer<typeof menuBodySchema>;

// Fields to store. Stock starts full: qtyRemaining = qtyTotal. Days are sorted
// so customers see them in order.
export function toMenuFields(body: MenuBody) {
  return {
    title: body.title,
    cutoffAt: body.cutoffAt,
    items: body.items.map((item) => ({
      name: item.name,
      description: item.description,
      price: item.price,
      qtyTotal: item.qty,
      qtyRemaining: item.qty,
    })),
    areas: body.areas,
    deliveryDays: [...body.deliveryDays].sort(),
  };
}

export function toMenuResponse(menu: MenuDoc) {
  return {
    id: menu._id.toString(),
    title: menu.title,
    status: menu.status,
    cutoffAt: menu.cutoffAt,
    items: menu.items.map((item) => ({
      id: item._id.toString(),
      name: item.name,
      description: item.description ?? null,
      price: item.price,
      qtyTotal: item.qtyTotal,
      qtyRemaining: item.qtyRemaining,
    })),
    areas: menu.areas,
    deliveryDays: menu.deliveryDays,
    openedAt: menu.openedAt ?? null,
    closedAt: menu.closedAt ?? null,
    createdAt: menu.createdAt,
    updatedAt: menu.updatedAt,
  };
}
