import { notifyExpiringSubscriptions } from './billing/reminders.js';
import { expireUnpaidOrders, type ExpireResult } from './orders/expire.js';
import type { PaystackClient } from './payments/paystack.js';
import { reconcileStalePayments, reconcileStaleSubscriptions, type StaleResult } from './payments/reconcile-stale.js';

// The upkeep that happens on a timer instead of in answer to a request. One runner, so
// there is one place that says what runs and how often. Every step is independent: one
// failing never stops the others, and a failed run is simply tried again next time.
// Safe with more than one server running: each step's writes are conditional, so the same
// order, payment or reminder is handled once.
export type MaintenanceOptions = {
  // 0 turns order expiry off.
  orderExpiryHours: number;
  // null = no Paystack key: there is nothing to re-check.
  paystack: PaystackClient | null;
  now?: Date;
};

export type MaintenanceResult = {
  expiry: ExpireResult | null;
  stalePayments: StaleResult | null;
  staleSubscriptions: StaleResult | null;
  reminders: number | null;
};

async function step<T>(name: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (err) {
    console.error(`Maintenance step "${name}" failed`, err instanceof Error ? err.name : err);
    return null;
  }
}

export async function runMaintenance(options: MaintenanceOptions): Promise<MaintenanceResult> {
  const now = options.now ?? new Date();
  return {
    expiry: options.orderExpiryHours > 0 ? await step('expiry', () => expireUnpaidOrders({ olderThanHours: options.orderExpiryHours, apply: true, now })) : null,
    stalePayments: await step('stale payments', () => reconcileStalePayments(options.paystack, now)),
    staleSubscriptions: await step('stale subscriptions', () => reconcileStaleSubscriptions(options.paystack, now)),
    reminders: await step('subscription reminders', () => notifyExpiringSubscriptions(now)),
  };
}

// Starts the timer. The first run is a minute after start, not during start-up. unref():
// a timer alone never keeps the process alive.
export function startMaintenance(options: Omit<MaintenanceOptions, 'now'>, everyMs = 15 * 60 * 1000): { stop(): void } {
  const run = () => void runMaintenance(options);
  const first = setTimeout(run, 60_000);
  const timer = setInterval(run, everyMs);
  first.unref();
  timer.unref();
  return {
    stop() {
      clearTimeout(first);
      clearInterval(timer);
    },
  };
}
