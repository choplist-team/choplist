import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { AuthProvider } from './auth/provider.js';
import { errorHandler, notFound } from './middleware/error-handler.js';
import { createSellerRouter } from './sellers/router.js';

// The biggest legitimate body is a seller's menu with a few dozen items
// (a few KB). Anything far larger is a mistake or abuse.
const JSON_BODY_LIMIT = '20kb';

export type AppOptions = {
  allowedOrigins: string[];
  // Clerk in production, a fake in tests.
  auth: AuthProvider;
};

// Builds the app without listening on a port or connecting to a database,
// so tests can send requests to it directly with supertest.
export function createApp(options: AppOptions): Express {
  const app = express();

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

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
