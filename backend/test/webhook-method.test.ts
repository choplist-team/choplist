import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { fakeAuth } from './helpers/fake-auth.js';
import { fakePaystack } from './helpers/fake-paystack.js';

const app = createApp({
  allowedOrigins: ['http://localhost:5173'],
  auth: fakeAuth,
  paystack: fakePaystack(),
  paystackSecretKey: 'sk_test_not_a_real_key_for_tests',
});

// A browser sent here by a wrong return page must see why, not "not found". No database needed:
// these requests never reach the handler.
describe('GET and other methods on the Paystack webhook address', () => {
  it.each(['get', 'put', 'delete'] as const)('%s answers 405 METHOD_NOT_ALLOWED as JSON, naming POST', async (method) => {
    const res = await request(app)[method]('/api/webhooks/paystack');
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe('POST');
    expect(res.body.error.code).toBe('METHOD_NOT_ALLOWED');
  });

  it('HEAD answers 405 too', async () => {
    expect((await request(app).head('/api/webhooks/paystack')).status).toBe(405);
  });

  it('POST still reaches the handler (a bad signature is 401, not 405)', async () => {
    const res = await request(app).post('/api/webhooks/paystack').set('Content-Type', 'application/json').send('{}');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_SIGNATURE');
  });
});
