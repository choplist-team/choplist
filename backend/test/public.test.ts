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

// Behind two proxies (e.g. Cloudflare then Render's load balancer) the request
// reaches the app with X-Forwarded-For: "<client>, <proxy 1>" and the socket
// peer is proxy 2. The setting decides which of those is "the client".
describe('TRUST_PROXY_HOPS decides which address the rate limit counts', () => {
  function appWith(hops: number) {
    return createApp({
      allowedOrigins: ['http://localhost:5173'],
      auth: fakeAuth,
      rateLimits: { windowMs: 60_000, ordersPerWindow: 1, lookupsPerWindow: 100 },
      trustProxyHops: hops,
    });
  }
  const post = (app: ReturnType<typeof createApp>, forwarded: string) =>
    request(app).post('/api/public/orders').set('X-Forwarded-For', forwarded).send({});

  it('1 hop: the entry added by the nearest proxy is the client, so two customers behind one edge share a counter (the bug seen on Render)', async () => {
    const app = appWith(1);
    expect((await post(app, '198.51.100.1, 104.16.0.9')).status).toBe(400); // customer A via edge 104.16.0.9
    expect((await post(app, '198.51.100.2, 104.16.0.9')).status).toBe(429); // customer B shares A's counter
  });

  it('2 hops: the real customer is read from the chain, so each customer has their own counter', async () => {
    const app = appWith(2);
    expect((await post(app, '198.51.100.1, 104.16.0.9')).status).toBe(400);
    expect((await post(app, '198.51.100.2, 104.16.0.9')).status).toBe(400); // different customer, own counter
    expect((await post(app, '198.51.100.1, 104.16.0.77')).status).toBe(429); // same customer via another edge: same counter
  });

  it('2 hops: the same customer through different edges, with a faked entry on the left, keeps one counter', async () => {
    const app = appWith(2);
    expect((await post(app, '1.1.1.1, 198.51.100.1, 104.16.0.9')).status).toBe(400);
    // Same real customer (198.51.100.1), another edge, a different faked left entry.
    expect((await post(app, '2.2.2.2, 198.51.100.1, 104.16.0.77')).status).toBe(429);
  });

  it('too many hops (3): the client-written entry is believed, so a client can dodge the limit', async () => {
    const app = appWith(3);
    expect((await post(app, '1.1.1.1, 198.51.100.1, 104.16.0.9')).status).toBe(400);
    // Same customer, different faked entry: a fresh counter. This is why the number must not be set higher than the real proxy count.
    expect((await post(app, '2.2.2.2, 198.51.100.1, 104.16.0.9')).status).toBe(400);
  });
});
