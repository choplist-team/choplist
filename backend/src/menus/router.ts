import { Router, type Request } from 'express';
import { Types, mongo } from 'mongoose';
import { authenticate, currentSellerId, requireSeller } from '../auth/middleware.js';
import type { AuthProvider } from '../auth/provider.js';
import { AppError } from '../errors.js';
import { MenuModel, type MenuDoc } from '../models/menu.js';
import { menuBodySchema, toMenuFields, toMenuResponse } from './schema.js';

// A malformed id and someone else's menu both give the same 404, so a seller
// cannot even learn that another seller's menu exists.
function notFound(): AppError {
  return new AppError(404, 'MENU_NOT_FOUND', 'Menu not found');
}

// The menu id from the URL, plus the signed-in seller: every query below uses
// both, so a seller can only ever match their own menus.
function menuFilter(req: Request) {
  const id = req.params.id;
  if (typeof id !== 'string' || !/^[0-9a-f]{24}$/i.test(id)) throw notFound();
  return { _id: new Types.ObjectId(id), sellerId: currentSellerId(req) };
}

// After a conditional update matched nothing: find out why, for a clear error.
async function loadOrNotFound(filter: ReturnType<typeof menuFilter>): Promise<MenuDoc> {
  const menu = await MenuModel.findOne(filter);
  if (!menu) throw notFound();
  return menu;
}

function isDuplicateKey(err: unknown): boolean {
  return err instanceof mongo.MongoServerError && err.code === 11000;
}

export function createMenuRouter(auth: AuthProvider): Router {
  const router = Router();
  router.use(authenticate(auth), requireSeller);

  // Create a draft.
  router.post('/', async (req, res) => {
    const body = menuBodySchema.parse(req.body);
    const menu = await MenuModel.create({ ...toMenuFields(body), sellerId: currentSellerId(req), status: 'draft' });
    res.status(201).json(toMenuResponse(menu));
  });

  // The seller's menus, newest first.
  router.get('/', async (req, res) => {
    const menus = await MenuModel.find({ sellerId: currentSellerId(req) }).sort({ createdAt: -1 }).limit(100);
    res.json({ menus: menus.map(toMenuResponse) });
  });

  router.get('/:id', async (req, res) => {
    res.json(toMenuResponse(await loadOrNotFound(menuFilter(req))));
  });

  // Replace a draft. One conditional write: it only matches while the menu is
  // still a draft, so an edit racing an "open" can never change an open menu.
  router.put('/:id', async (req, res) => {
    const filter = menuFilter(req);
    const body = menuBodySchema.parse(req.body);

    // Run the full schema rules (the backstop) on the new content in memory
    // first: update validators would skip the per-item rules.
    const fields = toMenuFields(body);
    await new MenuModel({ ...fields, sellerId: filter.sellerId }).validate();

    const updated = await MenuModel.findOneAndUpdate(
      { ...filter, status: 'draft' },
      { $set: fields },
      { returnDocument: 'after' },
    );
    if (updated) {
      res.json(toMenuResponse(updated));
      return;
    }
    const menu = await loadOrNotFound(filter);
    throw new AppError(409, 'MENU_NOT_DRAFT', `Only draft menus can be edited; this menu is ${menu.status}`);
  });

  // draft -> open. Requires a future cut-off, and the partial unique index
  // allows only one open menu per seller.
  router.post('/:id/open', async (req, res) => {
    const filter = menuFilter(req);
    const now = new Date();

    let opened: MenuDoc | null;
    try {
      opened = await MenuModel.findOneAndUpdate(
        { ...filter, status: 'draft', cutoffAt: { $gt: now } },
        { $set: { status: 'open', openedAt: now } },
        { returnDocument: 'after' },
      );
    } catch (err) {
      if (isDuplicateKey(err)) {
        throw new AppError(409, 'ANOTHER_MENU_OPEN', 'Close your open menu before opening another one');
      }
      throw err;
    }
    if (opened) {
      res.json(toMenuResponse(opened));
      return;
    }

    const menu = await loadOrNotFound(filter);
    if (menu.status === 'open') {
      res.json(toMenuResponse(menu)); // already open: same result as opening it
      return;
    }
    if (menu.status === 'closed') {
      throw new AppError(409, 'MENU_CLOSED', 'A closed menu cannot be reopened; create a new menu');
    }
    throw new AppError(409, 'CUTOFF_PASSED', 'The cut-off time has passed; edit the draft to set a new one');
  });

  // open -> closed. Closing an already closed menu returns it unchanged.
  router.post('/:id/close', async (req, res) => {
    const filter = menuFilter(req);
    const closed = await MenuModel.findOneAndUpdate(
      { ...filter, status: 'open' },
      { $set: { status: 'closed', closedAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (closed) {
      res.json(toMenuResponse(closed));
      return;
    }

    const menu = await loadOrNotFound(filter);
    if (menu.status === 'closed') {
      res.json(toMenuResponse(menu));
      return;
    }
    throw new AppError(409, 'MENU_NOT_OPEN', 'Only an open menu can be closed');
  });

  return router;
}
