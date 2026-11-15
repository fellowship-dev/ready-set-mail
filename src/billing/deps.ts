import type { BoundEnv } from '../index';
import { StripeClient } from './stripe-client';

/** What every billing operation needs. Built per request (nothing is kept between requests). */
export interface BillingDeps {
  env: BoundEnv;
  db: D1Database;
  stripe: StripeClient;
  ctx?: ExecutionContext;
  /** Unix seconds. */
  now(): number;
}

export function billingDeps(env: BoundEnv, ctx?: ExecutionContext, opts: { fetch?: typeof fetch; now?: () => number } = {}): BillingDeps {
  const stripe = new StripeClient(env.STRIPE_SECRET_KEY!.trim(), { fetch: opts.fetch, apiBase: env.STRIPE_API_BASE });
  return { env, db: env.DB, stripe, ctx, now: () => Math.floor((opts.now?.() ?? Date.now()) / 1000) };
}

export class BillingError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'BillingError';
  }
}

/** A Stripe id from a field that is either the id or the expanded object. */
export function idOf(v: unknown): string | null {
  if (typeof v === 'string') return v || null;
  if (v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string') return (v as { id: string }).id;
  return null;
}
