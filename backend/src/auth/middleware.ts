import type { Request, RequestHandler } from 'express';
import type { Types } from 'mongoose';
import { AppError } from '../errors.js';
import { SellerModel } from '../models/seller.js';
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
  const seller = await SellerModel.findOne({ clerkUserId: req.clerkUserId }, { _id: 1 }).lean();
  if (!seller) {
    throw new AppError(403, 'PROFILE_REQUIRED', 'Create your seller profile first');
  }
  req.sellerId = seller._id;
  next();
};

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
