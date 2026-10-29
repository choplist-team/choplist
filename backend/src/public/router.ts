import { Router } from 'express';
import { Types } from 'mongoose';
import { ZodError } from 'zod';
import { AppError } from '../errors.js';
import { MenuModel, type MenuDoc } from '../models/menu.js';
import { OrderModel, type OrderDoc } from '../models/order.js';
import { SellerModel, isSellerActive, type SellerDoc } from '../models/seller.js';
import { recordMenuView } from '../analytics/record-view.js';
import { logEvent } from '../events/log.js';
import { accessKeyMatches, generateAccessKey } from '../orders/delivery-code.js';
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
//
// deliveryCode is null unless the caller passes it in, and the lookup does that
// only while the order is out for delivery AND the request proved it is the
// customer (the access key). deliveryCodeHidden tells the page why it is null:
// true = "in transit, but this browser does not hold the key".
function toPublicOrder(order: OrderDoc, delivery: { code: string | null; hidden: boolean } = { code: null, hidden: false }) {
  return {
    ref: order.ref,
    status: order.status,
    deliveryCode: delivery.code,
    deliveryCodeHidden: delivery.hidden,
    outForDeliveryAt: order.outForDeliveryAt ?? null,
    deliveredAt: order.deliveredAt ?? null,
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

// Why a customer's order was refused, for the admin health page. It stores the
// error CODE and which menu, never what the customer typed: no phone, name,
// address or note. (The 4xx codes below are expected, e.g. SOLD_OUT; a 5xx is
// logged separately by the error handler.)
const LOGGED_FAILURES = new Set([
  'SOLD_OUT',
  'ORDERING_CLOSED',
  'INVALID_AREA',
  'INVALID_DELIVERY_DAY',
  'ITEM_NOT_FOUND',
  'MENU_NOT_FOUND',
  'VALIDATION_ERROR',
]);

async function recordFailedOrder(err: unknown, body: unknown): Promise<void> {
  const code = err instanceof AppError ? err.code : err instanceof ZodError ? 'VALIDATION_ERROR' : null;
  if (!code || !LOGGED_FAILURES.has(code)) return;

  // The menu id comes from an untrusted body: use it only if it is a real id of
  // an existing menu, and take the seller from the menu, not from the body.
  const rawMenuId = typeof body === 'object' && body !== null ? (body as { menuId?: unknown }).menuId : undefined;
  let menu: { _id: Types.ObjectId; sellerId: Types.ObjectId } | null = null;
  if (typeof rawMenuId === 'string' && /^[0-9a-f]{24}$/i.test(rawMenuId)) {
    try {
      menu = await MenuModel.findById(rawMenuId, { sellerId: 1 }).lean();
    } catch {
      menu = null;
    }
  }
  await logEvent({
    type: 'order_failed',
    level: 'warn',
    code,
    message: `An order was refused: ${code}`,
    menuId: menu?._id,
    sellerId: menu?.sellerId,
  });
}

export function createPublicRouter(rateLimits: RateLimitSettings): Router {
  const router = Router();
  const limit = createRateLimiters(rateLimits);

  // A seller's link. 404 if the slug is unknown; menu: null if they have no
  // open menu right now (the page can say so instead of showing an error).
  router.get('/menu/:slug', async (req, res) => {
    const seller = await SellerModel.findOne({ slug: req.params.slug.toLowerCase() });
    // A suspended or deactivated shop looks exactly like one that does not exist.
    if (!seller || !isSellerActive(seller)) throw new AppError(404, 'SELLER_NOT_FOUND', 'No seller has this link');

    const menu = await MenuModel.findOne({ sellerId: seller._id, status: 'open' });
    res.json({ seller: toPublicSeller(seller), menu: menu ? toPublicMenu(menu, new Date()) : null });
  });

  // "Someone opened this shop's menu." The page calls it once per visit; the
  // admin analytics add the counts up. A POST (not counted on the GET) so that
  // link previews, crawlers and prefetching, which only GET, do not inflate it.
  //
  // Always 204, with no body, when the shop exists. A counter must never break or
  // slow a customer's page, so a failed write is logged and still answers 204.
  // Nothing about the visitor is stored. Counts only an OPEN menu; a shop with no
  // open menu, or a suspended one, counts nothing.
  router.post('/menu/:slug/view', limit.views, async (req, res) => {
    const slug = String(req.params.slug ?? '').toLowerCase();
    const seller = await SellerModel.findOne({ slug });
    if (!seller || !isSellerActive(seller)) throw new AppError(404, 'SELLER_NOT_FOUND', 'No seller has this link');

    const menu = await MenuModel.findOne({ sellerId: seller._id, status: 'open' }, { _id: 1, sellerId: 1 }).lean();
    if (menu) {
      try {
        await recordMenuView(menu);
      } catch (err) {
        console.error('Could not count a menu view', err instanceof Error ? err.name : err);
      }
    }
    res.status(204).end();
  });

  router.post('/orders', limit.orders, async (req, res) => {
    // The customer's secret for this order. Shown once, below; only its hash is kept.
    const accessKey = generateAccessKey();
    let order: OrderDoc;
    try {
      const input = placeOrderSchema.parse(req.body);
      order = await placeOrder(input, { accessKey });
    } catch (err) {
      await recordFailedOrder(err, req.body);
      throw err;
    }

    const seller = await SellerModel.findById(order.sellerId);
    // The menu's seller always exists; if not, the data is broken: fail loudly.
    if (!seller) throw new Error(`Seller ${order.sellerId.toString()} missing for order ${order.ref}`);

    res.status(201).json({
      order: toPublicOrder(order),
      payment: paymentInstructions(seller, order),
      seller: toPublicSeller(seller),
      accessKey,
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

    // The ONLY query that asks for the secrets by name.
    const order = await OrderModel.findOne({ ref }).select('+deliveryCode +accessKeyHash');
    if (!order || !order.customer.phone.endsWith(phoneLast4)) throw orderNotFound();

    const seller = await SellerModel.findById(order.sellerId);
    if (!seller) throw new Error(`Seller ${order.sellerId.toString()} missing for order ${order.ref}`);

    // The ref and phone digits are known to the seller too, so they prove
    // nothing. The access key (a header, not the URL, so it stays out of logs
    // and history) is what separates the customer from the seller.
    const inTransit = order.status === 'out_for_delivery' && Boolean(order.deliveryCode);
    const isCustomer = accessKeyMatches(req.get('x-order-key'), order.accessKeyHash);
    const delivery = { code: inTransit && isCustomer ? (order.deliveryCode ?? null) : null, hidden: inTransit && !isCustomer };

    res.json({
      order: toPublicOrder(order, delivery),
      payment: paymentInstructions(seller, order),
      seller: toPublicSeller(seller),
    });
  });

  return router;
}
