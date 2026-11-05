import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { AuthProvider } from '../auth/provider.js';
import { AppError } from '../errors.js';
import { logEvent } from '../events/log.js';
import type { SellerDoc } from '../models/seller.js';
import { SubscriptionModel, type SubscriptionPlan } from '../models/subscription.js';
import { PaystackError, type PaystackClient } from '../payments/paystack.js';
import { findPlan, type BillingConfig } from './plans.js';

// A subscription's own reference. The prefix is how the webhook tells a vendor's
// subscription ("CLS-") from a customer's order payment ("CLP-") before it looks
// anything up. Unguessable, and never reused: Paystack refuses a repeat.
export const SUBSCRIPTION_REFERENCE_PATTERN = /^CLS-[0-9a-f]{24}$/;

export function newSubscriptionReference(): string {
  return `CLS-${randomBytes(12).toString('hex')}`;
}

// A subscription an admin granted has no Paystack payment, but the field is required
// and unique, so it gets a reference of its own. The different prefix means the webhook
// and the vendor status page never mistake it for a Paystack one.
export function newGrantReference(): string {
  return `ADM-${randomBytes(12).toString('hex')}`;
}

// Used only when the vendor has no email of their own and the login account has
// none either. It belongs to the vendor, not a mailbox: Paystack's receipts for
// it go nowhere.
const PLACEHOLDER_EMAIL_DOMAIN = 'sellers.choplistafrica.com';

export type PayerEmailSource = 'seller' | 'clerk' | 'placeholder';

const emailSchema = z.email();

// Paystack needs an email on every payment. In order of preference: the one the
// vendor gave us, the one on their login account, then a placeholder.
export async function resolvePayerEmail(
  seller: Pick<SellerDoc, '_id' | 'email' | 'clerkUserId'>,
  auth: Pick<AuthProvider, 'getEmail'>,
): Promise<{ email: string; source: PayerEmailSource }> {
  if (seller.email && emailSchema.safeParse(seller.email).success) return { email: seller.email, source: 'seller' };

  // A failed lookup is the same as no email: the payment goes ahead either way.
  let fromLogin: string | null = null;
  try {
    fromLogin = auth.getEmail ? await auth.getEmail(seller.clerkUserId) : null;
  } catch {
    fromLogin = null;
  }
  if (fromLogin && emailSchema.safeParse(fromLogin).success) return { email: fromLogin.toLowerCase(), source: 'clerk' };

  return { email: `${seller._id.toString()}@${PLACEHOLDER_EMAIL_DOMAIN}`, source: 'placeholder' };
}

export type StartedSubscription = {
  authorizationUrl: string;
  reference: string;
  plan: SubscriptionPlan;
  amountNaira: number;
};

export type SubscribeDeps = {
  paystack: PaystackClient | null;
  auth: Pick<AuthProvider, 'getEmail'>;
  config: BillingConfig;
};

// Asks Paystack to set up a payment to ChopList's OWN account (no subaccount, no
// split) and records it as pending. Nothing is activated here: only the signed
// webhook does that, after Paystack confirms the money.
export async function startSubscription(seller: SellerDoc, planId: SubscriptionPlan, deps: SubscribeDeps): Promise<StartedSubscription> {
  const { paystack, auth, config } = deps;
  if (!paystack) throw new AppError(503, 'PAYMENTS_UNAVAILABLE', 'Online payment is not available right now. Try again later.');

  // The price is read now and frozen on the row, so a later price change cannot
  // change what this payment is checked against.
  const plan = findPlan(config, planId);
  const reference = newSubscriptionReference();
  const payer = await resolvePayerEmail(seller, auth);

  let authorizationUrl: string;
  try {
    ({ authorizationUrl } = await paystack.initializeTransaction({
      email: payer.email,
      amountKobo: plan.priceNaira * 100,
      reference,
      callbackUrl: config.callbackUrl,
      // Ids and the plan only: no name, phone or bank detail leaves our system.
      metadata: { type: 'subscription', plan: plan.id, sellerId: seller._id.toString() },
    }));
  } catch (err) {
    const paystackError = err instanceof PaystackError ? err : null;
    await logEvent({
      type: 'subscription_start_failed',
      level: 'error',
      code: paystackError?.kind === 'rejected' ? 'PAYSTACK_REJECTED' : 'PAYSTACK_UNAVAILABLE',
      message: 'Could not start a subscription payment',
      sellerId: seller._id,
      meta: { plan: plan.id, httpStatus: paystackError?.status ?? 0, reason: paystackError?.message ?? 'unexpected error' },
    });
    throw new AppError(503, 'PAYMENTS_UNAVAILABLE', 'Could not start the payment. Please try again.');
  }

  // Saved only after Paystack accepted it, and before the vendor is given the
  // address, so there is no way to be paid for a reference we have not recorded.
  await SubscriptionModel.create({
    sellerId: seller._id,
    plan: plan.id,
    amountNaira: plan.priceNaira,
    status: 'pending',
    paystackReference: reference,
  });

  return { authorizationUrl, reference, plan: plan.id, amountNaira: plan.priceNaira };
}
