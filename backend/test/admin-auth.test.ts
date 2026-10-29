import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { parseEnv } from '../src/config.js';
import { bearer, fakeAuth } from './helpers/fake-auth.js';

// No database: admin access is decided before any query runs.
const ORIGIN = 'http://localhost:5173';
const admin = 'user_admin1';

const appWithAdmins = (ids: string[]) => createApp({ allowedOrigins: [ORIGIN], auth: fakeAuth, adminClerkUserIds: ids });

describe('requireAdmin on /api/admin', () => {
  const app = appWithAdmins([admin, 'user_admin2']);

  it('is 401 UNAUTHENTICATED without a token', async () => {
    const res = await request(app).get('/api/admin/anything');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('is 403 FORBIDDEN for a signed-in user who is not listed (a seller, say)', async () => {
    const res = await request(app).get('/api/admin/anything').set('Authorization', bearer('seller_a'));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('lets a listed admin through (the route itself does not exist yet, so 404, not 401/403)', async () => {
    for (const id of [admin, 'user_admin2']) {
      const res = await request(app).get('/api/admin/anything').set('Authorization', bearer(id));
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    }
  });

  it('guards every method, not just GET', async () => {
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      const res = await request(app)[method]('/api/admin/anything').set('Authorization', bearer('seller_a'));
      expect(res.status, method).toBe(403);
    }
  });

  it('matches ids exactly: no prefix, suffix or case tricks', async () => {
    for (const id of ['user_admin', 'USER_ADMIN1', 'user_admin12', 'xuser_admin1']) {
      const res = await request(app).get('/api/admin/anything').set('Authorization', `Bearer test:${id}`);
      expect(res.status, id).toBe(403);
    }
  });
});

describe('with no admins configured', () => {
  it('everyone signed in is 403, and nobody is made an admin by default', async () => {
    for (const ids of [undefined, []]) {
      const app = createApp({ allowedOrigins: [ORIGIN], auth: fakeAuth, ...(ids ? { adminClerkUserIds: ids } : {}) });
      const res = await request(app).get('/api/admin/anything').set('Authorization', bearer(admin));
      expect(res.status).toBe(403);
    }
  });
});

describe('ADMIN_CLERK_USER_IDS in the environment', () => {
  const base = {
    MONGO_URI: 'mongodb+srv://u:p@cluster0.example.mongodb.net/choplist',
    ALLOWED_ORIGINS: 'http://localhost:5173',
    CLERK_SECRET_KEY: 'sk_test_dummy',
    CLERK_PUBLISHABLE_KEY: 'pk_test_dummy',
  };

  it('is optional and empty by default', () => {
    expect(parseEnv(base).ADMIN_CLERK_USER_IDS).toEqual([]);
    expect(parseEnv({ ...base, ADMIN_CLERK_USER_IDS: '' }).ADMIN_CLERK_USER_IDS).toEqual([]);
  });

  it('splits on commas and trims spaces', () => {
    const ids = parseEnv({ ...base, ADMIN_CLERK_USER_IDS: ' user_2abc , user_2def,,' }).ADMIN_CLERK_USER_IDS;
    expect(ids).toEqual(['user_2abc', 'user_2def']);
  });

  it('rejects something that is not a Clerk user id (a typo would otherwise silently lock admins out)', () => {
    expect(() => parseEnv({ ...base, ADMIN_CLERK_USER_IDS: 'user_2abc,admin@example.com' })).toThrow(/not a Clerk user id/);
    expect(() => parseEnv({ ...base, ADMIN_CLERK_USER_IDS: 'sk_test_secret' })).toThrow(/not a Clerk user id/);
  });
});
