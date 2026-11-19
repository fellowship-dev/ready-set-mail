// The Stripe price the offer resolves to, by lookup key. Amount and currency come from Stripe, never from code.
// Cached in D1 (not module state: isolates share nothing) for a few minutes; a cached answer is kept for outages.
import { billingLookups } from '@ready-set-mail/db';
import type { StripeClient } from './stripe-client';
import { StripeError, StripeNetworkError } from './stripe-client';

export const PRICE_TTL_SECONDS = 600;

export interface OfferPrice { price_id: string; amount: number; currency: string }

/** The price cannot be sold: missing, inactive, recurring, not USD, not a positive whole amount, or several prices share the key. */
export class PriceMisconfiguredError extends Error {
  constructor(readonly why: string) { super(`The offer's Stripe price is misconfigured: ${why}`); this.name = 'PriceMisconfiguredError'; }
}
/** Stripe could not be asked and nothing is cached. */
export class PriceUnavailableError extends Error {
  constructor() { super('The price could not be read from Stripe'); this.name = 'PriceUnavailableError'; }
}

interface RawPrice { id?: unknown; active?: unknown; type?: unknown; currency?: unknown; unit_amount?: unknown; billing_scheme?: unknown; recurring?: unknown; tiers_mode?: unknown }

/** Throws PriceMisconfiguredError unless exactly one active one-time USD price with a fixed positive amount carries the key. */
export function validatePrice(list: { data: unknown[] }, lookupKey: string): OfferPrice {
  if (list.data.length === 0) throw new PriceMisconfiguredError(`no active price has the lookup key ${lookupKey}`);
  if (list.data.length > 1) throw new PriceMisconfiguredError(`more than one active price has the lookup key ${lookupKey}`);
  const p = list.data[0] as RawPrice;
  if (typeof p.id !== 'string' || !p.id) throw new PriceMisconfiguredError('the price has no id');
  if (p.active !== true) throw new PriceMisconfiguredError('the price is not active');
  if (p.type !== 'one_time' || p.recurring) throw new PriceMisconfiguredError('the price is not one-time');
  if (p.currency !== 'usd') throw new PriceMisconfiguredError('the price is not in USD');
  if (p.billing_scheme !== undefined && p.billing_scheme !== 'per_unit') throw new PriceMisconfiguredError('the price is tiered');
  if (!Number.isSafeInteger(p.unit_amount) || (p.unit_amount as number) <= 0) throw new PriceMisconfiguredError('the price has no fixed positive amount');
  return { price_id: p.id, amount: p.unit_amount as number, currency: 'usd' };
}

/** Throws PriceMisconfiguredError unless exactly one active recurring USD price at `interval` with a fixed positive amount carries the key. */
export function validateRecurringPrice(interval: 'month' | 'year') {
  return (list: { data: unknown[] }, lookupKey: string): OfferPrice => {
    const p = (list.data[0] ?? {}) as RawPrice & { recurring?: { interval?: unknown; interval_count?: unknown } | null };
    if (list.data.length === 1 && p.type === 'recurring' && p.recurring && (p.recurring.interval !== interval || (p.recurring.interval_count ?? 1) !== 1)) throw new PriceMisconfiguredError(`the price does not recur every ${interval}`);
    if (list.data.length === 1 && (p.type !== 'recurring' || !p.recurring)) throw new PriceMisconfiguredError('the price is not recurring');
    return validatePrice({ data: list.data.map((x) => ({ ...(x as object), type: 'one_time', recurring: null })) }, lookupKey);
  };
}

/**
 * `fresh`: ask Stripe now (the purchase itself) and refresh the cache. Otherwise a cached answer younger than the TTL is used; an older one
 * only if Stripe cannot be reached. A misconfigured price drops the cache entry.
 */
export async function resolvePrice(db: D1Database, stripe: StripeClient, lookupKey: string, opts: { fresh?: boolean; now?: () => number; validate?: (list: { data: unknown[] }, lookupKey: string) => OfferPrice } = {}): Promise<OfferPrice> {
  const now = Math.floor((opts.now?.() ?? Date.now()) / 1000);
  const lookups = billingLookups(db);
  const cached = await lookups.price.get(lookupKey);
  if (cached && !opts.fresh && now - cached.fetched_at < PRICE_TTL_SECONDS) return { price_id: cached.price_id, amount: cached.amount, currency: cached.currency };
  try {
    const price = (opts.validate ?? validatePrice)(await stripe.listPrices(lookupKey), lookupKey);
    await lookups.price.put({ lookup_key: lookupKey, ...price, fetched_at: now });
    return price;
  } catch (e) {
    if (e instanceof PriceMisconfiguredError) { await lookups.price.drop(lookupKey); throw e; }
    if (e instanceof StripeNetworkError || (e instanceof StripeError && e.status >= 500)) {
      if (cached && !opts.fresh) return { price_id: cached.price_id, amount: cached.amount, currency: cached.currency };
      throw new PriceUnavailableError();
    }
    throw e;
  }
}
