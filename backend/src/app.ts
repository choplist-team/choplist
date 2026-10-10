import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { AuthProvider } from './auth/provider.js';
import { errorHandler, notFound } from './middleware/error-handler.js';
import { DEFAULT_RATE_LIMITS, type RateLimitSettings } from './middleware/rate-limit.js';
import { createMenuRouter } from './menus/router.js';
import { createOrderRouter } from './orders/router.js';
import { createPublicRouter } from './public/router.js';
import { createSellerRouter } from './sellers/router.js';

// The biggest legitimate body is a seller's menu with a few dozen items
// (a few KB). Anything far larger is a mistake or abuse.
const JSON_BODY_LIMIT = '20kb';

export type AppOptions = {
  allowedOrigins: string[];
  // Clerk in production, a fake in tests.
  auth: AuthProvider;
  // Tests use small limits to exercise them, large ones to stay out of the way.
  rateLimits?: RateLimitSettings;
  // Proxies in front of the app. Default 1; Render has more (see README).
  trustProxyHops?: number;
};

// Builds the app without listening on a port or connecting to a database,
// so tests can send requests to it directly with supertest.
export function createApp(options: AppOptions): Express {
  const app = express();

  // The rate limits count requests per client address, which behind a proxy
  // comes from X-Forwarded-For. Each proxy appends the address it received the
  // request from, so the real client is the entry just before the proxies we
  // own. This number is how many proxies to skip:
  //   too low  -> req.ip is a proxy address shared by many customers
  //   too high -> req.ip is read from a header the client wrote, so it can
  //               fake its address and dodge the limits
  // The right value depends on the host, so it is a setting (TRUST_PROXY_HOPS).
  app.set('trust proxy', options.trustProxyHops ?? 1);

  // Security headers (nosniff, frame protection, etc.) and no X-Powered-By.
  app.use(helmet());

  // Only our frontend origins may read responses in a browser. Auth uses a
  // bearer header, not cookies, so credentials mode is not needed.
  app.use(cors({ origin: options.allowedOrigins }));

  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  // For UptimeRobot. Deliberately touches nothing else (no database), so it
  // stays fast and keeps answering even if MongoDB is down.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use('/api/sellers', createSellerRouter(options.auth));
  app.use('/api/menus', createMenuRouter(options.auth));
  app.use('/api/orders', createOrderRouter(options.auth));
  app.use('/api/public', createPublicRouter(options.rateLimits ?? DEFAULT_RATE_LIMITS));

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
