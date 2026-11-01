import { Router } from 'express';
import { mongo } from 'mongoose';
import { z } from 'zod';
import { assertSellerNotBlocked, authenticate, currentSellerId, currentUserId, requireSeller, requireUser } from '../auth/middleware.js';
import type { AuthProvider } from '../auth/provider.js';
import { DEFAULT_FREE_ORDERS, DEFAULT_PLATFORM_FEE_BPS } from '../config.js';
import { AppError } from '../errors.js';
import { FEE_MODES, SLUG_PATTERN, SellerModel, sellerFeeMode, sellerPaidOrderCount, sellerPaymentsReady, type SellerDoc } from '../models/seller.js';
import { tierFor } from '../payments/fees.js';
import type { PaystackBank, PaystackClient } from '../payments/paystack.js';
import { paymentsIssueFor, payoutDetailsChanged, syncSellerPayments, type PaymentsIssue } from '../payments/seller-setup.js';
import { nigerianPhone } from '../validation/phone.js';
import { slugCandidates } from './slug.js';

// PUT replaces the whole profile, so every field is required except slug,
// which is generated from businessName when missing. Unknown keys (e.g. a
// smuggled "clerkUserId") are stripped by z.object.
const profileSchema = z.object({
  businessName: z.string().trim().min(2).max(80),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(40)
    .regex(SLUG_PATTERN, 'Use lowercase letters, numbers and single hyphens, e.g. mama-ts-kitchen')
    .optional(),
  phone: nigerianPhone,
  // Optional contact address. Omitted = leave as it is; "" = remove it.
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(120)
    .refine((value) => value === '' || z.email().safeParse(value).success, 'Enter a valid email address')
    .optional(),
  payment: z.object({
    bankName: z.string().trim().min(2).max(60),
    accountNumber: z
      .string({ error: 'Account number must be text, e.g. "0123456789"' })
      .regex(/^\d{10}$/, 'Account number must be exactly 10 digits'),
    accountName: z.string().trim().min(2).max(80),
    // Paystack's code for the bank, from GET /api/sellers/banks. Optional so an
    // older client keeps working (see updateProfile for what omitting it does).
    bankCode: z
      .string({ error: 'bankCode must be text, e.g. "058"' })
      .regex(/^\d{2,6}$/, 'bankCode must be 2 to 6 digits, taken from the bank list')
      .optional(),
  }),
});

const feeModeSchema = z.object({
  feeMode: z.enum(FEE_MODES, { error: `feeMode must be one of: ${FEE_MODES.join(', ')}` }),
});

type ProfileInput = z.infer<typeof profileSchema>;

// How many "-2", "-3", ... variants to try before giving up.
const SLUG_ATTEMPTS = 20;

// What the API returns: no internal ids (clerkUserId) and no __v. The Paystack
// subaccount code is internal too: the frontend only needs paymentsReady.
function toSellerResponse(seller: SellerDoc, paymentsIssue: PaymentsIssue | null) {
  return {
    id: seller._id.toString(),
    businessName: seller.businessName,
    slug: seller.slug,
    phone: seller.phone,
    email: seller.email ?? null,
    status: seller.status,
    payment: {
      bankName: seller.payment.bankName,
      accountNumber: seller.payment.accountNumber,
      accountName: seller.payment.accountName,
      bankCode: seller.payment.bankCode ?? null,
    },
    feeMode: sellerFeeMode(seller),
    paymentsReady: sellerPaymentsReady(seller),
    // Why payments are not ready (null when they are). See PAYMENTS_ISSUES.
    paymentsIssue,
    createdAt: seller.createdAt,
    updatedAt: seller.updatedAt,
  };
}

// Which unique field caused a duplicate-key error, if any.
function duplicateKeyField(err: unknown): string | null {
  if (err instanceof mongo.MongoServerError && err.code === 11000) {
    return Object.keys(err.keyPattern ?? {})[0] ?? 'unknown';
  }
  return null;
}

async function createProfile(clerkUserId: string, input: ProfileInput): Promise<SellerDoc> {
  // A slug the seller chose is tried once; a generated one gets variants.
  const slugs = input.slug ? [input.slug] : slugCandidates(input.businessName, SLUG_ATTEMPTS);

  for (const slug of slugs) {
    try {
      const { email, ...rest } = input;
      return await SellerModel.create({ ...rest, ...(email ? { email } : {}), slug, clerkUserId });
    } catch (err) {
      // The unique index, not a "does it exist?" read, decides who gets a
      // slug, so two sellers signing up at once can't both get it.
      if (duplicateKeyField(err) !== 'slug') throw err;
    }
  }
  if (input.slug) throw new AppError(409, 'SLUG_TAKEN', `The link "${input.slug}" is taken`);
  throw new AppError(409, 'SLUG_TAKEN', 'Could not find a free link for this business name; choose one');
}

async function updateProfile(seller: SellerDoc, input: ProfileInput): Promise<SellerDoc> {
  const before = { bankCode: seller.payment.bankCode, accountNumber: seller.payment.accountNumber };
  // The whole payment object is replaced, so a client that does not know about
  // bankCode would erase it. Omitted means "keep it" only while the bank and
  // account are unchanged; otherwise the old code would point at the wrong bank.
  const sameBank = input.payment.bankName === seller.payment.bankName && input.payment.accountNumber === seller.payment.accountNumber;
  const bankCode = input.payment.bankCode ?? (sameBank ? seller.payment.bankCode : undefined);
  const payment = { ...input.payment, bankCode };
  seller.set({ businessName: input.businessName, phone: input.phone, payment });
  // Money must stop going to the old account the moment the details change, not
  // after Paystack has been told: payments stay off until the new ones are set up.
  if (payoutDetailsChanged(before, payment)) seller.paymentsReady = false;
  if (input.email === '') seller.set('email', undefined);
  else if (input.email) seller.email = input.email;
  // Keep the current slug unless a new one was sent. Changing it breaks the
  // old public link (documented limit).
  if (input.slug) seller.slug = input.slug;
  try {
    return await seller.save();
  } catch (err) {
    if (duplicateKeyField(err) === 'slug') {
      throw new AppError(409, 'SLUG_TAKEN', `The link "${input.slug}" is taken`);
    }
    throw err;
  }
}

export type SellerRouterOptions = {
  // null = no PAYSTACK_SECRET_KEY: payments are off, everything else works.
  paystack: PaystackClient | null;
  pricing: { freeOrders: number; platformFeeBps: number };
};

// The bank list barely changes; fetching it on every onboarding would be slow
// and would spend our Paystack rate limit.
const BANKS_TTL_MS = 6 * 60 * 60 * 1000;

export function createSellerRouter(
  auth: AuthProvider,
  options: SellerRouterOptions = { paystack: null, pricing: { freeOrders: DEFAULT_FREE_ORDERS, platformFeeBps: DEFAULT_PLATFORM_FEE_BPS } },
): Router {
  const router = Router();
  router.use(authenticate(auth));
  const { paystack, pricing } = options;

  // Sets up (or re-checks) the seller's payout account when it needs it, then
  // builds the response from the fresh seller.
  async function finishProfile(seller: SellerDoc) {
    let issue: PaymentsIssue | null = paymentsIssueFor(seller, paystack !== null);
    if (paystack && !sellerPaymentsReady(seller)) {
      issue = (await syncSellerPayments(seller, paystack)).issue;
    }
    const fresh = (await SellerModel.findById(seller._id)) ?? seller;
    return toSellerResponse(fresh, sellerPaymentsReady(fresh) ? null : issue ?? paymentsIssueFor(fresh, paystack !== null));
  }

  let banksCache: { at: number; banks: PaystackBank[] } | null = null;

  // The banks a seller can pick from (name + Paystack code). requireUser, not
  // requireSeller: onboarding needs it before the profile exists.
  router.get('/banks', requireUser, async (_req, res) => {
    if (!paystack) throw new AppError(503, 'PAYMENTS_UNAVAILABLE', 'Bank list is not available right now');
    if (!banksCache || Date.now() - banksCache.at > BANKS_TTL_MS) {
      try {
        banksCache = { at: Date.now(), banks: await paystack.listBanks() };
      } catch {
        // Better a stale list than none.
        if (!banksCache) throw new AppError(503, 'PAYMENTS_UNAVAILABLE', 'Bank list is not available right now');
      }
    }
    res.json({ banks: banksCache.banks });
  });

  // The signed-in seller's profile. 403 PROFILE_REQUIRED tells the frontend
  // to show onboarding.
  router.get('/me', requireSeller, async (req, res) => {
    const seller = await SellerModel.findById(currentSellerId(req));
    if (!seller) throw new AppError(403, 'PROFILE_REQUIRED', 'Create your seller profile first');
    res.json(toSellerResponse(seller, paymentsIssueFor(seller, paystack !== null)));
  });

  // Where the seller stands on online payments and pricing. Never contains the
  // Paystack subaccount code, another seller's data or any key.
  function paymentsStatus(seller: SellerDoc) {
    const paid = sellerPaidOrderCount(seller);
    return {
      paymentsReady: sellerPaymentsReady(seller),
      paymentsIssue: paymentsIssueFor(seller, paystack !== null),
      feeMode: sellerFeeMode(seller),
      paidOrderCount: paid,
      freeOrders: pricing.freeOrders,
      freeOrdersRemaining: Math.max(0, pricing.freeOrders - paid),
      // What the NEXT payment would be charged under.
      tier: tierFor(paid, pricing.freeOrders),
      platformFeeBps: pricing.platformFeeBps,
    };
  }

  router.get('/me/payments', requireSeller, async (req, res) => {
    const seller = await SellerModel.findById(currentSellerId(req));
    if (!seller) throw new AppError(403, 'PROFILE_REQUIRED', 'Create your seller profile first');
    res.json(paymentsStatus(seller));
  });

  // Who pays the fees from now on. Orders already quoted keep the fee they were
  // quoted; this only changes the next payment.
  router.put('/me/fee-mode', requireSeller, async (req, res) => {
    const { feeMode } = feeModeSchema.parse(req.body);
    const seller = await SellerModel.findOneAndUpdate({ _id: currentSellerId(req) }, { $set: { feeMode } }, { returnDocument: 'after' });
    if (!seller) throw new AppError(403, 'PROFILE_REQUIRED', 'Create your seller profile first');
    res.json(paymentsStatus(seller));
  });

  // Try the Paystack setup again without re-saving the profile (for example
  // after Paystack was down).
  router.post('/me/payments/retry', requireSeller, async (req, res) => {
    const seller = await SellerModel.findById(currentSellerId(req));
    if (!seller) throw new AppError(403, 'PROFILE_REQUIRED', 'Create your seller profile first');
    const result = await syncSellerPayments(seller, paystack);
    const fresh = (await SellerModel.findById(seller._id)) ?? seller;
    res.json({ ...paymentsStatus(fresh), paymentsIssue: sellerPaymentsReady(fresh) ? null : result.issue });
  });

  // Create (onboarding) or replace the profile. requireUser, not
  // requireSeller: on first call the seller does not exist yet.
  router.put('/me', requireUser, async (req, res) => {
    const input = profileSchema.parse(req.body);
    const clerkUserId = currentUserId(req);

    const existing = await SellerModel.findOne({ clerkUserId });
    if (existing) {
      // This route uses requireUser (the profile may not exist yet), so the
      // suspension check that requireSeller does must be repeated here.
      assertSellerNotBlocked(existing);
      res.json(await finishProfile(await updateProfile(existing, input)));
      return;
    }

    let created: SellerDoc;
    try {
      // Await before touching res: setting 201 first would leak into the
      // fallback response below if the create fails.
      created = await createProfile(clerkUserId, input);
    } catch (err) {
      // Two first-time PUTs from the same user at once: the other one created
      // the profile between our findOne and create. Update that one instead.
      if (duplicateKeyField(err) !== 'clerkUserId') throw err;
      const winner = await SellerModel.findOne({ clerkUserId });
      if (!winner) throw err;
      assertSellerNotBlocked(winner);
      res.json(await finishProfile(await updateProfile(winner, input)));
      return;
    }
    res.status(201).json(await finishProfile(created));
  });

  return router;
}
