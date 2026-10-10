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
