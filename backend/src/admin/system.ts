import type { BillingConfig } from '../billing/plans.js';

// A snapshot of how this server is configured, for an admin to check a deployment without
// opening Render. It reports WHETHER things are set and in which mode, never a value that
// is a secret: not the key, not its tail, not a URL with credentials.
export type SystemInputs = {
  // The Paystack key as configured (or undefined). Only its prefix is ever looked at.
  paystackSecretKey?: string | undefined;
  paystackCallbackUrl?: string | undefined;
  pricing: { freeOrders: number; platformFeeBps: number };
  billing: BillingConfig;
  orderExpiryHours: number;
  allowedOrigins: readonly string[];
  adminCount: number;
};

export type Warning = { code: string; message: string };

export function keyMode(key: string | undefined): 'test' | 'live' | 'unknown' | null {
  if (!key) return null;
  if (key.startsWith('sk_test_')) return 'test';
  if (key.startsWith('sk_live_')) return 'live';
  return 'unknown';
}

export function buildSystemCheck(input: SystemInputs) {
  const mode = keyMode(input.paystackSecretKey);
  const warnings: Warning[] = [];
  const warn = (code: string, message: string) => warnings.push({ code, message });

  if (!input.paystackSecretKey) warn('PAYSTACK_OFF', 'No Paystack key is set: online payments and subscriptions are switched off (bank transfer still works).');
  if (mode === 'live') warn('PAYSTACK_LIVE_KEY', 'A LIVE Paystack key is in use. Real money moves. Make sure the business is verified and the test run is done.');
  if (mode === 'unknown') warn('PAYSTACK_KEY_UNRECOGNISED', 'The Paystack key does not look like a test or live secret key.');
  if (input.paystackSecretKey && !input.paystackCallbackUrl) warn('NO_PAYMENT_RETURN_PAGE', 'PAYSTACK_CALLBACK_URL is not set: customers will not be sent back to ChopList after paying online.');
  if (input.paystackSecretKey && !input.billing.callbackUrl) warn('NO_SUBSCRIPTION_RETURN_PAGE', 'SUBSCRIPTION_CALLBACK_URL is not set: vendors will not be sent back to ChopList after paying a subscription.');
  if (!input.billing.shareUrlBase) warn('NO_SHARE_URL_BASE', 'SHARE_URL_BASE is not set: the share endpoint returns the slug only and the frontend has to build the link.');
  if (input.pricing.platformFeeBps > 0) warn('PLATFORM_FEE_ON', `A per-order platform fee of ${input.pricing.platformFeeBps / 100}% is switched on. ChopList is meant to earn from subscriptions instead.`);
  if (input.orderExpiryHours > 0) warn('ORDER_EXPIRY_ON', `Unpaid orders are cancelled after ${input.orderExpiryHours} hours. Check that is what the team agreed.`);
  if (input.adminCount === 0) warn('NO_ADMINS', 'ADMIN_CLERK_USER_IDS is empty: nobody can use the admin console.');

  return {
    paystack: { configured: Boolean(input.paystackSecretKey), mode },
    returnPages: { payment: Boolean(input.paystackCallbackUrl), subscription: Boolean(input.billing.callbackUrl) },
    shareUrlBaseSet: Boolean(input.billing.shareUrlBase),
    pricing: { platformFeeBps: input.pricing.platformFeeBps, freeOrders: input.pricing.freeOrders },
    billing: { trialDays: input.billing.trialDays, monthlyNaira: input.billing.monthlyNaira, quarterlyNaira: input.billing.quarterlyNaira },
    orderExpiryHours: input.orderExpiryHours,
    allowedOriginCount: input.allowedOrigins.length,
    adminCount: input.adminCount,
    warnings,
  };
}
