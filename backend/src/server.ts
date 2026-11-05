import { createApp } from './app.js';
import { createClerkAuth } from './auth/clerk.js';
import { parseEnv, type Config } from './config.js';
import { connectDb, disconnectDb } from './db.js';
import { startMaintenance } from './jobs.js';
import { createPaystackClient } from './payments/paystack.js';

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

// No key = payments off; the API still runs on bank transfer.
const paystack = config.PAYSTACK_SECRET_KEY ? createPaystackClient(config.PAYSTACK_SECRET_KEY) : null;

const app = createApp({
  allowedOrigins: config.ALLOWED_ORIGINS,
  trustProxyHops: config.TRUST_PROXY_HOPS,
  adminClerkUserIds: config.ADMIN_CLERK_USER_IDS,
  paystack,
  orderExpiryHours: config.ORDER_EXPIRY_HOURS,
  pricing: { freeOrders: config.FREE_ORDERS, platformFeeBps: config.PLATFORM_FEE_BPS },
  paystackCallbackUrl: config.PAYSTACK_CALLBACK_URL,
  billing: {
    trialDays: config.TRIAL_DAYS,
    monthlyNaira: config.SUBSCRIPTION_MONTHLY_NAIRA,
    quarterlyNaira: config.SUBSCRIPTION_QUARTERLY_NAIRA,
    callbackUrl: config.SUBSCRIPTION_CALLBACK_URL,
    shareUrlBase: config.SHARE_URL_BASE,
  },
  paystackSecretKey: config.PAYSTACK_SECRET_KEY,
  auth: createClerkAuth({
    secretKey: config.CLERK_SECRET_KEY,
    publishableKey: config.CLERK_PUBLISHABLE_KEY,
    authorizedParties: config.ALLOWED_ORIGINS,
  }),
});

// The upkeep that runs on a timer: cancel orders nobody paid for (ORDER_EXPIRY_HOURS=0 turns
// that off), re-check waiting payments whose Paystack message never came, and remind vendors
// their subscription is ending.
const maintenance = startMaintenance({ orderExpiryHours: config.ORDER_EXPIRY_HOURS, paystack });

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
  maintenance.stop();
  server.close(() => {
    disconnectDb().finally(() => process.exit(0));
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
