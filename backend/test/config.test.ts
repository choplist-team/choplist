import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config.js';

const valid = {
  PORT: '5000',
  MONGO_URI: 'mongodb+srv://user:pass@cluster0.example.mongodb.net/choplist',
  ALLOWED_ORIGINS: 'http://localhost:5173, https://choplist.onrender.com',
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

  it('rejects an empty ALLOWED_ORIGINS list', () => {
    expect(() => parseEnv({ ...valid, ALLOWED_ORIGINS: ' , ' })).toThrow(/at least one origin/);
  });

  it('rejects a non-numeric PORT', () => {
    expect(() => parseEnv({ ...valid, PORT: 'abc' })).toThrow(/PORT/);
  });
});
