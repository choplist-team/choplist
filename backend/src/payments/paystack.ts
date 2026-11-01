// The only file that talks to Paystack over HTTP. Everything else (routes,
// webhook) is written against the PaystackClient interface below, so tests hand
// in a fake and never call the real API.
//
// The secret key is passed in once, lives in a closure, and is only ever sent as
// the Authorization header. It is never logged, put in an error message or
// returned: PaystackError carries Paystack's own message text and a status, not
// the request.

export type PaystackBank = { name: string; code: string };

export type PaystackErrorKind =
  // Paystack understood the request and said no (unknown account, bad bank code).
  // The seller can fix it.
  | 'rejected'
  // We could not get a usable answer: network down, timeout, 5xx, bad key, or a
  // reply that was not what Paystack documents. Not the seller's fault; retry later.
  | 'unavailable';

export class PaystackError extends Error {
  readonly kind: PaystackErrorKind;
  readonly status: number | null;

  constructor(kind: PaystackErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = 'PaystackError';
    this.kind = kind;
    this.status = status;
  }
}

export type SubaccountInput = {
  businessName: string;
  bankCode: string;
  accountNumber: string;
};

export type InitializeInput = {
  email: string;
  amountKobo: number;
  reference: string;
  subaccountCode: string;
  // ChopList's cut, in kobo. 0 is left out of the request: Paystack treats an
  // absent value as "use the subaccount's default", which we set to 0%, so both
  // mean the same thing.
  transactionChargeKobo: number;
  // Who Paystack takes its own fee from: 'account' (ChopList) or 'subaccount' (the seller).
  bearer: 'account' | 'subaccount';
  callbackUrl?: string;
  metadata: Record<string, string>;
};

export interface PaystackClient {
  listBanks(): Promise<PaystackBank[]>;
  // Looks the account up at the bank; returns the name the bank has on file.
  resolveAccount(input: { bankCode: string; accountNumber: string }): Promise<{ accountName: string }>;
  createSubaccount(input: SubaccountInput): Promise<{ subaccountCode: string }>;
  updateSubaccount(code: string, input: SubaccountInput): Promise<void>;
  // Starts a payment; the customer is sent to authorizationUrl to pay.
  initializeTransaction(input: InitializeInput): Promise<{ authorizationUrl: string }>;
}

const BASE_URL = 'https://api.paystack.co';
const REQUEST_TIMEOUT_MS = 8_000;
// A bank list is 3 pages at most; the cap stops a misbehaving cursor looping.
const MAX_BANK_PAGES = 10;

type FetchLike = typeof fetch;

type Envelope = { status?: unknown; message?: unknown; data?: unknown; meta?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createPaystackClient(secretKey: string, fetchImpl: FetchLike = fetch): PaystackClient {
  async function call(method: 'GET' | 'POST' | 'PUT', path: string, body?: Record<string, unknown>): Promise<Envelope> {
    let res: Response;
    try {
      res = await fetchImpl(`${BASE_URL}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${secretKey}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // Deliberately not including the original error: some runtimes put the
      // request (headers) in it.
      throw new PaystackError('unavailable', 'Could not reach Paystack');
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new PaystackError('unavailable', `Paystack sent an unreadable reply (${res.status})`, res.status);
    }
    const envelope: Envelope = isRecord(json) ? json : {};
    const message = typeof envelope.message === 'string' ? envelope.message.slice(0, 200) : `Paystack error ${res.status}`;

    // 401/403 means OUR key is wrong or switched off: not something the seller
    // can fix, so it is "unavailable" and shows up in the event log.
    if (res.status === 401 || res.status === 403 || res.status >= 500) {
      throw new PaystackError('unavailable', message, res.status);
    }
    if (res.status >= 400 || envelope.status !== true) {
      throw new PaystackError('rejected', message, res.status);
    }
    return envelope;
  }

  return {
    async listBanks() {
      const banks: PaystackBank[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < MAX_BANK_PAGES; page += 1) {
        const query = new URLSearchParams({ country: 'nigeria', currency: 'NGN', perPage: '100' });
        if (cursor) query.set('next', cursor);
        const envelope = await call('GET', `/bank?${query.toString()}`);
        if (!Array.isArray(envelope.data)) throw new PaystackError('unavailable', 'Paystack sent an unexpected bank list');
        for (const row of envelope.data) {
          if (isRecord(row) && typeof row.name === 'string' && typeof row.code === 'string' && row.active !== false) {
            banks.push({ name: row.name, code: row.code });
          }
        }
        const next = isRecord(envelope.meta) && typeof envelope.meta.next === 'string' ? envelope.meta.next : null;
        if (!next) break;
        cursor = next;
      }
      return banks;
    },

    async resolveAccount({ bankCode, accountNumber }) {
      const query = new URLSearchParams({ account_number: accountNumber, bank_code: bankCode });
      const envelope = await call('GET', `/bank/resolve?${query.toString()}`);
      const name = isRecord(envelope.data) ? envelope.data.account_name : undefined;
      if (typeof name !== 'string' || name === '') throw new PaystackError('unavailable', 'Paystack sent an unexpected account reply');
      return { accountName: name };
    },

    async createSubaccount(input) {
      const envelope = await call('POST', '/subaccount', subaccountBody(input));
      const code = isRecord(envelope.data) ? envelope.data.subaccount_code : undefined;
      if (typeof code !== 'string' || code === '') throw new PaystackError('unavailable', 'Paystack sent an unexpected subaccount reply');
      return { subaccountCode: code };
    },

    async updateSubaccount(code, input) {
      await call('PUT', `/subaccount/${encodeURIComponent(code)}`, subaccountBody(input));
    },

    async initializeTransaction(input) {
      const envelope = await call('POST', '/transaction/initialize', {
        email: input.email,
        amount: input.amountKobo,
        currency: 'NGN',
        reference: input.reference,
        subaccount: input.subaccountCode,
        ...(input.transactionChargeKobo > 0 ? { transaction_charge: input.transactionChargeKobo } : {}),
        bearer: input.bearer,
        ...(input.callbackUrl ? { callback_url: input.callbackUrl } : {}),
        metadata: input.metadata,
      });
      const url = isRecord(envelope.data) ? envelope.data.authorization_url : undefined;
      if (typeof url !== 'string' || !isPaystackPaymentUrl(url)) {
        // We send this address to a customer's browser, so only a Paystack page will do.
        throw new PaystackError('unavailable', 'Paystack sent an unexpected payment page address');
      }
      return { authorizationUrl: url };
    },
  };
}

function isPaystackPaymentUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'paystack.com' || url.hostname.endsWith('.paystack.com'));
  } catch {
    return false;
  }
}

// percentage_charge is Paystack's DEFAULT cut for the platform on this
// subaccount. It is required by the API; we set 0 and send an explicit
// transaction_charge on every payment, so the split never depends on it.
function subaccountBody(input: SubaccountInput): Record<string, unknown> {
  return {
    business_name: input.businessName,
    settlement_bank: input.bankCode,
    account_number: input.accountNumber,
    percentage_charge: 0,
  };
}
