import { createHmac } from 'node:crypto';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { EventLogModel } from '../src/models/event-log.js';
import { OrderModel } from '../src/models/order.js';
import { PaymentModel } from '../src/models/payment.js';
import { SellerModel } from '../src/models/seller.js';
import { generateAccessKey, hashAccessKey } from '../src/orders/delivery-code.js';
import { generateRef } from '../src/orders/reference.js';
import { PaystackError } from '../src/payments/paystack.js';
import { signatureMatches } from '../src/payments/webhook.js';
import { redactKeys } from '../src/events/log.js';
import { connectTestDb, disconnectTestDb, testDbUri } from './helpers/db.js';
import { fakeAuth, bearer } from './helpers/fake-auth.js';
import { fakePaystack } from './helpers/fake-paystack.js';

// Obviously fake. The real key is never needed or used by any test.
const SECRET = 'sk_test_not_a_real_key_for_tests';
const LIMITS = { windowMs: 60_000, ordersPerWindow: 1000, lookupsPerWindow: 1000, paymentsPerWindow: 1000 };
const URL_PATH = '/api/webhooks/paystack';

let paystack = fakePaystack();
let secretConfigured = true;
let app = buildApp();

function buildApp() {
  return createApp({
    allowedOrigins: ['http://localhost:5173'],
    auth: fakeAuth,
    paystack,
    paystackSecretKey: secretConfigured ? SECRET : undefined,
    pricing: { freeOrders: 50, platformFeeBps: 300 },
    rateLimits: LIMITS,
  });
}

const sign = (body: string | Buffer, secret = SECRET) => createHmac('sha512', secret).update(body).digest('hex');

function deliver(body: string, opts: { signature?: string | null; contentType?: string } = {}) {
  const req = request(app).post(URL_PATH).set('Content-Type', opts.contentType ?? 'application/json');
  const signature = opts.signature === undefined ? sign(body) : opts.signature;
  return (signature === null ? req : req.set('x-paystack-signature', signature)).send(body);
}

const chargeSuccess = (reference: string) => JSON.stringify({ event: 'charge.success', data: { reference, status: 'success', amount: 1 } });

type Started = { orderId: Types.ObjectId; sellerId: Types.ObjectId; ref: string; key: string; reference: string; amountKobo: number };
let counter = 0;

async function makeSeller(overrides: Record<string, unknown> = {}) {
  counter += 1;
  return SellerModel.create({
    clerkUserId: `user_${counter}`,
    businessName: `Kitchen ${counter}`,
    slug: `kitchen-${counter}`,
    phone: '+2348031234567',
    payment: { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Owner', bankCode: '058' },
    paymentsReady: true,
    paystackSubaccountCode: `ACCT_seller${counter}`,
    ...overrides,
  });
}

async function makeOrder(sellerId: Types.ObjectId, total = 7500) {
  const key = generateAccessKey();
  const ref = generateRef();
  const order = await OrderModel.create({
    ref,
    sellerId,
    menuId: new Types.ObjectId(),
    customer: { name: 'Ada Customer', phone: '+2348091112222' },
    delivery: { area: 'Yaba', address: '12 Herbert Macaulay Way', day: '2026-10-17' },
    lines: [{ itemId: new Types.ObjectId(), name: 'Jollof rice', unitPrice: total, qty: 1 }],
    total,
    accessKeyHash: hashAccessKey(key),
  });
  return { orderId: order._id, ref, key };
}

// Starts a payment through the real /pay route, so the Payment row is exactly
// what production would have written.
async function attempt(order: { orderId: Types.ObjectId; ref: string; key: string }, sellerId: Types.ObjectId): Promise<Started> {
  const res = await request(app).post(`/api/public/orders/${order.ref}/pay`).set('X-Order-Key', order.key);
  if (res.status !== 200) throw new Error(`pay failed: ${res.status} ${JSON.stringify(res.body)}`);
  const payment = await PaymentModel.findOne({ reference: res.body.reference });
  return { ...order, sellerId, reference: res.body.reference as string, amountKobo: payment!.amountKobo };
}

async function started(sellerOverrides: Record<string, unknown> = {}, total = 7500): Promise<Started> {
  const seller = await makeSeller(sellerOverrides);
  return attempt(await makeOrder(seller._id, total), seller._id);
}

// What Paystack will say when the webhook handler asks it about a reference.
function paystackSays(p: Started | Started[], over: Record<string, unknown> = {}) {
  const all = Array.isArray(p) ? p : [p];
  paystack.verifyTransaction.mockImplementation(async (reference) => {
    const found = all.find((x) => x.reference === reference);
    if (!found) throw new PaystackError('rejected', 'Transaction reference not found', 404);
    return { status: 'success', reference, amountKobo: found.amountKobo, currency: 'NGN', ...over } as never;
  });
}

const order = (p: Started) => OrderModel.findById(p.orderId).lean();
const seller = (p: Started) => SellerModel.findById(p.sellerId).lean();
const payment = (p: Started) => PaymentModel.findOne({ reference: p.reference }).lean();
const issues = (code?: string) => EventLogModel.find({ type: 'payment_webhook_issue', ...(code ? { code } : {}) }).lean();

describe('redactKeys', () => {
  it('hides key-shaped text and leaves ordinary words alone', () => {
    expect(redactKeys('Invalid key sk_test_AbC123xyz given')).toBe('Invalid key [redacted] given');
    expect(redactKeys('sk_live_abc and pk_test_def and rk_live_ghi')).toBe('[redacted] and [redacted] and [redacted]');
    expect(redactKeys('Transaction reference not found')).toBe('Transaction reference not found');
    expect(redactKeys('risk_test is a word')).toBe('risk_test is a word');
  });
});

describe('signatureMatches', () => {
  const body = Buffer.from('{"event":"charge.success"}');
  it('accepts the HMAC-SHA512 of the exact bytes', () => expect(signatureMatches(body, sign(body), SECRET)).toBe(true));
  it('accepts upper-case hex', () => expect(signatureMatches(body, sign(body).toUpperCase(), SECRET)).toBe(true));
  it('refuses a different body, key, or a one-character change', () => {
    expect(signatureMatches(Buffer.from('{"event":"charge.success" }'), sign(body), SECRET)).toBe(false);
    expect(signatureMatches(body, sign(body, 'sk_test_other'), SECRET)).toBe(false);
    const flipped = sign(body).replace(/^./, (c) => (c === 'a' ? 'b' : 'a'));
    expect(signatureMatches(body, flipped, SECRET)).toBe(false);
  });
  it('refuses a missing, empty, short, long or non-hex signature without computing anything', () => {
    for (const bad of [undefined, '', 'abc', sign(body).slice(2), `${sign(body)}00`, 'z'.repeat(128)]) {
      expect(signatureMatches(body, bad, SECRET), String(bad)).toBe(false);
    }
  });
  it('refuses the signature of the empty body when the body is not empty', () => {
    expect(signatureMatches(body, sign(Buffer.alloc(0)), SECRET)).toBe(false);
  });
});

describe.skipIf(!testDbUri)('POST /api/webhooks/paystack on a real MongoDB', () => {
  beforeAll(async () => {
    await connectTestDb('webhook');
  });
  afterAll(async () => {
    await disconnectTestDb();
  });
  beforeEach(async () => {
    paystack = fakePaystack();
    secretConfigured = true;
    app = buildApp();
    await Promise.all([SellerModel.deleteMany({}), OrderModel.deleteMany({}), PaymentModel.deleteMany({}), EventLogModel.deleteMany({})]);
  });

  describe('the signature', () => {
    it('a request with no signature, a wrong one, or one made with another key is 401 and changes nothing', async () => {
      const p = await started();
      paystackSays(p);
      const body = chargeSuccess(p.reference);
      const attempts = [
        await deliver(body, { signature: null }),
        await deliver(body, { signature: 'f'.repeat(128) }),
        await deliver(body, { signature: sign(body, 'sk_test_someone_elses_key') }),
        await deliver(body, { signature: 'not hex at all' }),
        await deliver(body, { signature: '' }),
      ];
      for (const res of attempts) {
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('INVALID_SIGNATURE');
      }
      expect(paystack.verifyTransaction).not.toHaveBeenCalled();
      expect((await order(p))!.status).toBe('pending');
      expect((await seller(p))!.paidOrderCount).toBe(0);
      expect((await payment(p))!.status).toBe('initialized');
    });

    it('an empty body without a signature is 401', async () => {
      expect((await deliver('', { signature: null })).status).toBe(401);
      expect((await deliver('', { signature: 'f'.repeat(128) })).status).toBe(401);
    });

    it('an empty body with a genuine signature is acknowledged and ignored (only the key holder can make one)', async () => {
      expect((await deliver('', { signature: sign('') })).status).toBe(200);
      expect(paystack.verifyTransaction).not.toHaveBeenCalled();
    });

    it('a signature for a different event cannot be reused on this one', async () => {
      const a = await started();
      const b = await started();
      paystackSays([a, b]);
      const res = await deliver(chargeSuccess(b.reference), { signature: sign(chargeSuccess(a.reference)) });
      expect(res.status).toBe(401);
      expect((await order(b))!.status).toBe('pending');
    });

    it('is checked against the RAW bytes: odd spacing that was signed as sent is accepted', async () => {
      const p = await started();
      paystackSays(p);
      const spaced = `{\n  "event" :  "charge.success",\n  "data":{"reference":"${p.reference}"}\n}`;
      const res = await deliver(spaced);
      expect(res.status).toBe(200);
      expect((await order(p))!.status).toBe('paid');
    });

    it('...and a body that only matches after being parsed and re-serialised is refused', async () => {
      const p = await started();
      paystackSays(p);
      const compact = chargeSuccess(p.reference);
      const reformatted = JSON.stringify(JSON.parse(compact), null, 2);
      expect(reformatted).not.toBe(compact);
      const res = await deliver(reformatted, { signature: sign(compact) });
      expect(res.status).toBe(401);
      expect((await order(p))!.status).toBe('pending');
    });

    it('does not depend on the content type', async () => {
      const p = await started();
      paystackSays(p);
      expect((await deliver(chargeSuccess(p.reference), { contentType: 'text/plain' })).status).toBe(200);
      expect((await order(p))!.status).toBe('paid');
    });

    it('is 503 when no Paystack key is configured, and never accepts anything', async () => {
      const p = await started();
      secretConfigured = false;
      app = buildApp();
      const body = chargeSuccess(p.reference);
      const res = await deliver(body, { signature: sign(body, '') });
      expect(res.status).toBe(503);
      expect((await order(p))!.status).toBe('pending');
    });

    it('refuses a huge body (413) without reading it into memory', async () => {
      const res = await deliver('x'.repeat(200_000), { signature: 'f'.repeat(128) });
      expect(res.status).toBe(413);
    });

    it('only POST is a webhook', async () => {
      expect((await request(app).get(URL_PATH)).status).toBe(404);
    });

    it('JSON parsing is untouched for every other route', async () => {
      const res = await request(app).put('/api/sellers/me').set('Authorization', bearer('someone')).send({ businessName: 'x' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('a good payment', () => {
    it('marks the order paid by Paystack, records the payment and counts it for the seller', async () => {
      const p = await started();
      paystackSays(p);
      const res = await deliver(chargeSuccess(p.reference));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true });

      expect(paystack.verifyTransaction).toHaveBeenCalledExactlyOnceWith(p.reference);
      const o = await order(p);
      expect(o).toMatchObject({ status: 'paid', paymentMethod: 'paystack', total: 7500, serviceFee: 216, platformFeeBps: 0, platformFeeKobo: 0 });
      expect(o!.paidAt).toBeInstanceOf(Date);
      expect(o!.paystackFeeKobo).toBeGreaterThan(0);
      const pay = await payment(p);
      expect(pay!.status).toBe('succeeded');
      expect(pay!.paidAt).toBeInstanceOf(Date);
      expect((await seller(p))!.paidOrderCount).toBe(1);
      expect(await issues()).toHaveLength(0);
    });

    it('takes the amount from Paystack\'s verify call, not from the webhook body', async () => {
      const p = await started();
      paystackSays(p);
      // The webhook body claims a wrong amount and status; only the verified figures count.
      const body = JSON.stringify({ event: 'charge.success', data: { reference: p.reference, status: 'success', amount: 100 } });
      expect((await deliver(body)).status).toBe(200);
      expect((await order(p))!.status).toBe('paid');
    });

    it('a seller-pays order is paid at its base amount', async () => {
      const p = await started({ feeMode: 'seller', paidOrderCount: 50 });
      paystackSays(p);
      await deliver(chargeSuccess(p.reference));
      expect(await order(p)).toMatchObject({ status: 'paid', serviceFee: 0, platformFeeBps: 300, platformFeeKobo: 22_500 });
      expect(p.amountKobo).toBe(750_000);
    });

    it('does not touch another seller\'s count or another order', async () => {
      const a = await started();
      const b = await started();
      paystackSays([a, b]);
      await deliver(chargeSuccess(a.reference));
      expect((await seller(a))!.paidOrderCount).toBe(1);
      expect((await seller(b))!.paidOrderCount).toBe(0);
      expect((await order(b))!.status).toBe('pending');
      expect((await payment(b))!.status).toBe('initialized');
    });
  });

  describe('sending the same event again', () => {
    it('three deliveries of one event count the payment once', async () => {
      const p = await started();
      paystackSays(p);
      const first = await deliver(chargeSuccess(p.reference));
      const paidAt = (await order(p))!.paidAt;
      const second = await deliver(chargeSuccess(p.reference));
      const third = await deliver(chargeSuccess(p.reference));
      for (const res of [first, second, third]) expect(res.status).toBe(200);

      expect((await seller(p))!.paidOrderCount).toBe(1);
      expect((await order(p))!.paidAt).toEqual(paidAt);
      expect(await PaymentModel.countDocuments({ orderId: p.orderId, status: 'succeeded' })).toBe(1);
      // Once confirmed, repeats do not even ask Paystack again.
      expect(paystack.verifyTransaction).toHaveBeenCalledTimes(1);
      expect(await issues()).toHaveLength(0);
    });

    it('ten deliveries arriving at the same moment count the payment once', async () => {
      const p = await started();
      paystackSays(p);
      const results = await Promise.all(Array.from({ length: 10 }, () => deliver(chargeSuccess(p.reference))));
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect((await seller(p))!.paidOrderCount).toBe(1);
      expect(await PaymentModel.countDocuments({ orderId: p.orderId, status: 'succeeded' })).toBe(1);
      expect((await order(p))!.status).toBe('paid');
      expect(await issues()).toHaveLength(0);
    });

    it('fifty different orders paid at the same moment all count, none twice', async () => {
      const sellerDoc = await makeSeller();
      const all = await Promise.all(Array.from({ length: 50 }, async () => attempt(await makeOrder(sellerDoc._id), sellerDoc._id)));
      paystackSays(all);
      // Each event is delivered twice, all 100 at once.
      const results = await Promise.all(all.flatMap((p) => [deliver(chargeSuccess(p.reference)), deliver(chargeSuccess(p.reference))]));
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect((await SellerModel.findById(sellerDoc._id).lean())!.paidOrderCount).toBe(50);
      expect(await OrderModel.countDocuments({ status: 'paid', paymentMethod: 'paystack' })).toBe(50);
    });

    it('after a crash between "payment recorded" and "order marked paid", the next delivery finishes the job', async () => {
      const p = await started();
      paystackSays(p);
      // The state a crash would leave: the payment is succeeded, the order untouched.
      await PaymentModel.updateOne({ reference: p.reference }, { $set: { status: 'succeeded', paidAt: new Date() } });
      expect((await order(p))!.status).toBe('pending');

      expect((await deliver(chargeSuccess(p.reference))).status).toBe(200);
      expect(await order(p)).toMatchObject({ status: 'paid', paymentMethod: 'paystack' });
      expect((await seller(p))!.paidOrderCount).toBe(1);
      // ...and still only once if it arrives yet again.
      await deliver(chargeSuccess(p.reference));
      expect((await seller(p))!.paidOrderCount).toBe(1);
    });

    it('a seller who cancels a Paystack-paid order does not turn a later redelivery into a problem', async () => {
      const p = await started();
      paystackSays(p);
      await deliver(chargeSuccess(p.reference));
      await OrderModel.updateOne({ _id: p.orderId }, { $set: { status: 'cancelled' } });
      expect((await deliver(chargeSuccess(p.reference))).status).toBe(200);
      expect((await payment(p))!.status).toBe('succeeded');
      expect(await issues()).toHaveLength(0);
      expect((await seller(p))!.paidOrderCount).toBe(1);
    });
  });

  describe('the free-order boundary', () => {
    it('the 50th Paystack payment is the last free one; the next quote is charged', async () => {
      const sellerDoc = await makeSeller({ paidOrderCount: 49 });
      const fiftieth = await attempt(await makeOrder(sellerDoc._id), sellerDoc._id);
      expect((await order(fiftieth))!.platformFeeBps).toBe(0);
      paystackSays(fiftieth);
      await deliver(chargeSuccess(fiftieth.reference));
      expect((await SellerModel.findById(sellerDoc._id).lean())!.paidOrderCount).toBe(50);

      const fiftyFirst = await attempt(await makeOrder(sellerDoc._id), sellerDoc._id);
      expect((await order(fiftyFirst))).toMatchObject({ platformFeeBps: 300, platformFeeKobo: 22_500 });
    });
  });

  describe('the order gets the figures of the attempt that was actually paid', () => {
    it('paying the first attempt after the seller switched fee mode keeps the first attempt\'s service fee', async () => {
      const sellerDoc = await makeSeller();
      const o = await makeOrder(sellerDoc._id);
      const first = await attempt(o, sellerDoc._id); // customer pays fees: 216
      await SellerModel.updateOne({ _id: sellerDoc._id }, { $set: { feeMode: 'seller' } });
      const second = await attempt(o, sellerDoc._id); // seller pays: 0
      expect((await order(second))!.serviceFee).toBe(0); // the order shows the newest quote...

      paystackSays([first, second]);
      await deliver(chargeSuccess(first.reference)); // ...but the customer paid the first one
      expect(await order(first)).toMatchObject({ status: 'paid', serviceFee: 216 });
      expect(first.amountKobo).toBe(771_600);
    });
  });

  describe('a customer who pays twice', () => {
    it('only one payment counts; the other is set aside for refund and flagged', async () => {
      const sellerDoc = await makeSeller();
      const o = await makeOrder(sellerDoc._id);
      const a = await attempt(o, sellerDoc._id);
      const b = await attempt(o, sellerDoc._id);
      paystackSays([a, b]);

      const results = await Promise.all([deliver(chargeSuccess(a.reference)), deliver(chargeSuccess(b.reference))]);
      expect(results.every((r) => r.status === 200)).toBe(true);

      const statuses = [(await payment(a))!.status, (await payment(b))!.status].sort();
      expect(statuses).toEqual(['needs_review', 'succeeded']);
      expect((await SellerModel.findById(sellerDoc._id).lean())!.paidOrderCount).toBe(1);
      expect((await OrderModel.findById(o.orderId).lean())!.status).toBe('paid');
      const flagged = await issues('DUPLICATE_PAYMENT');
      expect(flagged).toHaveLength(1);
      expect(flagged[0]).toMatchObject({ level: 'error', orderRef: o.ref });
    });

    it('the second payment arriving a day later is also set aside, not counted', async () => {
      const sellerDoc = await makeSeller();
      const o = await makeOrder(sellerDoc._id);
      const a = await attempt(o, sellerDoc._id);
      const b = await attempt(o, sellerDoc._id);
      paystackSays([a, b]);
      await deliver(chargeSuccess(a.reference));
      await deliver(chargeSuccess(b.reference));
      expect((await payment(b))!.status).toBe('needs_review');
      expect((await SellerModel.findById(sellerDoc._id).lean())!.paidOrderCount).toBe(1);
    });
  });

  describe('money that does not match what we asked for', () => {
    it.each([
      ['less than asked', { amountKobo: 100 }],
      ['more than asked', { amountKobo: 99_999_999 }],
      ['one kobo off', { amountKobo: -1 }],
      ['another currency', { currency: 'USD' }],
    ])('%s: not paid, set aside for a human, 200 so Paystack stops resending', async (_name, over) => {
      const p = await started();
      const delta = (over as { amountKobo?: number }).amountKobo;
      paystackSays(p, delta === -1 ? { amountKobo: p.amountKobo - 1 } : over);
      const res = await deliver(chargeSuccess(p.reference));
      expect(res.status).toBe(200);
      expect((await order(p))!.status).toBe('pending');
      expect((await order(p))!.paymentMethod).toBe('transfer');
      expect((await seller(p))!.paidOrderCount).toBe(0);
      expect((await payment(p))!.status).toBe('needs_review');
      const flagged = await issues('AMOUNT_MISMATCH');
      expect(flagged).toHaveLength(1);
      expect(flagged[0]!.meta).toMatchObject({ expectedKobo: p.amountKobo, reference: p.reference });
    });

    it('a payment set aside while the webhook is still asking Paystack is not revived by that webhook', async () => {
      const p = await started();
      paystack.verifyTransaction.mockImplementation(async (reference) => {
        // Meanwhile (another delivery, or a person) sets the payment aside for review.
        await PaymentModel.updateOne({ reference }, { $set: { status: 'needs_review' } });
        return { status: 'success', reference, amountKobo: p.amountKobo, currency: 'NGN' };
      });
      expect((await deliver(chargeSuccess(p.reference))).status).toBe(200);
      expect((await payment(p))!.status).toBe('needs_review');
      expect((await order(p))!.status).toBe('pending');
      expect((await seller(p))!.paidOrderCount).toBe(0);
    });

    it('a redelivery of a mismatched payment does not pay it later', async () => {
      const p = await started();
      paystackSays(p, { amountKobo: 100 });
      await deliver(chargeSuccess(p.reference));
      paystackSays(p); // even if Paystack later reports the right figure
      await deliver(chargeSuccess(p.reference));
      expect((await order(p))!.status).toBe('pending');
      expect((await payment(p))!.status).toBe('needs_review');
    });

    it.each([['failed'], ['abandoned'], ['pending'], ['reversed']])('Paystack status "%s" is not a payment', async (status) => {
      const p = await started();
      paystackSays(p, { status });
      expect((await deliver(chargeSuccess(p.reference))).status).toBe(200);
      expect((await order(p))!.status).toBe('pending');
      expect((await seller(p))!.paidOrderCount).toBe(0);
      expect((await payment(p))!.status).toBe('initialized'); // can still succeed later
      expect(await issues('NOT_CONFIGURED')).toHaveLength(0);
      expect(await issues('NOT_CONFIRMED')).toHaveLength(1);
    });

    it('Paystack answering about a different reference is not a payment', async () => {
      const p = await started();
      paystack.verifyTransaction.mockResolvedValue({ status: 'success', reference: 'CLP-aaaaaaaaaaaaaaaaaaaaaaaa', amountKobo: p.amountKobo, currency: 'NGN' });
      await deliver(chargeSuccess(p.reference));
      expect((await order(p))!.status).toBe('pending');
    });

    it('Paystack not knowing the reference is not a payment', async () => {
      const p = await started();
      paystack.verifyTransaction.mockRejectedValue(new PaystackError('rejected', 'Transaction reference not found', 404));
      expect((await deliver(chargeSuccess(p.reference))).status).toBe(200);
      expect((await order(p))!.status).toBe('pending');
      expect(await issues('NOT_CONFIRMED')).toHaveLength(1);
    });
  });

  describe('when Paystack cannot be asked', () => {
    it('answers 503 so Paystack resends, changes nothing, and the resend then works', async () => {
      const p = await started();
      paystack.verifyTransaction.mockRejectedValueOnce(new PaystackError('unavailable', 'Could not reach Paystack'));
      const res = await deliver(chargeSuccess(p.reference));
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('PAYMENTS_UNAVAILABLE');
      expect((await order(p))!.status).toBe('pending');
      expect((await payment(p))!.status).toBe('initialized');
      expect((await seller(p))!.paidOrderCount).toBe(0);
      expect(await issues('VERIFY_FAILED')).toHaveLength(1);

      paystackSays(p);
      expect((await deliver(chargeSuccess(p.reference))).status).toBe(200);
      expect((await order(p))!.status).toBe('paid');
      expect((await seller(p))!.paidOrderCount).toBe(1);
    });

    it('an unexpected crash while verifying is a 500, never a silent success', async () => {
      const p = await started();
      paystack.verifyTransaction.mockRejectedValueOnce(new TypeError('boom'));
      expect((await deliver(chargeSuccess(p.reference))).status).toBe(500);
      expect((await order(p))!.status).toBe('pending');
    });
  });

  describe('an order that can no longer be paid', () => {
    it('cancelled before the money arrived: not marked paid, set aside for refund, not counted', async () => {
      const p = await started();
      await OrderModel.updateOne({ _id: p.orderId }, { $set: { status: 'cancelled', cancelledAt: new Date() } });
      paystackSays(p);
      expect((await deliver(chargeSuccess(p.reference))).status).toBe(200);

      expect(await order(p)).toMatchObject({ status: 'cancelled', paymentMethod: 'transfer' });
      expect((await order(p))!.paidAt).toBeUndefined();
      expect((await seller(p))!.paidOrderCount).toBe(0);
      expect((await payment(p))!.status).toBe('needs_review');
      const flagged = await issues('ORDER_NOT_PAYABLE');
      expect(flagged).toHaveLength(1);
      expect(flagged[0]).toMatchObject({ level: 'error', orderRef: p.ref });
      expect(flagged[0]!.meta).toMatchObject({ orderStatus: 'cancelled' });
    });

    it('already marked paid by the seller (bank transfer): the Paystack money is flagged, the count is not touched', async () => {
      const p = await started();
      await OrderModel.updateOne({ _id: p.orderId }, { $set: { status: 'paid', paidAt: new Date() } });
      paystackSays(p);
      await deliver(chargeSuccess(p.reference));
      expect(await order(p)).toMatchObject({ status: 'paid', paymentMethod: 'transfer' });
      expect((await seller(p))!.paidOrderCount).toBe(0);
      expect((await payment(p))!.status).toBe('needs_review');
      expect(await issues('ORDER_NOT_PAYABLE')).toHaveLength(1);
    });

    it('a redelivery of a flagged payment does not change its outcome', async () => {
      const p = await started();
      await OrderModel.updateOne({ _id: p.orderId }, { $set: { status: 'cancelled' } });
      paystackSays(p);
      await deliver(chargeSuccess(p.reference));
      await deliver(chargeSuccess(p.reference));
      expect((await payment(p))!.status).toBe('needs_review');
      expect(await issues('ORDER_NOT_PAYABLE')).toHaveLength(1);
      expect((await seller(p))!.paidOrderCount).toBe(0);
    });
  });

  describe('events that are not for us to act on', () => {
    it('a payment reference we have no record of: 200, logged, never looked up at Paystack', async () => {
      const res = await deliver(chargeSuccess('CLP-0123456789abcdef01234567'));
      expect(res.status).toBe(200);
      expect(paystack.verifyTransaction).not.toHaveBeenCalled();
      expect(await issues('UNKNOWN_REFERENCE')).toHaveLength(1);
    });

    it.each([['charge.failed'], ['transfer.success'], ['refund.processed'], ['subscription.create'], ['something.new']])(
      '%s is acknowledged and ignored',
      async (event) => {
        const p = await started();
        paystackSays(p);
        const res = await deliver(JSON.stringify({ event, data: { reference: p.reference } }));
        expect(res.status).toBe(200);
        expect(paystack.verifyTransaction).not.toHaveBeenCalled();
        expect((await order(p))!.status).toBe('pending');
      },
    );

    it.each([
      ['a reference that is not ours', 'order-123'],
      ['a reference with query characters', { $ne: '' }],
      ['a number', 12345],
      ['a very long string', 'CLP-' + 'a'.repeat(5000)],
      ['an empty string', ''],
      ['null', null],
    ])('%s never reaches the database', async (_name, reference) => {
      const p = await started();
      paystackSays(p);
      const res = await deliver(JSON.stringify({ event: 'charge.success', data: { reference } }));
      expect(res.status).toBe(200);
      expect(paystack.verifyTransaction).not.toHaveBeenCalled();
      expect((await order(p))!.status).toBe('pending');
      expect(await issues()).toHaveLength(0);
    });

    it('a signed body that is not JSON, or has no data, is acknowledged and ignored', async () => {
      for (const body of ['not json', '[]', 'null', '"text"', '{"event":"charge.success"}', '{"event":"charge.success","data":null}']) {
        const res = await deliver(body);
        expect(res.status, body).toBe(200);
      }
      expect(paystack.verifyTransaction).not.toHaveBeenCalled();
    });
  });

  describe('secrets', () => {
    it('no response or event holds the key, a signature, a phone number, a name or an address', async () => {
      const p = await started();
      const responses = [
        await deliver(chargeSuccess(p.reference), { signature: 'f'.repeat(128) }),
        await deliver(chargeSuccess('CLP-0123456789abcdef01234567')),
      ];
      paystack.verifyTransaction.mockRejectedValueOnce(new PaystackError('unavailable', 'Invalid key sk_test_LEAK', 401));
      responses.push(await deliver(chargeSuccess(p.reference)));
      paystackSays(p, { amountKobo: 1 });
      responses.push(await deliver(chargeSuccess(p.reference)));

      const text = JSON.stringify([responses.map((r) => r.body), await EventLogModel.find().lean()]);
      for (const secret of [SECRET, 'sk_test_LEAK', '+2348091112222', 'Ada Customer', 'Herbert Macaulay', 'ACCT_', p.key]) {
        expect(text, secret).not.toContain(secret);
      }
      expect(text).not.toContain('f'.repeat(128));
    });
  });
});
