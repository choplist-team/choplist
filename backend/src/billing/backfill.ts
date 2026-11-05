import { SellerModel } from '../models/seller.js';
import { addDaysUTC } from './dates.js';

// Gives every seller that has no free trial yet one that starts at `startAt`, and
// counts which sellers would end up paying Paystack with the placeholder address.
//
// Existing sellers get a trial from the DEPLOY date, not from when they joined, so
// nobody's trial is already over the moment billing goes live. Sellers who already
// have trial dates are never touched, so running it twice, or after sellers have
// started using the app, is safe.
//
// Dry run unless `apply` is true: nothing is written. It returns counts only, never
// an email, phone or id.
export type BillingBackfillResult = {
  sellersTotal: number;
  // Sellers with no trial dates yet (what --apply will give one).
  sellersNeedingTrial: number;
  // Sellers who gave an email of their own on their profile.
  sellersWithOwnEmail: number;
  sellersWithoutOwnEmail: number;
  // Of those without one: how many have no email on their login account either,
  // so a subscription payment would use the placeholder address. null = not
  // checked (it needs a call to the login provider per seller).
  sellersOnPlaceholder: number | null;
  // How many lookups failed or found nothing, out of sellersWithoutOwnEmail.
  trialStartedAt: Date;
  trialEndsAt: Date;
  updated: number;
};

export async function backfillBilling(options: {
  apply: boolean;
  startAt: Date;
  trialDays: number;
  // Looks up the email on a seller's login account. Omit to skip the check.
  lookupEmail?: (clerkUserId: string) => Promise<string | null>;
}): Promise<BillingBackfillResult> {
  const { apply, startAt, trialDays, lookupEmail } = options;
  const trialEndsAt = addDaysUTC(startAt, trialDays);
  const needsTrial = { 'billing.trialStartedAt': { $exists: false } };

  const [sellersTotal, sellersNeedingTrial, sellersWithOwnEmail] = await Promise.all([
    SellerModel.countDocuments({}),
    SellerModel.countDocuments(needsTrial),
    SellerModel.countDocuments({ email: { $exists: true, $nin: [null, ''] } }),
  ]);
  const sellersWithoutOwnEmail = sellersTotal - sellersWithOwnEmail;

  let sellersOnPlaceholder: number | null = null;
  if (lookupEmail) {
    sellersOnPlaceholder = 0;
    const without = SellerModel.find({ $or: [{ email: { $exists: false } }, { email: null }, { email: '' }] }, { clerkUserId: 1 }).lean().cursor();
    for await (const seller of without) {
      if (!(await lookupEmail(seller.clerkUserId))) sellersOnPlaceholder += 1;
    }
  }

  let updated = 0;
  if (apply && sellersNeedingTrial > 0) {
    const result = await SellerModel.updateMany(needsTrial, {
      $set: { billing: { trialStartedAt: startAt, trialEndsAt, verification: { status: 'not_started' } } },
    });
    updated = result.modifiedCount;
  }

  return { sellersTotal, sellersNeedingTrial, sellersWithOwnEmail, sellersWithoutOwnEmail, sellersOnPlaceholder, trialStartedAt: startAt, trialEndsAt, updated };
}
