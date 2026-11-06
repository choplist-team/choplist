import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildSystemCheck, keyMode } from '../src/admin/system.js';
import { createApp } from '../src/app.js';
import { DEFAULT_BILLING, type BillingConfig } from '../src/billing/plans.js';
import { bearer, fakeAuth } from './helpers/fake-auth.js';
import { fakePaystack } from './helpers/fake-paystack.js';

const ADMIN = 'user_admin1';
const TEST_KEY = 'sk_test_not_a_real_key_for_tests';
const LIVE_KEY = 'sk_live_not_a_real_key_for_tests';

const inputs = (over: Partial<Parameters<typeof buildSystemCheck>[0]> = {}) => ({
  paystackSecretKey: TEST_KEY,
  paystackCallbackUrl: 'https://choplistafrica.com/paystack-return',
  pricing: { freeOrders: 50, platformFeeBps: 0 },
  billing: { ...DEFAULT_BILLING, callbackUrl: 'https://choplistafrica.com/subscribed', shareUrlBase: 'https://choplistafrica.com/shop' } as BillingConfig,
  orderExpiryHours: 0,
  allowedOrigins: ['https://choplistafrica.com'],
  adminCount: 1,
  ...over,
});
const codes = (over?: Partial<Parameters<typeof buildSystemCheck>[0]>) => buildSystemCheck(inputs(over)).warnings.map((w) => w.code);

describe('keyMode', () => {
  it('tells test, live and unrecognised keys apart, by prefix only', () => {
    expect(keyMode(TEST_KEY)).toBe('test');
    expect(keyMode(LIVE_KEY)).toBe('live');
    expect(keyMode('sk_something')).toBe('unknown');
    expect(keyMode('pk_test_x')).toBe('unknown');
    expect(keyMode(undefined)).toBeNull();
    expect(keyMode('')).toBeNull();
  });
});

describe('buildSystemCheck', () => {
  it('has no warnings for a tidy test-mode setup', () => {
    expect(codes()).toEqual([]);
    expect(buildSystemCheck(inputs())).toMatchObject({
      paystack: { configured: true, mode: 'test' },
      returnPages: { payment: true, subscription: true },
      shareUrlBaseSet: true,
      pricing: { platformFeeBps: 0, freeOrders: 50 },
      billing: { trialDays: 7, monthlyNaira: 3000, quarterlyNaira: 8_000 },
      orderExpiryHours: 0,
      adminCount: 1,
    });
  });

  it('warns loudly about a LIVE key', () => {
    expect(codes({ paystackSecretKey: LIVE_KEY })).toEqual(['PAYSTACK_LIVE_KEY']);
    expect(buildSystemCheck(inputs({ paystackSecretKey: LIVE_KEY })).paystack.mode).toBe('live');
  });

  it('warns when Paystack is off, and does not nag about return pages then', () => {
    const c = codes({ paystackSecretKey: undefined, paystackCallbackUrl: undefined, billing: { ...DEFAULT_BILLING, shareUrlBase: 'https://x.test/shop' } });
    expect(c).toEqual(['PAYSTACK_OFF']);
  });

  it('warns about a key it does not recognise', () => {
    expect(codes({ paystackSecretKey: 'sk_weird' })).toEqual(['PAYSTACK_KEY_UNRECOGNISED']);
  });

  it('warns about each missing return page and the share base', () => {
    const c = codes({ paystackCallbackUrl: undefined, billing: { ...DEFAULT_BILLING } });
    expect(c.sort()).toEqual(['NO_PAYMENT_RETURN_PAGE', 'NO_SHARE_URL_BASE', 'NO_SUBSCRIPTION_RETURN_PAGE']);
  });

  it('warns when the per-order fee is switched on, and when order expiry is', () => {
    expect(codes({ pricing: { freeOrders: 50, platformFeeBps: 300 } })).toEqual(['PLATFORM_FEE_ON']);
    expect(codes({ orderExpiryHours: 48 })).toEqual(['ORDER_EXPIRY_ON']);
    expect(buildSystemCheck(inputs({ orderExpiryHours: 48 })).warnings[0]!.message).toContain('48 hours');
    expect(buildSystemCheck(inputs({ pricing: { freeOrders: 50, platformFeeBps: 300 } })).warnings[0]!.message).toContain('3%');
  });

  it('warns when nobody can use the admin console', () => {
    expect(codes({ adminCount: 0 })).toEqual(['NO_ADMINS']);
  });

  it('never contains the key, any part of it, or any URL value', () => {
    const text = JSON.stringify(buildSystemCheck(inputs({ paystackSecretKey: LIVE_KEY })));
    expect(text).not.toMatch(/sk_live|sk_test|not_a_real_key|choplistafrica\.com|https?:\/\//);
  });
});

describe('GET /api/admin/system', () => {
  const build = (extra: Record<string, unknown> = {}) =>
    createApp({
      allowedOrigins: ['http://localhost:5173', 'https://choplistafrica.com'], auth: fakeAuth, adminClerkUserIds: [ADMIN, 'user_admin2'],
      paystack: fakePaystack(), paystackSecretKey: TEST_KEY, paystackCallbackUrl: 'https://choplistafrica.com/paystack-return', orderExpiryHours: 48, ...extra,
    });

  it('is for admins only', async () => {
    const app = build();
    await request(app).get('/api/admin/system').expect(401);
    await request(app).get('/api/admin/system').set('Authorization', bearer('user_someone')).expect(403);
  });

  it('reports the real configuration of the running app, never cached, with no secrets', async () => {
    const app = build({ billing: { ...DEFAULT_BILLING, callbackUrl: 'https://choplistafrica.com/subscribed' } });
    const res = await request(app).get('/api/admin/system').set('Authorization', bearer(ADMIN));
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({
      paystack: { configured: true, mode: 'test' },
      returnPages: { payment: true, subscription: true },
      shareUrlBaseSet: false,
      pricing: { platformFeeBps: 0 },
      orderExpiryHours: 48,
      allowedOriginCount: 2,
      adminCount: 2,
    });
    expect(res.body.warnings.map((w: { code: string }) => w.code).sort()).toEqual(['NO_SHARE_URL_BASE', 'ORDER_EXPIRY_ON']);
    expect(JSON.stringify(res.body)).not.toMatch(/sk_test|not_a_real_key|https?:\/\/|localhost/);
  });

  it('shows a live key as live and a missing key as off', async () => {
    const live = await request(build({ paystackSecretKey: LIVE_KEY })).get('/api/admin/system').set('Authorization', bearer(ADMIN));
    expect(live.body.paystack).toEqual({ configured: true, mode: 'live' });
    expect(live.body.warnings.map((w: { code: string }) => w.code)).toContain('PAYSTACK_LIVE_KEY');
    const off = await request(build({ paystackSecretKey: undefined, paystack: null })).get('/api/admin/system').set('Authorization', bearer(ADMIN));
    expect(off.body.paystack).toEqual({ configured: false, mode: null });
    expect(off.body.warnings.map((w: { code: string }) => w.code)).toContain('PAYSTACK_OFF');
  });
});
