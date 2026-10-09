import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { fakeAuth } from './helpers/fake-auth.js';

// Rate limits and validation, which run before any database call.
function appWithLimits(ordersPerWindow: number, lookupsPerWindow: number) {
  return createApp({
    allowedOrigins: ['http://localhost:5173'],
    auth: fakeAuth,
    rateLimits: { windowMs: 60_000, ordersPerWindow, lookupsPerWindow },
  });
}

describe('public routes without a database', () => {
  it('rate-limits orders per IP with a JSON 429 and RateLimit headers', async () => {
    const app = appWithLimits(3, 100);
    const post = (ip: string) => request(app).post('/api/public/orders').set('X-Forwarded-For', ip).send({});

    // Invalid bodies still count: the limit is on attempts, not successes.
    for (let i = 0; i < 3; i++) expect((await post('203.0.113.7')).status).toBe(400);

    const blocked = await post('203.0.113.7');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(blocked.headers['ratelimit']).toBeDefined();

    // Another customer (different IP, via the one trusted proxy) is not affected.
    expect((await post('198.51.100.20')).status).toBe(400);
  });

  it('rate-limits order lookups separately from orders', async () => {
    const app = appWithLimits(100, 2);
    const lookup = () => request(app).get('/api/public/orders/CL-AAAAA').set('X-Forwarded-For', '203.0.113.9');
    await lookup();
    await lookup();
    expect((await lookup()).status).toBe(429);
    // Orders from the same IP still go through to validation.
    const order = await request(app).post('/api/public/orders').set('X-Forwarded-For', '203.0.113.9').send({});
    expect(order.status).toBe(400);
  });

  it('validates the order body and names the fields', async () => {
    const app = appWithLimits(100, 100);
    const res = await request(app)
      .post('/api/public/orders')
      .send({
        menuId: 'x',
        customer: { name: 'Ada', phone: '12345' },
        delivery: { area: 'Yaba', address: 'x', day: '2030-01-01' },
        lines: [{ itemId: 'y', qty: 0.5 }],
      });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toMatch(/customer\.phone/);
    expect(res.body.error.message).toMatch(/delivery\.address: Enter a full delivery address/);
    expect(res.body.error.message).toMatch(/lines\.0\.qty: qty must be a whole number/);
  });

  it('order lookup needs phoneLast4 (400), and a malformed ref is a plain 404', async () => {
    const app = appWithLimits(100, 100);
    const missing = await request(app).get('/api/public/orders/CL-AAAAA');
    expect(missing.status).toBe(400);
    expect(missing.body.error.message).toMatch(/phoneLast4/);

    const malformed = await request(app).get('/api/public/orders/hello?phoneLast4=1234');
    expect(malformed.status).toBe(404);
    expect(malformed.body.error.code).toBe('ORDER_NOT_FOUND');
  });
});
