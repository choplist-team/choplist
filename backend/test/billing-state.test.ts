import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { assertCanShare, computeBillingState, type ConfirmedSubscription } from '../src/billing/state.js';
import { buildPlans, DEFAULT_BILLING } from '../src/billing/plans.js';
import { AppError } from '../src/errors.js';

const PLANS = buildPlans(DEFAULT_BILLING);
const at = (iso: string) => new Date(iso);

// The trial runs 1 November 00:00 to 8 November 00:00 UTC.
const TRIAL = { trialStartedAt: at('2026-11-01T00:00:00.000Z'), trialEndsAt: at('2026-11-08T00:00:00.000Z') };

function sub(plan: 'monthly' | 'quarterly', startsAt: string, expiresAt: string): ConfirmedSubscription {
  return { _id: new Types.ObjectId(), plan, startsAt: at(startsAt), expiresAt: at(expiresAt) };
}

function stateAt(now: string, subscriptions: ConfirmedSubscription[] = [], verification?: { status?: 'not_started' | 'pending' | 'verified' | 'rejected' }) {
  return computeBillingState({ billing: { ...TRIAL, verification }, subscriptions, plans: PLANS, now: at(now) });
}

describe('the free trial boundary', () => {
  it('is a trial on its first instant', () => {
    expect(stateAt('2026-11-01T00:00:00.000Z')).toMatchObject({ state: 'trial', canShareLink: true });
  });

  it('is still a trial one millisecond before it ends', () => {
    expect(stateAt('2026-11-07T23:59:59.999Z')).toMatchObject({ state: 'trial', canShareLink: true });
  });

  it('is over AT trialEndsAt, to the millisecond', () => {
    expect(stateAt('2026-11-08T00:00:00.000Z')).toMatchObject({ state: 'expired', canShareLink: false });
  });

  it('stays over afterwards', () => {
    expect(stateAt('2027-06-01T00:00:00.000Z')).toMatchObject({ state: 'expired', canShareLink: false });
  });
});

describe('the subscription boundary', () => {
  const novToDec = sub('monthly', '2026-11-10T00:00:00.000Z', '2026-12-10T00:00:00.000Z');

  it('does not cover the moment before it starts', () => {
    expect(stateAt('2026-11-09T23:59:59.999Z', [novToDec])).toMatchObject({ state: 'expired', canShareLink: false, subscription: null });
  });

  it('covers its first instant', () => {
    expect(stateAt('2026-11-10T00:00:00.000Z', [novToDec])).toMatchObject({ state: 'active', canShareLink: true });
  });

  it('covers one millisecond before it expires', () => {
    expect(stateAt('2026-12-09T23:59:59.999Z', [novToDec])).toMatchObject({ state: 'active', canShareLink: true });
  });

  it('has expired AT expiresAt, to the millisecond', () => {
    expect(stateAt('2026-12-10T00:00:00.000Z', [novToDec])).toMatchObject({ state: 'expired', canShareLink: false, subscription: null, accessEndsAt: null });
  });
});

describe('how trial and subscription combine', () => {
  it('a vendor who pays during the trial is active, not trial', () => {
    const early = sub('monthly', '2026-11-03T00:00:00.000Z', '2026-12-03T00:00:00.000Z');
    expect(stateAt('2026-11-04T00:00:00.000Z', [early])).toMatchObject({ state: 'active', canShareLink: true });
  });

  it('a subscription that ran out during the trial leaves the vendor in the trial', () => {
    const odd = sub('monthly', '2026-11-01T00:00:00.000Z', '2026-11-03T00:00:00.000Z');
    expect(stateAt('2026-11-05T00:00:00.000Z', [odd])).toMatchObject({ state: 'trial', canShareLink: true });
  });

  it('a lapsed subscription after the trial means expired', () => {
    const lapsed = sub('monthly', '2026-11-10T00:00:00.000Z', '2026-12-10T00:00:00.000Z');
    expect(stateAt('2026-12-20T00:00:00.000Z', [lapsed])).toMatchObject({ state: 'expired', canShareLink: false });
  });

  it('reports the covering subscription and, with renewals queued, when cover really ends', () => {
    const first = sub('monthly', '2026-11-10T00:00:00.000Z', '2026-12-10T00:00:00.000Z');
    const second = sub('quarterly', '2026-12-10T00:00:00.000Z', '2027-03-10T00:00:00.000Z');
    const result = stateAt('2026-11-20T00:00:00.000Z', [first, second]);
    expect(result.subscription).toMatchObject({ id: first._id.toString(), plan: 'monthly' });
    expect(result.accessEndsAt).toEqual(at('2027-03-10T00:00:00.000Z'));
  });

  it('moves to the next subscription at the seam with no gap', () => {
    const first = sub('monthly', '2026-11-10T00:00:00.000Z', '2026-12-10T00:00:00.000Z');
    const second = sub('monthly', '2026-12-10T00:00:00.000Z', '2027-01-10T00:00:00.000Z');
    expect(stateAt('2026-12-09T23:59:59.999Z', [first, second]).subscription?.id).toBe(first._id.toString());
    expect(stateAt('2026-12-10T00:00:00.000Z', [first, second]).subscription?.id).toBe(second._id.toString());
  });
});

describe('verification is recorded, and blocks nothing', () => {
  it('is not started by default, and due only once the trial has ended', () => {
    expect(stateAt('2026-11-05T00:00:00.000Z')).toMatchObject({ verification: { status: 'not_started', startedAt: null, completedAt: null }, verificationDue: false });
    expect(stateAt('2026-11-08T00:00:00.000Z')).toMatchObject({ verificationDue: true });
  });

  it('is not due once it has started, and never changes whether the vendor can share', () => {
    for (const status of ['pending', 'verified', 'rejected'] as const) {
      expect(stateAt('2026-11-09T00:00:00.000Z', [], { status })).toMatchObject({ verification: { status }, verificationDue: false, state: 'expired', canShareLink: false });
    }
    // Verified or not, a vendor inside the trial can share.
    expect(stateAt('2026-11-02T00:00:00.000Z', [], { status: 'rejected' })).toMatchObject({ canShareLink: true });
  });

  it('treats a missing verification object as not started', () => {
    expect(stateAt('2026-11-02T00:00:00.000Z').verification.status).toBe('not_started');
  });
});

describe('plans in the state', () => {
  it('lists both plans with their prices', () => {
    expect(stateAt('2026-11-02T00:00:00.000Z').plans).toEqual([
      { id: 'monthly', months: 1, priceNaira: 3000 },
      { id: 'quarterly', months: 3, priceNaira: 8_000 },
    ]);
  });
});

describe('assertCanShare', () => {
  it('lets a trial and an active vendor through and refuses an expired one with SHARING_NOT_ALLOWED', () => {
    expect(() => assertCanShare(stateAt('2026-11-02T00:00:00.000Z'))).not.toThrow();
    let caught: unknown;
    try {
      assertCanShare(stateAt('2026-11-09T00:00:00.000Z'));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect(caught).toMatchObject({ status: 403, code: 'SHARING_NOT_ALLOWED' });
  });
});
