import type { Request, RequestHandler } from 'express';
import type { Types } from 'mongoose';
import { AppError } from '../errors.js';
import { SellerModel, isSellerActive } from '../models/seller.js';
import type { AuthProvider } from './provider.js';

// Adds our two fields to Express's Request type.
declare global {
  namespace Express {
    interface Request {
      // Set by authenticate(): the login id, or null if not signed in.
      clerkUserId?: string | null;
      // Set by requireSeller(): the seller's own _id. Every seller query
      // filters on this, so a seller can only ever reach their own data.
      sellerId?: Types.ObjectId;
    }
  }
}

// Runs the provider (e.g. Clerk) and records who is calling. Never rejects.
export function authenticate(auth: AuthProvider): RequestHandler[] {
  return [
    auth.middleware,
    (req, _res, next) => {
      req.clerkUserId = auth.getUserId(req);
      next();
    },
  ];
}

// 401 unless the request carries a valid token.
export const requireUser: RequestHandler = (req, _res, next) => {
  if (!req.clerkUserId) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue');
  }
  next();
};

// 401 unless signed in, 403 unless that user has a seller profile. The seller
// is looked up by the token's user id, never by anything in the request body
// or URL, so a user cannot claim to be another seller.
export const requireSeller: RequestHandler = async (req, _res, next) => {
  if (!req.clerkUserId) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue');
  }
  const seller = await SellerModel.findOne(
    { clerkUserId: req.clerkUserId },
    { _id: 1, status: 1, lastActiveAt: 1 },
  ).lean();
  if (!seller) {
    throw new AppError(403, 'PROFILE_REQUIRED', 'Create your seller profile first');
  }
  // One place blocks suspended and deactivated sellers from every seller route.
  assertSellerNotBlocked(seller);
  await touchLastActive(seller);
  req.sellerId = seller._id;
  next();
};

export function assertSellerNotBlocked(seller: { status?: string | null }): void {
  if (!isSellerActive(seller)) {
    throw new AppError(
      403,
      'ACCOUNT_SUSPENDED',
      'Your account is not active. Contact ChopList support to have it restored.',
    );
  }
}

// "Last active" is only a rough signal for the admin dashboard, so it is
// written at most once per interval instead of on every request. The seller was
// already read above, so the common case costs no extra database call. Two
// requests racing past the check just write the same minute twice, which is
// harmless. A failed write must never break the seller's actual request.
export const LAST_ACTIVE_INTERVAL_MS = 10 * 60 * 1000;

async function touchLastActive(seller: { _id: Types.ObjectId; lastActiveAt?: Date | null }): Promise<void> {
  const now = Date.now();
  if (seller.lastActiveAt && now - seller.lastActiveAt.getTime() < LAST_ACTIVE_INTERVAL_MS) return;
  try {
    await SellerModel.updateOne({ _id: seller._id }, { $set: { lastActiveAt: new Date(now) } });
  } catch (err) {
    console.error('Could not record lastActiveAt', err instanceof Error ? err.name : err);
  }
}

// Accessors for route handlers. They throw (a 500) if a route forgot its
// middleware, instead of silently querying with undefined.
export function currentUserId(req: Request): string {
  if (!req.clerkUserId) throw new Error('currentUserId used without requireUser');
  return req.clerkUserId;
}

export function currentSellerId(req: Request): Types.ObjectId {
  if (!req.sellerId) throw new Error('currentSellerId used without requireSeller');
  return req.sellerId;
}
