// /api/billing/*, POST /api/stripe/webhook and /api/operator/orders*: hosted billing. One mount line in src/api/router.ts.
//
// Everything is 404 unless billing is on (MODE=saas + SAAS_ENABLED=1 + a restricted Stripe key + a webhook secret): a self-hosted instance and a
// hosted one without billing have none of these routes. Every route derives the workspace from the signed-in browser session (the app's
// resolver); an order, session or domain id of another workspace behaves exactly like a missing one (404). API keys and agent credentials are
// refused: money is spent from a browser session only. State-changing routes inherit the resolver's CSRF check for cookie sessions.
import { billingLookups, billingQueries, forWorkspace, globalQueries, workspaceLifecycle, type MembershipRole } from '@ready-set-mail/db';
import { AuthError } from '../api/auth';
import { DomainServiceError } from '../domains/service';
import { siteOrigin } from '../auth/legal';
import { isInstanceOwner } from '../funnel/routes';
import type { BoundEnv } from '../index';
import type { AuthedWorkspace } from '../auth/resolver';
import type { WorkspaceResolver } from '../tenancy/resolver';
import { billingEnabled } from './config';
import { billingDeps, BillingError, type BillingDeps } from './deps';
import { auditOrder } from './notify';
import { NEXT_STEPS, OFFER_ID, OFFER_NAME, OFFER_SCOPE, REFUND_RULE } from './offer';
import { operatorView, orderView, predecessorsOf, STAMP, type OperatorOrderView } from './orders';
import { appLocation, BILLING_PATH, safeReturnPath } from './paths';
import { completeSetupSession, offerPrice, purchase, readCard, readOrder, startCardSession, startPortalSession, type Actor, type Ws } from './service';
import { PLAN_NOTICE_KEY, addPaidDomains, cancelPendingPlan, applySubscription, keepOneDomain, planView, previewPaidAdd, previewRemoval, repairQuantity, startPlan } from './plan-service';
import { completeWorkspaceIntent, startWorkspaceIntent } from './plan-workspaces';
import { planEnforced } from '../hosted/plan';
import { cleanName } from '../auth/names';
import { loadTenant } from '../tenancy/load';
import { handleStripeWebhook } from './webhook';
import { offerViewed } from '../product-analytics/steps';

export interface RouteOpts { fetch?: typeof fetch; now?: () => number }

const NO_STORE: Readonly<Record<string, string>> = { 'Cache-Control': 'no-store' };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
const fail = (status: number, code: string, error: string, extra: Record<string, unknown> = {}) => json({ error, code, ...extra }, status);

export function isBillingPath(path: string): boolean {
  return path === '/api/billing' || path.startsWith('/api/billing/') || path === '/api/stripe/webhook' || path === '/api/operator/orders' || path.startsWith('/api/operator/orders/');
}

function publicOrigin(env: Pick<BoundEnv, 'BETTER_AUTH_URL'>, request: Request): string {
  try {
    const u = new URL(env.BETTER_AUTH_URL ?? '');
    if (u.protocol === 'https:' || u.hostname === '127.0.0.1' || u.hostname === 'localhost') return u.origin;
  } catch { /* the request's own origin */ }
  return new URL(request.url).origin;
}

interface Caller { userId: string; email: string; role: MembershipRole; ws: Ws; actor: Actor; kind: string }

async function caller(request: Request, env: BoundEnv, resolver: WorkspaceResolver): Promise<Caller | Response> {
  let w: Awaited<ReturnType<WorkspaceResolver>>;
  try {
    w = await resolver(request, env);
  } catch (e) {
    if (e instanceof AuthError) return json({ error: e.message }, e.status);
    return json({ error: 'authentication error' }, 401);
  }
  if (!w) return json({ error: 'Unauthorized — sign in' }, 401);
  const kind = (w as AuthedWorkspace).kind;
  if (kind !== 'session' || !w.userId || !w.role) return fail(403, 'session_required', 'Billing needs a signed-in browser session.');
  const user = await globalQueries(env.DB).users.byId(w.userId);
  const name = await billingLookups(env.DB).workspaceName(w.workspaceId);
  if (!user || name === null) return json({ error: 'Unauthorized — sign in' }, 401);
  return { userId: user.id, email: user.email, role: w.role as MembershipRole, ws: { id: w.workspaceId, name }, actor: { userId: user.id, email: user.email }, kind };
}

const OWNER_ONLY = fail.bind(null, 403, 'owner_required', 'Only the workspace owner can add a card or buy.');

async function body(request: Request): Promise<Record<string, unknown> | Response> {
  const text = await request.text();
  if (text.length > 4096) return fail(413, 'too_large', 'Request too large.');
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : fail(400, 'invalid_body', 'Send a JSON object.');
  } catch {
    return fail(400, 'invalid_body', 'Invalid JSON body.');
  }
}

async function offerView(d: BillingDeps) {
  try {
    const p = await offerPrice(d);
    return { offer: { id: OFFER_ID, name: OFFER_NAME, scope: OFFER_SCOPE, amount: p.amount, currency: p.currency, refund_rule: REFUND_RULE, next_steps: NEXT_STEPS }, offer_problem: null as string | null };
  } catch (e) {
    return { offer: null, offer_problem: e instanceof BillingError ? e.code : 'unavailable' };
  }
}

/** Terms and refund policy are pages of the website: `<site origin>/terms` and `<site origin>/refund-policy` (the origin the app already has: SITE_URL, else the hosted site). */
function links(env: BoundEnv) {
  const origin = siteOrigin(env);
  return { terms_url: origin ? `${origin}/terms` : null, refund_policy_url: origin ? `${origin}/refund-policy` : null };
}

/** What the viewer may know of the workspace's card: the owner sees it and the billing email; everyone else only whether there is one. */
function cardFields(isOwner: boolean, view: Awaited<ReturnType<typeof readCard>>) {
  const card_on_file = !!view.card;
  return isOwner ? { card_on_file, card: view.card, billing_email: view.email } : { card_on_file };
}

export async function handleBillingRoutes(request: Request, env: BoundEnv, ctx: ExecutionContext, resolver: WorkspaceResolver, opts: RouteOpts = {}): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!isBillingPath(path)) return null;
  if (!billingEnabled(env)) return json({ error: 'not found' }, 404);
  if (path === '/api/stripe/webhook') return handleStripeWebhook(request, env, ctx, opts);
  const method = request.method.toUpperCase();
  try {
    if (path.startsWith('/api/operator/orders')) return await operatorRoutes(request, env, ctx, resolver, opts, path, method);
    return await workspaceRoutes(request, env, ctx, resolver, opts, url, path, method);
  } catch (e) {
    if (e instanceof BillingError) return json({ error: e.message, code: e.code, ...e.extra }, e.status, e.code === 'rate_limited' ? { 'Retry-After': String(e.extra.retry_after ?? 600) } : {});
    console.error(`[billing] route failed: ${(e as Error)?.name ?? 'error'}`);
    return fail(500, 'billing_error', 'Billing failed unexpectedly.');
  }
}

async function workspaceRoutes(request: Request, env: BoundEnv, ctx: ExecutionContext, resolver: WorkspaceResolver, opts: RouteOpts, url: URL, path: string, method: string): Promise<Response> {
  // The return from Stripe's hosted page is a browser navigation: it carries the cookie but cannot carry X-Workspace-Id.
  if (path === '/api/billing/checkout/return') return method === 'GET' ? checkoutReturn(request, env, ctx, resolver, opts, url) : fail(405, 'method_not_allowed', 'Method not allowed.');

  const me = await caller(request, env, resolver);
  if (me instanceof Response) return me;
  const d = billingDeps(env, ctx, opts);
  const isOwner = me.role === 'owner';
  const scope = forWorkspace(env.DB, me.ws.id);

  if (path === '/api/billing' && method === 'GET') {
    const [view, { offer, offer_problem }] = await Promise.all([readCard(d, me.ws, isOwner ? me.email : null), offerView(d)]);
    const orders = await scope.billing.orders.list(50);
    // The plan (HOSTED_PLAN on, or a subscription that exists: shown read-only after a rollback). Nothing new appears otherwise.
    let sub = await scope.plan.subscription.get();
    // A first payment waiting for the bank: the owner's confirm polls here, so ask Stripe again (the webhook may be late or lost).
    if (isOwner && sub?.status === 'incomplete' && planEnforced(env)) { await applySubscription(d, sub.stripe_subscription_id).catch(() => undefined); sub = await scope.plan.subscription.get(); }
    // The owner's Billing page repairs a quantity that drifted (a removal that lost the lease): bounded, skipped when busy, never failing the read.
    if (isOwner && sub && (await repairQuantity(d, me.ws.id))) sub = await scope.plan.subscription.get();
    const plan = planEnforced(env) || sub ? await planView(d, me.ws, { isOwner, cardAddedAt: view.added_at ?? null }) : null;
    // The one-time notice (a first payment that never completed): shown to the owner once.
    let notice: string | null = null;
    if (plan && isOwner) { notice = (await scope.settings.get(PLAN_NOTICE_KEY))?.value || null; if (notice) await scope.settings.set(PLAN_NOTICE_KEY, ''); }
    return json({
      enabled: true, role: me.role, can_manage: isOwner, ...(plan ? { plan: { ...plan, notice } } : {}),
      ...cardFields(isOwner, view), has_customer: view.customer, ...(view.unavailable ? { card_unavailable: true } : {}),
      offer, offer_problem, orders: orders.map(orderView), ...links(env),
    });
  }

  const rm = path.match(/^\/api\/billing\/domains\/(\d{1,9})\/removal$/);
  if (rm && method === 'GET') {
    if (!planEnforced(env)) return json({ error: 'not found' }, 404);
    if (!isOwner) return OWNER_ONLY();
    return json(await previewRemoval(d, me.ws, Number(rm[1])));
  }
  const dm = path.match(/^\/api\/billing\/domains\/(\d{1,9})$/);
  if (dm && method === 'GET') {
    const domain = await scope.domains.getById(Number(dm[1]));
    if (!domain) return fail(404, 'domain_not_found', 'That domain was not found.');
    const open = await scope.billing.orders.open(domain.domain, OFFER_ID);
    const openNow = open ? await readOrder(d, me.ws.id, open.id) : null;
    const stillOpen = openNow && (openNow.status === 'pending' || openNow.status === 'paid' || openNow.status === 'started') ? openNow : null;
    const [view, { offer, offer_problem }] = await Promise.all([readCard(d, me.ws, isOwner ? me.email : null), offerView(d)]);
    const history = await scope.billing.orders.forDomain(domain.domain);
    if (isOwner && offer && !stillOpen) offerViewed(env, ctx, me.ws.id, !!view.card);
    return json({
      domain: { id: domain.id, name: domain.domain }, role: me.role, can_buy: isOwner && !!offer && !stillOpen,
      has_customer: view.customer, ...cardFields(isOwner, view), ...(view.unavailable ? { card_unavailable: true } : {}),
      offer, offer_problem, open_order: stillOpen ? orderView(stillOpen) : null, orders: history.map(orderView), ...links(env),
    });
  }

  if (path === '/api/billing/domains/preview' && method === 'GET') {
    if (!planEnforced(env)) return json({ error: 'not found' }, 404);
    if (!isOwner) return OWNER_ONLY();
    const names = url.searchParams.getAll('domain').slice(0, 10);
    // No domain: the explicit "Start pay as you go" (what it would charge now, which is nothing for most workspaces).
    if (names.length === 0 && url.searchParams.get('start') !== '1') return fail(400, 'invalid_domains', 'domain is required.');
    return json(await previewPaidAdd(d, me.ws, names, url.searchParams.get('interval') === 'year' ? 'year' : 'month', names.length === 1 ? await loadTenant(env, { workspaceId: me.ws.id }) : undefined));
  }

  if (path === '/api/billing/orders' && method === 'GET') {
    return json({ orders: (await scope.billing.orders.list(100)).map(orderView) });
  }
  const om = path.match(/^\/api\/billing\/orders\/(ord_[0-9a-f]{32})$/);
  if (om && method === 'GET') {
    const order = await readOrder(d, me.ws.id, om[1]!);
    return order ? json({ order: orderView(order) }) : fail(404, 'order_not_found', 'That order was not found.');
  }

  if (method !== 'POST') return json({ error: 'not found' }, 404);

  if (path === '/api/billing/card-session') {
    if (!isOwner) return OWNER_ONLY();
    const b = await body(request);
    if (b instanceof Response) return b;
    const returnPath = safeReturnPath(b.return_path) ?? BILLING_PATH;
    return json(await startCardSession(d, me.ws, me.actor, returnPath, publicOrigin(env, request)));
  }
  if (path === '/api/billing/portal-session') {
    if (!isOwner) return OWNER_ONLY();
    return json(await startPortalSession(d, me.ws, me.actor, publicOrigin(env, request)));
  }
  if (path === '/api/billing/domains' || path === '/api/billing/domains/bulk') {
    if (!planEnforced(env)) return json({ error: 'not found' }, 404);
    if (!isOwner) return OWNER_ONLY();
    const b = await body(request);
    if (b instanceof Response) return b;
    // The browser says which domain(s) and which price it was shown. The quantity is the server's: it is never read from a request.
    const bulk = path.endsWith('/bulk');
    const domains = bulk ? b.domains : [b.domain];
    if (!Array.isArray(domains) || domains.length === 0 || domains.length > 10 || domains.some((x) => typeof x !== 'string' || x.length > 253)) return fail(400, 'invalid_domains', bulk ? 'domains must be a list of one to ten names.' : 'domain is required.');
    if (typeof b.expected_amount !== 'number' || !Number.isSafeInteger(b.expected_amount) || b.expected_amount < 0) return fail(400, 'invalid_amount', 'expected_amount is required: the price in minor units that you were shown.');
    if (typeof b.expected_currency !== 'string' || !/^[A-Za-z]{3}$/.test(b.expected_currency)) return fail(400, 'invalid_currency', 'expected_currency is required: the three-letter currency of the price that you were shown.');
    const tenant = await loadTenant(env, { workspaceId: me.ws.id });
    try {
      return json(await addPaidDomains(d, tenant, me.ws, me.actor, { domains: domains as string[], expectedAmount: b.expected_amount, expectedCurrency: b.expected_currency, expectedCharge: typeof b.expected_charge === 'number' && Number.isSafeInteger(b.expected_charge) ? b.expected_charge : null, interval: b.interval === 'year' ? 'year' : 'month', via: bulk ? 'cloudflare' : 'single' }), 201);
    } catch (e) {
      if (e instanceof DomainServiceError) return json(e.body ?? { error: e.message }, e.status);
      throw e;
    }
  }
  if (path === '/api/billing/plan/start') {
    if (!planEnforced(env)) return json({ error: 'not found' }, 404);
    if (!isOwner) return OWNER_ONLY();
    const b = await body(request);
    if (b instanceof Response) return b;
    return json(await startPlan(d, me.ws, me.actor, { interval: b.interval === 'year' ? 'year' : 'month', ...(typeof b.expected_amount === 'number' ? { expectedAmount: b.expected_amount } : {}), ...(typeof b.expected_currency === 'string' ? { expectedCurrency: b.expected_currency } : {}), ...(typeof b.expected_charge === 'number' ? { expectedCharge: b.expected_charge } : {}) }), 201);
  }
  if (path === '/api/billing/plan/cancel-pending') {
    if (!planEnforced(env)) return json({ error: 'not found' }, 404);
    if (method !== 'POST') return fail(405, 'method_not_allowed', 'Method not allowed.');
    if (!isOwner) return OWNER_ONLY();
    return json(await cancelPendingPlan(d, me.ws, me.actor));
  }
  if (path === '/api/billing/plan/keep-one') {
    if (!planEnforced(env)) return json({ error: 'not found' }, 404);
    if (!isOwner) return OWNER_ONLY();
    const b = await body(request);
    if (b instanceof Response) return b;
    if (typeof b.domain_id !== 'number' || !Number.isSafeInteger(b.domain_id) || b.domain_id < 1) return fail(400, 'invalid_domain', 'domain_id must be a positive integer.');
    return json(await keepOneDomain(d, me.ws, me.actor, b.domain_id));
  }
  if (path === '/api/billing/workspace-intents') {
    if (!planEnforced(env)) return json({ error: 'not found' }, 404);
    const b = await body(request);
    if (b instanceof Response) return b;
    const name = cleanName(b.name, Number.MAX_SAFE_INTEGER);
    if (!name || [...name].length > 80) return fail(400, 'invalid_name', 'name is required (max 80 characters)');
    return json(await startWorkspaceIntent(d, me.ws, me.actor, name, publicOrigin(env, request)));
  }
  if (path === '/api/billing/orders') {
    if (!isOwner) return OWNER_ONLY();
    const b = await body(request);
    if (b instanceof Response) return b;
    // The charge is the price Stripe has now; the request only says which price the buyer was shown (expected_amount and expected_currency,
    // both required): if Stripe's differs, nothing is created and the answer is 409 price_changed with the new price.
    if (b.offer !== OFFER_ID) return fail(400, 'unknown_offer', 'Unknown offer.');
    if (typeof b.domain_id !== 'number' || !Number.isSafeInteger(b.domain_id) || b.domain_id < 1) return fail(400, 'invalid_domain', 'domain_id must be a positive integer.');
    if (typeof b.expected_amount !== 'number' || !Number.isSafeInteger(b.expected_amount) || b.expected_amount < 0) return fail(400, 'invalid_amount', 'expected_amount is required: the price in minor units that you were shown.');
    if (typeof b.expected_currency !== 'string' || !/^[A-Za-z]{3}$/.test(b.expected_currency)) return fail(400, 'invalid_currency', 'expected_currency is required: the three-letter currency of the price that you were shown.');
    const r = await purchase(d, me.ws, me.actor, { domainId: b.domain_id, expectedAmount: b.expected_amount, expectedCurrency: b.expected_currency });
    return json(r, 201);
  }
  return json({ error: 'not found' }, 404);
}

/** GET /api/billing/checkout/return?session_id=… : finish adding a card, then send the browser back where it started. */
async function checkoutReturn(request: Request, env: BoundEnv, ctx: ExecutionContext, resolver: WorkspaceResolver, opts: RouteOpts, url: URL): Promise<Response> {
  const redirect = (location: string) => new Response(null, { status: 303, headers: { Location: location, ...NO_STORE } });
  const sessionId = url.searchParams.get('session_id') ?? '';
  let who: Awaited<ReturnType<WorkspaceResolver>> = null;
  try { who = await resolver(request, env); } catch { /* not signed in: no effect */ }
  const row = /^cs_[A-Za-z0-9_]{1,250}$/.test(sessionId) ? await billingLookups(env.DB).sessionByStripeId(sessionId) : null;
  const kind = who ? (who as AuthedWorkspace).kind : undefined;
  // A card added to create a workspace: the workspace does not exist yet, so the person who started it (not a role) is who may finish it.
  if (row?.purpose === 'create_workspace') {
    if (!who?.userId || kind !== 'session' || who.userId !== row.user_id) return redirect(who?.workspaceId ? appLocation(who.workspaceId, BILLING_PATH) : '/');
    let made: Awaited<ReturnType<typeof completeWorkspaceIntent>> = 'mismatch';
    try { made = await completeWorkspaceIntent(billingDeps(env, ctx, opts), row, ctx); } catch (e) { console.error(`[billing] workspace intent failed: ${(e as Error)?.name ?? 'error'}`); }
    return redirect(made === 'created' ? appLocation(row.workspace_id, '/', { workspace: 'created' }) : appLocation(who.workspaceId, '/', { workspace: made === 'limit' ? 'limit' : 'canceled' }));
  }
  // Unknown, not signed in, or not (any more) an owner of the workspace the session was started for: it behaves as if it did not exist.
  const owner = row && who?.userId && kind === 'session' ? (await workspaceLifecycle(env.DB).roleOf(who.userId, row.workspace_id)) === 'owner' : false;
  if (!row || !who?.userId || !owner) return redirect(who?.workspaceId ? appLocation(who.workspaceId, BILLING_PATH) : '/');
  const d = billingDeps(env, ctx, opts);
  let outcome: 'added' | 'canceled' | 'error' = 'error';
  try {
    const r = await completeSetupSession(d, row);
    outcome = r === 'completed' ? 'added' : r === 'incomplete' ? 'canceled' : 'error';
  } catch (e) {
    console.error(`[billing] card return failed: ${(e as Error)?.name ?? 'error'}`);
  }
  return redirect(appLocation(row.workspace_id, safeReturnPath(row.return_path) ?? BILLING_PATH, { card: outcome }));
}

// ── The instance owner's orders ─────────────────────────────

async function operatorRoutes(request: Request, env: BoundEnv, ctx: ExecutionContext, resolver: WorkspaceResolver, opts: RouteOpts, path: string, method: string): Promise<Response> {
  const me = await caller(request, env, resolver);
  if (me instanceof Response) return me;
  if (!isInstanceOwner(env, { kind: me.kind, email: me.email, role: me.role, workspaceId: me.ws.id })) return fail(403, 'operator_required', 'Only the person who runs this instance can see orders.');
  const lookups = billingLookups(env.DB);
  if (path === '/api/operator/orders' && method === 'GET') {
    const s = new URL(request.url).searchParams.get('status');
    const status = s && ['pending', 'paid', 'started', 'done', 'refunded', 'failed', 'canceled'].includes(s) ? s as 'pending' : undefined;
    return json({ orders: (await lookups.allOrders({ status })).map((o): OperatorOrderView => operatorView(o)) });
  }
  const m = path.match(/^\/api\/operator\/orders\/(ord_[0-9a-f]{32})\/(started|done)$/);
  if (m && method === 'POST') {
    const to = m[2] as 'started' | 'done';
    const order = await lookups.orderById(m[1]!);
    if (!order) return fail(404, 'order_not_found', 'That order was not found.');
    const moved = await billingQueries(env.DB, order.workspace_id).orders.move(order.id, predecessorsOf(to), to, { [STAMP[to]!]: Math.floor((opts.now?.() ?? Date.now()) / 1000) });
    if (!moved) return fail(409, 'invalid_transition', `This order cannot be marked ${to} from "${order.status}".`, { order: operatorView(order) });
    const fresh = (await lookups.orderById(order.id))!;
    auditOrder(env, ctx, fresh, to === 'started' ? 'billing.order_started' : 'billing.order_done', { userId: me.userId, email: me.email });
    return json({ order: operatorView(fresh) });
  }
  return json({ error: 'not found' }, 404);
}
