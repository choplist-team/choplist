import { DEFAULT_MONTHLY_NAIRA, DEFAULT_QUARTERLY_NAIRA, DEFAULT_TRIAL_DAYS } from '../config.js';
import { SUBSCRIPTION_PLANS, type SubscriptionPlan } from '../models/subscription.js';

// Everything about vendor billing that is a setting rather than code. Built once
// from the environment (server.ts) and passed down; tests pass their own.
export type BillingConfig = {
  trialDays: number;
  monthlyNaira: number;
  quarterlyNaira: number;
  // Where Paystack sends a vendor after paying (SUBSCRIPTION_CALLBACK_URL).
  callbackUrl?: string;
  // The start of a shop link without the slug (SHARE_URL_BASE).
  shareUrlBase?: string;
};

export const DEFAULT_BILLING: BillingConfig = {
  trialDays: DEFAULT_TRIAL_DAYS,
  monthlyNaira: DEFAULT_MONTHLY_NAIRA,
  quarterlyNaira: DEFAULT_QUARTERLY_NAIRA,
};

export type PlanInfo = {
  id: SubscriptionPlan;
  // How many calendar months one purchase covers.
  months: number;
  // Whole naira.
  priceNaira: number;
};

// How long one purchase of each plan lasts, in calendar months. Fixed in code, not
// a setting: a "monthly" plan that lasted 2 months would be a pricing change.
export const PLAN_MONTHS: Record<SubscriptionPlan, number> = { monthly: 1, quarterly: 3 };

export function buildPlans(config: BillingConfig): PlanInfo[] {
  return [
    { id: 'monthly', months: PLAN_MONTHS.monthly, priceNaira: config.monthlyNaira },
    { id: 'quarterly', months: PLAN_MONTHS.quarterly, priceNaira: config.quarterlyNaira },
  ];
}

export function isPlanId(value: unknown): value is SubscriptionPlan {
  return typeof value === 'string' && (SUBSCRIPTION_PLANS as readonly string[]).includes(value);
}

export function findPlan(config: BillingConfig, id: SubscriptionPlan): PlanInfo {
  const plan = buildPlans(config).find((candidate) => candidate.id === id);
  if (!plan) throw new Error(`Unknown plan ${id}`);
  return plan;
}
