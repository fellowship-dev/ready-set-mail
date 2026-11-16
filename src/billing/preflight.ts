// Billing in the instance preflight (GET /api/instance/preflight): by setting name and reason, never a value.
import type { BoundEnv } from '../index';
import type { BillingPreflight, PreflightItem } from '../setup/preflight';
import { billingStatus, priceLookupKey } from './config';
import { billingDeps } from './deps';
import { PriceMisconfiguredError, PriceUnavailableError, resolvePlanPrice, resolvePrice } from './price';
import { paidPathAvailable, planMode } from '../hosted/plan';
import { planHelpUrl } from '../hosted/plan-limits';
import { getMode } from '../tenancy/mode';

export async function billingPreflight(env: BoundEnv): Promise<{ status?: BillingPreflight; items: PreflightItem[] }> {
  const hosted = getMode(env) === 'saas';
  const plan = planMode(env);
  const planItems: PreflightItem[] = [];
  if (plan === 'free_one_domain') {
    if (!paidPathAvailable(env)) planItems.push({ id: 'billing', severity: 'note', setting: 'HOSTED_PLAN', message: 'HOSTED_PLAN=free_one_domain is on but billing is not configured: the free limits are enforced and more domains say "talk to us" (BOOKING_URL). Nothing can be bought.' });
    else if (!planHelpUrl(env)) planItems.push({ id: 'billing', severity: 'note', setting: 'BOOKING_URL', message: 'BOOKING_URL is not set (or not https): a workspace at its free limit has no "talk to us" link to follow if the paid path is unavailable.' });
  }
  const anySet = !!(env.STRIPE_SECRET_KEY?.trim() || env.STRIPE_WEBHOOK_SECRET?.trim());
  if (!hosted && !anySet) return { items: [] };
  if (!hosted) {
    return {
      status: { state: 'off', reason: 'Billing exists on the hosted service only; the Stripe settings are ignored here.' },
      items: [{ id: 'billing', severity: 'note', setting: 'STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET', message: 'Stripe settings are present, but billing exists on the hosted service only (MODE=saas): they are ignored.' }],
    };
  }
  const s = billingStatus(env);
  if (s.state === 'off') return { status: { state: 'off', reason: env.SAAS_ENABLED === '1' ? 'STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are not set: no offer, no Billing section, no billing routes.' : 'The hosted service is not enabled (SAAS_ENABLED).', ...(plan === 'free_one_domain' ? { plan: { mode: plan, paid: false } } : {}) }, items: planItems };
  if (s.state === 'misconfigured') {
    return { status: { state: 'misconfigured', reason: s.reason }, items: [{ id: 'billing', severity: 'action', setting: 'STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET', message: `${s.reason} Billing is off until it is fixed.` }] };
  }
  const items: PreflightItem[] = [...planItems];
  const status: BillingPreflight = { state: 'configured', livemode: s.livemode };
  if (plan === 'free_one_domain') {
    status.plan = { mode: plan, paid: true };
    try {
      const d = billingDeps(env);
      await Promise.all((['month', 'year'] as const).map((i) => resolvePlanPrice(env.DB, d.stripe, i)));
      status.plan.prices = 'ok';
    } catch (e) {
      status.plan.prices = e instanceof PriceMisconfiguredError ? 'misconfigured' : 'unreachable';
      items.push({ id: 'billing', severity: e instanceof PriceMisconfiguredError ? 'action' : 'note', setting: 'HOSTED_PLAN', message: e instanceof PriceMisconfiguredError ? `The pay-as-you-go price cannot be sold (${e.why}). Paid domains are unavailable until single active recurring USD prices carry the lookup keys rsm_extra_domain_monthly and rsm_extra_domain_yearly.` : 'Stripe could not be asked for the pay-as-you-go prices just now.' });
      if (!(e instanceof PriceMisconfiguredError) && !(e instanceof PriceUnavailableError)) status.plan.prices = 'unreachable';
    }
  }
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
