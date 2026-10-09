import { Router } from 'express';
import { mongo } from 'mongoose';
import { z } from 'zod';
import { authenticate, currentSellerId, currentUserId, requireSeller, requireUser } from '../auth/middleware.js';
import type { AuthProvider } from '../auth/provider.js';
import { AppError } from '../errors.js';
import { SLUG_PATTERN, SellerModel, type SellerDoc } from '../models/seller.js';
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
  payment: z.object({
    bankName: z.string().trim().min(2).max(60),
    accountNumber: z
      .string({ error: 'Account number must be text, e.g. "0123456789"' })
      .regex(/^\d{10}$/, 'Account number must be exactly 10 digits'),
    accountName: z.string().trim().min(2).max(80),
  }),
});

type ProfileInput = z.infer<typeof profileSchema>;

// How many "-2", "-3", ... variants to try before giving up.
const SLUG_ATTEMPTS = 20;

// What the API returns: no internal ids (clerkUserId) and no __v.
function toSellerResponse(seller: SellerDoc) {
  return {
    id: seller._id.toString(),
    businessName: seller.businessName,
    slug: seller.slug,
    phone: seller.phone,
    payment: {
      bankName: seller.payment.bankName,
      accountNumber: seller.payment.accountNumber,
      accountName: seller.payment.accountName,
    },
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
      return await SellerModel.create({ ...input, slug, clerkUserId });
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
  seller.set({ businessName: input.businessName, phone: input.phone, payment: input.payment });
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

export function createSellerRouter(auth: AuthProvider): Router {
  const router = Router();
  router.use(authenticate(auth));

  // The signed-in seller's profile. 403 PROFILE_REQUIRED tells the frontend
  // to show onboarding.
  router.get('/me', requireSeller, async (req, res) => {
    const seller = await SellerModel.findById(currentSellerId(req));
    if (!seller) throw new AppError(403, 'PROFILE_REQUIRED', 'Create your seller profile first');
    res.json(toSellerResponse(seller));
  });

  // Create (onboarding) or replace the profile. requireUser, not
  // requireSeller: on first call the seller does not exist yet.
  router.put('/me', requireUser, async (req, res) => {
    const input = profileSchema.parse(req.body);
    const clerkUserId = currentUserId(req);

    const existing = await SellerModel.findOne({ clerkUserId });
    if (existing) {
      res.json(toSellerResponse(await updateProfile(existing, input)));
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
      res.json(toSellerResponse(await updateProfile(winner, input)));
      return;
    }
    res.status(201).json(toSellerResponse(created));
  });

  return router;
}
