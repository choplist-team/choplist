import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { fakeAuth } from './helpers/fake-auth.js';

// No database: a CORS preflight is answered before any route runs.
//
// A browser sends X-Order-Key only if the server's preflight answer allows that
// header. If it did not, the browser would silently drop the key (or block the
// request), every customer would look like a stranger, and the delivery code
// would never show. So the header is checked the way a browser checks it.
const ORIGIN = 'https://choplist.onrender.com';
const app = createApp({ allowedOrigins: [ORIGIN], auth: fakeAuth });

describe('CORS lets the browser send X-Order-Key', () => {
  it('the preflight for the order lookup allows the X-Order-Key header', async () => {
    const res = await request(app)
      .options('/api/public/orders/CL-7KQ2M')
      .set('Origin', ORIGIN)
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'x-order-key');
    expect(res.status).toBeLessThan(300);
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    const allowed = (res.headers['access-control-allow-headers'] ?? '').toLowerCase().split(',').map((h) => h.trim());
    expect(allowed).toContain('x-order-key');
  });

  it('an origin that is not allowed gets no CORS approval', async () => {
    const res = await request(app)
      .options('/api/public/orders/CL-7KQ2M')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'x-order-key');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
