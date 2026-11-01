import { describe, expect, it, vi } from 'vitest';
import { PaystackError, createPaystackClient } from '../src/payments/paystack.js';

// A made-up key, obviously not a real one. The point of these tests is that
// whatever it is, it only ever travels in the Authorization header.
const KEY = 'sk_test_not_a_real_key_for_tests';

function reply(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// A fetch stand-in. Never touches the network.
function mockFetch(...replies: Array<Response | Error>) {
  const fn = vi.fn<typeof fetch>();
  for (const r of replies) fn.mockImplementationOnce(async () => { if (r instanceof Error) throw r; return r; });
  return fn;
}

function sent(fn: ReturnType<typeof mockFetch>, call = 0) {
  const [url, init] = fn.mock.calls[call]!;
  return { url: String(url), init: init as RequestInit };
}

async function failure(promise: Promise<unknown>): Promise<PaystackError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(PaystackError);
    return err as PaystackError;
  }
  throw new Error('expected the call to fail');
}

describe('createPaystackClient', () => {
  it('sends the key as a bearer header to api.paystack.co, and nowhere else', async () => {
    const fetchFn = mockFetch(reply(200, { status: true, data: { account_name: 'TITILAYO ADEBAYO' } }));
    await createPaystackClient(KEY, fetchFn).resolveAccount({ bankCode: '058', accountNumber: '0123456789' });
    const { url, init } = sent(fetchFn);
    expect(url).toBe('https://api.paystack.co/bank/resolve?account_number=0123456789&bank_code=058');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(url).not.toContain(KEY);
    expect(String(init.body ?? '')).not.toContain(KEY);
  });

  it('resolveAccount returns the name the bank has on file', async () => {
    const fetchFn = mockFetch(reply(200, { status: true, data: { account_number: '0123456789', account_name: 'TITILAYO ADEBAYO' } }));
    await expect(createPaystackClient(KEY, fetchFn).resolveAccount({ bankCode: '058', accountNumber: '0123456789' })).resolves.toEqual({
      accountName: 'TITILAYO ADEBAYO',
    });
  });

  it('createSubaccount sends the bank details and a 0 default percentage, and returns the code', async () => {
    const fetchFn = mockFetch(reply(201, { status: true, data: { subaccount_code: 'ACCT_abc123' } }));
    const result = await createPaystackClient(KEY, fetchFn).createSubaccount({ businessName: "Mama T's Kitchen", bankCode: '058', accountNumber: '0123456789' });
    expect(result).toEqual({ subaccountCode: 'ACCT_abc123' });
    const { url, init } = sent(fetchFn);
    expect(url).toBe('https://api.paystack.co/subaccount');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      business_name: "Mama T's Kitchen",
      settlement_bank: '058',
      account_number: '0123456789',
      percentage_charge: 0,
    });
  });

  it('updateSubaccount PUTs to the encoded code', async () => {
    const fetchFn = mockFetch(reply(200, { status: true, data: {} }));
    await createPaystackClient(KEY, fetchFn).updateSubaccount('ACCT_a/b', { businessName: 'X Kitchen', bankCode: '044', accountNumber: '0123456789' });
    const { url, init } = sent(fetchFn);
    expect(url).toBe('https://api.paystack.co/subaccount/ACCT_a%2Fb');
    expect(init.method).toBe('PUT');
  });

  it('listBanks follows the cursor, keeps only name and code, and skips inactive banks', async () => {
    const fetchFn = mockFetch(
      reply(200, { status: true, data: [{ name: 'GTBank', code: '058', active: true, slug: 'x', id: 1 }, { name: 'Old Bank', code: '999', active: false }], meta: { next: 'CURSOR1' } }),
      reply(200, { status: true, data: [{ name: 'Access Bank', code: '044' }], meta: { next: null } }),
    );
    await expect(createPaystackClient(KEY, fetchFn).listBanks()).resolves.toEqual([
      { name: 'GTBank', code: '058' },
      { name: 'Access Bank', code: '044' },
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sent(fetchFn, 1).url).toContain('next=CURSOR1');
  });

  it('listBanks stops after a bounded number of pages even if the cursor never ends', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => reply(200, { status: true, data: [], meta: { next: 'AGAIN' } }));
    await createPaystackClient(KEY, fetchFn).listBanks();
    expect(fetchFn.mock.calls.length).toBeLessThanOrEqual(10);
  });

  describe('failures', () => {
    it('a 400 with status:false is "rejected" and carries Paystack\'s own message', async () => {
      const fetchFn = mockFetch(reply(422, { status: false, message: 'Could not resolve account name' }));
      const err = await failure(createPaystackClient(KEY, fetchFn).resolveAccount({ bankCode: '058', accountNumber: '0123456789' }));
      expect(err).toMatchObject({ kind: 'rejected', status: 422, message: 'Could not resolve account name' });
    });

    it('a 200 with status:false is still rejected', async () => {
      const fetchFn = mockFetch(reply(200, { status: false, message: 'nope' }));
      expect((await failure(createPaystackClient(KEY, fetchFn).listBanks())).kind).toBe('rejected');
    });

    it.each([401, 403, 500, 502, 503])('%i is "unavailable": our key or Paystack is at fault, not the seller', async (status) => {
      const fetchFn = mockFetch(reply(status, { status: false, message: 'Invalid key' }));
      expect((await failure(createPaystackClient(KEY, fetchFn).listBanks())).kind).toBe('unavailable');
    });

    it('a network failure is "unavailable" and its message does not include the key', async () => {
      // Some runtimes put the whole request in the error; the client must not pass it on.
      const fetchFn = mockFetch(new Error(`connect ECONNREFUSED while sending Authorization: Bearer ${KEY}`));
      const err = await failure(createPaystackClient(KEY, fetchFn).listBanks());
      expect(err.kind).toBe('unavailable');
      expect(err.message).not.toContain(KEY);
      expect(JSON.stringify(err)).not.toContain(KEY);
      expect(String(err.stack)).not.toContain(KEY);
    });

    it('a reply that is not JSON is "unavailable"', async () => {
      const fetchFn = mockFetch(reply(200, '<html>Bad gateway</html>'));
      expect((await failure(createPaystackClient(KEY, fetchFn).listBanks())).kind).toBe('unavailable');
    });

    it('a success reply with the wrong shape is "unavailable", not a crash or a made-up value', async () => {
      const a = mockFetch(reply(200, { status: true, data: {} }));
      expect((await failure(createPaystackClient(KEY, a).createSubaccount({ businessName: 'X', bankCode: '058', accountNumber: '0123456789' }))).kind).toBe('unavailable');
      const b = mockFetch(reply(200, { status: true, data: { account_name: '' } }));
      expect((await failure(createPaystackClient(KEY, b).resolveAccount({ bankCode: '058', accountNumber: '0123456789' }))).kind).toBe('unavailable');
      const c = mockFetch(reply(200, { status: true, data: 'oops' }));
      expect((await failure(createPaystackClient(KEY, c).listBanks())).kind).toBe('unavailable');
    });

    it('every request carries a timeout signal', async () => {
      const fetchFn = mockFetch(reply(200, { status: true, data: [] }));
      await createPaystackClient(KEY, fetchFn).listBanks();
      expect(sent(fetchFn).init.signal).toBeInstanceOf(AbortSignal);
    });

    it('a very long Paystack message is cut short', async () => {
      const fetchFn = mockFetch(reply(400, { status: false, message: 'x'.repeat(5000) }));
      expect((await failure(createPaystackClient(KEY, fetchFn).listBanks())).message.length).toBeLessThanOrEqual(200);
    });
  });
});
