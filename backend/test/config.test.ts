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

  describe('pricing and Paystack settings', () => {
    it('defaults to 50 free orders and a 3% fee, with Paystack off', () => {
      const config = parseEnv(valid);
      expect(config.FREE_ORDERS).toBe(50);
      expect(config.PLATFORM_FEE_BPS).toBe(300);
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
