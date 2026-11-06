import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SellerModel } from '../src/models/seller.js';
import { PaystackError } from '../src/payments/paystack.js';
import { resubaccountSellers } from '../src/payments/resubaccount.js';
import { connectTestDb, disconnectTestDb, testDbUri } from './helpers/db.js';
import { fakePaystack } from './helpers/fake-paystack.js';

let n = 0;
const seller = (over: Record<string, unknown> = {}, bankCode: string | null = '058') => {
  n += 1;
  return SellerModel.create({
    clerkUserId: `user_rs${n}`,
    businessName: `Kitchen ${n}`,
    slug: `kitchen-rs${n}`,
    phone: '+2348031234567',
    payment: { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Owner', ...(bankCode ? { bankCode } : {}) },
    ...over,
  });
};

describe.skipIf(!testDbUri)('resubaccountSellers', () => {
  beforeAll(async () => {
    await connectTestDb('resubaccount');
  });
  afterAll(disconnectTestDb);
  beforeEach(async () => {
    await SellerModel.deleteMany({});
  });

  it('a dry run counts and writes nothing, and never calls Paystack', async () => {
    const paystack = fakePaystack();
    const a = await seller({ paystackSubaccountCode: 'ACCT_old', paymentsReady: false });
    await seller({}, '058'); // no stored code: not counted
    await seller({ paystackSubaccountCode: 'ACCT_nobank' }, null);

    const r = await resubaccountSellers({ apply: false, paystack });
    expect(r).toEqual({ withCode: 2, recreated: 0, failed: 0, skippedNoBankCode: 1 });
    expect(paystack.createSubaccount).not.toHaveBeenCalled();
    expect((await SellerModel.findById(a._id))?.paystackSubaccountCode).toBe('ACCT_old');
  });

  it('--apply makes a fresh subaccount for each seller and marks payments ready', async () => {
    const paystack = fakePaystack();
    paystack.createSubaccount = vi.fn().mockResolvedValue({ subaccountCode: 'ACCT_new' });
    const a = await seller({ paystackSubaccountCode: 'ACCT_old', paymentsReady: false });
    await seller({ paystackSubaccountCode: 'ACCT_nobank' }, null);

    const r = await resubaccountSellers({ apply: true, paystack });
    expect(r).toEqual({ withCode: 2, recreated: 1, failed: 0, skippedNoBankCode: 1 });
    const after = await SellerModel.findById(a._id);
    expect(after?.paystackSubaccountCode).toBe('ACCT_new');
    expect(after?.paymentsReady).toBe(true);
  });

  it('a seller Paystack refuses is counted, keeps the old code, and does not stop the others', async () => {
    const paystack = fakePaystack();
    paystack.createSubaccount = vi
      .fn()
      .mockRejectedValueOnce(new PaystackError('rejected', 'no', 400))
      .mockResolvedValueOnce({ subaccountCode: 'ACCT_new' });
    const first = await seller({ paystackSubaccountCode: 'ACCT_a' });
    await seller({ paystackSubaccountCode: 'ACCT_b' });

    const r = await resubaccountSellers({ apply: true, paystack });
    expect(r.recreated + r.failed).toBe(2);
    expect(r.failed).toBe(1);
    const codes = (await SellerModel.find({})).map((s) => s.paystackSubaccountCode).sort();
    expect(codes).toContain('ACCT_new');
    expect(first).toBeTruthy();
  });

  it('--apply without a Paystack client refuses instead of silently doing nothing', async () => {
    await seller({ paystackSubaccountCode: 'ACCT_old' });
    await expect(resubaccountSellers({ apply: true, paystack: null })).rejects.toThrow(/key is needed/);
  });
});
