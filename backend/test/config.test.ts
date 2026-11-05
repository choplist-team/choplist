import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config.js';

const valid = {
  PORT: '5000',
  MONGO_URI: 'mongodb+srv://user:pass@cluster0.example.mongodb.net/choplist',
  ALLOWED_ORIGINS: 'http://localhost:5173, https://choplist.onrender.com',
  CLERK_SECRET_KEY: 'sk_test_dummy',
  CLERK_PUBLISHABLE_KEY: 'pk_test_dummy',
};

describe('parseEnv', () => {
  it('parses a valid env into typed values', () => {
    const config = parseEnv(valid);
    expect(config.PORT).toBe(5000);
    expect(config.ALLOWED_ORIGINS).toEqual(['http://localhost:5173', 'https://choplist.onrender.com']);
  });

  it('defaults PORT to 5000 when unset', () => {
    const { PORT: _unused, ...withoutPort } = valid;
    expect(parseEnv(withoutPort).PORT).toBe(5000);
  });

  it('rejects a missing MONGO_URI', () => {
    const { MONGO_URI: _unused, ...withoutMongo } = valid;
    expect(() => parseEnv(withoutMongo)).toThrow(/MONGO_URI is required/);
  });

  it('rejects an empty MONGO_URI (the blank value in .env.example)', () => {
    expect(() => parseEnv({ ...valid, MONGO_URI: '' })).toThrow(/MONGO_URI must start with/);
  });

  it('rejects an origin with a trailing slash', () => {
    expect(() => parseEnv({ ...valid, ALLOWED_ORIGINS: 'https://choplist.onrender.com/' })).toThrow(
      /is not an origin/,
    );
  });

  it('rejects an origin that is not a URL', () => {
    // "localhost:5173" with no scheme also fails (it parses with an origin of
    // "null"); plain text cannot be parsed as a URL at all.
    expect(() => parseEnv({ ...valid, ALLOWED_ORIGINS: 'localhost:5173' })).toThrow(/is not an origin/);
    expect(() => parseEnv({ ...valid, ALLOWED_ORIGINS: 'choplist frontend' })).toThrow(/is not an origin/);
  });

  it('accepts the new domain next to the old one, with or without spaces after the commas', () => {
    const list = ['https://choplistafrica.com', 'https://www.choplistafrica.com', 'https://choplist.onrender.com'];
    expect(parseEnv({ ...valid, ALLOWED_ORIGINS: list.join(',') }).ALLOWED_ORIGINS).toEqual(list);
    expect(parseEnv({ ...valid, ALLOWED_ORIGINS: list.join(' , ') }).ALLOWED_ORIGINS).toEqual(list);
  });

  it('rejects a capitalised host, which a browser would never send (so it could never match)', () => {
    expect(() => parseEnv({ ...valid, ALLOWED_ORIGINS: 'https://ChopListAfrica.com' })).toThrow(/is not an origin/);
  });

  describe('order expiry setting', () => {
    it('defaults to 48 hours', () => {
      expect(parseEnv(valid).ORDER_EXPIRY_HOURS).toBe(48);
    });

    it('reads an override, treats a blank as the default, and 0 switches it off', () => {
      expect(parseEnv({ ...valid, ORDER_EXPIRY_HOURS: '72' }).ORDER_EXPIRY_HOURS).toBe(72);
      expect(parseEnv({ ...valid, ORDER_EXPIRY_HOURS: '' }).ORDER_EXPIRY_HOURS).toBe(48);
      expect(parseEnv({ ...valid, ORDER_EXPIRY_HOURS: '0' }).ORDER_EXPIRY_HOURS).toBe(0);
    });

    it('refuses a negative, fractional, text or silly-long value', () => {
      for (const bad of ['-1', '1.5', 'two days', '721']) {
        expect(() => parseEnv({ ...valid, ORDER_EXPIRY_HOURS: bad })).toThrow(/ORDER_EXPIRY_HOURS/);
      }
    });
  });

  describe('vendor billing settings', () => {
    it('defaults to a 7 day trial, 3000 monthly and 11000 quarterly, with no return page', () => {
      const config = parseEnv(valid);
      expect(config.TRIAL_DAYS).toBe(7);
      expect(config.SUBSCRIPTION_MONTHLY_NAIRA).toBe(3000);
      expect(config.SUBSCRIPTION_QUARTERLY_NAIRA).toBe(11_000);
      expect(config.SUBSCRIPTION_CALLBACK_URL).toBeUndefined();
      expect(config.SHARE_URL_BASE).toBeUndefined();
    });

    it('reads overrides from the environment', () => {
      const config = parseEnv({
        ...valid,
        TRIAL_DAYS: '14',
        SUBSCRIPTION_MONTHLY_NAIRA: '3500',
        SUBSCRIPTION_QUARTERLY_NAIRA: '9000',
        SUBSCRIPTION_CALLBACK_URL: 'https://choplistafrica.com/seller/subscription/done',
        SHARE_URL_BASE: 'https://choplistafrica.com/shop/',
      });
      expect(config).toMatchObject({ TRIAL_DAYS: 14, SUBSCRIPTION_MONTHLY_NAIRA: 3500, SUBSCRIPTION_QUARTERLY_NAIRA: 9000 });
      expect(config.SUBSCRIPTION_CALLBACK_URL).toBe('https://choplistafrica.com/seller/subscription/done');
      // The trailing slash is dropped so the link is base + "/" + slug.
      expect(config.SHARE_URL_BASE).toBe('https://choplistafrica.com/shop');
    });

    it('treats blank numbers, as left by .env.example, as "use the default" instead of 0', () => {
      const config = parseEnv({ ...valid, TRIAL_DAYS: '', SUBSCRIPTION_MONTHLY_NAIRA: '  ', SUBSCRIPTION_QUARTERLY_NAIRA: '' });
      expect(config).toMatchObject({ TRIAL_DAYS: 7, SUBSCRIPTION_MONTHLY_NAIRA: 3000, SUBSCRIPTION_QUARTERLY_NAIRA: 11_000 });
    });

    it('refuses a trial that is zero, negative, fractional, text or longer than 90 days', () => {
      for (const bad of ['0', '-7', '3.5', 'week', '91']) {
        expect(() => parseEnv({ ...valid, TRIAL_DAYS: bad })).toThrow(/TRIAL_DAYS/);
      }
    });

    it('refuses a price that is a slipped digit, fractional or text', () => {
      expect(() => parseEnv({ ...valid, SUBSCRIPTION_MONTHLY_NAIRA: '30' })).toThrow(/SUBSCRIPTION_MONTHLY_NAIRA/);
      expect(() => parseEnv({ ...valid, SUBSCRIPTION_MONTHLY_NAIRA: '3000.5' })).toThrow(/SUBSCRIPTION_MONTHLY_NAIRA/);
      expect(() => parseEnv({ ...valid, SUBSCRIPTION_QUARTERLY_NAIRA: 'cheap' })).toThrow(/SUBSCRIPTION_QUARTERLY_NAIRA/);
      expect(() => parseEnv({ ...valid, SUBSCRIPTION_QUARTERLY_NAIRA: '80000000' })).toThrow(/SUBSCRIPTION_QUARTERLY_NAIRA/);
    });

    it('treats blank return/share settings as not set and refuses non-URLs', () => {
      expect(parseEnv({ ...valid, SUBSCRIPTION_CALLBACK_URL: '', SHARE_URL_BASE: '  ' }).SUBSCRIPTION_CALLBACK_URL).toBeUndefined();
      expect(() => parseEnv({ ...valid, SUBSCRIPTION_CALLBACK_URL: 'not a url' })).toThrow(/SUBSCRIPTION_CALLBACK_URL/);
      expect(() => parseEnv({ ...valid, SHARE_URL_BASE: 'javascript:alert(1)' })).toThrow(/SHARE_URL_BASE/);
    });
  });

  describe('pricing and Paystack settings', () => {
    it('defaults to no ChopList fee per order (income is the vendor subscription), with Paystack off', () => {
      const config = parseEnv(valid);
      expect(config.FREE_ORDERS).toBe(50);
      expect(config.PLATFORM_FEE_BPS).toBe(0);
      expect(config.PAYSTACK_SECRET_KEY).toBeUndefined();
      expect(config.PAYSTACK_CALLBACK_URL).toBeUndefined();
    });

    it('reads overrides from the environment', () => {
      const config = parseEnv({ ...valid, FREE_ORDERS: '20', PLATFORM_FEE_BPS: '250' });
      expect(config.FREE_ORDERS).toBe(20);
      expect(config.PLATFORM_FEE_BPS).toBe(250);
    });

    it('allows a fee of 0 and no free period', () => {
      const config = parseEnv({ ...valid, FREE_ORDERS: '0', PLATFORM_FEE_BPS: '0' });
      expect(config.FREE_ORDERS).toBe(0);
      expect(config.PLATFORM_FEE_BPS).toBe(0);
    });

    it('refuses a slipped zero (30% typed for 3%), a negative or a fractional value', () => {
      expect(() => parseEnv({ ...valid, PLATFORM_FEE_BPS: '3000' })).toThrow(/PLATFORM_FEE_BPS/);
      expect(() => parseEnv({ ...valid, PLATFORM_FEE_BPS: '-1' })).toThrow(/PLATFORM_FEE_BPS/);
      expect(() => parseEnv({ ...valid, PLATFORM_FEE_BPS: '2.5' })).toThrow(/PLATFORM_FEE_BPS/);
      expect(() => parseEnv({ ...valid, FREE_ORDERS: '-5' })).toThrow(/FREE_ORDERS/);
      expect(() => parseEnv({ ...valid, FREE_ORDERS: 'fifty' })).toThrow(/FREE_ORDERS/);
    });

    it('still lets the per-order fee be switched back on', () => {
      expect(parseEnv({ ...valid, PLATFORM_FEE_BPS: '300' }).PLATFORM_FEE_BPS).toBe(300);
    });

    it('treats a blank PAYSTACK_SECRET_KEY (as in .env.example) as not set', () => {
      expect(parseEnv({ ...valid, PAYSTACK_SECRET_KEY: '' }).PAYSTACK_SECRET_KEY).toBeUndefined();
      expect(parseEnv({ ...valid, PAYSTACK_SECRET_KEY: '   ' }).PAYSTACK_SECRET_KEY).toBeUndefined();
    });

    it('accepts a key that starts with sk_', () => {
      expect(parseEnv({ ...valid, PAYSTACK_SECRET_KEY: 'sk_test_dummy' }).PAYSTACK_SECRET_KEY).toBe('sk_test_dummy');
    });

    it('rejects a key that does not start with sk_ WITHOUT repeating it in the error', () => {
      // A publishable key pasted by mistake: refuse it, and never print it.
      const pasted = 'pk_live_ThisMustNeverAppearInALog123';
      let message = '';
      try {
        parseEnv({ ...valid, PAYSTACK_SECRET_KEY: pasted });
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toMatch(/PAYSTACK_SECRET_KEY must start with sk_/);
      expect(message).not.toContain(pasted);
      expect(message).not.toContain('ThisMustNeverAppear');
    });

    it('validates PAYSTACK_CALLBACK_URL as an http(s) URL, and treats blank as not set', () => {
      expect(parseEnv({ ...valid, PAYSTACK_CALLBACK_URL: 'https://choplistafrica.com/pay/done' }).PAYSTACK_CALLBACK_URL).toBe(
        'https://choplistafrica.com/pay/done',
      );
      expect(parseEnv({ ...valid, PAYSTACK_CALLBACK_URL: '' }).PAYSTACK_CALLBACK_URL).toBeUndefined();
      expect(() => parseEnv({ ...valid, PAYSTACK_CALLBACK_URL: 'choplistafrica.com/pay' })).toThrow(/PAYSTACK_CALLBACK_URL/);
      expect(() => parseEnv({ ...valid, PAYSTACK_CALLBACK_URL: 'javascript:alert(1)' })).toThrow(/PAYSTACK_CALLBACK_URL/);
    });
  });

  it('rejects an empty ALLOWED_ORIGINS list', () => {
    expect(() => parseEnv({ ...valid, ALLOWED_ORIGINS: ' , ' })).toThrow(/at least one origin/);
  });

  it('rejects Clerk keys that are missing or swapped', () => {
    const { CLERK_SECRET_KEY: _unused, ...withoutSecret } = valid;
    expect(() => parseEnv(withoutSecret)).toThrow(/CLERK_SECRET_KEY is required/);
    expect(() =>
      parseEnv({ ...valid, CLERK_SECRET_KEY: valid.CLERK_PUBLISHABLE_KEY, CLERK_PUBLISHABLE_KEY: valid.CLERK_SECRET_KEY }),
    ).toThrow(/must start with sk_[\s\S]*must start with pk_/);
  });

  it('TRUST_PROXY_HOPS defaults to 1, accepts 0 to 5, and rejects anything else', () => {
    expect(parseEnv(valid).TRUST_PROXY_HOPS).toBe(1);
    expect(parseEnv({ ...valid, TRUST_PROXY_HOPS: '2' }).TRUST_PROXY_HOPS).toBe(2);
    expect(parseEnv({ ...valid, TRUST_PROXY_HOPS: '0' }).TRUST_PROXY_HOPS).toBe(0);
    for (const bad of ['-1', '6', '1.5', 'two']) {
      expect(() => parseEnv({ ...valid, TRUST_PROXY_HOPS: bad })).toThrow(/TRUST_PROXY_HOPS/);
    }
  });

  it('rejects a non-numeric PORT', () => {
    expect(() => parseEnv({ ...valid, PORT: 'abc' })).toThrow(/PORT/);
  });
});
