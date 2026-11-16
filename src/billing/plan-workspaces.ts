// Workspaces under the plan: who may create another one, how a workspace with a card is created, and what an ownership transfer does to the allowance.
//
//   A person's FIRST workspace holds their free domain (the allowance). A second workspace is allowed when the person already pays somewhere (they own a
//   workspace whose subscription is active): it holds no allowance, so its first domain is a paid one (card for THAT workspace, then its plan starts).
//   Otherwise the person adds a card first: the workspace id is allocated in `workspace_intents` and the workspace row is written only when Stripe's setup
//   Checkout succeeded (return URL or webhook, whichever first). Nothing exists, holds a place under the cap of five, or can be invited into before that.
import { billingQueries, planLookups, workspaceLifecycle, type CheckoutSessionRow } from '@ready-set-mail/db';
import { logAudit } from '../audit/log';
import { isInstanceOwner } from '../funnel/routes';
import { paidPathAvailable, planEnforced, withPlanLock, PlanBusyError, loadPlanState } from '../hosted/plan';
import { planHelpUrl, planLimits } from '../hosted/plan-limits';
import { workspaceAdded } from '../product-analytics/steps';
import type { BoundEnv } from '../index';
import { BillingError, billingDeps, type BillingDeps } from './deps';
import { appUrl } from './paths';
import { planPrice, startSubscription, syncQuantity } from './plan-service';
import { completeSetupSession, rateLimit, stripeFailure, type Actor, type Ws } from './service';
import type { StripeObject } from './stripe-client';

export type CreateDecision = 'plain' | 'free' | 'eligible' | 'needs_card';

/** May this person create a workspace now, and how? `plain`: no plan applies (off, self-host, the operator): today's cap only. */
export async function createDecision(env: Pick<BoundEnv, 'MODE' | 'SAAS_ENABLED' | 'HOSTED_PLAN' | 'OWNER_EMAIL'>, db: D1Database, user: { id: string; email: string }): Promise<CreateDecision> {
  if (!planEnforced(env)) return 'plain';
  if (isInstanceOwner(env, { kind: 'session', email: user.email, role: 'owner', workspaceId: '' })) return 'plain';
  const lookups = planLookups(db);
  if (!(await lookups.allowanceOf(user.id))) return 'free';
  const owned = await lookups.ownedBy(user.id);
  return owned.some((w) => w.plan === 'payg' && ['active', 'trialing'].includes(w.status ?? '') && !w.cancel_at_period_end) ? 'eligible' : 'needs_card';
}

/** The 402 for a person who must add a card before creating another workspace. */
export async function workspaceNeedsCardBody(env: BoundEnv) {
  const paid = paidPathAvailable(env);
  // The price is Stripe's (the screen says "$5 a month for each domain in it"); when it cannot be read the screen says it without an amount.
  let unit_price: { amount: number; currency: string; interval: 'month' | 'year' } | null = null;
  if (paid) { try { const p = await planPrice(billingDeps(env), 'month'); unit_price = { amount: p.amount, currency: p.currency, interval: 'month' }; } catch { /* no amount */ } }
  return {
    error: paid ? 'Add a card to create more workspaces.' : 'Your free plan includes one workspace. For more, talk to us.',
    code: 'workspace_needs_card' as const, paid_available: paid, help_url: planHelpUrl(env), unit_price,
  };
}

export const MAX_OPEN_INTENTS = 3;
const INTENT_TTL_SECONDS = 24 * 3600;

/** Start "Add a card to create a workspace": the intent, the customer for the future workspace, and Stripe's hosted setup page. */
export async function startWorkspaceIntent(d: BillingDeps, current: Ws, actor: Actor, name: string, origin: string): Promise<{ url: string }> {
  if ((await createDecision(d.env, d.db, { id: actor.userId, email: actor.email })) !== 'needs_card' || !paidPathAvailable(d.env)) {
    throw new BillingError(409, 'not_needed', 'You can create this workspace without adding a card.');
  }
  await rateLimit(d, 'session', `intent:${actor.userId}`, actor.userId);
  const caps = planLimits(d.env);
  const lifecycle = workspaceLifecycle(d.db);
  if (caps && (await lifecycle.ownedCount(actor.userId)) >= caps.workspacesPerUser) throw new BillingError(403, 'plan_limit', `You have reached the limit of ${caps.workspacesPerUser} workspaces you can own.`);
  const lookups = planLookups(d.db);
  await lookups.intents.purge(d.now() - INTENT_TTL_SECONDS);
  if ((await lookups.intents.openCount(actor.userId)) >= MAX_OPEN_INTENTS) throw new BillingError(429, 'rate_limited', 'Too many attempts. Try again in a few minutes.', { retry_after: 600 });
  const id = `ws_${crypto.randomUUID().replace(/-/g, '')}`;
  await lookups.intents.insert({ id, user_id: actor.userId, name, stripe_customer_id: null });
  try {
    const customerId = (await d.stripe.createCustomer({ workspaceId: id, email: actor.email, name })).id;
    await lookups.intents.setCustomer(id, customerId);
    const ref = `bcs_${crypto.randomUUID().replace(/-/g, '')}`;
    const q = billingQueries(d.db, id);
    await q.sessions.insert({ ref, user_id: actor.userId, purpose: 'create_workspace', return_path: '/', stripe_customer_id: customerId });
    let session: StripeObject;
    try {
      session = await d.stripe.createSetupSession({
        ref, customerId, workspaceId: id, purpose: 'create_workspace',
        successUrl: `${origin}/api/billing/checkout/return?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: appUrl(origin, current.id, '/', { workspace: 'canceled' }),
      });
    } catch (e) { await q.sessions.drop(ref); throw e; }
    if (typeof session.url !== 'string' || !session.url) throw new Error('billing: Checkout session has no url');
    await q.sessions.attach(ref, session.id);
    return { url: session.url };
  } catch (e) {
    await lookups.intents.purge(0).catch(() => undefined); // nothing: only expired ones go; the open intent expires by itself
    throw e instanceof BillingError ? e : stripeFailure(e);
  }
}

export type IntentResult = 'created' | 'incomplete' | 'mismatch' | 'limit';

/**
 * The card was saved at Stripe for a workspace that does not exist yet: verify it, create the workspace with the pre-allocated id (the cap of five is
 * checked in the same statement), attach the customer and start its plan at quantity 0. Safe to run twice (return URL and webhook): one wins.
 */
export async function completeWorkspaceIntent(d: BillingDeps, row: CheckoutSessionRow, ctx: ExecutionContext | undefined): Promise<IntentResult> {
  const lookups = planLookups(d.db);
  const intent = await lookups.intents.get(row.workspace_id);
  if (!intent || intent.user_id !== row.user_id || !intent.stripe_customer_id || intent.stripe_customer_id !== row.stripe_customer_id) return 'mismatch';
  if (intent.status === 'created') return 'created';
  if (intent.status !== 'open') return 'mismatch';
  const saved = await completeSetupSession(d, row, { customerId: intent.stripe_customer_id });
  if (saved !== 'completed') return saved;
  if (!(await lookups.intents.claim(intent.id))) return 'created';
  const caps = planLimits(d.env);
  const lifecycle = workspaceLifecycle(d.db);
  const made = caps ? await lifecycle.createCapped(intent.id, intent.name, intent.user_id, caps.workspacesPerUser, 'none') : (await lifecycle.create(intent.id, intent.name, intent.user_id), true);
  if (!made) { await lookups.intents.reopen(intent.id); return 'limit'; }
  await billingQueries(d.db, intent.id).customer.claim(intent.stripe_customer_id);
  logAudit({ db: d.db, workspaceId: intent.id }, { actor_id: intent.user_id, actor_type: 'user', action: 'workspace.created', resource_type: 'workspace', resource_id: intent.id, resource_name: intent.name, meta: { with_card: true } }, ctx);
  workspaceAdded({ ...d.env, DB: d.db }, ctx, intent.id);
  try {
    await withPlanLock(d.env, d.db, intent.id, d.now, async (lock) => { await startSubscription(d, lock, { id: intent.id, name: intent.name }, 'month', 'new_workspace'); });
  } catch (e) {
    // The workspace exists with its card; its plan starts with its first paid domain.
    console.error(`[billing] the plan of a new workspace did not start (${e instanceof BillingError ? e.code : e instanceof PlanBusyError ? 'busy' : (e as Error)?.name ?? 'error'})`);
  }
  return 'created';
}

// ── Ownership transfer ──────────────────────────────────────

export interface TransferCheck {
  /** The transfer may go ahead. */
  ok: boolean;
  status?: number;
  body?: Record<string, unknown>;
  /** After the transfer committed: bring the subscription's quantity to what the workspace owes now. */
  after?: () => Promise<void>;
}

const dollars = (cents: number) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;

/**
 * The allowance follows the new owner's count. It moves with the workspace when the new owner holds none. When they already hold one, the workspace
 * loses its allowance: if it holds domains it then needs an ACTIVE plan, and the confirm states the new monthly amount (409 `confirm_required` until the
 * request echoes it); without one the transfer is refused (409 `plan_required`). The database moves the allowance in the same batch as the role swap
 * (workspaceLifecycle.transferOwnership); this reads and decides.
 */
export async function checkTransfer(env: BoundEnv, db: D1Database, workspaceId: string, toUser: { id: string; name: string }, confirm: { amount?: unknown }, ctx?: ExecutionContext): Promise<TransferCheck> {
  if (!planEnforced(env)) return { ok: true };
  const st = await loadPlanState(env, db, workspaceId);
  if (st.exempt || !(st.holdsAllowance && (await planLookups(db).allowanceOf(toUser.id)))) return { ok: true };
  if (st.units === 0) return { ok: true }; // nothing in it: nothing to bill
  const who = toUser.name || 'The new owner';
  const active = st.plan === 'payg' && st.subscriptionState === 'active';
  const d = paidPathAvailable(env) ? billingDeps({ ...env, DB: db } as BoundEnv, ctx) : null;
  if (!active || !d) {
    let each = ' more domains need pay as you go.';
    if (d) { try { each = ` its domains would then cost ${dollars((await planPrice(d, st.subscription?.interval ?? 'month')).amount)} a month each.`; } catch { /* true without the amount */ } }
    return { ok: false, status: 409, body: { error: `${who} already has a free workspace. Add a card to this workspace first;${each}`, code: 'plan_required', paid_available: !!d, help_url: planHelpUrl(env) } };
  }
  const price = await planPrice(d, st.subscription?.interval ?? 'month');
  const monthly = price.amount * st.units; // no allowance after the transfer: every unit is billable
  if (confirm.amount !== monthly) {
    return { ok: false, status: 409, body: { error: `After the transfer this workspace costs ${dollars(monthly)} a month. Confirm to continue.`, code: 'confirm_required', monthly_amount: monthly, currency: price.currency, interval: price.interval } };
  }
  return { ok: true, after: async () => { await syncQuantity(d, workspaceId); } };
}
