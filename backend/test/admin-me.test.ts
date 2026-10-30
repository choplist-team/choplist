import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { bearer, fakeAuth } from './helpers/fake-auth.js';

// No database: /me is decided by the admin guard alone.
const app = createApp({ allowedOrigins: ['http://localhost:5173'], auth: fakeAuth, adminClerkUserIds: ['user_admin1'] });

describe('GET /api/admin/me', () => {
  it('is 401 without a token', async () => {
    const res = await request(app).get('/api/admin/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('is 403 for a signed-in user who is not an admin (a seller, say)', async () => {
    const res = await request(app).get('/api/admin/me').set('Authorization', bearer('seller_a'));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('is 200 for a listed admin, and returns nothing but the answer', async () => {
    const res = await request(app).get('/api/admin/me').set('Authorization', bearer('user_admin1'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ admin: true });
  });
});
