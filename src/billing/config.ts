// Billing configuration (hosted only). Billing is off unless the hosted service has a restricted Stripe key and a webhook signing secret.
// Nothing here ever returns or logs a configured value: `reason` names the setting and what is wrong with it.
import { hostedEnabled } from '../hosted/config';

export interface BillingEnv {
  MODE?: string;
  SAAS_ENABLED?: string;
  STRIPE_SECRET_KEY?: string;       // secret: a RESTRICTED key (rk_live_ / rk_test_); a full sk_ key is refused
  STRIPE_WEBHOOK_SECRET?: string;   // secret: whsec_… signing secret of the webhook endpoint
  STRIPE_PRICE_LOOKUP_KEY?: string; // lookup key of the one-time price (default rsm_fix_one_domain)
  HOSTED_PLAN?: string;             // 'pay_as_you_go' turns on the hosted plan (src/billing/plan.ts); anything else is off
  STRIPE_API_BASE?: string;         // testing only: http://127.0.0.1:<port> or http://localhost:<port> (a local fake Stripe); anything else is ignored
}

/** The Stripe API version every request is pinned to; parameter shapes in stripe-client.ts are valid for it. Bump together. */
export const STRIPE_API_VERSION = '2025-09-30.clover';
export const DEFAULT_PRICE_LOOKUP_KEY = 'rsm_fix_one_domain';
const STRIPE_API = 'https://api.stripe.com';

export type BillingStatus =
  | { state: 'off' }
  | { state: 'misconfigured'; reason: string }
  | { state: 'configured'; livemode: boolean };

export function billingStatus(env: BillingEnv): BillingStatus {
  if (!hostedEnabled(env)) return { state: 'off' };
  const key = env.STRIPE_SECRET_KEY?.trim();
  const whsec = env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!key && !whsec) return { state: 'off' };
  if (!key) return { state: 'misconfigured', reason: 'STRIPE_SECRET_KEY is not set (STRIPE_WEBHOOK_SECRET is), so billing stays off.' };
  if (!whsec) return { state: 'misconfigured', reason: 'STRIPE_WEBHOOK_SECRET is not set (STRIPE_SECRET_KEY is), so billing stays off.' };
  if (key.startsWith('sk_')) return { state: 'misconfigured', reason: 'STRIPE_SECRET_KEY is a full secret key (sk_…). Create a restricted key (rk_live_… / rk_test_…) with only the permissions in docs/billing.md and use that.' };
  if (!/^rk_(live|test)_[A-Za-z0-9]+$/.test(key)) return { state: 'misconfigured', reason: 'STRIPE_SECRET_KEY is not a restricted Stripe key (it must start with rk_live_ or rk_test_).' };
  if (!/^whsec_[A-Za-z0-9]+$/.test(whsec)) return { state: 'misconfigured', reason: 'STRIPE_WEBHOOK_SECRET is not a Stripe webhook signing secret (it must start with whsec_).' };
  return { state: 'configured', livemode: key.startsWith('rk_live_') };
}

export const billingEnabled = (env: BillingEnv): boolean => billingStatus(env).state === 'configured';

export const priceLookupKey = (env: Pick<BillingEnv, 'STRIPE_PRICE_LOOKUP_KEY'>): string => {
  const k = env.STRIPE_PRICE_LOOKUP_KEY?.trim();
  return k && /^[A-Za-z0-9_.-]{1,200}$/.test(k) ? k : DEFAULT_PRICE_LOOKUP_KEY;
};

/**
 * The Stripe API origin. Testing only: STRIPE_API_BASE points the client at a local fake (e2e/support/fake-stripe.mjs). Honoured ONLY for
 * `http://127.0.0.1:<port>` or `http://localhost:<port>` (strict parse: no userinfo, path, query or fragment), so a stray or malicious value
 * can never send the Stripe key to a remote host. Anything else is ignored.
 */
export function stripeApiBase(override?: string | null): string {
  if (!override) return STRIPE_API;
  const raw = override.trim();
  if (!/^http:\/\/(127\.0\.0\.1|localhost):[0-9]{1,5}\/?$/.test(raw)) return STRIPE_API;
  try {
    const u = new URL(raw);
    if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && Number(u.port) > 0) return `http://${u.hostname}:${u.port}`;
  } catch { /* not a URL: ignored */ }
  return STRIPE_API;
}
