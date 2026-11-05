import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { SellerModel } from '../src/models/seller.js';
import { connectTestDb, disconnectTestDb, testDbUri } from './helpers/db.js';
import { bearer, fakeAuth } from './helpers/fake-auth.js';
import { fakePaystack } from './helpers/fake-paystack.js';
import { LIMITS, makeSeller } from './helpers/flow.js';

describe.skipIf(!testDbUri)('the payment-setup retry route has its own limit, on a real MongoDB', () => {
  beforeAll(async () => {
    await connectTestDb('retry_limit');
  });
  afterAll(disconnectTestDb);
  beforeEach(async () => {
    await SellerModel.deleteMany({});
  });

  it('allows a few retries, then answers 429 RATE_LIMITED, and each retry before that really does the work', async () => {
    const paystack = fakePaystack();
    const app = createApp({ allowedOrigins: ['http://localhost:5173'], auth: fakeAuth, paystack, rateLimits: { ...LIMITS, paymentsPerWindow: 3 } });
    const seller = await makeSeller({ paymentsReady: false, paystackSubaccountCode: undefined });
    const retry = () => request(app).post('/api/sellers/me/payments/retry').set({ Authorization: bearer(seller.clerkUserId) });

    for (let i = 0; i < 3; i += 1) expect((await retry()).status).toBe(200);
    const blocked = await retry();
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    // The blocked call spent no Paystack requests.
    const callsAfterThree = paystack.resolveAccount.mock.calls.length + paystack.createSubaccount.mock.calls.length;
    await retry();
    expect(paystack.resolveAccount.mock.calls.length + paystack.createSubaccount.mock.calls.length).toBe(callsAfterThree);
  });

  it('is not limited at the normal setting for ordinary use', async () => {
    const app = createApp({ allowedOrigins: ['http://localhost:5173'], auth: fakeAuth, paystack: fakePaystack(), rateLimits: LIMITS });
    const seller = await makeSeller();
    for (let i = 0; i < 5; i += 1) {
      expect((await request(app).post('/api/sellers/me/payments/retry').set({ Authorization: bearer(seller.clerkUserId) })).status).toBe(200);
    }
  });
});
