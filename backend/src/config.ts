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

// Also the fallback the app uses when it is built without a config (tests).
//
// ChopList now earns from vendor subscriptions, not from a cut of each order, so
// the per-order platform fee is OFF (0 basis points). The tier code in
// payments/fees.ts is kept but unused: setting PLATFORM_FEE_BPS above 0 turns it
// back on. This does not touch the Paystack processing fee the customer or the
// seller pays (feeMode / serviceFee): only ChopList's own cut goes to zero.
export const DEFAULT_FREE_ORDERS = 50;
export const DEFAULT_PLATFORM_FEE_BPS = 0;

// ---- Vendor billing (see billing/) ----
// Every new vendor gets this many days free, counted from the moment the seller
// profile is created.
export const DEFAULT_TRIAL_DAYS = 7;
// Whole naira per plan.
export const DEFAULT_MONTHLY_NAIRA = 3000;
// How long an order can sit unpaid before it is cancelled and its portions go back on
// sale (orders/expire.ts). 0 turns the expiry off.
export const DEFAULT_ORDER_EXPIRY_HOURS = 48;

// 11,000, as the project description says. Note this is MORE than three months at
// the monthly price (3 x 3,000 = 9,000), so the quarterly plan costs extra rather
// than saving money; that is the agreed price, not a typo.
export const DEFAULT_QUARTERLY_NAIRA = 11_000;

// A whole-number setting where a blank value (as left by .env.example) means "use the
// default". Without this a blank would be read as 0 and refused at startup.
function wholeNumberSetting(fallback: number, min: number, max: number) {
  return z.preprocess(
    (raw) => (typeof raw === 'string' && raw.trim() === '' ? undefined : raw),
    z.coerce.number().int().min(min).max(max).default(fallback),
  );
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
  FREE_ORDERS: z.coerce.number().int().min(0).max(100_000).default(DEFAULT_FREE_ORDERS),
  // Capped at 20% so a slipped zero (300 typed as 3000) is refused at startup.
  PLATFORM_FEE_BPS: z.coerce.number().int().min(0).max(2000).default(DEFAULT_PLATFORM_FEE_BPS),

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

  // Unpaid orders hold stock until someone cancels them. After this many hours an order
  // that was never paid (and nobody is mid-payment on) is cancelled and its portions go
  // back on sale. 0 = never. Orders where the customer said they paid by transfer are
  // never expired: the seller still has to look at those.
  ORDER_EXPIRY_HOURS: wholeNumberSetting(DEFAULT_ORDER_EXPIRY_HOURS, 0, 720),

  // ---- Vendor billing: free trial and subscriptions (see billing/) ----
  TRIAL_DAYS: wholeNumberSetting(DEFAULT_TRIAL_DAYS, 1, 90),
  // Capped well above any sensible price so a slipped zero is refused at startup.
  SUBSCRIPTION_MONTHLY_NAIRA: wholeNumberSetting(DEFAULT_MONTHLY_NAIRA, 100, 1_000_000),
  SUBSCRIPTION_QUARTERLY_NAIRA: wholeNumberSetting(DEFAULT_QUARTERLY_NAIRA, 100, 3_000_000),
  // The frontend page Paystack sends a vendor back to after paying a subscription,
  // e.g. https://choplistafrica.com/seller/subscription/done. Separate from the
  // customer's PAYSTACK_CALLBACK_URL because it is a different page.
  SUBSCRIPTION_CALLBACK_URL: z
    .string()
    .optional()
    .transform((raw) => (raw && raw.trim() !== '' ? raw.trim() : undefined))
    .pipe(z.url({ protocol: /^https?$/, error: 'SUBSCRIPTION_CALLBACK_URL must be an http(s) URL' }).optional()),
  // The start of a shop link, without the slug, e.g. https://choplistafrica.com/shop
  // . GET /api/sellers/me/share returns base + "/" + slug. Unset = it returns the
  // slug only and the frontend builds the link itself.
  SHARE_URL_BASE: z
    .string()
    .optional()
    .transform((raw) => (raw && raw.trim() !== '' ? raw.trim().replace(/\/+$/, '') : undefined))
    .pipe(z.url({ protocol: /^https?$/, error: 'SHARE_URL_BASE must be an http(s) URL' }).optional()),

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
