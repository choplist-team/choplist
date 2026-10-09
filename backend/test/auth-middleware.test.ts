import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { currentSellerId, currentUserId } from '../src/auth/middleware.js';

// A route that forgot requireUser / requireSeller must fail loudly, not run
// a query with an undefined seller id.
describe('auth accessors', () => {
  it('throw when the middleware did not run', () => {
    const bare = {} as Request;
    expect(() => currentUserId(bare)).toThrow('currentUserId used without requireUser');
    expect(() => currentSellerId(bare)).toThrow('currentSellerId used without requireSeller');
  });
});
