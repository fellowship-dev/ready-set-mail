// The hosted plan "pay as you go": one free domain per workspace, every extra domain billed once it is proven. Billing owns Stripe, so this lives here.
//   - `hostedPlanOn`: the switch. Off unless the hosted service has billing configured AND HOSTED_PLAN=pay_as_you_go; off means nothing changes anywhere.
//   - `planCap`: the number of places a workspace has under the plan (the one cap `domainCap` in src/domains/service.ts hands to the one room rule, `domainRoom`).
//   - `syncPlan`: the one function that makes Stripe's subscription say how many extra domains are proven and live. A Stripe failure is recorded, never raised.
//   - `planItems`: what the subscription bills (the extra-domain item, plus an item per add-on that has a price). `PLAN_ADD_ONS` is where a feature can attach a price to ONE domain.
import { billingQueries, forWorkspace } from '@ready-set-mail/db';
import { getMode } from '../tenancy/mode';
import type { BoundEnv } from '../index';
import { provenDomainIds } from '../domains/ownership';
import { billingEnabled, type BillingEnv } from './config';
import { billingDeps, idOf, type BillingDeps } from './deps';
import { PriceMisconfiguredError, PriceUnavailableError, resolvePrice, validateRecurringPrice, type OfferPrice } from './price';
import { readCard } from './service';

/** Domains a workspace holds for free. */
export const FREE_DOMAINS = 1;

export type PlanInterval = 'month' | 'year';
export const PLAN_LOOKUP_KEYS: Record<PlanInterval, string> = { year: 'rsm_extra_domain_yearly', month: 'rsm_extra_domain_monthly' };

/** The words for the two prices when Stripe cannot be asked (the 402 body): the owner's rules, D-44. The app shows Stripe's own amounts where it has them. */
export const PLAN_PRICE_WORDS = { month: 'USD 5', year: 'USD 50' } as const;

type PlanEnv = Pick<BillingEnv, 'HOSTED_PLAN'> & Parameters<typeof billingEnabled>[0];

/** The plan is on: hosted, billing configured, and the switch set. Everything else is today's behaviour. */
export function hostedPlanOn(env: PlanEnv): boolean {
  return getMode(env) === 'saas' && billingEnabled(env) && env.HOSTED_PLAN?.trim() === 'pay_as_you_go';
}

/**
 * Add-ons: a feature that costs money per domain (SPF flattening, later) attaches a price to ONE domain here. `lookupKey: null` = the price is not
 * decided: nothing is billed. Nothing is charged for any add-on today.
 */
export const PLAN_ADD_ONS: Record<string, { label: string; lookupKey: string | null }> = {
  'spf-flattening': { label: 'SPF flattening', lookupKey: null },
};

export interface PlanItem { lookupKey: string; quantity: number }

/** The subscription's items: the extra-domain item, plus one item per add-on whose price is set (quantity = the domains that have it). A null lookup key bills nothing. */
export function planItems(quantity: number, addOns: { addOn: string; domainId: number }[], interval: PlanInterval = 'year'): PlanItem[] {
  const items: PlanItem[] = [{ lookupKey: PLAN_LOOKUP_KEYS[interval], quantity: Math.max(0, Math.trunc(quantity)) }];
  const domainsBy = new Map<string, Set<number>>();
  for (const a of addOns) {
    if (!PLAN_ADD_ONS[a.addOn]?.lookupKey) continue;
    (domainsBy.get(a.addOn) ?? domainsBy.set(a.addOn, new Set()).get(a.addOn)!).add(a.domainId);
  }
  for (const [addOn, ids] of domainsBy) items.push({ lookupKey: PLAN_ADD_ONS[addOn]!.lookupKey!, quantity: ids.size });
  return items;
}

/** Extra domains billed: the workspace's proven, live domains beyond the free one. The proof rule is the ownership module's (`provenDomainIds`); claims are never billed. */
export async function billedQuantity(db: D1Database, workspaceId: string): Promise<number> {
  const rows = await forWorkspace(db, workspaceId).domains.list();
  return Math.max(0, provenDomainIds(rows).size - FREE_DOMAINS);
}

/** Is there a default card on the workspace's Stripe customer? Stripe is asked now; a failure counts as no card. */
export async function cardOnFile(env: BoundEnv, workspaceId: string, deps?: BillingDeps): Promise<boolean> {
  const view = await readCard(deps ?? billingDeps(env), { id: workspaceId, name: '' }, null);
  return !!view.card;
}

/**
 * Places a workspace has under the plan, for `placesUsed` places in use (live domains plus open claims): the free place while one is still open
 * (no Stripe call), otherwise FREE_DOMAINS unless a card is on file, then the hosted `max`.
 */
export async function planCap(env: BoundEnv, workspaceId: string, placesUsed: number, max: number): Promise<number> {
  if (placesUsed < FREE_DOMAINS) return FREE_DOMAINS;
  return (await cardOnFile(env, workspaceId)) ? max : FREE_DOMAINS;
}

/** The recurring price of an interval, by lookup key (the offer's price cache pattern). */
export async function planPrice(d: BillingDeps, interval: PlanInterval, fresh = false): Promise<OfferPrice> {
  return resolvePrice(d.db, d.stripe, PLAN_LOOKUP_KEYS[interval], { fresh, now: () => d.now() * 1000, validate: validateRecurringPrice(interval) });
}

/** Both prices for the app; an interval whose price cannot be read is null (the app says the price is not available). */
export async function planPrices(d: BillingDeps): Promise<Record<PlanInterval, { amount: number; currency: string } | null>> {
  const one = (i: PlanInterval) => planPrice(d, i).then((p) => ({ amount: p.amount, currency: p.currency }), (e) => {
    if (!(e instanceof PriceMisconfiguredError || e instanceof PriceUnavailableError)) console.error('[billing] plan price read failed');
    return null;
  });
  const [month, year] = await Promise.all([one('month'), one('year')]);
  return { month, year };
}

export interface PlanView { free_domains: number; interval: PlanInterval; prices: Record<PlanInterval, { amount: number; currency: string } | null>; billed_domains: number; card_on_file: boolean; started: boolean }

/**
 * Make the workspace's subscription say how many extra domains are proven and live. Creates the subscription when the quantity first goes above 0,
 * then only updates the quantity (never deletes: quantity 0 is fine). Never throws: a failure is stored as `sync_error` and the daily job tries again,
 * so adding or removing a domain is never blocked or undone by Stripe.
 */
export async function syncPlan(env: BoundEnv, db: D1Database, workspaceId: string, opts: { fetch?: typeof fetch; now?: () => number } = {}): Promise<void> {
  if (!hostedPlanOn(env)) return;
  const q = billingQueries(db, workspaceId);
  try {
    let plan = await q.plan.get();
    const quantity = await billedQuantity(db, workspaceId);
    if (!plan?.stripe_subscription_id && quantity === 0) return; // nothing to bill, nothing billed yet
    if (plan?.stripe_subscription_id && plan.quantity === quantity && !plan.sync_error) return;
    if (!plan) { await q.plan.ensure(); plan = (await q.plan.get())!; }
    const d = billingDeps(env, undefined, opts);
    if (!plan.stripe_subscription_id) {
      const customerId = await q.customer.get();
      if (!customerId || !(await readCard(d, { id: workspaceId, name: '' }, null)).card) { await q.plan.failed('no card on file'); return; }
      const items = [];
      for (const it of planItems(quantity, [], plan.interval)) items.push({ price: (await resolvePrice(d.db, d.stripe, it.lookupKey, { fresh: true, now: () => d.now() * 1000, validate: validateRecurringPrice(plan.interval) })).price_id, quantity: it.quantity });
      const sub = await d.stripe.createSubscription({ workspaceId, customerId, items, revision: `${plan.interval}-${quantity}` });
      const item = ((sub.items as { data?: unknown[] } | undefined)?.data ?? [])[0];
      const itemId = idOf(item);
      if (!itemId) throw new Error('billing: subscription has no item');
      await q.plan.attach(sub.id, itemId, quantity, d.now());
      return;
    }
    if (!plan.stripe_item_id) throw new Error('billing: plan has no item');
    await d.stripe.updateSubscriptionItem({ workspaceId, itemId: plan.stripe_item_id, quantity, revision: String(d.now()) });
    await q.plan.synced(quantity, d.now());
  } catch (e) {
    console.error(`[billing] plan sync failed: ${(e as Error)?.name ?? 'error'}`);
    try { await q.plan.ensure(); await q.plan.failed(`${(e as Error)?.name ?? 'error'}: ${String((e as Error)?.message ?? '').slice(0, 120)}`); } catch { /* the daily job finds the workspace by its row; nothing more to do */ }
  }
}

/** After a change to what a workspace's proven domains are: sync in the background when the request has a lifetime for it, else now. Never throws (see `syncPlan`). */
export async function syncPlanSoon(env: BoundEnv, workspaceId: string, ctx?: ExecutionContext): Promise<void> {
  if (!hostedPlanOn(env)) return;
  const run = syncPlan(env, env.DB, workspaceId);
  if (ctx) ctx.waitUntil(run); else await run;
}
