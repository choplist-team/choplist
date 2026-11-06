import { SellerModel } from '../models/seller.js';
import { PaystackError, type PaystackClient } from './paystack.js';

// A Paystack payout account ("subaccount") belongs to ONE mode: a code made with a test key
// does not exist under a live key. After switching modes, sellers still carry the old code
// and every payment would be refused. This makes a fresh subaccount, in the mode of the
// current key, for each seller who has a stored code and bank code.
//
// Never automatic: it only runs from scripts/resubaccount.ts, and writes nothing unless
// apply is true. It returns counts only (no ids, accounts or codes).
export type ResubaccountResult = { withCode: number; recreated: number; failed: number; skippedNoBankCode: number };

export async function resubaccountSellers(options: { apply: boolean; paystack: PaystackClient | null }): Promise<ResubaccountResult> {
  const { apply, paystack } = options;
  const result: ResubaccountResult = { withCode: 0, recreated: 0, failed: 0, skippedNoBankCode: 0 };

  const sellers = await SellerModel.find({ paystackSubaccountCode: { $exists: true, $nin: [null, ''] } });
  result.withCode = sellers.length;

  for (const seller of sellers) {
    const { bankCode, accountNumber } = seller.payment;
    if (!bankCode) {
      result.skippedNoBankCode += 1;
      continue;
    }
    if (!apply) continue;
    if (!paystack) throw new Error('A Paystack key is needed to recreate subaccounts.');
    try {
      const { subaccountCode } = await paystack.createSubaccount({ businessName: seller.businessName, bankCode, accountNumber });
      // Only if the bank details are still the ones just set up, as syncSellerPayments does.
      await SellerModel.updateOne(
        { _id: seller._id, 'payment.bankCode': bankCode, 'payment.accountNumber': accountNumber },
        { $set: { paystackSubaccountCode: subaccountCode, paymentsReady: true } },
      );
      result.recreated += 1;
    } catch (err) {
      if (!(err instanceof PaystackError)) throw err;
      result.failed += 1;
    }
  }
  return result;
}
