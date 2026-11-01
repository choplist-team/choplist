import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { EventLogModel } from '../src/models/event-log.js';
import { SellerModel } from '../src/models/seller.js';
import { PaystackError, type PaystackClient } from '../src/payments/paystack.js';
import { connectTestDb, disconnectTestDb, testDbUri } from './helpers/db.js';
import { bearer, fakeAuth } from './helpers/fake-auth.js';
import { fakePaystack } from './helpers/fake-paystack.js';

const unavailable = () => new PaystackError('unavailable', 'Could not reach Paystack');
const rejected = (message: string) => new PaystackError('rejected', message, 422);

let paystack = fakePaystack();
let app = createApp({ allowedOrigins: ['http://localhost:5173'], auth: fakeAuth, paystack, pricing: { freeOrders: 50, platformFeeBps: 300 } });

function rebuild(client: PaystackClient | null = paystack) {
  app = createApp({ allowedOrigins: ['http://localhost:5173'], auth: fakeAuth, paystack: client, pricing: { freeOrders: 50, platformFeeBps: 300 } });
}

function profile(overrides: Record<string, unknown> = {}, payment: Record<string, unknown> = {}) {
  return {
    businessName: "Mama T's Kitchen",
    phone: '0803 123 4567',
    payment: { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Titilayo Adebayo', bankCode: '058', ...payment },
    ...overrides,
  };
}

const put = (userId: string, body: unknown) => request(app).put('/api/sellers/me').set('Authorization', bearer(userId)).send(body as object);
const get = (userId: string, path: string) => request(app).get(path).set('Authorization', bearer(userId));

async function stored(userId: string) {
  const seller = await SellerModel.findOne({ clerkUserId: userId }).lean();
  if (!seller) throw new Error(`no seller for ${userId}`);
  return seller;
}

describe.skipIf(!testDbUri)('seller payments setup on a real MongoDB', () => {
  beforeAll(async () => {
    await connectTestDb('seller_payments');
  });
  afterAll(async () => {
    await disconnectTestDb();
  });
  beforeEach(async () => {
    paystack = fakePaystack();
    rebuild();
    await SellerModel.deleteMany({});
    await EventLogModel.deleteMany({});
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('profile save sets up the Paystack payout account', () => {
    it('a new profile with a bank code is resolved, gets a subaccount and is payments-ready', async () => {
      const res = await put('u1', profile());
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ paymentsReady: true, paymentsIssue: null, feeMode: 'customer', payment: { bankCode: '058' } });

      expect(paystack.resolveAccount).toHaveBeenCalledExactlyOnceWith({ bankCode: '058', accountNumber: '0123456789' });
      expect(paystack.createSubaccount).toHaveBeenCalledExactlyOnceWith({ businessName: "Mama T's Kitchen", bankCode: '058', accountNumber: '0123456789' });
      expect(paystack.updateSubaccount).not.toHaveBeenCalled();

      const row = await stored('u1');
      expect(row.paystackSubaccountCode).toBe('ACCT_test1');
      expect(row.paymentsReady).toBe(true);
    });

    it('never puts the subaccount code in a response', async () => {
      const created = await put('u1', profile());
      const me = await get('u1', '/api/sellers/me');
      const status = await get('u1', '/api/sellers/me/payments');
      for (const res of [created, me, status]) {
        expect(JSON.stringify(res.body)).not.toContain('ACCT_');
        expect(res.body).not.toHaveProperty('paystackSubaccountCode');
      }
    });

    it('without a bank code the profile saves, payments stay off, and Paystack is not called', async () => {
      const res = await put('u1', profile({}, { bankCode: undefined }));
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ paymentsReady: false, paymentsIssue: 'NO_BANK_CODE', payment: { bankCode: null } });
      expect(paystack.resolveAccount).not.toHaveBeenCalled();
      expect(paystack.createSubaccount).not.toHaveBeenCalled();
    });

    it('rejects a malformed bank code as a validation error', async () => {
      for (const bad of ['GTB', '5', '1234567', '05 8', 58, '058; drop']) {
        const res = await put('u1', profile({}, { bankCode: bad }));
        expect(res.status, String(bad)).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
      expect(await SellerModel.countDocuments()).toBe(0);
    });

    it('Paystack down: the profile still saves (201), payments are off, and the failure is logged', async () => {
      paystack.resolveAccount.mockRejectedValueOnce(unavailable());
      const res = await put('u1', profile());
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ businessName: "Mama T's Kitchen", paymentsReady: false, paymentsIssue: 'PAYSTACK_UNAVAILABLE' });

      const row = await stored('u1');
      expect(row.paymentsReady).toBe(false);
      expect(row.paystackSubaccountCode).toBeUndefined();

      const events = await EventLogModel.find({ type: 'payment_setup_failed' }).lean();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ level: 'error', code: 'PAYSTACK_UNAVAILABLE', sellerId: row._id });
      expect(events[0]!.meta).toMatchObject({ stage: 'resolve' });
    });

    it('an unknown account is ACCOUNT_NOT_FOUND (a warning), and no subaccount is created', async () => {
      paystack.resolveAccount.mockRejectedValueOnce(rejected('Could not resolve account name'));
      const res = await put('u1', profile());
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ paymentsReady: false, paymentsIssue: 'ACCOUNT_NOT_FOUND' });
      expect(paystack.createSubaccount).not.toHaveBeenCalled();
      const events = await EventLogModel.find({ type: 'payment_setup_failed' }).lean();
      expect(events[0]).toMatchObject({ level: 'warn', code: 'ACCOUNT_NOT_FOUND' });
    });

    it('Paystack refusing to create the subaccount is SETUP_REJECTED', async () => {
      paystack.createSubaccount.mockRejectedValueOnce(rejected('Settlement bank is invalid'));
      const res = await put('u1', profile());
      expect(res.body).toMatchObject({ paymentsReady: false, paymentsIssue: 'SETUP_REJECTED' });
      expect((await EventLogModel.findOne({ type: 'payment_setup_failed' }).lean())!.meta).toMatchObject({ stage: 'subaccount' });
    });

    it('an unexpected crash inside the setup is treated as unavailable and still saves the profile', async () => {
      paystack.resolveAccount.mockRejectedValueOnce(new TypeError('boom'));
      const res = await put('u1', profile());
      expect(res.status).toBe(201);
      expect(res.body.paymentsIssue).toBe('PAYSTACK_UNAVAILABLE');
    });

    it('the event log never holds the account number, bank details or a key', async () => {
      paystack.resolveAccount.mockRejectedValueOnce(unavailable());
      await put('u1', profile());
      const text = JSON.stringify(await EventLogModel.find().lean());
      expect(text).not.toContain('0123456789');
      expect(text).not.toContain('Titilayo');
      expect(text).not.toContain('sk_');
    });

    it('with no Paystack key configured everything else works and the issue says so', async () => {
      rebuild(null);
      const res = await put('u1', profile());
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ paymentsReady: false, paymentsIssue: 'NOT_CONFIGURED' });
      expect((await get('u1', '/api/sellers/me')).body.paymentsIssue).toBe('NOT_CONFIGURED');
    });
  });

  describe('re-saving the profile', () => {
    beforeEach(async () => {
      await put('u1', profile());
      vi.clearAllMocks();
    });

    it('does not call Paystack again when nothing about the payout account changed', async () => {
      const res = await put('u1', profile({ businessName: 'Mama T Foods', phone: '0803 999 9999' }));
      expect(res.status).toBe(200);
      expect(res.body.paymentsReady).toBe(true);
      expect(paystack.resolveAccount).not.toHaveBeenCalled();
      expect(paystack.createSubaccount).not.toHaveBeenCalled();
      expect(paystack.updateSubaccount).not.toHaveBeenCalled();
    });

    it('a new account number updates the SAME subaccount instead of creating another', async () => {
      const res = await put('u1', profile({}, { accountNumber: '0999999999' }));
      expect(res.body).toMatchObject({ paymentsReady: true, paymentsIssue: null });
      expect(paystack.createSubaccount).not.toHaveBeenCalled();
      expect(paystack.updateSubaccount).toHaveBeenCalledExactlyOnceWith('ACCT_test1', {
        businessName: "Mama T's Kitchen",
        bankCode: '058',
        accountNumber: '0999999999',
      });
      expect((await stored('u1')).paystackSubaccountCode).toBe('ACCT_test1');
    });

    it('if Paystack fails after the account changed, payments are OFF so money cannot go to the old account', async () => {
      paystack.updateSubaccount.mockRejectedValueOnce(unavailable());
      const res = await put('u1', profile({}, { accountNumber: '0999999999' }));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ paymentsReady: false, paymentsIssue: 'PAYSTACK_UNAVAILABLE' });
      expect((await stored('u1')).paymentsReady).toBe(false);
    });

    it('the same holds when Paystack is unreachable at the very first call', async () => {
      paystack.resolveAccount.mockRejectedValueOnce(unavailable());
      await put('u1', profile({}, { bankCode: '044', bankName: 'Access Bank' }));
      expect((await stored('u1')).paymentsReady).toBe(false);
    });

    it('omitting bankCode keeps the stored one while the bank and account are unchanged (older clients)', async () => {
      const res = await put('u1', profile({}, { bankCode: undefined }));
      expect(res.body).toMatchObject({ paymentsReady: true, payment: { bankCode: '058' } });
      expect((await stored('u1')).payment.bankCode).toBe('058');
      expect(paystack.resolveAccount).not.toHaveBeenCalled();
    });

    it('omitting bankCode while changing the account clears it, so a stale code never points at the wrong bank', async () => {
      const res = await put('u1', profile({}, { bankCode: undefined, accountNumber: '0999999999' }));
      expect(res.body).toMatchObject({ paymentsReady: false, paymentsIssue: 'NO_BANK_CODE', payment: { bankCode: null } });
      expect((await stored('u1')).payment.bankCode).toBeUndefined();
      expect(paystack.resolveAccount).not.toHaveBeenCalled();
    });

    it('omitting bankCode while changing only the bank name also clears it', async () => {
      const res = await put('u1', profile({}, { bankCode: undefined, bankName: 'Access Bank' }));
      expect(res.body).toMatchObject({ paymentsReady: false, paymentsIssue: 'NO_BANK_CODE' });
    });

    it('an unready seller is retried on the next save even with the same details', async () => {
      paystack.updateSubaccount.mockRejectedValueOnce(unavailable());
      await put('u1', profile({}, { accountNumber: '0999999999' }));
      vi.clearAllMocks();
      const res = await put('u1', profile({}, { accountNumber: '0999999999' }));
      expect(res.body).toMatchObject({ paymentsReady: true, paymentsIssue: null });
      expect(paystack.updateSubaccount).toHaveBeenCalledTimes(1);
    });

    it('a save that finishes after the seller changed their account does not mark the NEW account ready', async () => {
      // While Paystack is "working" on account A, the seller saves account B.
      paystack.resolveAccount.mockImplementationOnce(async () => {
        await SellerModel.updateOne({ clerkUserId: 'u1' }, { $set: { 'payment.accountNumber': '0555555555' } });
        return { accountName: 'X' };
      });
      await put('u1', profile({}, { accountNumber: '0999999999' }));
      const row = await stored('u1');
      expect(row.payment.accountNumber).toBe('0555555555');
      expect(row.paymentsReady).toBe(false);
    });
  });

  describe('retry route', () => {
    it('sets payments up after an earlier failure, without re-saving the profile', async () => {
      paystack.resolveAccount.mockRejectedValueOnce(unavailable());
      await put('u1', profile());
      const res = await request(app).post('/api/sellers/me/payments/retry').set('Authorization', bearer('u1'));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ paymentsReady: true, paymentsIssue: null });
    });

    it('a Paystack outage during a retry does not switch off payments that already work', async () => {
      await put('u1', profile());
      paystack.resolveAccount.mockRejectedValueOnce(unavailable());
      const res = await request(app).post('/api/sellers/me/payments/retry').set('Authorization', bearer('u1'));
      expect(res.body).toMatchObject({ paymentsReady: true, paymentsIssue: null });
      expect((await stored('u1')).paymentsReady).toBe(true);
      // ...but the outage is still recorded for the admin health page.
      expect(await EventLogModel.countDocuments({ type: 'payment_setup_failed' })).toBe(1);
    });

    it('reports the failure when it fails again', async () => {
      paystack.resolveAccount.mockRejectedValue(unavailable());
      await put('u1', profile());
      const res = await request(app).post('/api/sellers/me/payments/retry').set('Authorization', bearer('u1'));
      expect(res.body).toMatchObject({ paymentsReady: false, paymentsIssue: 'PAYSTACK_UNAVAILABLE' });
    });

    it('only ever acts on the signed-in seller', async () => {
      paystack.resolveAccount.mockRejectedValueOnce(unavailable());
      await put('u1', profile());
      await put('u2', profile({ businessName: 'Other Kitchen' }, { accountNumber: '0222222222' }));
      await request(app).post('/api/sellers/me/payments/retry').set('Authorization', bearer('u2'));
      expect((await stored('u1')).paymentsReady).toBe(false);
      expect((await stored('u2')).paymentsReady).toBe(true);
    });

    it('needs sign-in and a profile', async () => {
      expect((await request(app).post('/api/sellers/me/payments/retry')).status).toBe(401);
      const res = await request(app).post('/api/sellers/me/payments/retry').set('Authorization', bearer('nobody'));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PROFILE_REQUIRED');
    });
  });

  describe('fee mode', () => {
    it('defaults to customer', async () => {
      await put('u1', profile());
      expect((await get('u1', '/api/sellers/me/payments')).body.feeMode).toBe('customer');
    });

    it('the seller can switch to seller-pays and back', async () => {
      await put('u1', profile());
      const a = await request(app).put('/api/sellers/me/fee-mode').set('Authorization', bearer('u1')).send({ feeMode: 'seller' });
      expect(a.status).toBe(200);
      expect(a.body.feeMode).toBe('seller');
      expect((await stored('u1')).feeMode).toBe('seller');
      const b = await request(app).put('/api/sellers/me/fee-mode').set('Authorization', bearer('u1')).send({ feeMode: 'customer' });
      expect(b.body.feeMode).toBe('customer');
    });

    it('changes only the signed-in seller', async () => {
      await put('u1', profile());
      await put('u2', profile({ businessName: 'Other Kitchen' }, { accountNumber: '0222222222' }));
      await request(app).put('/api/sellers/me/fee-mode').set('Authorization', bearer('u1')).send({ feeMode: 'seller' });
      expect((await stored('u2')).feeMode).toBe('customer');
    });

    it('refuses anything but the two modes', async () => {
      await put('u1', profile());
      for (const bad of ['free', '', 'SELLER', 1, null, undefined]) {
        const res = await request(app).put('/api/sellers/me/fee-mode').set('Authorization', bearer('u1')).send({ feeMode: bad });
        expect(res.status, String(bad)).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
      expect((await stored('u1')).feeMode).toBe('customer');
    });

    it('a body field cannot smuggle in other seller fields', async () => {
      await put('u1', profile());
      await request(app)
        .put('/api/sellers/me/fee-mode')
        .set('Authorization', bearer('u1'))
        .send({ feeMode: 'seller', paidOrderCount: 999, paymentsReady: true, paystackSubaccountCode: 'ACCT_evil' });
      const row = await stored('u1');
      expect(row).toMatchObject({ feeMode: 'seller', paidOrderCount: 0 });
      expect(row.paystackSubaccountCode).not.toBe('ACCT_evil');
    });

    it('needs sign-in', async () => {
      expect((await request(app).put('/api/sellers/me/fee-mode').send({ feeMode: 'seller' })).status).toBe(401);
    });

    it('a profile save can neither set the fee mode nor the paid-order count', async () => {
      await put('u1', profile({ feeMode: 'seller', paidOrderCount: 500, paymentsReady: true, paystackSubaccountCode: 'ACCT_evil' }));
      const row = await stored('u1');
      expect(row).toMatchObject({ feeMode: 'customer', paidOrderCount: 0 });
      expect(row.paystackSubaccountCode).toBe('ACCT_test1');
    });
  });

  describe('GET /api/sellers/me/payments', () => {
    it('reports the free-order countdown and the tier of the next payment', async () => {
      await put('u1', profile());
      await SellerModel.updateOne({ clerkUserId: 'u1' }, { $set: { paidOrderCount: 49 } });
      expect((await get('u1', '/api/sellers/me/payments')).body).toEqual({
        paymentsReady: true,
        paymentsIssue: null,
        feeMode: 'customer',
        paidOrderCount: 49,
        freeOrders: 50,
        freeOrdersRemaining: 1,
        tier: 'free',
        platformFeeBps: 300,
      });
      await SellerModel.updateOne({ clerkUserId: 'u1' }, { $set: { paidOrderCount: 50 } });
      const after = (await get('u1', '/api/sellers/me/payments')).body;
      expect(after).toMatchObject({ freeOrdersRemaining: 0, tier: 'standard' });
    });

    it('treats a seller saved before any of this existed as customer-pays, 0 paid orders, not ready', async () => {
      // Written straight to the collection, like a document from before the fields existed.
      await SellerModel.collection.insertOne({
        clerkUserId: 'legacy',
        businessName: 'Old Kitchen',
        slug: 'old-kitchen',
        phone: '+2348031234567',
        payment: { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Old Owner' },
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const res = await get('legacy', '/api/sellers/me/payments');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ paymentsReady: false, paymentsIssue: 'NO_BANK_CODE', feeMode: 'customer', paidOrderCount: 0, freeOrdersRemaining: 50, tier: 'free' });
      const me = await get('legacy', '/api/sellers/me');
      expect(me.body).toMatchObject({ feeMode: 'customer', paymentsReady: false, payment: { bankCode: null } });
    });

    it('shows each seller only their own numbers', async () => {
      await put('u1', profile());
      await put('u2', profile({ businessName: 'Other Kitchen' }, { accountNumber: '0222222222' }));
      await SellerModel.updateOne({ clerkUserId: 'u2' }, { $set: { paidOrderCount: 7, feeMode: 'seller' } });
      expect((await get('u1', '/api/sellers/me/payments')).body).toMatchObject({ paidOrderCount: 0, feeMode: 'customer' });
      expect((await get('u2', '/api/sellers/me/payments')).body).toMatchObject({ paidOrderCount: 7, feeMode: 'seller' });
    });

    it('needs sign-in and a profile', async () => {
      expect((await request(app).get('/api/sellers/me/payments')).status).toBe(401);
      expect((await get('nobody', '/api/sellers/me/payments')).status).toBe(403);
    });
  });

  describe('suspended sellers', () => {
    it('cannot use the payment routes or change the profile', async () => {
      await put('u1', profile());
      await SellerModel.updateOne({ clerkUserId: 'u1' }, { $set: { status: 'suspended' } });
      vi.clearAllMocks();
      const calls = [
        get('u1', '/api/sellers/me/payments'),
        request(app).put('/api/sellers/me/fee-mode').set('Authorization', bearer('u1')).send({ feeMode: 'seller' }),
        request(app).post('/api/sellers/me/payments/retry').set('Authorization', bearer('u1')),
        put('u1', profile({}, { accountNumber: '0999999999' })),
      ];
      for (const res of await Promise.all(calls)) {
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('ACCOUNT_SUSPENDED');
      }
      expect(paystack.updateSubaccount).not.toHaveBeenCalled();
      expect((await stored('u1')).feeMode).toBe('customer');
    });
  });

  describe('GET /api/sellers/banks', () => {
    it('needs sign-in but not a profile (onboarding picks the bank first)', async () => {
      expect((await request(app).get('/api/sellers/banks')).status).toBe(401);
      const res = await get('brand_new', '/api/sellers/banks');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        banks: [
          { name: 'GTBank', code: '058' },
          { name: 'Access Bank', code: '044' },
        ],
      });
    });

    it('asks Paystack once, then serves the saved list', async () => {
      await get('a', '/api/sellers/banks');
      await get('b', '/api/sellers/banks');
      await get('c', '/api/sellers/banks');
      expect(paystack.listBanks).toHaveBeenCalledTimes(1);
    });

    it('asks again after six hours, and serves the old list if Paystack is down by then', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      await get('a', '/api/sellers/banks');
      vi.setSystemTime(Date.now() + 6 * 60 * 60 * 1000 + 1000);
      paystack.listBanks.mockRejectedValueOnce(unavailable());
      const stale = await get('a', '/api/sellers/banks');
      expect(stale.status).toBe(200);
      expect(stale.body.banks).toHaveLength(2);
      expect(paystack.listBanks).toHaveBeenCalledTimes(2);
    });

    it('is 503 PAYMENTS_UNAVAILABLE when Paystack is down and there is nothing saved', async () => {
      paystack.listBanks.mockRejectedValueOnce(unavailable());
      const res = await get('a', '/api/sellers/banks');
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('PAYMENTS_UNAVAILABLE');
    });

    it('is 503 PAYMENTS_UNAVAILABLE when payments are not configured', async () => {
      rebuild(null);
      const res = await get('a', '/api/sellers/banks');
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('PAYMENTS_UNAVAILABLE');
    });

    it('does not leak Paystack error text to the client', async () => {
      paystack.listBanks.mockRejectedValueOnce(new PaystackError('unavailable', 'Invalid key sk_test_LEAK', 401));
      const res = await get('a', '/api/sellers/banks');
      expect(JSON.stringify(res.body)).not.toContain('sk_test_LEAK');
    });
  });
});
