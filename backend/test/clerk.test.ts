import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createClerkAuth } from '../src/auth/clerk.js';

// The real Clerk middleware (not the fake), with dummy keys in the right
// format. Only requests that Clerk can reject without the network are sent:
// no token, and a token that is not a JWT at all. Verifying a real signed
// token needs real keys and is checked by hand.
process.env.CLERK_TELEMETRY_DISABLED = '1';

const publishableKey = `pk_test_${Buffer.from('example.clerk.accounts.dev$').toString('base64')}`;
const app = createApp({
  allowedOrigins: ['http://localhost:5173'],
  auth: createClerkAuth({
    secretKey: 'sk_test_dummydummydummydummy',
    publishableKey,
    authorizedParties: ['http://localhost:5173'],
  }),
});

describe('real Clerk middleware (no network)', () => {
  it('no token: 401 UNAUTHENTICATED on seller routes', async () => {
    for (const path of ['/api/sellers/me', '/api/menus', '/api/orders/CL-AAAAA/paid']) {
      const res = path.endsWith('/paid') ? await request(app).patch(path) : await request(app).get(path);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue' } });
    }
  });

  it('a token that is not a JWT: 401, not a 500', async () => {
    const res = await request(app).get('/api/sellers/me').set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('public routes and /health do not need a token', async () => {
    expect((await request(app).get('/health')).status).toBe(200);
    // Reaches validation (400), so auth did not block it.
    expect((await request(app).post('/api/public/orders').send({})).status).toBe(400);
  });
});
