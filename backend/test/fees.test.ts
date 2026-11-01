import { describe, expect, it } from 'vitest';
import { PAYSTACK_PRICING } from '../src/config.js';
import { calculateFees, grossUpKobo, paystackFeeKobo, tierFor, type FeeInput } from '../src/payments/fees.js';

// Pure maths, no database. Every expected figure below was worked out by hand
// from the rules in src/payments/fees.ts, not copied from the code's output.
// kobo: 100 kobo = 1 naira.

const FREE = 50;
const BPS = 300; // 3%

// Paystack waiving its flat fee on small payments is NOT the default (the spec
// charges 100 naira on every order). These tests keep the waiver logic honest in
// case the constant is ever switched on after checking Paystack's pricing.
const WAIVER_ON = { ...PAYSTACK_PRICING, flatFeeWaivedBelowKobo: 250_000 };

const quote = (over: Partial<FeeInput> & Pick<FeeInput, 'baseNaira' | 'feeMode'>) =>
  calculateFees({ paidOrderCount: 0, freeOrders: FREE, platformFeeBps: BPS, ...over });

describe('tierFor: free for the first FREE_ORDERS paid orders', () => {
  it('a brand-new seller is free', () => expect(tierFor(0, 50)).toBe('free'));
  it('with 49 paid orders the 50th is still free', () => expect(tierFor(49, 50)).toBe('free'));
  it('with 50 paid orders the 51st is the first charged', () => expect(tierFor(50, 50)).toBe('standard'));
  it('and so is every later one', () => expect(tierFor(51, 50)).toBe('standard'));
  it('FREE_ORDERS of 0 means no free period', () => expect(tierFor(0, 0)).toBe('standard'));
});

describe('paystackFeeKobo: 1.5% + 100 naira on every payment, capped at 2,000', () => {
  it('charges the flat fee on every payment by default, even a small one', () => {
    // 249,900 kobo * 1.5% = 3748.5 -> 3749, + 10,000
    expect(paystackFeeKobo(249_900)).toBe(13_749);
    expect(paystackFeeKobo(100_000)).toBe(11_500); // 1,000 naira: 15 + 100
  });
  it('can waive the flat fee under 2,500 naira when that setting is switched on', () => {
    expect(paystackFeeKobo(249_900, WAIVER_ON)).toBe(3749);
    expect(paystackFeeKobo(250_000, WAIVER_ON)).toBe(13_750);
  });
  it('charges the flat fee from exactly 2,500 naira', () => {
    // 250,000 * 1.5% = 3750, + 10,000
    expect(paystackFeeKobo(250_000)).toBe(13_750);
  });
  it('a 7,500 naira payment: 112.50 + 100 = 212.50 naira', () => {
    expect(paystackFeeKobo(750_000)).toBe(21_250);
  });
  it('never exceeds the 2,000 naira cap', () => {
    expect(paystackFeeKobo(20_000_000)).toBe(200_000); // 200,000 naira payment
    expect(paystackFeeKobo(1_000_000_000)).toBe(200_000);
  });
});

describe('worked examples: customer pays the fees (feeMode customer)', () => {
  it('7,500 naira, free tier: service fee 216, total 7,716', () => {
    const q = quote({ baseNaira: 7500, feeMode: 'customer' });
    expect(q).toMatchObject({
      tier: 'free',
      platformFeeBps: 0,
      platformFeeKobo: 0,
      serviceFee: 216,
      totalNaira: 7716,
      totalKobo: 771_600,
      transactionChargeKobo: 21_600,
      bearer: 'account',
      paystackFeeKobo: 21_574,
      sellerReceivesKobo: 750_000, // the seller gets the full 7,500
      chopListKeepsKobo: 26, // rounding only
    });
  });

  it('7,500 naira, 3% tier: platform fee 225, service fee 445, total 7,945', () => {
    const q = quote({ baseNaira: 7500, feeMode: 'customer', paidOrderCount: 50 });
    expect(q).toMatchObject({
      tier: 'standard',
      platformFeeBps: 300,
      platformFeeKobo: 22_500,
      serviceFee: 445,
      totalNaira: 7945,
      transactionChargeKobo: 44_500,
      paystackFeeKobo: 21_918,
      sellerReceivesKobo: 750_000,
      chopListKeepsKobo: 22_582, // 22,500 platform fee + 82 kobo rounding
    });
  });

  it('11,000 naira, free tier: service fee 270, total 11,270', () => {
    const q = quote({ baseNaira: 11_000, feeMode: 'customer' });
    expect(q).toMatchObject({ serviceFee: 270, totalNaira: 11_270, paystackFeeKobo: 26_905, chopListKeepsKobo: 95, sellerReceivesKobo: 1_100_000 });
  });

  it('11,000 naira, 3% tier: platform fee 330, service fee 605, total 11,605', () => {
    const q = quote({ baseNaira: 11_000, feeMode: 'customer', paidOrderCount: 50 });
    expect(q).toMatchObject({ platformFeeKobo: 33_000, serviceFee: 605, totalNaira: 11_605, paystackFeeKobo: 27_408, chopListKeepsKobo: 33_092 });
  });

  it('50,000 naira, free tier: service fee 863, total 50,863', () => {
    const q = quote({ baseNaira: 50_000, feeMode: 'customer' });
    expect(q).toMatchObject({ serviceFee: 863, totalNaira: 50_863, paystackFeeKobo: 86_295, chopListKeepsKobo: 5 });
  });

  it('50,000 naira, 3% tier: platform fee 1,500, service fee 2,386, total 52,386', () => {
    const q = quote({ baseNaira: 50_000, feeMode: 'customer', paidOrderCount: 99 });
    expect(q).toMatchObject({ platformFeeKobo: 150_000, serviceFee: 2386, totalNaira: 52_386, paystackFeeKobo: 88_579, chopListKeepsKobo: 150_021 });
  });
});

describe('worked examples: seller pays the fees (feeMode seller)', () => {
  it('the customer pays only the base, whatever the tier', () => {
    for (const paidOrderCount of [0, 49, 50, 500]) {
      const q = quote({ baseNaira: 7500, feeMode: 'seller', paidOrderCount });
      expect(q.serviceFee).toBe(0);
      expect(q.totalNaira).toBe(7500);
      expect(q.totalKobo).toBe(750_000);
      expect(q.bearer).toBe('subaccount');
    }
  });

  it('7,500 naira, free tier: ChopList takes nothing, the seller bears only Paystack', () => {
    const q = quote({ baseNaira: 7500, feeMode: 'seller' });
    expect(q).toMatchObject({ transactionChargeKobo: 0, paystackFeeKobo: 21_250, sellerReceivesKobo: 728_750, chopListKeepsKobo: 0 });
  });

  it('7,500 naira, 3% tier: ChopList takes 225 at source', () => {
    const q = quote({ baseNaira: 7500, feeMode: 'seller', paidOrderCount: 50 });
    expect(q).toMatchObject({ transactionChargeKobo: 22_500, sellerReceivesKobo: 706_250, chopListKeepsKobo: 22_500 });
  });

  it('11,000 naira, 3% tier', () => {
    const q = quote({ baseNaira: 11_000, feeMode: 'seller', paidOrderCount: 50 });
    expect(q).toMatchObject({ transactionChargeKobo: 33_000, paystackFeeKobo: 26_500, sellerReceivesKobo: 1_040_500 });
  });

  it('50,000 naira, 3% tier', () => {
    const q = quote({ baseNaira: 50_000, feeMode: 'seller', paidOrderCount: 50 });
    expect(q).toMatchObject({ transactionChargeKobo: 150_000, paystackFeeKobo: 85_000, sellerReceivesKobo: 4_765_000 });
  });
});

describe('the tier boundary at the 50th and 51st paid order', () => {
  it('prices the 50th (49 already paid) at zero and the 51st (50 already paid) at 3%', () => {
    const fiftieth = quote({ baseNaira: 10_000, feeMode: 'seller', paidOrderCount: 49 });
    const fiftyFirst = quote({ baseNaira: 10_000, feeMode: 'seller', paidOrderCount: 50 });
    expect(fiftieth.platformFeeKobo).toBe(0);
    expect(fiftieth.tier).toBe('free');
    expect(fiftyFirst.platformFeeKobo).toBe(30_000);
    expect(fiftyFirst.tier).toBe('standard');
  });
});

describe('the 2,000 naira cap', () => {
  it('a 150,000 naira order: the fee is the capped 2,000, not 1.5% + 100', () => {
    const q = quote({ baseNaira: 150_000, feeMode: 'customer' });
    expect(q).toMatchObject({ serviceFee: 2000, totalNaira: 152_000, paystackFeeKobo: 200_000, chopListKeepsKobo: 0, sellerReceivesKobo: 15_000_000 });
  });

  it('the service fee never exceeds the cap plus the platform fee (rounded up a naira)', () => {
    for (const base of [100_000, 124_000, 124_666, 124_667, 125_000, 150_000, 500_000, 2_000_000]) {
      for (const paidOrderCount of [0, 50]) {
        const q = quote({ baseNaira: base, feeMode: 'customer', paidOrderCount });
        const ceiling = Math.ceil((PAYSTACK_PRICING.capKobo + q.platformFeeKobo) / 100);
        expect(q.serviceFee, `base ${base}`).toBeLessThanOrEqual(ceiling);
      }
    }
  });

  it('is continuous across the point where the cap starts to apply (no jump, never backwards)', () => {
    let previous = 0;
    for (let base = 124_000; base <= 126_000; base += 1) {
      const q = quote({ baseNaira: base, feeMode: 'customer' });
      expect(q.totalNaira).toBeGreaterThanOrEqual(previous);
      expect(q.totalNaira - base).toBeLessThanOrEqual(2000);
      previous = q.totalNaira;
    }
  });
});

describe('small orders', () => {
  it('2,000 naira by default: the 100 naira is included, service fee 132 naira', () => {
    const q = quote({ baseNaira: 2000, feeMode: 'customer' });
    expect(q).toMatchObject({ serviceFee: 132, totalNaira: 2132, paystackFeeKobo: 13_198, transactionChargeKobo: 13_200, chopListKeepsKobo: 2 });
  });

  it('with the waiver switched on, the same order costs 31 naira', () => {
    const q = quote({ baseNaira: 2000, feeMode: 'customer', paystack: WAIVER_ON });
    expect(q).toMatchObject({ serviceFee: 31, totalNaira: 2031, paystackFeeKobo: 3047, transactionChargeKobo: 3100, chopListKeepsKobo: 53 });
  });

  it('with the waiver on, ChopList is never short when rounding carries the total across 2,500 naira', () => {
    // The trap: a total worked out as "under 2,500, no flat fee" can round up to
    // exactly 2,500, where Paystack does charge it. Walk every base around it.
    for (let base = 2300; base <= 2600; base += 1) {
      const q = quote({ baseNaira: base, feeMode: 'customer', paystack: WAIVER_ON });
      expect(q.chopListKeepsKobo, `base ${base}`).toBeGreaterThanOrEqual(q.platformFeeKobo);
      expect(q.sellerReceivesKobo).toBe(base * 100);
    }
  });
});

describe('properties that must hold for any order (customer mode)', () => {
  const bases = [
    ...Array.from({ length: 600 }, (_, i) => i + 1), // 1 .. 600, every naira
    ...Array.from({ length: 400 }, (_, i) => 600 + (i + 1) * 37), // up to ~15,400
    ...Array.from({ length: 200 }, (_, i) => 15_400 + (i + 1) * 997), // up to ~214,000, past the cap
  ];

  for (const paidOrderCount of [0, 50]) {
    it(`the seller receives exactly the base, ChopList is never short, rounding is under 2 naira (paid orders: ${paidOrderCount})`, () => {
      let previousTotal = 0;
      for (const base of bases) {
        const q = quote({ baseNaira: base, feeMode: 'customer', paidOrderCount });
        // 1. The seller is paid in full.
        expect(q.sellerReceivesKobo, `base ${base}`).toBe(base * 100);
        // 2. After paying Paystack, ChopList still has at least its own fee...
        expect(q.chopListKeepsKobo, `base ${base}`).toBeGreaterThanOrEqual(q.platformFeeKobo);
        // 3. ...and the customer is not overcharged by more than a naira of
        //    rounding plus Paystack's rounding (under 2 naira in all).
        expect(q.chopListKeepsKobo - q.platformFeeKobo, `base ${base}`).toBeLessThan(200);
        // 4. Everything is whole numbers, and the pieces add up.
        expect(Number.isInteger(q.serviceFee)).toBe(true);
        expect(q.totalNaira).toBe(base + q.serviceFee);
        expect(q.totalKobo).toBe(q.totalNaira * 100);
        expect(q.transactionChargeKobo).toBe(q.totalKobo - q.baseKobo);
        // 5. A bigger order never costs the customer less.
        expect(q.totalNaira).toBeGreaterThanOrEqual(previousTotal);
        previousTotal = q.totalNaira;
      }
    });
  }
});

describe('properties that must hold for any order (seller mode)', () => {
  it('the customer pays the base, ChopList gets exactly its fee, the seller gets the rest', () => {
    for (const base of [1, 99, 2499, 2500, 7500, 11_000, 50_000, 124_667, 150_000, 1_000_000]) {
      for (const paidOrderCount of [0, 50]) {
        const q = quote({ baseNaira: base, feeMode: 'seller', paidOrderCount });
        expect(q.totalKobo).toBe(base * 100);
        expect(q.transactionChargeKobo).toBe(q.platformFeeKobo);
        expect(q.sellerReceivesKobo + q.transactionChargeKobo + q.paystackFeeKobo).toBe(q.totalKobo);
      }
    }
  });
});

describe('grossUpKobo', () => {
  it('leaves at least the net after Paystack, and one kobo less would not', () => {
    // The closed formula is exact to the kobo except where Paystack's own
    // rounding makes two neighbouring amounts equally good, so allow one kobo.
    for (const net of [100, 5000, 100_000, 750_000, 1_100_000, 5_000_000, 12_466_600, 15_000_000]) {
      const charge = grossUpKobo(net);
      expect(charge - paystackFeeKobo(charge)).toBeGreaterThanOrEqual(net);
      expect(charge - 2 - paystackFeeKobo(charge - 2)).toBeLessThan(net);
    }
  });
});

describe('the Paystack constants are inputs, not buried numbers', () => {
  it('a changed rate changes the quote (so updating config really updates prices)', () => {
    const base = quote({ baseNaira: 7500, feeMode: 'customer' });
    const dearer = quote({ baseNaira: 7500, feeMode: 'customer', paystack: { ...PAYSTACK_PRICING, rateBps: 200 } });
    expect(dearer.serviceFee).toBeGreaterThan(base.serviceFee);
  });
});

describe('bad input is refused, not guessed at', () => {
  it.each([
    ['a zero order', { baseNaira: 0 }],
    ['a fractional naira amount', { baseNaira: 7500.5 }],
    ['a negative count', { paidOrderCount: -1 }],
    ['a fractional fee rate', { platformFeeBps: 2.5 }],
  ])('throws for %s', (_name, bad) => {
    expect(() => quote({ baseNaira: 7500, feeMode: 'customer', ...bad })).toThrow(RangeError);
  });
});
