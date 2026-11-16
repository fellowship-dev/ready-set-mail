// Pay as you go: one Stripe subscription per workspace, one item, quantity = billable domains (units beyond the free allowance).
//
// Rules this file keeps (docs/billing.md "Pay as you go", ADR 0014 and 0015):
//   - THE SERVER IS THE ONLY WRITER OF THE QUANTITY. It is recomputed from the database inside the workspace's lease (src/hosted/plan.ts withPlanLock)
//     every time, never taken from a request. The idempotency key of every Stripe write names workspace, item, target and the lease's revision.
//   - A domain added while the Stripe update fails is rolled back: the row goes, nothing is billed, nothing is free.
//   - Removing a domain never waits for Stripe: the row goes first; if the update fails the quantity is marked dirty and repaired (over-billing at
//     most one proration until then).
//   - Nothing is charged at a click: an added or removed domain prorates onto the NEXT invoice (Stripe's default), so the confirm can state the amount
//     of that invoice (Stripe's invoice preview) and its date.
//   - With HOSTED_PLAN off nothing here changes anything at Stripe (create, quantity, cancel); only reads and recording the webhook remain.
//   - Nothing is ever deleted for non-payment: a lapsed plan pauses domains (readable, exportable, new reports not processed).
import { billingLookups, forWorkspace, planLookups, type SubscriptionRow } from '@ready-set-mail/db';
import { logAudit } from '../audit/log';
import { DomainServiceError, enrollDomain, commitVerifiedDomain, requireDomainName } from '../domains/service';
import { claimView, verifyClaim } from '../domains/ownership';
import { planHelpUrl } from '../hosted/plan-limits';
import {
  PlanBusyError, billableAfter, loadPlanState, paidPathAvailable, planEnforced, subscriptionState, unitOf, withPlanLock,
  type PlanLock, type PlanState,
} from '../hosted/plan';
import { planEvent } from '../product-analytics/steps';
import type { TenantContext } from '../tenancy/context';
import { BillingError, billingDeps, idOf, type BillingDeps } from './deps';
import type { BoundEnv } from '../index';
import { PriceMisconfiguredError, PriceUnavailableError, resolvePlanPrice, type PlanInterval, type PlanPrice } from './price';
import { readCard, rateLimit, stripeFailure, type Actor, type Ws } from './service';
import { StripeError, StripeNetworkError, type StripeObject } from './stripe-client';

export const PAYMENT_FAILED_TEXT = 'Your card was declined. Use another card.';
export const ACTION_REQUIRED_TEXT = 'Your bank needs you to confirm the payment.';
export const PAYMENT_PROBLEM_TEXT = 'Your last payment did not go through. Update your card to add more domains.';
export const PENDING_TEXT = "Waiting for your bank's confirmation.";
export const NOT_ADDED_TEXT = 'We could not update your plan; the domain was not added. Try again.';

type Ctx = ExecutionContext | undefined;

// ── Stripe objects, read defensively (a subscription is only trusted after the checks in `ours`) ──

interface SubFacts { id: string; status: string; customerId: string | null; workspaceId: string | null; itemId: string | null; priceId: string | null; priceIsOurs: boolean; quantity: number | null; periodEnd: number | null; cancelAtPeriodEnd: boolean; canceledAt: number | null }

export function subFacts(sub: StripeObject): SubFacts {
  const items = (sub.items as { data?: Array<Record<string, unknown>> } | undefined)?.data ?? [];
  const item = items[0];
  const price = item?.price as { id?: unknown; lookup_key?: unknown; product?: unknown; metadata?: Record<string, unknown> } | string | undefined;
  const p = typeof price === 'object' && price ? price : null;
  const meta = (sub.metadata ?? {}) as Record<string, unknown>;
  // API 2025-09-30.clover keeps the period on the item; older shapes on the subscription itself.
  const end = (item?.current_period_end ?? sub.current_period_end) as unknown;
  return {
    id: sub.id, status: String(sub.status ?? ''), customerId: idOf(sub.customer), workspaceId: typeof meta.workspace_id === 'string' ? meta.workspace_id : null,
    priceIsOurs: !!p && (p.lookup_key === 'rsm_extra_domain_monthly' || p.lookup_key === 'rsm_extra_domain_yearly' || idOf(p.product) === OUR_PRODUCT || (p.metadata?.app === 'ready-set-mail' && p.metadata?.offer === 'extra-domain')),
    itemId: typeof item?.id === 'string' ? item.id : null, priceId: typeof price === 'string' ? price : typeof price?.id === 'string' ? price.id : null,
    quantity: typeof item?.quantity === 'number' ? item.quantity : null, periodEnd: typeof end === 'number' ? end : null,
    cancelAtPeriodEnd: sub.cancel_at_period_end === true || (typeof sub.cancel_at === 'number' && sub.cancel_at > 0),
    canceledAt: typeof sub.canceled_at === 'number' ? sub.canceled_at : null,
  };
}

/** The product the extra-domain prices hang on (docs/billing.md, "Stripe setup"). */
const OUR_PRODUCT = 'rsm_extra_domain';

/**
 * Is this subscription one WE made for THIS workspace: its customer and its metadata agree, and its price is ours. The price is ours when it is the one
 * we created the subscription with (stored on the row: the operator moves the lookup key to a new price when the price changes, and the old subscriptions
 * keep their old price), or one of the two the lookup keys resolve to now, or, with no row to say (a subscription being adopted), a price that is
 * recognisably ours (our lookup key, our product, or our price metadata).
 */
export async function isOurs(d: BillingDeps, f: SubFacts, workspaceId: string, customerId: string | null, storedPriceId: string | null = null): Promise<boolean> {
  if (!customerId || f.customerId !== customerId || f.workspaceId !== workspaceId || !f.itemId || !f.priceId) return false;
  if (storedPriceId) { if (storedPriceId === f.priceId) return true; } else if (f.priceIsOurs) return true;
  for (const interval of ['month', 'year'] as const) {
    try { if ((await resolvePlanPrice(d.db, d.stripe, interval, { now: () => d.now() * 1000 })).price_id === f.priceId) return true; } catch (e) { if (!(e instanceof PriceMisconfiguredError)) throw e; }
  }
  return false;
}

// ── Prices and errors ───────────────────────────────────────

export async function planPrice(d: BillingDeps, interval: PlanInterval = 'month', fresh = false): Promise<PlanPrice> {
  try {
    return await resolvePlanPrice(d.db, d.stripe, interval, { fresh, now: () => d.now() * 1000 });
  } catch (e) {
    if (e instanceof PriceMisconfiguredError) { console.error(`[billing] ${e.message}`); throw new BillingError(502, 'price_misconfigured', 'Pay as you go is not available right now.'); }
    if (e instanceof PriceUnavailableError) throw new BillingError(503, 'stripe_unavailable', 'The price could not be read. Try again in a minute.');
    throw stripeFailure(e);
  }
}

/** A Stripe failure while paying, as what the person can do (never a raw code). */
export function paymentFailure(e: unknown): BillingError | null {
  if (!(e instanceof StripeError)) return null;
  if (e.code === 'invoice_payment_intent_requires_action' || e.code === 'payment_intent_authentication_required' || e.declineCode === 'authentication_required') {
    return new BillingError(402, 'payment_action_required', ACTION_REQUIRED_TEXT, { action: 'confirm_payment' });
  }
  if (e.isCardError) return new BillingError(402, 'payment_failed', PAYMENT_FAILED_TEXT, { action: 'update_card' });
  return null;
}

/** An update that did not reach Stripe: the answer for an add (nothing was added). */
function notUpdated(e: unknown): BillingError {
  if (e instanceof BillingError) return e;
  const pay = paymentFailure(e);
  if (pay) return pay;
  if (e instanceof StripeNetworkError || e instanceof StripeError) console.error(`[billing] plan update failed: ${e instanceof StripeError ? `status=${e.status} code=${e.code ?? '-'}` : 'network'}`);
  return new BillingError(502, 'plan_update_failed', NOT_ADDED_TEXT);
}

const busy = () => new BillingError(409, 'plan_busy', 'Another change is being made. Try again in a moment.');
const need = (d: BillingDeps) => {
  if (!planEnforced(d.env)) throw new BillingError(404, 'not_found', 'not found');
  if (!paidPathAvailable(d.env)) throw new BillingError(404, 'not_found', 'not found');
};

// ── The subscription row ────────────────────────────────────

function rowFrom(f: SubFacts, interval: PlanInterval, price: string, sent: number, now: number) {
  return {
    stripe_subscription_id: f.id, stripe_item_id: f.itemId!, price_id: price, interval, status: f.status, quantity_sent: sent, quantity_seen: f.quantity,
    current_period_end: f.periodEnd, cancel_at_period_end: f.cancelAtPeriodEnd ? 1 : 0, canceled_at: f.canceledAt, lapsed_at: null as number | null, dirty: 0,
    action_url: null as string | null, last_failed_at: null as number | null, synced_at: now,
  };
}

export interface StartOutcome { row: SubscriptionRow; state: 'active' | 'pending'; action_url: string | null }

/**
 * The workspace's subscription, created if there is none (or it lapsed), at the quantity the workspace owes NOW (0 for most workspaces: Stripe keeps it
 * active with a $0 first invoice). With a quantity above 0 the first invoice is charged at once (`allow_incomplete`, the pattern of buying Fix one domain):
 *   paid                  active: the plan starts, paused domains resume
 *   declined              the incomplete subscription is cancelled and the caller rolls its domains back (402 payment_failed)
 *   waiting on the bank   the row is stored `incomplete` with the hosted invoice link; the plan starts when `invoice.paid` arrives (or is abandoned if the
 *                         payment never completes): the caller marks the domains it added as pending
 */
export async function startSubscription(d: BillingDeps, lock: PlanLock, ws: Ws, interval: PlanInterval, via: 'add_domain' | 'settings' | 'new_workspace'): Promise<StartOutcome> {
  const q = forWorkspace(d.db, ws.id).plan;
  const existing = await q.subscription.get();
  const existingState = subscriptionState(existing);
  if (existing && existingState !== 'lapsed') return { row: existing, state: existingState === 'pending' ? 'pending' : 'active', action_url: existing.action_url };
  const customerId = lock.state.customerId;
  if (!customerId) throw new BillingError(409, 'card_required', 'Add a card first.');
  const quantity = (await lock.refresh()).billable;
  const price = await planPrice(d, interval, true);
  const revision = await lock.revision();
  let sub: StripeObject;
  try {
    sub = await d.stripe.createSubscription({ workspaceId: ws.id, revision, customerId, priceId: price.price_id, quantity });
  } catch (e) {
    throw paymentFailure(e) ?? (e instanceof BillingError ? e : notUpdated(e));
  }
  const f = subFacts(sub);
  if (f.customerId !== customerId || f.workspaceId !== ws.id || f.priceId !== price.price_id || !f.itemId || f.quantity !== quantity) {
    console.error('[billing] a subscription came back that is not what was asked for; it is cancelled');
    await d.stripe.cancelSubscription(f.id).catch(() => undefined);
    throw new BillingError(502, 'plan_update_failed', NOT_ADDED_TEXT);
  }
  if (f.status === 'active' || f.status === 'trialing') {
    await q.subscription.insert(rowFrom(f, interval, price.price_id, quantity, d.now()));
    await q.setPlan('payg');
    await q.unpauseAll();
    await q.clearPending();
    planEvent(d.env, d.ctx, ws.id, 'Plan Started', { interval, via });
    logAudit({ db: d.db, workspaceId: ws.id }, { actor_id: null, actor_type: 'system', action: 'billing.plan_started', resource_type: 'billing', resource_id: f.id, after_value: { interval, quantity } }, d.ctx);
    return { row: (await q.subscription.get())!, state: 'active', action_url: null };
  }
  // The first payment did not go through at once: a decline, or a payment that waits for the bank.
  const invoiceId = idOf(sub.latest_invoice);
  const inv = invoiceId ? await d.stripe.retrieveInvoice(invoiceId).catch(() => null) : null;
  if (f.status === 'incomplete' && inv && waitingOnBank(inv)) {
    const url = typeof inv.hosted_invoice_url === 'string' && /^https:\/\//.test(inv.hosted_invoice_url) ? inv.hosted_invoice_url : null;
    await q.subscription.insert({ ...rowFrom(f, interval, price.price_id, quantity, d.now()), action_url: url });
    return { row: (await q.subscription.get())!, state: 'pending', action_url: url };
  }
  await d.stripe.cancelSubscription(f.id).catch(() => undefined);
  throw new BillingError(402, 'payment_failed', PAYMENT_FAILED_TEXT, { action: 'update_card' });
}

/** Set the item's quantity to `target` (only under the lease). No-op when Stripe already has it. */
async function pushQuantity(d: BillingDeps, lock: PlanLock, target: number): Promise<void> {
  const q = forWorkspace(d.db, lock.workspaceId).plan;
  const row = await q.subscription.get();
  if (!row) throw new BillingError(409, 'no_plan', 'This workspace is not on pay as you go.');
  if (row.quantity_sent === target && !row.dirty) return;
  const revision = await lock.revision();
  await d.stripe.setItemQuantity({ workspaceId: lock.workspaceId, revision, itemId: row.stripe_item_id, quantity: target });
  await q.subscription.patch({ quantity_sent: target, quantity_seen: target, dirty: 0, synced_at: d.now() });
}

// ── Adding paid domains ─────────────────────────────────────

export interface PaidAddInput { domains: string[]; expectedAmount: number; expectedCurrency: string; /** What the confirm said is charged NOW (cents): required when the add starts the plan, so no charge is a surprise. */ expectedCharge?: number | null; interval?: PlanInterval; via: 'single' | 'cloudflare' }
export interface PaidAddResult { added: { domain: string; domain_id: number }[]; pending: { domain: string; claim_id: number | null; reason?: string }[]; resumed: string[]; failed: { domain: string; error: string; code: string | null }[]; billable: number;
  /** The first payment of a new subscription waits for the owner's bank: the domains added are pending until Stripe says paid. */
  payment: { state: 'requires_action'; action_url: string | null } | null }

/**
 * The owner's confirmed paid add (a browser session of the workspace owner, checked by the route). Re-checks everything the confirm showed, then under
 * the lease enrolls through enrollDomain (with the grant only the lease can make) and sets the quantity from the database.
 */
export async function addPaidDomains(d: BillingDeps, tenant: TenantContext, ws: Ws, actor: Actor, input: PaidAddInput): Promise<PaidAddResult> {
  need(d);
  const undoHit = await rateLimit(d, 'plan', ws.id, actor.userId);
  const interval = input.interval ?? 'month';
  const names = [...new Set(input.domains.map((x) => requireDomainName(x)))];
  if (names.length === 0 || names.length > 10) throw new BillingError(400, 'invalid_domains', 'Choose between one and ten domains.');
  const price = await planPrice(d, interval, true);
  if (input.expectedAmount !== price.amount || input.expectedCurrency.toLowerCase() !== price.currency) {
    throw new BillingError(409, 'price_changed', 'The price changed. Review it and confirm again.', { amount: price.amount, currency: price.currency, interval });
  }
  const view = await readCard(d, ws, actor.email);
  if (!view.customer || !view.card) throw new BillingError(409, 'card_required', 'Add a card first.');

  try {
    return await withPlanLock(d.env, d.db, ws.id, d.now, async (lock): Promise<PaidAddResult> => {
      const st = lock.state;
      if (st.exempt) throw new BillingError(409, 'not_needed', 'This workspace is not on a plan.');
      if (st.subscriptionState === 'payment_problem') throw new BillingError(409, 'payment_problem', PAYMENT_PROBLEM_TEXT, { action: 'update_card' });
      if (st.subscriptionState === 'pending') throw new BillingError(409, 'payment_pending', PENDING_TEXT, { action: 'confirm_payment', action_url: st.subscription?.action_url ?? null });
      const have = new Set(st.rows.map((r) => r.org));
      const fresh = new Set(names.map(unitOf).filter((u) => !have.has(u)));
      // Covered by the free allowance (the first domain of a workspace that holds it, a subdomain): not a paid add, nothing is sent to Stripe.
      const paid = billableAfter(st, fresh.size) > st.billable;
      const grant = paid ? lock.grant(fresh.size) : undefined;
      if (paid && !grant) throw new BillingError(403, 'plan_limit', 'This workspace has reached its limit of domains.', { help_url: planHelpUrl(d.env) });
      // No subscription yet: this add creates it and the first invoice is charged now. The amount is Stripe's own (a preview of that very subscription), and it
      // must be the one the confirm showed: never a charge the person did not see.
      if (paid && (st.subscriptionState === 'none' || st.subscriptionState === 'lapsed')) {
        const first = await newSubscriptionPreview(d, st, billableAfter(st, fresh.size), interval);
        if (!first) throw new BillingError(503, 'preview_unavailable', 'We could not read what this costs just now. Try again in a minute.');
        if (input.expectedCharge === undefined || input.expectedCharge === null || input.expectedCharge !== first.charge_now) {
          throw new BillingError(409, 'price_changed', 'The price changed. Review it and confirm again.', { amount: price.amount, currency: price.currency, interval, charge_now: first.charge_now });
        }
      }
      const result: PaidAddResult = { added: [], pending: [], resumed: [], failed: [], billable: 0, payment: null };
      const addedRows: { id: number; domain: string }[] = [];
      for (const domain of names) {
        try {
          // A claim already waiting for its proof (the TXT record) is checked now; the grant lets the row in once it holds.
          const claim = await tenant.scope.claims.get(domain);
          if (claim && claim.status === 'pending' && claim.settled_at === null && !(await tenant.scope.domains.getByName(domain))) {
            const outcome = await verifyClaim(tenant, claim);
            if (outcome.kind === 'taken') { result.failed.push({ domain, error: 'another workspace has already verified this domain', code: 'domain_taken' }); continue; }
            if (outcome.kind === 'unproven') { result.pending.push({ domain, claim_id: claim.id, reason: outcome.reason }); continue; }
            const done = await commitVerifiedDomain(tenant, domain, outcome.via, actor.email, d.ctx, actor.userId, grant ? { grant } : {});
            if (done.domain && !('resumed' in done && done.resumed)) { addedRows.push({ id: done.domain.id, domain }); result.added.push({ domain, domain_id: done.domain.id }); } else result.resumed.push(domain);
            continue;
          }
          const r = await enrollDomain(tenant, domain, actor.email, d.ctx, actor.userId, grant ? { grant } : {});
          if ('pending' in r && r.pending) result.pending.push({ domain, claim_id: (r.claim as { id?: number } | undefined)?.id ?? null });
          else if ('resumed' in r && r.resumed) result.resumed.push(domain);
          else if (r.domain) { addedRows.push({ id: r.domain.id, domain }); result.added.push({ domain, domain_id: r.domain.id }); }
        } catch (e) {
          if (!(e instanceof DomainServiceError)) throw e;
          result.failed.push({ domain, error: e.message, code: typeof e.body?.code === 'string' ? e.body.code : null });
        }
      }
      const after = await lock.refresh();
      result.billable = after.billable;
      if (!paid || (addedRows.length === 0 && after.subscription && after.subscription.quantity_sent === after.billable)) return result;
      try {
        if (addedRows.length > 0 || after.subscription) {
          // The first paid domain creates the subscription at the quantity owed (charged now); with one, the quantity is raised and Stripe prorates onto the next invoice.
          const started = await startSubscription(d, lock, ws, interval, 'add_domain');
          if (started.state === 'pending') {
            await forWorkspace(d.db, ws.id).plan.markPending(addedRows.map((r) => r.id), d.now());
            result.payment = { state: 'requires_action', action_url: started.action_url };
          } else await pushQuantity(d, lock, (await lock.refresh()).billable);
        }
      } catch (e) {
        for (const row of addedRows) {
          await forWorkspace(d.db, ws.id).plan.rollbackDomain(row.id, row.domain);
          logAudit({ db: d.db, workspaceId: ws.id }, { actor_id: actor.userId, actor_email: actor.email, actor_type: 'user', action: 'domain.add_rolled_back', resource_type: 'domain', resource_id: String(row.id), resource_name: row.domain }, d.ctx);
        }
        await forWorkspace(d.db, ws.id).plan.subscription.markDirty();
        throw notUpdated(e);
      }
      if (addedRows.length && !result.payment) {
        logAudit({ db: d.db, workspaceId: ws.id }, { actor_id: actor.userId, actor_email: actor.email, actor_type: 'user', action: 'billing.domain_added_paid', resource_type: 'billing', resource_id: ws.id, after_value: { domains: addedRows.map((r) => r.domain), billable: after.billable } }, d.ctx);
        planEvent(d.env, d.ctx, ws.id, 'Paid Domain Added', { via: input.via, added: String(addedRows.length) === '1' ? '1' : addedRows.length <= 5 ? '2-5' : '6-20' });
      }
      return result;
    });
  } catch (e) {
    if (e instanceof PlanBusyError) { await undoHit(); throw busy(); }
    throw e;
  }
}

// ── Removing ────────────────────────────────────────────────

/** A removal that finds the workspace's lease taken tries again this many times, 150 ms then double each time (about a second in all), before it marks the quantity dirty. */
const REMOVAL_LEASE_ATTEMPTS = 4;
const REMOVAL_BACKOFF_MS = 150;

/** A domain was removed (the row is gone): bring the quantity down. Never blocks the removal and never throws. */
export async function afterDomainRemoved(d: BillingDeps, workspaceId: string): Promise<{ quantity_changed: boolean }> {
  if (!planEnforced(d.env)) return { quantity_changed: false };
  const q = forWorkspace(d.db, workspaceId).plan;
  const sub = await q.subscription.get();
  if (!sub || subscriptionState(sub) !== 'active') return { quantity_changed: false };
  for (let attempt = 0; attempt < REMOVAL_LEASE_ATTEMPTS; attempt++) {
    try {
      return await withPlanLock(d.env, d.db, workspaceId, d.now, async (lock) => {
        const before = (await q.subscription.get())?.quantity_sent ?? null;
        await pushQuantity(d, lock, lock.state.billable);
        return { quantity_changed: before !== lock.state.billable };
      });
    } catch (e) {
      if (e instanceof PlanBusyError && attempt < REMOVAL_LEASE_ATTEMPTS - 1) { await new Promise((r) => setTimeout(r, REMOVAL_BACKOFF_MS * 2 ** attempt)); continue; }
      break;
    }
  }
  await q.subscription.markDirty().catch(() => undefined); // the owner's next Billing page (repairQuantity) or the daily job repairs it
  return { quantity_changed: false };
}

/**
 * The owner opened Billing: if Stripe's quantity may differ from what the workspace owes (a removal that lost the lease, an eviction), put it right now.
 * Bounded and never blocking the read: it takes the lease once and skips when another change holds it; any failure leaves the quantity dirty for the daily job.
 */
export async function repairQuantity(d: BillingDeps, workspaceId: string): Promise<boolean> {
  if (!planEnforced(d.env) || !paidPathAvailable(d.env)) return false;
  const q = forWorkspace(d.db, workspaceId).plan;
  const sub = await q.subscription.get();
  if (!sub || subscriptionState(sub) !== 'active') return false;
  if (!sub.dirty && sub.quantity_sent === (await loadPlanState(d.env, d.db, workspaceId)).billable) return false; // the common case: no lease taken
  try {
    return await withPlanLock(d.env, d.db, workspaceId, d.now, async (lock) => {
      const row = await q.subscription.get();
      if (lock.state.exempt || !row || (!row.dirty && row.quantity_sent === lock.state.billable)) return false;
      await pushQuantity(d, lock, lock.state.billable);
      return true;
    });
  } catch (e) {
    if (!(e instanceof PlanBusyError)) console.error(`[billing] quantity repair failed: ${(e as Error)?.name ?? 'error'}`);
    return false;
  }
}

/** The hook for code that removes a domain (the API, a workspace delete): the answer's `billing` field, or null when no plan applies. */
export async function planAfterRemoval(env: BoundEnv, workspaceId: string, ctx?: ExecutionContext): Promise<{ quantity_changed: boolean } | null> {
  if (!paidPathAvailable(env)) return null;
  return afterDomainRemoved(billingDeps(env, ctx), workspaceId);
}

/** Bring the quantity to what the workspace owes now (ownership moved, the allowance moved): under the lease, never blocking. */
export const syncQuantity = async (d: BillingDeps, workspaceId: string): Promise<void> => { await afterDomainRemoved(d, workspaceId); };

// ── Starting, keeping one ───────────────────────────────────

/**
 * "Start pay as you go" from Settings. A workspace that owes nothing now (most) gets its subscription at quantity 0: no charge until a domain beyond the
 * free one is added. A workspace that already holds more than its free domain (grandfathered, or lapsed with paused domains) owes its units now: the
 * first invoice is charged at once, the confirm states Stripe's exact amount and the request must echo it (`expectedCharge`).
 */
export async function startPlan(d: BillingDeps, ws: Ws, actor: Actor, input: { interval?: PlanInterval; expectedAmount?: number; expectedCurrency?: string; expectedCharge?: number | null }): Promise<{ plan: 'payg'; payment: { state: 'requires_action'; action_url: string | null } | null }> {
  need(d);
  const undoHit = await rateLimit(d, 'plan', ws.id, actor.userId);
  const interval = input.interval ?? 'month';
  const price = await planPrice(d, interval, true);
  if (input.expectedAmount !== undefined && (input.expectedAmount !== price.amount || (input.expectedCurrency ?? 'usd').toLowerCase() !== price.currency)) {
    throw new BillingError(409, 'price_changed', 'The price changed. Review it and confirm again.', { amount: price.amount, currency: price.currency, interval });
  }
  const view = await readCard(d, ws, actor.email);
  if (!view.customer || !view.card) throw new BillingError(409, 'card_required', 'Add a card first.');
  try {
    return await withPlanLock(d.env, d.db, ws.id, d.now, async (lock) => {
      const st = lock.state;
      if (st.exempt) throw new BillingError(409, 'not_needed', 'This workspace is not on a plan.');
      if (st.subscriptionState === 'payment_problem') throw new BillingError(409, 'payment_problem', PAYMENT_PROBLEM_TEXT, { action: 'update_card' });
      if (st.subscriptionState === 'pending') throw new BillingError(409, 'payment_pending', PENDING_TEXT, { action: 'confirm_payment', action_url: st.subscription?.action_url ?? null });
      if (st.subscriptionState === 'active') return { plan: 'payg' as const, payment: null };
      if (st.billable > 0) {
        const first = await newSubscriptionPreview(d, st, st.billable, interval);
        if (!first) throw new BillingError(503, 'preview_unavailable', 'We could not read what this costs just now. Try again in a minute.');
        if (input.expectedCharge === undefined || input.expectedCharge === null || input.expectedCharge !== first.charge_now) {
          throw new BillingError(409, 'price_changed', 'The price changed. Review it and confirm again.', { amount: price.amount, currency: price.currency, interval, charge_now: first.charge_now });
        }
      }
      const started = await startSubscription(d, lock, ws, interval, 'settings');
      if (started.state === 'pending') return { plan: 'payg' as const, payment: { state: 'requires_action' as const, action_url: started.action_url } };
      return { plan: 'payg' as const, payment: null };
    });
  } catch (e) {
    if (e instanceof PlanBusyError) { await undoHit(); throw busy(); }
    throw e;
  }
}

/** Grandfather choice (and the owner's pick after a lapse): keep ONE unit free; every other unit is paused (readable, exportable, new reports not processed). */
export async function keepOneDomain(d: BillingDeps, ws: Ws, actor: Actor, domainId: number): Promise<{ kept: string; paused: number }> {
  if (!planEnforced(d.env)) throw new BillingError(404, 'not_found', 'not found');
  try {
    return await withPlanLock(d.env, d.db, ws.id, d.now, async (lock) => {
      const st = lock.state;
      if (st.exempt || st.plan !== 'free' || !st.holdsAllowance) throw new BillingError(409, 'not_applicable', 'This workspace keeps its domains.');
      const row = st.rows.find((r) => r.id === domainId);
      if (!row) throw new BillingError(404, 'domain_not_found', 'That domain was not found.');
      const q = forWorkspace(d.db, ws.id).plan;
      const paused = await q.pauseExcept(row.org, d.now());
      await q.unpauseUnit(row.org);
      logAudit({ db: d.db, workspaceId: ws.id }, { actor_id: actor.userId, actor_email: actor.email, actor_type: 'user', action: 'billing.kept_one_domain', resource_type: 'domain', resource_id: String(row.id), resource_name: row.domain, after_value: { paused } }, d.ctx);
      return { kept: row.domain, paused };
    });
  } catch (e) {
    if (e instanceof PlanBusyError) throw busy();
    throw e;
  }
}

// ── Lapse and resume ────────────────────────────────────────

/**
 * The plan ended (Stripe says canceled or unpaid): the workspace is free again. The allowance domain stays (the oldest unit, unless the owner already
 * kept another); every other unit is paused. Nothing is deleted. Idempotent. Under HOSTED_PLAN off the status is recorded and nothing is paused.
 */
export async function lapseWorkspace(d: BillingDeps, workspaceId: string, why: 'lapsed' | 'canceled'): Promise<'lapsed' | 'recorded' | 'noop'> {
  const q = forWorkspace(d.db, workspaceId).plan;
  const sub = await q.subscription.get();
  if (!sub) return 'noop';
  if (!planEnforced(d.env)) return 'recorded';
  if (sub.lapsed_at) return 'noop';
  try {
    return await withPlanLock(d.env, d.db, workspaceId, d.now, async (lock) => {
      const st = lock.state;
      await q.subscription.patch({ lapsed_at: d.now() });
      await q.setPlan('free');
      if (!st.exempt) {
        const orgs = [...new Set(st.rows.map((r) => r.org))];
        const alreadyKept = st.rows.find((r) => !r.paused);
        const keep = st.holdsAllowance ? (alreadyKept ? alreadyKept.org : (st.rows[0]?.org ?? null)) : null;
        await q.pauseExcept(keep, d.now());
        if (keep) await q.unpauseUnit(keep);
        logAudit({ db: d.db, workspaceId }, { actor_id: null, actor_type: 'system', action: 'billing.plan_lapsed', resource_type: 'billing', resource_id: workspaceId, after_value: { units: orgs.length, kept: keep } }, d.ctx);
      }
      planEvent(d.env, d.ctx, workspaceId, 'Subscription Ended', { reason: why });
      return 'lapsed' as const;
    });
  } catch (e) {
    if (e instanceof PlanBusyError) throw new Error('plan busy: the event is retried'); // the webhook answers 500 and Stripe retries
    throw e;
  }
}

/** The bank confirmed the first payment: the plan starts (under the lease), paused domains resume, the pending ones are ordinary domains. */
async function activatePending(d: BillingDeps, workspaceId: string, interval: PlanInterval): Promise<boolean> {
  const q = forWorkspace(d.db, workspaceId).plan;
  return withPlanLock(d.env, d.db, workspaceId, d.now, async () => {
    const pending = await q.pendingRows();
    await q.subscription.patch({ action_url: null, last_failed_at: null });
    await q.setPlan('payg');
    await q.unpauseAll();
    await q.clearPending();
    planEvent(d.env, d.ctx, workspaceId, 'Plan Started', { interval, via: 'add_domain' });
    if (pending.length) {
      planEvent(d.env, d.ctx, workspaceId, 'Paid Domain Added', { via: 'single', added: pending.length === 1 ? '1' : pending.length <= 5 ? '2-5' : '6-20' });
      logAudit({ db: d.db, workspaceId }, { actor_id: null, actor_type: 'system', action: 'billing.domain_added_paid', resource_type: 'billing', resource_id: workspaceId, after_value: { domains: pending.map((r) => r.domain) } }, d.ctx);
    }
    return true;
  }).catch((e) => { if (e instanceof PlanBusyError) throw new Error('plan busy: the event is retried'); throw e; });
}

/** The first payment never completed (the bank did not confirm in time): the pending domains are removed again, the plan was never started, the owner is told once. */
async function abandonPending(d: BillingDeps, workspaceId: string): Promise<void> {
  const q = forWorkspace(d.db, workspaceId).plan;
  await withPlanLock(d.env, d.db, workspaceId, d.now, async () => {
    for (const r of await q.pendingRows()) {
      await q.rollbackDomain(r.id, r.domain);
      logAudit({ db: d.db, workspaceId }, { actor_id: null, actor_type: 'system', action: 'domain.add_rolled_back', resource_type: 'domain', resource_id: String(r.id), resource_name: r.domain }, d.ctx);
    }
    await q.subscription.remove();
    await q.setPlan('free');
    await forWorkspace(d.db, workspaceId).settings.set(PLAN_NOTICE_KEY, 'payment_not_completed');
    planEvent(d.env, d.ctx, workspaceId, 'Subscription Failed', { reason: 'payment_failed' });
  }).catch((e) => { if (e instanceof PlanBusyError) throw new Error('plan busy: the event is retried'); throw e; });
}

/** The one-time notice kept for the owner (read once by GET /api/billing). */
export const PLAN_NOTICE_KEY = 'plan_notice';

// ── Stripe says something happened to a subscription (webhook, return, daily job) ──

export type SubResult = 'applied' | 'lapsed' | 'resumed' | 'abandoned' | 'recorded' | 'foreign' | 'stale' | 'unknown_workspace' | 'gone';

/**
 * Re-read the subscription from Stripe and store what it says, if it is ours: its customer is the workspace's, its metadata names the workspace and its
 * price is one of the two we sell. An event (or a subscription) that fails any of those changes nothing. With the plan off it only records.
 */
export async function applySubscription(d: BillingDeps, subscriptionId: string, opts: { customerHint?: string | null } = {}): Promise<SubResult> {
  let sub: StripeObject;
  try { sub = await d.stripe.retrieveSubscription(subscriptionId); } catch (e) { if (e instanceof StripeError && e.isNotFound) return 'gone'; throw e; }
  const f = subFacts(sub);
  const customerId = f.customerId ?? opts.customerHint ?? null;
  const workspaceId = customerId ? await billingLookups(d.db).workspaceByCustomer(customerId) : null;
  if (!workspaceId) { console.warn(`[billing] subscription ${f.id.slice(0, 12)} ignored: unknown_customer`); return 'unknown_workspace'; }
  const q = forWorkspace(d.db, workspaceId).plan;
  const row = await q.subscription.get();
  if (!(await isOurs(d, f, workspaceId, customerId, row?.stripe_subscription_id === f.id ? row.price_id : null))) { console.warn(`[billing] subscription ${f.id.slice(0, 12)} ignored: foreign_subscription`); return 'foreign'; }
  if (row && row.stripe_subscription_id !== f.id) return 'stale'; // an older subscription of this workspace (one that lapsed, or was replaced)
  if (!row) {
    // Ours, but the row was never written (a crash between Stripe and the database): adopt a live one.
    if (!['active', 'trialing', 'past_due', 'incomplete'].includes(f.status) || !planEnforced(d.env)) return 'recorded';
    const interval: PlanInterval = (await resolvePlanPrice(d.db, d.stripe, 'year', { now: () => d.now() * 1000 }).then((p) => p.price_id === f.priceId).catch(() => false)) ? 'year' : 'month';
    await q.subscription.insert(rowFrom(f, interval, f.priceId!, f.quantity ?? 0, d.now()));
    await q.setPlan('payg');
    return 'applied';
  }
  const state = await loadPlanState(d.env, d.db, workspaceId);
  const owed = state.billable;
  const wasPending = row.status === 'incomplete';
  // Paid at last: the plan starts and the pending domains become ordinary BEFORE the stored status says active, so nothing reads "active" while a domain is still pending.
  if (wasPending && (f.status === 'active' || f.status === 'trialing') && planEnforced(d.env)) await activatePending(d, workspaceId, row.interval);
  await q.subscription.patch({
    status: f.status, quantity_seen: f.quantity, current_period_end: f.periodEnd, cancel_at_period_end: f.cancelAtPeriodEnd ? 1 : 0, canceled_at: f.canceledAt, synced_at: d.now(),
    ...(f.quantity !== null && f.quantity !== owed ? { dirty: 1 } : {}),
    ...(f.status === 'active' || f.status === 'trialing' ? { action_url: null, last_failed_at: null } : {}),
  });
  if (wasPending) {
    // A new subscription whose first payment waited for the bank: paid → the plan starts and its domains stop being pending; never paid → they go again.
    if ((f.status === 'active' || f.status === 'trialing') && planEnforced(d.env)) return 'applied';
    if ((f.status === 'incomplete_expired' || f.status === 'canceled' || f.status === 'unpaid') && planEnforced(d.env)) { await abandonPending(d, workspaceId); return 'abandoned'; }
    return planEnforced(d.env) ? 'applied' : 'recorded';
  }
  if (f.status === 'canceled' || f.status === 'unpaid' || f.status === 'incomplete_expired') return (await lapseWorkspace(d, workspaceId, f.status === 'canceled' ? 'canceled' : 'lapsed')) === 'lapsed' ? 'lapsed' : 'recorded';
  if ((f.status === 'active' || f.status === 'trialing') && row.lapsed_at && planEnforced(d.env)) {
    // The same subscription is paid again after Stripe had given up (unpaid): the plan resumes.
    await q.subscription.patch({ lapsed_at: null });
    await q.setPlan('payg');
    await q.unpauseAll();
    return 'resumed';
  }
  return planEnforced(d.env) ? 'applied' : 'recorded';
}

/** The subscription an invoice belongs to (API 2025-09-30.clover keeps it under `parent`; older shapes at the top level or on a line), or null. */
export function subscriptionOfInvoice(inv: StripeObject): string | null {
  const parent = inv.parent as { subscription_details?: { subscription?: unknown } } | null | undefined;
  const fromParent = idOf(parent?.subscription_details?.subscription);
  if (fromParent) return fromParent;
  const top = idOf(inv.subscription);
  if (top) return top;
  const lines = (inv.lines as { data?: Array<{ parent?: { subscription_item_details?: { subscription?: unknown } } }> } | undefined)?.data ?? [];
  for (const l of lines) { const s = idOf(l.parent?.subscription_item_details?.subscription); if (s) return s; }
  return null;
}

/** A subscription invoice event: store what happened to the plan (a failed renewal, a renewal that needs the bank, a paid one). */
export async function applySubscriptionInvoice(d: BillingDeps, type: 'invoice.paid' | 'invoice.payment_failed' | 'invoice.payment_action_required', invoiceId: string, subscriptionId: string): Promise<SubResult> {
  const result = await applySubscription(d, subscriptionId);
  if (result === 'foreign' || result === 'stale' || result === 'unknown_workspace' || result === 'gone') return result;
  const workspaceId = await planLookups(d.db).workspaceBySubscription(subscriptionId);
  if (!workspaceId) return result;
  const q = forWorkspace(d.db, workspaceId).plan;
  if (type === 'invoice.paid') { await q.subscription.patch({ action_url: null, last_failed_at: null }); return result; }
  const inv = await d.stripe.retrieveInvoice(invoiceId);
  const sub = await q.subscription.get();
  if (!sub || idOf(inv.customer) !== (await q.get())?.stripe_customer_id || subscriptionOfInvoice(inv) !== subscriptionId) return 'foreign';
  if (inv.status === 'paid') { await q.subscription.patch({ action_url: null, last_failed_at: null }); return result; }
  const url = typeof inv.hosted_invoice_url === 'string' && /^https:\/\//.test(inv.hosted_invoice_url) ? inv.hosted_invoice_url : null;
  await q.subscription.patch({ last_failed_at: d.now(), ...(type === 'invoice.payment_action_required' || waitingOnBank(inv) ? { action_url: url } : {}) });
  planEvent(d.env, d.ctx, workspaceId, 'Subscription Failed', { reason: type === 'invoice.payment_action_required' || waitingOnBank(inv) ? 'action_required' : 'payment_failed' });
  return result;
}

/** The invoice's payment is waiting on the bank (3-D Secure), not declined. */
function waitingOnBank(inv: StripeObject): boolean {
  const list = (inv.payments as { data?: Array<{ status?: string; payment?: { payment_intent?: unknown } }> } | undefined)?.data ?? [];
  return list.some((p) => { const pi = p.payment?.payment_intent; return p.status !== 'canceled' && !!pi && typeof pi === 'object' && (pi as { status?: unknown }).status === 'requires_action'; });
}

// ── A deleted workspace ─────────────────────────────────────

/**
 * Cancel the workspace's subscription now (Stripe's default: no refund of the unused period), before its rows go, so billing never outlives it.
 * With the plan off nothing is cancelled at Stripe (documented: the operator does that). Throws a BillingError when it could not be cancelled.
 */
export async function cancelPlanForDelete(d: BillingDeps, workspaceId: string): Promise<boolean> {
  const sub = await forWorkspace(d.db, workspaceId).plan.subscription.get();
  if (!sub || sub.lapsed_at || !planEnforced(d.env)) return false;
  try {
    await d.stripe.cancelSubscription(sub.stripe_subscription_id);
  } catch (e) {
    if (e instanceof StripeError && e.isNotFound) return false; // already gone
    console.error('[billing] the subscription of a deleted workspace could not be cancelled; the workspace was not deleted');
    throw new BillingError(502, 'subscription_cancel_failed', 'We could not end the plan, so nothing was deleted. Try again in a moment.');
  }
  return true;
}

// ── What Settings → Billing and the confirm steps show ──────

export interface MoneyView { amount: number; currency: string; interval: PlanInterval }
/**
 * The date of the next invoice of a subscription, from Stripe's preview: its `period_end`, the end of the current period (the item's `current_period_end`).
 * Not `next_payment_attempt`: on a real preview that is about an hour later (Stripe's finalization delay), which can name the next day.
 */
export function previewDate(inv: StripeObject, fallback: number | null): number | null {
  return typeof inv.period_end === 'number' ? inv.period_end : fallback;
}

export interface NextInvoice { amount_due: number; currency: string; date: number | null }

async function nextInvoiceOf(d: BillingDeps, sub: SubscriptionRow, customerId: string): Promise<NextInvoice | null> {
  try {
    const inv = await d.stripe.upcomingInvoice({ customerId, subscriptionId: sub.stripe_subscription_id });
    return { amount_due: Number(inv.amount_due ?? inv.total ?? 0), currency: String(inv.currency ?? 'usd'), date: previewDate(inv, sub.current_period_end) };
  } catch { return null; }
}

/** The `plan` object of GET /api/billing. Owners get the money; everyone gets the plan's name, what it includes and "ask the owner". */
export async function planView(d: BillingDeps, ws: Ws, who: { isOwner: boolean }) {
  const st = await loadPlanState(d.env, d.db, ws.id);
  const sub = st.subscription;
  const interval: PlanInterval = sub?.interval ?? 'month';
  let price: MoneyView | null = null;
  if (who.isOwner && (paidPathAvailable(d.env) || sub)) {
    try { const p = await planPrice(d, interval); price = { amount: p.amount, currency: p.currency, interval }; } catch { price = null; }
  }
  const state = subscriptionState(sub);
  const ordered = [...new Map(st.rows.map((r) => [r.org, r])).values()];
  const free = st.holdsAllowance ? ordered[0]?.org ?? null : null;
  const domains = st.rows.map((r) => ({ id: r.id, name: r.domain, billable: r.org !== free && !(st.exempt), paused: r.paused }));
  const next = who.isOwner && sub && state === 'active' && st.customerId ? await nextInvoiceOf(d, sub, st.customerId) : null;
  return {
    mode: st.enforced ? 'free_one_domain' : 'off',
    name: st.plan === 'payg' && state !== 'lapsed' ? 'payg' : 'free',
    exempt: st.exempt,
    includes_free_domain: st.holdsAllowance,
    paid_available: paidPathAvailable(d.env), help_url: planHelpUrl(d.env),
    units: st.units, billable: st.billable, paused_units: st.pausedUnits, grandfathered: st.grandfathered, domains,
    status: sub?.status ?? null, payment_problem: state === 'payment_problem', lapsed: state === 'lapsed',
    // A first payment that waits for the owner's bank: the domains added with it are pending until Stripe says paid (the dashboard polls).
    pending: state === 'pending' ? { domains: st.rows.filter((r) => r.pending).map((r) => r.domain), action_url: who.isOwner ? sub?.action_url ?? null : null } : null,
    // After a lapse a workspace without the free domain has every domain paused: one sentence, one action (the dashboard's words).
    paused_domains: st.rows.filter((r) => r.paused).length,
    resume_by_starting: state === 'lapsed' || (st.plan === 'free' && st.rows.some((r) => r.paused) && !st.holdsAllowance),
    cancel_at_period_end: !!sub?.cancel_at_period_end, period_end: sub?.current_period_end ?? null, interval: sub ? interval : null,
    ...(who.isOwner ? {
      price, quantity: sub?.quantity_sent ?? null, monthly_amount: price && st.plan === 'payg' && interval === 'month' ? price.amount * st.billable : null,
      next_invoice: next, action_required_url: sub?.action_url ?? null, can_manage: true,
    } : { ask_owner: true, can_manage: false }),
  };
}

export interface PaidAddPreview {
  needs_confirm: boolean;
  domains: string[];
  new_units: number;
  unit_price: MoneyView | null;
  /**
   * What is charged NOW, in cents, from Stripe's preview of the invoice (0: nothing at the click: with a subscription Stripe prorates onto the next
   * invoice). Null when Stripe could not be asked: then `can_confirm` is false if the add would charge now, and the plain monthly price is all that is said.
   */
  charge_now: number | null;
  /** With a subscription: the next invoice, amount and date from Stripe's preview (null when it could not be read). */
  next_invoice: { amount_due: number; currency: string; date: number | null } | null;
  /** Without one: the monthly amount after this add (the unit price times the quantity: exact) and the day the next period's invoice falls, from the preview's line period. */
  then: { amount: number; currency: string; date: number | null } | null;
  /** This add creates the subscription (and its first invoice is charged now); the explicit start at quantity 0 charges nothing. */
  plan_starts: boolean;
  no_charge: boolean;
  preview_failed: boolean;
  can_confirm: boolean;
  grandfather: { units: number; billable_now: number; billable_after: number } | null;
  reason: 'free' | 'paid' | 'start' | 'active' | 'payment_pending' | 'payment_problem' | 'no_paid_path';
  /** For a domain with a claim waiting on its TXT record: whether the record holds now. `none`: no claim (a Cloudflare zone proves it on the spot, or it is already a domain). */
  proof: { state: 'none' | 'verified' | 'unverified'; domain: string | null; claim_id: number | null; txt_name: string | null; txt_value: string | null; reason: string | null };
}

/** The TXT proof of the one domain a confirm is for, read now (it is the same check the paid add makes): the record to publish, and whether it holds. */
async function proofOf(tenant: TenantContext | undefined, names: string[]): Promise<PaidAddPreview['proof']> {
  const none = { state: 'none' as const, domain: null, claim_id: null, txt_name: null, txt_value: null, reason: null };
  if (!tenant || names.length !== 1) return none;
  const domain = names[0]!;
  const claim = await tenant.scope.claims.get(domain);
  if (!claim || claim.status !== 'pending' || claim.settled_at !== null || (await tenant.scope.domains.getByName(domain))) return none;
  const view = claimView(claim);
  const outcome = await verifyClaim(tenant, claim);
  if (outcome.kind === 'verified') return { state: 'verified', domain, claim_id: claim.id, txt_name: view.txt_name, txt_value: view.txt_value, reason: null };
  return { state: 'unverified', domain, claim_id: claim.id, txt_name: view.txt_name, txt_value: view.txt_value, reason: outcome.kind === 'unproven' ? outcome.reason : null };
}

/** Stripe's own numbers for a subscription that does not exist yet: the first invoice (charged now) and the date its period ends. Null when Stripe cannot say. */
async function newSubscriptionPreview(d: BillingDeps, st: PlanState, quantity: number, interval: PlanInterval): Promise<{ charge_now: number; currency: string; period_end: number | null; monthly: number } | null> {
  if (!st.customerId) return null;
  try {
    const price = await planPrice(d, interval);
    const inv = await d.stripe.previewNewSubscription({ customerId: st.customerId, priceId: price.price_id, quantity });
    const line = (inv.lines as { data?: Array<{ period?: { end?: unknown } }> } | undefined)?.data?.[0];
    const end = line?.period?.end;
    return { charge_now: Number(inv.amount_due ?? inv.total ?? 0), currency: String(inv.currency ?? price.currency), period_end: typeof end === 'number' ? end : null, monthly: price.amount * quantity };
  } catch { return null; }
}

/**
 * What a paid add of these domains would be, for the confirm step. Every amount is Stripe's: with a subscription its preview of the next invoice; without
 * one its preview of the first invoice (charged now). Nothing is computed here but the unit price times a quantity. No domains: the explicit "Start pay as you go".
 */
export async function previewPaidAdd(d: BillingDeps, ws: Ws, domains: string[], interval: PlanInterval = 'month', tenant?: TenantContext): Promise<PaidAddPreview> {
  const names = [...new Set(domains.map((x) => requireDomainName(x)))];
  const st = await loadPlanState(d.env, d.db, ws.id);
  const have = new Set(st.rows.map((r) => r.org));
  const fresh = new Set(names.map(unitOf).filter((u) => !have.has(u)));
  const target = billableAfter(st, fresh.size);
  const proof = await proofOf(tenant, names);
  const base = { proof, domains: names, new_units: fresh.size, grandfather: st.grandfathered ? { units: st.units, billable_now: st.billable, billable_after: target } : null, no_charge: false, preview_failed: false, then: null, next_invoice: null, plan_starts: false, charge_now: 0 as number | null, can_confirm: true };
  const none = (reason: PaidAddPreview['reason'], unit_price: MoneyView | null = null): PaidAddPreview => ({ ...base, needs_confirm: false, unit_price, can_confirm: false, reason });
  if (!paidPathAvailable(d.env) || st.exempt) return none('no_paid_path');
  const price = await planPrice(d, interval);
  const unit_price = { amount: price.amount, currency: price.currency, interval };
  if (st.subscriptionState === 'payment_problem') return none('payment_problem', unit_price);
  if (st.subscriptionState === 'pending') return none('payment_pending', unit_price);
  const starting = names.length === 0;
  if (starting && st.subscriptionState === 'active') return none('active', unit_price);
  if (!starting && target <= st.billable) return { ...base, needs_confirm: false, unit_price, can_confirm: false, reason: 'free' };
  const sub = st.subscription;
  if (sub && st.subscriptionState === 'active' && st.customerId) {
    try {
      const inv = await d.stripe.previewInvoice({ customerId: st.customerId, subscriptionId: sub.stripe_subscription_id, itemId: sub.stripe_item_id, quantity: target });
        return { ...base, needs_confirm: true, unit_price, reason: 'paid', next_invoice: { amount_due: Number(inv.amount_due ?? inv.total ?? 0), currency: String(inv.currency ?? price.currency), date: previewDate(inv, sub.current_period_end) } };
    } catch { return { ...base, needs_confirm: true, unit_price, reason: 'paid', preview_failed: true }; }
  }
  // No subscription (or a lapsed one): this creates it, and a quantity above 0 is charged now.
  if (target === 0) return { ...base, needs_confirm: true, unit_price, plan_starts: true, no_charge: true, reason: starting ? 'start' : 'paid' };
  const first = await newSubscriptionPreview(d, st, target, interval);
  if (!first) return { ...base, needs_confirm: true, unit_price, plan_starts: true, charge_now: null, preview_failed: true, can_confirm: false, reason: starting ? 'start' : 'paid' };
  return { ...base, needs_confirm: true, unit_price, plan_starts: true, charge_now: first.charge_now, then: { amount: first.monthly, currency: first.currency, date: first.period_end }, reason: starting ? 'start' : 'paid' };
}

/** What removing a domain does to the bill: whether it is a billable one, and Stripe's preview of the next invoice without it (never a number computed here). */
export async function previewRemoval(d: BillingDeps, ws: Ws, domainId: number): Promise<{ billable: boolean; unit_price: MoneyView | null; next_invoice: { amount_due: number; currency: string; date: number | null } | null }> {
  const st = await loadPlanState(d.env, d.db, ws.id);
  const row = st.rows.find((r) => r.id === domainId);
  if (!row) throw new BillingError(404, 'domain_not_found', 'That domain was not found.');
  const free = st.holdsAllowance ? st.rows[0]?.org : null;
  const sub = st.subscription;
  const billable = !st.exempt && st.plan === 'payg' && subscriptionState(sub) === 'active' && row.org !== free && !row.paused;
  if (!billable || !sub || !st.customerId) return { billable: false, unit_price: null, next_invoice: null };
  const interval = sub.interval;
  const others = st.rows.filter((r) => r.org === row.org && r.id !== row.id).length;
  const target = others > 0 ? st.billable : Math.max(0, st.billable - 1); // the unit goes only with its last row
  let unit_price: MoneyView | null = null;
  try { const p = await planPrice(d, interval); unit_price = { amount: p.amount, currency: p.currency, interval }; } catch { /* no amount */ }
  try {
    const inv = await d.stripe.previewInvoice({ customerId: st.customerId, subscriptionId: sub.stripe_subscription_id, itemId: sub.stripe_item_id, quantity: target });
    return { billable: true, unit_price, next_invoice: { amount_due: Number(inv.amount_due ?? inv.total ?? 0), currency: String(inv.currency ?? 'usd'), date: previewDate(inv, sub.current_period_end) } };
  } catch { return { billable: true, unit_price, next_invoice: null }; }
}

// ── The daily job ───────────────────────────────────────────

export interface PlanSyncReport { synced: number; repaired: number; lapsed: number; failed: number }

/**
 * Each pay-as-you-go workspace (a bounded batch, never-synced and dirty first): re-read Stripe, refresh status, and (plan on) bring Stripe's quantity to
 * the database count (the server count wins), then lapse what Stripe says has ended. With the plan off it only reads and records.
 */
export async function reconcilePlans(d: BillingDeps, batch: number): Promise<PlanSyncReport> {
  const report: PlanSyncReport = { synced: 0, repaired: 0, lapsed: 0, failed: 0 };
  for (const row of await planLookups(d.db).dueForSync(batch)) {
    try {
      const r = await applySubscription(d, row.stripe_subscription_id, {});
      if (r === 'lapsed') report.lapsed++;
      const q = forWorkspace(d.db, row.workspace_id).plan;
      const now = await q.subscription.get();
      if (planEnforced(d.env) && paidPathAvailable(d.env) && now && subscriptionState(now) === 'active' && (now.dirty || now.quantity_seen !== now.quantity_sent)) {
        await withPlanLock(d.env, d.db, row.workspace_id, d.now, async (lock) => {
          if (lock.state.exempt) return;
          await pushQuantity(d, lock, lock.state.billable);
          report.repaired++;
        });
      }
      report.synced++;
    } catch (e) {
      report.failed++;
      console.error(`[billing] plan sync of a workspace failed: ${e instanceof PlanBusyError ? 'busy' : (e as Error)?.name ?? 'error'}`);
    }
  }
  return report;
}
