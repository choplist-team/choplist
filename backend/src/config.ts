import { z } from 'zod';

// An origin is scheme + host + port only, e.g. https://choplist.onrender.com.
// The browser sends it in that exact form, so "https://x.com/" (trailing slash)
// or "https://x.com/app" would never match and CORS would silently block it.
function isOrigin(value: string): boolean {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(5000),

  // How many proxies sit between the internet and this app (see app.ts). The
  // rate limits need it to find the real customer address. 0 = none (local).
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),

  MONGO_URI: z
    .string({ error: 'MONGO_URI is required' })
    .regex(/^mongodb(\+srv)?:\/\/.+/, 'MONGO_URI must start with mongodb:// or mongodb+srv://'),

  ALLOWED_ORIGINS: z
    .string({ error: 'ALLOWED_ORIGINS is required' })
    .transform((raw) =>
      raw
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    )
    .pipe(
      z
        .array(
          z.string().refine(isOrigin, {
            error: (issue) =>
              `"${String(issue.input)}" is not an origin (use scheme://host[:port], no path or trailing slash)`,
          }),
        )
        .min(1, 'ALLOWED_ORIGINS must list at least one origin'),
    ),

  // Clerk user ids allowed to use /api/admin, comma separated. Empty or unset
  // means nobody is an admin (the admin routes then answer 403 to everyone).
  // Find an id in the Clerk dashboard > Users > the user's page.
  ADMIN_CLERK_USER_IDS: z
    .string()
    .optional()
    .transform((raw) =>
      (raw ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id.length > 0),
    )
    .pipe(
      z.array(
        z.string().regex(/^user_[A-Za-z0-9]+$/, {
          error: (issue) => `"${String(issue.input)}" is not a Clerk user id (they look like user_2abc...)`,
        }),
      ),
    ),

  // ---- Pricing (see payments/fees.ts) ----
  // A seller's first FREE_ORDERS paid orders carry no ChopList fee. From the
  // next one the fee is PLATFORM_FEE_BPS basis points of the order (100 bps = 1%,
  // so 300 = 3%). Changing these affects NEW payments only: each order keeps the
  // fee it was quoted.
  FREE_ORDERS: z.coerce.number().int().min(0).max(100_000).default(50),
  // Capped at 20% so a slipped zero (300 typed as 3000) is refused at startup.
  PLATFORM_FEE_BPS: z.coerce.number().int().min(0).max(2000).default(300),

  // ---- Paystack (card/transfer payments with the seller paid directly) ----
  // Optional: without a key the API runs as before with manual bank transfer
  // only, and the pay route answers "payments unavailable". A blank value in
  // .env counts as not set. Error messages never repeat the value.
  PAYSTACK_SECRET_KEY: z
    .string()
    .optional()
    .transform((raw) => (raw && raw.trim() !== '' ? raw.trim() : undefined))
    .pipe(z.string().startsWith('sk_', 'PAYSTACK_SECRET_KEY must start with sk_').optional()),
  // Where Paystack sends the customer after paying: a page on the frontend,
  // e.g. https://choplistafrica.com/pay/done. The order reference is added to it.
  PAYSTACK_CALLBACK_URL: z
    .string()
    .optional()
    .transform((raw) => (raw && raw.trim() !== '' ? raw.trim() : undefined))
    .pipe(z.url({ protocol: /^https?$/, error: 'PAYSTACK_CALLBACK_URL must be an http(s) URL' }).optional()),

  // From the Clerk dashboard (API keys). The publishable key is the same value
  // the frontend uses as VITE_CLERK_PUBLISHABLE_KEY.
  CLERK_SECRET_KEY: z
    .string({ error: 'CLERK_SECRET_KEY is required' })
    .startsWith('sk_', 'CLERK_SECRET_KEY must start with sk_'),
  CLERK_PUBLISHABLE_KEY: z
    .string({ error: 'CLERK_PUBLISHABLE_KEY is required' })
    .startsWith('pk_', 'CLERK_PUBLISHABLE_KEY must start with pk_'),
});

export type Config = z.infer<typeof EnvSchema>;

// Paystack's own charge on a local (Nigerian) payment, kept apart from the env
// settings above because it is Paystack's price, not ours. Amounts are in kobo
// (100 kobo = 1 naira) and rates in basis points.
//
// !! These are NOT read from Paystack. They are our copy of their published
// !! pricing and MUST be re-checked against https://paystack.com/pricing before
// !! going live and whenever Paystack announces a change. If they are wrong the
// !! customer is quoted the wrong service fee, or ChopList absorbs the gap.
export const PAYSTACK_PRICING = {
  // 1.5% of the amount charged.
  rateBps: 150,
  // Plus a flat 100 naira...
  flatFeeKobo: 10_000,
  // ...charged on every order, as specified. Paystack may waive it on small
  // payments (we believe under 2,500 naira, UNVERIFIED): set this to 250_000 only
  // after checking, and the calculator then quotes small orders lower.
  flatFeeWaivedBelowKobo: 0,
  // The fee never exceeds 2,000 naira.
  capKobo: 200_000,
} as const;

export type PaystackPricing = {
  readonly rateBps: number;
  readonly flatFeeKobo: number;
  readonly flatFeeWaivedBelowKobo: number;
  readonly capKobo: number;
};

// Pure: takes the env as an argument and throws on bad input, so tests can call
// it with any object. server.ts calls it once with process.env and exits on error.
export function parseEnv(env: Record<string, string | undefined>): Config {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
