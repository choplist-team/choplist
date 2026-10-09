import { rateLimit, type RateLimitRequestHandler } from 'express-rate-limit';
import type { ErrorCode } from '../errors.js';

export type RateLimitSettings = {
  windowMs: number;
  // Orders placed per IP per window. Generous on purpose: Nigerian mobile
  // networks often put many customers behind one shared IP.
  ordersPerWindow: number;
  // Order lookups per IP per window. Also slows anyone guessing phoneLast4.
  lookupsPerWindow: number;
};

export const DEFAULT_RATE_LIMITS: RateLimitSettings = {
  windowMs: 10 * 60 * 1000,
  ordersPerWindow: 20,
  lookupsPerWindow: 30,
};

// Counts live in this process's memory: they reset on restart and are not
// shared between instances. Fine for one Render instance; several instances
// would need a shared store (e.g. Redis).
function limiter(limit: number, windowMs: number, message: string): RateLimitRequestHandler {
  const code: ErrorCode = 'RATE_LIMITED';
  return rateLimit({
    windowMs,
    limit,
    // Sends RateLimit-* headers so clients can see how long to wait.
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res, _next, options) => {
      res.status(options.statusCode).json({ error: { code, message } });
    },
  });
}

export function createRateLimiters(settings: RateLimitSettings) {
  return {
    orders: limiter(settings.ordersPerWindow, settings.windowMs, 'Too many orders from this network. Please wait a few minutes.'),
    lookups: limiter(settings.lookupsPerWindow, settings.windowMs, 'Too many lookups. Please wait a few minutes.'),
  };
}
