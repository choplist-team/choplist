import { beforeEach, describe, expect, it, vi } from 'vitest';

// The real Clerk is never contacted: the SDK is replaced, so these tests prove how
// we PICK an email from what Clerk would return, and that a failure gives nothing.
//
// The stand-in is a plain function, not vi.fn(): a vi.fn() that returns a rejected
// promise is reported by some vitest versions as an error of its own, even when the
// code under test handles it, which would make this test depend on the tool version.
let getUserImpl: (userId: string) => Promise<unknown> = async () => ({});
const asked: string[] = [];

vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  getAuth: () => ({ userId: null }),
  createClerkClient: () => ({
    users: {
      getUser: (userId: string) => {
        asked.push(userId);
        return getUserImpl(userId);
      },
    },
  }),
}));

const { createClerkEmailLookup } = await import('../src/auth/clerk.js');

const KEY = 'sk_test_not_a_real_key_for_tests';
const address = (id: string, emailAddress: string) => ({ id, emailAddress });

describe('createClerkEmailLookup', () => {
  beforeEach(() => {
    asked.length = 0;
    getUserImpl = async () => ({});
  });

  it('returns the primary email address', async () => {
    getUserImpl = async () => ({ primaryEmailAddressId: 'idn_2', emailAddresses: [address('idn_1', 'old@example.com'), address('idn_2', 'main@example.com')] });
    expect(await createClerkEmailLookup(KEY)('user_1')).toBe('main@example.com');
    expect(asked).toEqual(['user_1']);
  });

  it('falls back to the first address when none is marked primary', async () => {
    getUserImpl = async () => ({ primaryEmailAddressId: null, emailAddresses: [address('idn_1', 'first@example.com'), address('idn_2', 'second@example.com')] });
    expect(await createClerkEmailLookup(KEY)('user_1')).toBe('first@example.com');
  });

  it('returns null for an account with no email', async () => {
    getUserImpl = async () => ({ primaryEmailAddressId: null, emailAddresses: [] });
    expect(await createClerkEmailLookup(KEY)('user_1')).toBeNull();
  });

  it('returns null, and does not throw, when Clerk fails', async () => {
    getUserImpl = async () => {
      throw new Error('Clerk is down');
    };
    await expect(createClerkEmailLookup(KEY)('user_1')).resolves.toBeNull();
  });

  it('returns null, and does not throw, when Clerk rejects an unknown user', async () => {
    getUserImpl = () => Promise.reject(new Error('Not Found'));
    await expect(createClerkEmailLookup(KEY)('user_unknown')).resolves.toBeNull();
  });

  it('returns null when Clerk answers with something unexpected', async () => {
    getUserImpl = async () => ({});
    await expect(createClerkEmailLookup(KEY)('user_1')).resolves.toBeNull();
  });
});
