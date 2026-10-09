import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { defineConfig } from 'vitest/config';

// Pick up MONGO_URI_TEST from the root .env (if present and not already set),
// so "npm test" runs the database tests without typing the variable.
// parseEnv only reads the file; nothing else from .env reaches the tests.
if (!process.env.MONGO_URI_TEST && existsSync('../.env')) {
  const fromFile = parseEnv(readFileSync('../.env', 'utf8'));
  if (fromFile.MONGO_URI_TEST) process.env.MONGO_URI_TEST = fromFile.MONGO_URI_TEST;
}

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // server.ts only wires real Clerk + Mongo + listen; it is checked by
      // starting the built server, not by unit tests.
      exclude: ['src/server.ts'],
      reporter: ['text', 'html'],
    },
  },
});
