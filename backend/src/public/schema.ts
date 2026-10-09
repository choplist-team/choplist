import { z } from 'zod';
import { REF_PATTERN } from '../models/order.js';
import { nigerianPhone } from '../validation/phone.js';

// What a customer sends to place an order. Prices are NOT accepted: any "price"
// or "total" field is stripped, and placeOrder takes prices from the menu.
// Lengths match the Order model so the model never rejects a valid request.
export const placeOrderSchema = z.object({
  menuId: z.string().min(1),
  customer: z.object({
    name: z.string().trim().min(1).max(80),
    phone: nigerianPhone,
  }),
  delivery: z.object({
    area: z.string().trim().min(1).max(60),
    address: z.string().trim().min(5, 'Enter a full delivery address').max(300),
    day: z.string().trim().min(1),
  }),
  note: z
    .string()
    .trim()
    .max(300)
    .optional()
    .transform((note) => note || undefined),
  lines: z
    .array(
      z.object({
        itemId: z.string().min(1),
        qty: z.number().int('qty must be a whole number').min(1).max(100),
      }),
    )
    .min(1, 'Choose at least one item')
    .max(30),
});

// GET /orders/:ref?phoneLast4=4567. The ref is uppercased so "cl-7kq2m" works.
export const lookupSchema = z.object({
  ref: z
    .string()
    .trim()
    .toUpperCase()
    .regex(REF_PATTERN, 'Reference looks like CL-7KQ2M'),
  phoneLast4: z.string().regex(/^\d{4}$/, 'phoneLast4 must be the last 4 digits of your phone number'),
});
