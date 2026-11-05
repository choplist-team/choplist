import { Router } from 'express';
import { z } from 'zod';
import { authenticate, currentSellerId, requireSeller } from '../auth/middleware.js';
import type { AuthProvider } from '../auth/provider.js';
import { AppError } from '../errors.js';
import { createRateLimiters, DEFAULT_RATE_LIMITS, type RateLimitSettings } from '../middleware/rate-limit.js';
import { SellerModel } from '../models/seller.js';
import { reconcileSubscription } from '../payments/reconcile.js';
import { SUBSCRIPTION_PLANS, SubscriptionModel, type SubscriptionDoc } from '../models/subscription.js';
import type { PaystackClient } from '../payments/paystack.js';
import { assertCanShare, getBillingState } from './state.js';
import type { BillingConfig } from './plans.js';
import { SUBSCRIPTION_REFERENCE_PATTERN, startSubscription } from './subscribe.js';

const subscribeSchema = z.object({
  plan: z.enum(SUBSCRIPTION_PLANS, { error: `plan must be one of: ${SUBSCRIPTION_PLANS.join(', ')}` }),
});

// What a vendor sees about their own subscription attempts. Their own rows only.
function toSubscriptionResponse(subscription: SubscriptionDoc) {
  return {
    id: subscription._id.toString(),
    plan: subscription.plan,
    amountNaira: subscription.amountNaira,
    status: subscription.status,
    reference: subscription.paystackReference,
    paidAt: subscription.paidAt ?? null,
    startsAt: subscription.startsAt ?? null,
    expiresAt: subscription.expiresAt ?? null,
    renewalOf: subscription.renewalOf ? subscription.renewalOf.toString() : null,
    createdAt: subscription.createdAt,
  };
}

export type BillingRouterOptions = {
  // null = no PAYSTACK_SECRET_KEY: the trial and the state still work, buying does not.
  paystack: PaystackClient | null;
  config: BillingConfig;
  rateLimits?: RateLimitSettings;
};

// Mounted at /api/sellers/me, BEFORE the sellers router, and only handles the
// paths below: anything else falls through to it. Authentication is per route so
// a request that falls through is not authenticated twice.
export function createBillingRouter(auth: AuthProvider, options: BillingRouterOptions): Router {
  const router = Router();
  const { paystack, config } = options;
  const limit = createRateLimiters(options.rateLimits ?? DEFAULT_RATE_LIMITS);
  // Only these paths are signed-in seller routes. Scoped to them (not router-wide)
  // so a request for any other /api/sellers/me path, which falls through to the
  // sellers router, is not authenticated twice.
  router.use(['/billing', '/share'], ...authenticate(auth), requireSeller);

  // Where the vendor stands: the single answer the frontend greys the share area
  // out by (canShareLink), plus the trial dates, plans and prices.
  router.get('/billing', async (req, res) => {
    res.json(await getBillingState(currentSellerId(req), config));
  });

  // The vendor's subscription attempts and renewals, newest first.
  router.get('/billing/subscriptions', async (req, res) => {
    const rows = await SubscriptionModel.find({ sellerId: currentSellerId(req) }).sort({ createdAt: -1 }).limit(100);
    res.json({ subscriptions: rows.map(toSubscriptionResponse) });
  });

  // One attempt, by its reference: for the page the vendor lands on after Paystack,
  // which polls until the status is "active". Read-only; only the Paystack webhook
  // ever activates a subscription. Someone else's reference is the same 404.
  router.get('/billing/subscriptions/:reference', async (req, res) => {
    const reference = String(req.params.reference ?? '');
    const notFound = new AppError(404, 'SUBSCRIPTION_NOT_FOUND', 'No subscription matches that reference');
    if (!SUBSCRIPTION_REFERENCE_PATTERN.test(reference)) throw notFound;
    let subscription = await SubscriptionModel.findOne({ paystackReference: reference, sellerId: currentSellerId(req) });
    if (!subscription) throw notFound;
    // Still waiting and the webhook has not come: ask Paystack ourselves (rate limited
    // per subscription; see payments/reconcile.ts), then read it afresh.
    if (subscription.status !== 'active') {
      await reconcileSubscription(subscription._id, paystack);
      subscription = (await SubscriptionModel.findById(subscription._id)) ?? subscription;
    }
    // Polled every few seconds: a browser or proxy must never answer from a copy.
    res.set('Cache-Control', 'no-store');
    res.json(toSubscriptionResponse(subscription));
  });

  // Starts paying for a plan. Returns where to send the vendor. The subscription
  // becomes active only when Paystack confirms the payment (the webhook), never
  // because the browser came back.
  router.post('/billing/subscribe', limit.payments, async (req, res) => {
    const { plan } = subscribeSchema.parse(req.body);
    const current = await SellerModel.findById(currentSellerId(req));
    if (!current) throw new AppError(403, 'PROFILE_REQUIRED', 'Create your seller profile first');
    res.json(await startSubscription(current, plan, { paystack, auth, config }));
  });

  // The vendor's shop link, for the "share" button. Refused once the trial has
  // ended with no active subscription. See docs/api.md for what this does and does
  // not protect: it controls what the APP hands out, it cannot make a link that was
  // already shared stop working.
  router.get('/share', async (req, res) => {
    const id = currentSellerId(req);
    assertCanShare(await getBillingState(id, config));
    const current = await SellerModel.findById(id, { slug: 1 }).lean();
    if (!current) throw new AppError(403, 'PROFILE_REQUIRED', 'Create your seller profile first');
    res.json({ slug: current.slug, url: config.shareUrlBase ? `${config.shareUrlBase}/${current.slug}` : null });
  });

  return router;
}
