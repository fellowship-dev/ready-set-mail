// Billing in the instance preflight (GET /api/instance/preflight): by setting name and reason, never a value.
import type { BoundEnv } from '../index';
import type { BillingPreflight, PreflightItem } from '../setup/preflight';
import { billingStatus, priceLookupKey } from './config';
import { billingDeps } from './deps';
import { PriceMisconfiguredError, resolvePrice } from './price';
import { getMode } from '../tenancy/mode';

export async function billingPreflight(env: BoundEnv): Promise<{ status?: BillingPreflight; items: PreflightItem[] }> {
  const hosted = getMode(env) === 'saas';
  const anySet = !!(env.STRIPE_SECRET_KEY?.trim() || env.STRIPE_WEBHOOK_SECRET?.trim());
  if (!hosted && !anySet) return { items: [] };
  if (!hosted) {
    return {
      status: { state: 'off', reason: 'Billing exists on the hosted service only; the Stripe settings are ignored here.' },
      items: [{ id: 'billing', severity: 'note', setting: 'STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET', message: 'Stripe settings are present, but billing exists on the hosted service only (MODE=saas): they are ignored.' }],
    };
  }
  const s = billingStatus(env);
  if (s.state === 'off') return { status: { state: 'off', reason: env.SAAS_ENABLED === '1' ? 'STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are not set: no offer, no Billing section, no billing routes.' : 'The hosted service is not enabled (SAAS_ENABLED).' }, items: [] };
  if (s.state === 'misconfigured') {
    return { status: { state: 'misconfigured', reason: s.reason }, items: [{ id: 'billing', severity: 'action', setting: 'STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET', message: `${s.reason} Billing is off until it is fixed.` }] };
  }
  const items: PreflightItem[] = [];
  const status: BillingPreflight = { state: 'configured', livemode: s.livemode };
  try {
    await resolvePrice(env.DB, billingDeps(env).stripe, priceLookupKey(env));
    status.price = 'ok';
  } catch (e) {
    if (e instanceof PriceMisconfiguredError) {
      status.price = 'misconfigured';
      items.push({ id: 'billing', severity: 'action', setting: 'STRIPE_PRICE_LOOKUP_KEY', message: `The offer's Stripe price cannot be sold (${e.why}). The offer is hidden until a single active one-time USD price carries the lookup key.` });
    } else {
      status.price = 'unreachable';
      items.push({ id: 'billing', severity: 'note', setting: 'STRIPE_SECRET_KEY', message: 'Stripe could not be asked for the offer\'s price just now (network, or the key lacks the Prices read permission).' });
    }
  }
  if (!env.OWNER_EMAIL?.trim()) items.push({ id: 'billing', severity: 'action', setting: 'OWNER_EMAIL', message: 'OWNER_EMAIL is not set, so nobody is emailed when an order is paid and the Orders list is visible to nobody.' });
  return { status, items };
}
