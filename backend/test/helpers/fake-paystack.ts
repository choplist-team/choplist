import { vi } from 'vitest';
import type { PaystackClient } from '../../src/payments/paystack.js';

// A Paystack stand-in that records every call. Nothing here touches the network,
// so the tests can never reach the live API or need a key.
export function fakePaystack() {
  let subaccounts = 0;
  return {
    listBanks: vi.fn<PaystackClient['listBanks']>(async () => [
      { name: 'GTBank', code: '058' },
      { name: 'Access Bank', code: '044' },
    ]),
    resolveAccount: vi.fn<PaystackClient['resolveAccount']>(async () => ({ accountName: 'TITILAYO ADEBAYO' })),
    createSubaccount: vi.fn<PaystackClient['createSubaccount']>(async () => ({ subaccountCode: `ACCT_test${(subaccounts += 1)}` })),
    updateSubaccount: vi.fn<PaystackClient['updateSubaccount']>(async () => undefined),
    // Tests that exercise the webhook say what Paystack reports for a reference.
    verifyTransaction: vi.fn<PaystackClient['verifyTransaction']>(async (reference) => ({
      status: 'success',
      reference,
      amountKobo: 0,
      currency: 'NGN',
    })),
    initializeTransaction: vi.fn<PaystackClient['initializeTransaction']>(async (input) => ({
      authorizationUrl: `https://checkout.paystack.com/${input.reference}`,
    })),
  };
}
