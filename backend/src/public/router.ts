import { Router } from 'express';
import { AppError } from '../errors.js';
import { MenuModel, type MenuDoc } from '../models/menu.js';
import { OrderModel, type OrderDoc } from '../models/order.js';
import { SellerModel, type SellerDoc } from '../models/seller.js';
import { placeOrder } from '../orders/place-order.js';
import { createRateLimiters, type RateLimitSettings } from '../middleware/rate-limit.js';
import { lookupSchema, placeOrderSchema } from './schema.js';

// --- What customers see. Nothing internal: no qtyTotal, no clerk ids. ---

function toPublicSeller(seller: SellerDoc) {
  return { businessName: seller.businessName, slug: seller.slug, phone: seller.phone };
}

function toPublicMenu(menu: MenuDoc, now: Date) {
  return {
    id: menu._id.toString(),
    title: menu.title,
    cutoffAt: menu.cutoffAt,
    // The menu can still say "open" after the cut-off until the seller closes
    // it; this is what the page should use to show the order button.
    acceptingOrders: menu.cutoffAt > now,
    items: menu.items.map((item) => ({
      id: item._id.toString(),
      name: item.name,
      description: item.description ?? null,
      price: item.price,
      qtyRemaining: item.qtyRemaining,
      soldOut: item.qtyRemaining === 0,
    })),
    areas: menu.areas,
    deliveryDays: menu.deliveryDays,
  };
}

// Where and how to pay. Shown right after ordering and on lookup.
function paymentInstructions(seller: SellerDoc, order: OrderDoc) {
  return {
    amount: order.total,
    reference: order.ref,
    bankName: seller.payment.bankName,
    accountNumber: seller.payment.accountNumber,
    accountName: seller.payment.accountName,
    instructions:
      `Transfer ₦${order.total.toLocaleString('en-NG')} to ${seller.payment.accountName}, ` +
      `${seller.payment.bankName} ${seller.payment.accountNumber}, and write ${order.ref} ` +
      `as the transfer description so ${seller.businessName} can match your payment.`,
  };
}

// Deliberately leaves out the address and full phone number: anyone holding
// the ref and the last 4 digits sees only what they need to track the order.
function toPublicOrder(order: OrderDoc) {
  return {
    ref: order.ref,
    status: order.status,
    customerName: order.customer.name,
    lines: order.lines.map((line) => ({ name: line.name, unitPrice: line.unitPrice, qty: line.qty })),
    total: order.total,
    delivery: { area: order.delivery.area, day: order.delivery.day },
    createdAt: order.createdAt,
  };
}

function orderNotFound(): AppError {
  return new AppError(404, 'ORDER_NOT_FOUND', 'No order matches that reference and phone number');
}

export function createPublicRouter(rateLimits: RateLimitSettings): Router {
  const router = Router();
  const limit = createRateLimiters(rateLimits);

  // A seller's link. 404 if the slug is unknown; menu: null if they have no
  // open menu right now (the page can say so instead of showing an error).
  router.get('/menu/:slug', async (req, res) => {
    const seller = await SellerModel.findOne({ slug: req.params.slug.toLowerCase() });
    if (!seller) throw new AppError(404, 'SELLER_NOT_FOUND', 'No seller has this link');

    const menu = await MenuModel.findOne({ sellerId: seller._id, status: 'open' });
    res.json({ seller: toPublicSeller(seller), menu: menu ? toPublicMenu(menu, new Date()) : null });
  });

  router.post('/orders', limit.orders, async (req, res) => {
    const input = placeOrderSchema.parse(req.body);
    const order = await placeOrder(input);

    const seller = await SellerModel.findById(order.sellerId);
    // The menu's seller always exists; if not, the data is broken: fail loudly.
    if (!seller) throw new Error(`Seller ${order.sellerId.toString()} missing for order ${order.ref}`);

    res.status(201).json({
      order: toPublicOrder(order),
      payment: paymentInstructions(seller, order),
      seller: toPublicSeller(seller),
    });
  });

  // Track an order. Needs the ref AND the last 4 digits of the phone used.
  // A wrong ref and a wrong phone give the same 404, so a guesser can't tell
  // which part was wrong.
  router.get('/orders/:ref', limit.lookups, async (req, res) => {
    const parsed = lookupSchema.safeParse({ ref: req.params.ref, phoneLast4: req.query.phoneLast4 });
    if (!parsed.success) {
      if (parsed.error.issues.some((issue) => issue.path[0] === 'phoneLast4')) throw parsed.error;
      throw orderNotFound(); // a malformed ref can't match anything
    }
    const { ref, phoneLast4 } = parsed.data;

    const order = await OrderModel.findOne({ ref });
    if (!order || !order.customer.phone.endsWith(phoneLast4)) throw orderNotFound();

    const seller = await SellerModel.findById(order.sellerId);
    if (!seller) throw new Error(`Seller ${order.sellerId.toString()} missing for order ${order.ref}`);

    res.json({
      order: toPublicOrder(order),
      payment: paymentInstructions(seller, order),
      seller: toPublicSeller(seller),
    });
  });

  return router;
}
