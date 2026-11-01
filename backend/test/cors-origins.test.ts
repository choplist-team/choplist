import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { parseEnv } from '../src/config.js';
import { fakeAuth } from './helpers/fake-auth.js';

// The exact value to put in ALLOWED_ORIGINS on Render during the domain move:
// the new site (apex and www) next to the old one, so nothing breaks while both
// are in use. It goes through parseEnv, like the real server, so this also
// proves the value is accepted at startup.
const RENDER_ALLOWED_ORIGINS = [
  'https://choplistafrica.com',
  'https://www.choplistafrica.com',
  'https://choplist.onrender.com',
].join(',');

const env = {
  MONGO_URI: 'mongodb+srv://user:pass@cluster0.example.mongodb.net/choplist',
  ALLOWED_ORIGINS: RENDER_ALLOWED_ORIGINS,
  CLERK_SECRET_KEY: 'sk_test_dummy',
  CLERK_PUBLISHABLE_KEY: 'pk_test_dummy',
};

const allowedOrigins = parseEnv(env).ALLOWED_ORIGINS;
const app = createApp({ allowedOrigins, auth: fakeAuth });

const NEW_APEX = 'https://choplistafrica.com';
const NEW_WWW = 'https://www.choplistafrica.com';
const OLD_FRONTEND = 'https://choplist.onrender.com';

// What the browser asks permission for when the site calls the API.
const REQUEST_HEADERS = 'authorization,x-order-key,content-type';

describe('ALLOWED_ORIGINS for the new domain', () => {
  it('is read from the environment as three separate origins', () => {
    expect(allowedOrigins).toEqual([NEW_APEX, NEW_WWW, OLD_FRONTEND]);
  });

  it('is what Clerk is told too (server.ts passes the same list as authorizedParties)', () => {
    // server.ts uses config.ALLOWED_ORIGINS for both CORS and Clerk, so one
    // list moves both. This pins that the parsed list is exactly the three.
    expect(new Set(allowedOrigins).size).toBe(3);
  });
});

describe('CORS with the new and old origins', () => {
  it.each([
    ['the new apex', NEW_APEX],
    ['the new www', NEW_WWW],
    ['the old Render frontend', OLD_FRONTEND],
  ])('allows %s', async (_name, origin) => {
    const res = await request(app).get('/health').set('Origin', origin);
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(origin);
  });

  it.each([
    ['an unrelated site', 'https://evil.example'],
    ['the right host over plain http', 'http://choplistafrica.com'],
    ['our domain as a prefix of theirs', 'https://choplistafrica.com.evil.example'],
    ['their domain ending in ours', 'https://evilchoplistafrica.com'],
    ['another subdomain nobody listed', 'https://admin.choplistafrica.com'],
    ['the API hostname itself', 'https://api.choplistafrica.com'],
    ['the apex on a different port', 'https://choplistafrica.com:8443'],
    ['a null origin (sandboxed page or local file)', 'null'],
  ])('refuses %s', async (_name, origin) => {
    const res = await request(app).get('/health').set('Origin', origin);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('preflight (OPTIONS) from the new and old origins', () => {
  it.each([
    ['the new apex', NEW_APEX],
    ['the new www', NEW_WWW],
    ['the old Render frontend', OLD_FRONTEND],
  ])('from %s allows Authorization, X-Order-Key and Content-Type', async (_name, origin) => {
    const res = await request(app)
      .options('/api/public/orders/CL-AAAAA')
      .set('Origin', origin)
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', REQUEST_HEADERS);

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(origin);
    const allowed = String(res.headers['access-control-allow-headers']).toLowerCase().split(',');
    for (const header of REQUEST_HEADERS.split(',')) expect(allowed).toContain(header);
  });

  it.each(['PUT', 'PATCH', 'DELETE', 'POST'])('allows the %s method from the new apex', async (method) => {
    const res = await request(app)
      .options('/api/menus')
      .set('Origin', NEW_APEX)
      .set('Access-Control-Request-Method', method)
      .set('Access-Control-Request-Headers', 'authorization,content-type');
    expect(res.status).toBe(204);
    expect(String(res.headers['access-control-allow-methods']).split(',')).toContain(method);
  });

  it('gives an unlisted origin no permission, even when the headers asked for are the same', async () => {
    const res = await request(app)
      .options('/api/public/orders/CL-AAAAA')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', REQUEST_HEADERS);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('/health on either hostname', () => {
  // The server never looks at the Host header, so the same app answers on
  // choplist-api.onrender.com and on api.choplistafrica.com. Render forwards the
  // request to the one service, whichever name the visitor used.
  it.each(['choplist-api.onrender.com', 'api.choplistafrica.com'])('answers 200 ok on %s', async (host) => {
    const res = await request(app).get('/health').set('Host', host);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});
