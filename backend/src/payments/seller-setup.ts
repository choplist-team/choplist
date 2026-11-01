import { logEvent } from '../events/log.js';
import { SellerModel, sellerPaymentsReady, type SellerDoc } from '../models/seller.js';
import { PaystackError, type PaystackClient } from './paystack.js';

// Why a seller cannot take Paystack payments right now. The frontend shows a
// message for each; null means they can.
export const PAYMENTS_ISSUES = [
  'NOT_CONFIGURED', // the server has no Paystack key (payments are off for everyone)
  'NO_BANK_CODE', // the seller has not picked their bank from the list yet
  'ACCOUNT_NOT_FOUND', // Paystack could not find that account at that bank
  'SETUP_REJECTED', // Paystack refused to create the payout account
  'PAYSTACK_UNAVAILABLE', // Paystack (or our key) failed; saving the profile again retries
  'NOT_SET_UP', // not set up yet and nothing has failed (e.g. an old profile)
] as const;
export type PaymentsIssue = (typeof PAYMENTS_ISSUES)[number];

export type PaymentsSetupResult = { ready: boolean; issue: PaymentsIssue | null };

// What can be said about a seller without calling Paystack.
export function paymentsIssueFor(seller: SellerDoc, configured: boolean): PaymentsIssue | null {
  if (sellerPaymentsReady(seller)) return null;
  if (!configured) return 'NOT_CONFIGURED';
  if (!seller.payment.bankCode) return 'NO_BANK_CODE';
  return 'NOT_SET_UP';
}

// True when the details Paystack pays out to differ between two versions of a
// seller. Until the new details are set up at Paystack, the old payout account
// must not keep receiving money.
export function payoutDetailsChanged(
  before: { bankCode?: string | null; accountNumber: string },
  after: { bankCode?: string | null; accountNumber: string },
): boolean {
  return (before.bankCode ?? '') !== (after.bankCode ?? '') || before.accountNumber !== after.accountNumber;
}

// Makes the seller's Paystack payout account (a "subaccount") match their bank
// details, and records whether payments are ready. It never throws: a Paystack
// problem must not stop a profile from saving, so the failure is written to the
// event log and returned as an issue instead.
//
// The final write only succeeds if the seller's bank details are still the ones
// we just set up. If they saved a different account while this ran, we leave
// paymentsReady alone and the other save's own setup decides.
export async function syncSellerPayments(seller: SellerDoc, client: PaystackClient | null): Promise<PaymentsSetupResult> {
  if (!client) return { ready: sellerPaymentsReady(seller), issue: sellerPaymentsReady(seller) ? null : 'NOT_CONFIGURED' };

  const sellerId = seller._id;
  const bankCode = seller.payment.bankCode;
  const accountNumber = seller.payment.accountNumber;
  const unchanged = { _id: sellerId, 'payment.bankCode': bankCode, 'payment.accountNumber': accountNumber };

  if (!bankCode) {
    await SellerModel.updateOne({ _id: sellerId }, { $set: { paymentsReady: false } });
    return { ready: false, issue: 'NO_BANK_CODE' };
  }

  let stage: 'resolve' | 'subaccount' = 'resolve';
  try {
    await client.resolveAccount({ bankCode, accountNumber });
    stage = 'subaccount';
    const input = { businessName: seller.businessName, bankCode, accountNumber };
    let subaccountCode = seller.paystackSubaccountCode;
    if (subaccountCode) {
      await client.updateSubaccount(subaccountCode, input);
    } else {
      subaccountCode = (await client.createSubaccount(input)).subaccountCode;
    }
    await SellerModel.updateOne(unchanged, { $set: { paystackSubaccountCode: subaccountCode, paymentsReady: true } });
    return { ready: true, issue: null };
  } catch (err) {
    const paystackError = err instanceof PaystackError ? err : null;
    const issue: PaymentsIssue =
      paystackError?.kind === 'rejected' ? (stage === 'resolve' ? 'ACCOUNT_NOT_FOUND' : 'SETUP_REJECTED') : 'PAYSTACK_UNAVAILABLE';

    // paymentsReady is deliberately NOT touched here. When the bank details
    // change, the profile save has already switched it off before Paystack was
    // called; and a seller whose setup already works must not lose payments
    // because Paystack had a bad minute during a retry.
    await logEvent({
      type: 'payment_setup_failed',
      level: issue === 'PAYSTACK_UNAVAILABLE' ? 'error' : 'warn',
      code: issue,
      message: `Could not set up Paystack payments (${stage})`,
      sellerId,
      meta: { stage, httpStatus: paystackError?.status ?? 0, reason: paystackError?.message ?? 'unexpected error' },
    });
    return { ready: false, issue };
  }
}
