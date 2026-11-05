import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { backfillBilling } from '../src/billing/backfill.js';
import { SellerModel } from '../src/models/seller.js';
import { connectTestDb, disconnectTestDb, testDbUri } from './helpers/db.js';

const START = new Date('2026-11-10T00:00:00.000Z');
const payment = { bankName: 'GTBank', accountNumber: '0123456789', accountName: 'Owner' };
let n = 0;
const seller = (extra: Record<string, unknown> = {}) => {
  n += 1;
  return { clerkUserId: `user_f${n}`, businessName: `Kitchen ${n}`, slug: `kitchen-f${n}`, phone: '+2348031234567', payment, ...extra };
};

describe.skipIf(!testDbUri)('the billing backfill on a real MongoDB', () => {
  beforeAll(async () => {
    await connectTestDb('billing_backfill');
  });
  afterAll(disconnectTestDb);
  beforeEach(async () => {
    await SellerModel.deleteMany({});
  });

  it('a dry run counts and writes nothing', async () => {
    await SellerModel.create([seller(), seller(), seller()]);
    const r = await backfillBilling({ apply: false, startAt: START, trialDays: 7 });
    expect(r).toMatchObject({ sellersTotal: 3, sellersNeedingTrial: 3, updated: 0 });
    expect(await SellerModel.countDocuments({ 'billing.trialStartedAt': { $exists: true } })).toBe(0);
  });

  it('apply starts every existing seller\'s trial at the chosen date, not at their registration date', async () => {
    const old = await SellerModel.create(seller());
    await SellerModel.collection.updateOne({ _id: old._id }, { $set: { createdAt: new Date('2025-01-01T00:00:00.000Z') } });
    await SellerModel.create(seller());

    const r = await backfillBilling({ apply: true, startAt: START, trialDays: 7 });
    expect(r).toMatchObject({ sellersNeedingTrial: 2, updated: 2 });
    expect(r.trialEndsAt.toISOString()).toBe('2026-11-17T00:00:00.000Z');

    for (const s of await SellerModel.find({})) {
      expect(s.billing!.trialStartedAt.toISOString()).toBe('2026-11-10T00:00:00.000Z');
      expect(s.billing!.trialEndsAt.toISOString()).toBe('2026-11-17T00:00:00.000Z');
      expect(s.billing!.verification!.status).toBe('not_started');
    }
  });

  it('never touches a seller who already has a trial, and a second run changes nothing', async () => {
    const existing = await SellerModel.create(
      seller({ billing: { trialStartedAt: new Date('2026-11-01T00:00:00.000Z'), trialEndsAt: new Date('2026-11-08T00:00:00.000Z'), verification: { status: 'verified' } } }),
    );
    await SellerModel.create(seller());

    const first = await backfillBilling({ apply: true, startAt: START, trialDays: 7 });
    expect(first.updated).toBe(1);
    const kept = (await SellerModel.findById(existing._id))!.billing!;
    expect(kept.trialStartedAt.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(kept.verification!.status).toBe('verified');

    const second = await backfillBilling({ apply: true, startAt: new Date('2027-01-01T00:00:00.000Z'), trialDays: 7 });
    expect(second).toMatchObject({ sellersNeedingTrial: 0, updated: 0 });
    expect((await SellerModel.find({ 'billing.trialStartedAt': START })).length).toBe(1);
  });

  it('counts sellers with and without an email of their own, and how many would use the placeholder', async () => {
    await SellerModel.create([
      seller({ email: 'one@kitchen.ng' }),
      seller({ email: 'two@kitchen.ng' }),
      seller({ clerkUserId: 'user_has_login_email' }),
      seller({ clerkUserId: 'user_no_email_anywhere_1' }),
      seller({ clerkUserId: 'user_no_email_anywhere_2' }),
    ]);

    const unchecked = await backfillBilling({ apply: false, startAt: START, trialDays: 7 });
    expect(unchecked).toMatchObject({ sellersTotal: 5, sellersWithOwnEmail: 2, sellersWithoutOwnEmail: 3, sellersOnPlaceholder: null });

    const lookupEmail = vi.fn(async (id: string) => (id === 'user_has_login_email' ? 'login@account.ng' : null));
    const checked = await backfillBilling({ apply: false, startAt: START, trialDays: 7, lookupEmail });
    expect(checked).toMatchObject({ sellersWithOwnEmail: 2, sellersWithoutOwnEmail: 3, sellersOnPlaceholder: 2 });
    // Only sellers without an email of their own are looked up.
    expect(lookupEmail.mock.calls.map(([id]) => id).sort()).toEqual(['user_has_login_email', 'user_no_email_anywhere_1', 'user_no_email_anywhere_2']);
  });

  it('treats an empty-string email as no email', async () => {
    await SellerModel.collection.insertOne({ ...seller(), email: '', createdAt: new Date(), updatedAt: new Date() });
    const r = await backfillBilling({ apply: false, startAt: START, trialDays: 7 });
    expect(r).toMatchObject({ sellersWithOwnEmail: 0, sellersWithoutOwnEmail: 1 });
  });

  it('puts nothing personal in its result', async () => {
    await SellerModel.create(seller({ email: 'private@kitchen.ng' }));
    const r = await backfillBilling({ apply: true, startAt: START, trialDays: 7 });
    const text = JSON.stringify(r);
    expect(text).not.toMatch(/private@|2348031234567|0123456789|user_f/);
  });
});
