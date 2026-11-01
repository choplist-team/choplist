import { PAYSTACK_PRICING, type PaystackPricing } from '../config.js';
import type { FeeMode } from '../models/seller.js';

// The fee calculator. Pure: numbers in, numbers out, no database and no network,
// so every case can be tested exactly.
//
// Units. Orders are whole naira in our API and database. Fees are worked out in
// KOBO (100 kobo = 1 naira) because a percentage of an order is rarely a whole
// naira, and Paystack wants kobo. Every figure here is a whole number, so there
// is no floating-point drift: the only fractions are inside Math.round/ceil.
//
// Two separate charges exist and must not be confused:
//   platform fee  ChopList's cut. 0 for a seller's first FREE_ORDERS paid orders,
//                 then PLATFORM_FEE_BPS of the order (percent of the base).
//   Paystack fee  Paystack's processing charge (about 1.5% + 100 naira, capped).
//                 Paid by whoever the seller's feeMode says.
//
// How the money moves (Paystack "split", seller settled directly, no wallet):
//   transaction_charge  the part of the payment ChopList keeps. The seller's
//                       subaccount receives everything else.
//   bearer              who Paystack takes ITS fee from: 'account' (ChopList's
//                       share) or 'subaccount' (the seller's share).
//
//   feeMode 'customer'  The customer pays base + service fee. The service fee
//                       covers ChopList's fee AND Paystack's, grossed up because
//                       Paystack's 1.5% is charged on the total including the fee
//                       itself. transaction_charge = the whole service fee and
//                       bearer = 'account', so ChopList pays Paystack out of it
//                       and the seller receives exactly the base.
//   feeMode 'seller'    The customer pays only the base. transaction_charge =
//                       platform fee and bearer = 'subaccount', so Paystack's fee
//                       comes out of the seller's share.

export type FeeTier = 'free' | 'standard';

export type FeeInput = {
  // The order total in whole naira: what the menu items add up to.
  baseNaira: number;
  feeMode: FeeMode;
  // Orders this seller has already been paid for through Paystack.
  paidOrderCount: number;
  freeOrders: number;
  platformFeeBps: number;
  // Paystack's pricing; defaults to our copy in config.ts (see the warning there).
  paystack?: PaystackPricing;
};

export type FeeQuote = {
  tier: FeeTier;
  feeMode: FeeMode;
  platformFeeBps: number;
  baseKobo: number;
  // ChopList's cut of this order.
  platformFeeKobo: number;
  // Our ESTIMATE of Paystack's charge on `totalKobo`. Paystack's own figure is
  // the truth; this is for quoting and for the order's snapshot.
  paystackFeeKobo: number;
  // Added to the order for the customer, whole naira. 0 unless feeMode 'customer'.
  serviceFee: number;
  // What the customer is charged: base + serviceFee.
  totalNaira: number;
  totalKobo: number;
  // Sent to Paystack as transaction_charge, and who bears Paystack's fee.
  transactionChargeKobo: number;
  bearer: 'account' | 'subaccount';
  // What the seller's subaccount receives. Exactly the base in customer mode;
  // an estimate in seller mode (it depends on Paystack's real fee).
  sellerReceivesKobo: number;
  // What ChopList keeps after Paystack has taken its fee. In customer mode this
  // is the platform fee plus a few kobo of rounding.
  chopListKeepsKobo: number;
};

const KOBO_PER_NAIRA = 100;
const BPS = 10_000;

function assertWhole(name: string, value: number, min: number): void {
  if (!Number.isInteger(value) || value < min) {
    throw new RangeError(`${name} must be a whole number of at least ${min}, got ${value}`);
  }
}

// Free for the first `freeOrders` paid orders: with 49 paid orders the seller's
// 50th is still free, and the 51st (count 50) is the first one charged.
export function tierFor(paidOrderCount: number, freeOrders: number): FeeTier {
  return paidOrderCount < freeOrders ? 'free' : 'standard';
}

// Paystack's charge on an amount: rate of the amount, plus the flat fee (waived
// for small amounts), never more than the cap. Rounded to the nearest kobo.
export function paystackFeeKobo(amountKobo: number, pricing: PaystackPricing = PAYSTACK_PRICING): number {
  const flat = amountKobo < pricing.flatFeeWaivedBelowKobo ? 0 : pricing.flatFeeKobo;
  const fee = Math.round((amountKobo * pricing.rateBps) / BPS) + flat;
  return Math.min(fee, pricing.capKobo);
}

// The smallest whole-kobo charge that leaves `netKobo` after Paystack's fee.
// Paystack's rate applies to the TOTAL charged, which includes the fee we are
// adding, so the sum is solved rather than added up:
//     charge - (rate * charge + flat) = net   =>   charge = (net + flat) / (1 - rate)
// Rounded UP so the seller is never a kobo short. Three cases:
//   small    the flat fee is waived, so charge = net / (1 - rate)
//   normal   charge = (net + flat) / (1 - rate)
//   capped   the fee stops at the cap, so charge = net + cap. This is chosen
//            exactly when it is smaller than the "normal" figure, which is when
//            the percentage fee would otherwise have gone over the cap.
export function grossUpKobo(netKobo: number, pricing: PaystackPricing = PAYSTACK_PRICING): number {
  const keep = BPS - pricing.rateBps;

  const waived = Math.ceil((netKobo * BPS) / keep);
  let charge: number;
  if (waived < pricing.flatFeeWaivedBelowKobo) {
    charge = waived;
  } else {
    const normal = Math.ceil(((netKobo + pricing.flatFeeKobo) * BPS) / keep);
    charge = Math.min(normal, netKobo + pricing.capKobo);
  }

  // Belt and braces: the formulas above are exact, but whatever the pricing
  // constants are changed to, never return a charge that leaves less than `net`.
  while (charge - paystackFeeKobo(charge, pricing) < netKobo) charge += 1;
  return charge;
}

export function calculateFees(input: FeeInput): FeeQuote {
  const pricing = input.paystack ?? PAYSTACK_PRICING;
  assertWhole('baseNaira', input.baseNaira, 1);
  assertWhole('paidOrderCount', input.paidOrderCount, 0);
  assertWhole('freeOrders', input.freeOrders, 0);
  assertWhole('platformFeeBps', input.platformFeeBps, 0);

  const tier = tierFor(input.paidOrderCount, input.freeOrders);
  const platformFeeBps = tier === 'free' ? 0 : input.platformFeeBps;
  const baseKobo = input.baseNaira * KOBO_PER_NAIRA;
  // The platform fee is a percentage of the BASE order, not of the service fee.
  const platformFeeKobo = Math.round((baseKobo * platformFeeBps) / BPS);

  if (input.feeMode === 'seller') {
    // The customer pays the base only; ChopList takes its cut at source and
    // Paystack's fee comes out of the seller's share.
    const totalKobo = baseKobo;
    const paystackFee = paystackFeeKobo(totalKobo, pricing);
    return {
      tier,
      feeMode: 'seller',
      platformFeeBps,
      baseKobo,
      platformFeeKobo,
      paystackFeeKobo: paystackFee,
      serviceFee: 0,
      totalNaira: input.baseNaira,
      totalKobo,
      transactionChargeKobo: platformFeeKobo,
      bearer: 'subaccount',
      sellerReceivesKobo: totalKobo - platformFeeKobo - paystackFee,
      chopListKeepsKobo: platformFeeKobo,
    };
  }

  // feeMode 'customer': gross up so that, after Paystack's fee, ChopList's fee is
  // still covered and the seller receives the full base. The service fee is shown
  // to the customer in whole naira, so it is rounded UP; the few extra kobo stay
  // with ChopList and the seller still gets exactly the base.
  const chargeKobo = grossUpKobo(baseKobo + platformFeeKobo, pricing);
  let serviceFee = Math.ceil((chargeKobo - baseKobo) / KOBO_PER_NAIRA);

  // Rounding up to a whole naira can push the total across a Paystack price
  // step (the flat fee applies from 2,500 naira up). A total that was worked out
  // as "under 2,500, flat fee waived" can round up to exactly 2,500, where the
  // flat fee applies after all, and ChopList would be 100 naira short. So check
  // the real total against Paystack's real fee and add a naira at a time until
  // ChopList's cut is covered. Normally this loop does not run at all.
  let totalKobo = (input.baseNaira + serviceFee) * KOBO_PER_NAIRA;
  for (let guard = 0; totalKobo - paystackFeeKobo(totalKobo, pricing) - baseKobo < platformFeeKobo; guard += 1) {
    if (guard > 100_000) throw new Error('Could not work out a service fee for this order');
    serviceFee += 1;
    totalKobo += KOBO_PER_NAIRA;
  }

  const totalNaira = input.baseNaira + serviceFee;
  const paystackFee = paystackFeeKobo(totalKobo, pricing);
  const transactionChargeKobo = totalKobo - baseKobo;
  return {
    tier,
    feeMode: 'customer',
    platformFeeBps,
    baseKobo,
    platformFeeKobo,
    paystackFeeKobo: paystackFee,
    serviceFee,
    totalNaira,
    totalKobo,
    transactionChargeKobo,
    bearer: 'account',
    sellerReceivesKobo: totalKobo - transactionChargeKobo,
    chopListKeepsKobo: transactionChargeKobo - paystackFee,
  };
}
