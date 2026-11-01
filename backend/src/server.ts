import { createApp } from './app.js';
import { createClerkAuth } from './auth/clerk.js';
import { parseEnv, type Config } from './config.js';
import { connectDb, disconnectDb } from './db.js';

let config: Config;
try {
  config = parseEnv(process.env);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

// Connect (and build indexes) before listening, so the first request never
// meets a missing database or a missing unique index.
try {
  await connectDb(config.MONGO_URI);
} catch (err) {
  console.error('Could not connect to MongoDB:', err instanceof Error ? err.message : err);
  process.exit(1);
}

const app = createApp({
  allowedOrigins: config.ALLOWED_ORIGINS,
  trustProxyHops: config.TRUST_PROXY_HOPS,
  adminClerkUserIds: config.ADMIN_CLERK_USER_IDS,
  auth: createClerkAuth({
    secretKey: config.CLERK_SECRET_KEY,
    publishableKey: config.CLERK_PUBLISHABLE_KEY,
    authorizedParties: config.ALLOWED_ORIGINS,
  }),
});

const server = app.listen(config.PORT, () => {
  // The count only (no values): in the Render log it shows at a glance whether
  // a changed ALLOWED_ORIGINS was picked up by the redeploy.
  console.log(`ChopList API listening on port ${config.PORT} (${config.ALLOWED_ORIGINS.length} allowed origins)`);
});

// e.g. the port is already in use.
server.on('error', (err) => {
  console.error('Server failed to start:', err.message);
  process.exit(1);
});

// Render sends SIGTERM before stopping the instance; Ctrl+C sends SIGINT.
// Stop accepting new connections, let in-flight requests finish, then close
// the database connection.
function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    disconnectDb().finally(() => process.exit(0));
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
