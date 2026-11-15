// Billing for one workspace: its Stripe customer, the card on file, the Checkout that adds one, the billing portal, and buying.
// Callers have already decided who the person is and that they are the workspace owner where that is required (routes.ts); everything
// here takes the workspace id explicitly and reads and writes only that workspace's rows.
import { billingQueries, forWorkspace, globalQueries, isUnprovenRow, type CheckoutSessionRow, type OrderRow } from '@ready-set-mail/db';
import { auditOrder, emailOf } from './notify';
import { logAudit } from '../audit/log';
import { priceLookupKey } from './config';
import { BillingError, idOf, type BillingDeps } from './deps';
import { appUrl } from './paths';
import { OFFER_ID, OFFER_NAME } from './offer';
import { failOrder, reconcileOrder, soldProblem } from './sync';
import { orderView, type OrderView } from './orders';
import { PriceMisconfiguredError, PriceUnavailableError, resolvePrice, type OfferPrice } from './price';
import { StripeError, StripeNetworkError, type StripeObject } from './stripe-client';

export interface Ws { id: string; name: string }
export interface Actor { userId: string; email: string }
export interface Card { brand: string; last4: string; exp_month: number; exp_year: number }

const hex32 = () => crypto.randomUUID().replace(/-/g, '');

// ── Rate limits (per workspace and per user, on the D1 limiter; a hit is counted before any Stripe call) ──
export const BILLING_LIMITS = {
  order: { max: 5, windowMs: 10 * 60_000 },
  session: { max: 10, windowMs: 10 * 60_000 },
} as const;

export async function rateLimit(d: BillingDeps, kind: keyof typeof BILLING_LIMITS, ws: string, userId: string): Promise<void> {
  const { max, windowMs } = BILLING_LIMITS[kind];
  const q = globalQueries(d.db).rateLimit;
  const nowMs = d.now() * 1000;
  for (const key of [`billing:${kind}:ws:${ws}`, `billing:${kind}:user:${userId}`]) {
    if (!(await q.hitUnder(key, nowMs, windowMs, max))) {
      throw new BillingError(429, 'rate_limited', 'Too many attempts. Try again in a few minutes.', { retry_after: Math.ceil(windowMs / 1000) });
    }
  }
}

/** A Stripe failure as the caller's answer: never the Stripe message for non-card problems, which can name internals. */
export function stripeFailure(e: unknown): BillingError {
  if (e instanceof StripeNetworkError) return new BillingError(503, 'stripe_unavailable', 'Stripe could not be reached. Try again in a minute.');
  if (e instanceof StripeError) {
    console.error(`[billing] stripe error status=${e.status} type=${e.type} code=${e.code ?? '-'}`);
    return new BillingError(502, 'stripe_error', 'Stripe refused the request. Nothing was changed; try again, and tell us if it keeps happening.');
  }
  return e instanceof BillingError ? e : new BillingError(500, 'billing_error', 'Billing failed unexpectedly.');
}

// ── Customer and card ───────────────────────────────────────

/** The workspace's Stripe customer, created on first need. Two concurrent creators get the same customer (same idempotency key, then a conditional store). */
export async function ensureCustomer(d: BillingDeps, ws: Ws, email: string): Promise<string> {
  const q = billingQueries(d.db, ws.id).customer;
  const existing = await q.get();
  if (existing) return existing;
  let created = '';
  // The idempotency key replays its answer for 24 hours: if that answer is a customer deleted since, the next key makes a fresh one.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      created = (await d.stripe.createCustomer({ workspaceId: ws.id, email, name: ws.name, attempt })).id;
    } catch (e) {
      // The same key with other parameters (the owner's email changed between two concurrent requests): the other request won.
      if (e instanceof StripeError && e.code === 'idempotency_error') {
        const again = await q.get();
        if (again) return again;
      }
      throw e;
    }
    if (attempt === 2 || (await d.stripe.retrieveCustomer(created)).deleted !== true) break;
  }
  await q.claim(created);
  const stored = await q.get();
  if (!stored) throw new Error('billing: customer was not stored');
  return stored;
}

export interface CardView { customer: boolean; card: Card | null; email: string | null; unavailable?: boolean }

function cardOf(customer: StripeObject): Card | null {
  const pm = (customer.invoice_settings as { default_payment_method?: unknown } | undefined)?.default_payment_method;
  const card = pm && typeof pm === 'object' ? (pm as { card?: Partial<Card> }).card : undefined;
  if (!card || typeof card.last4 !== 'string') return null;
  return { brand: String(card.brand ?? 'card'), last4: card.last4, exp_month: Number(card.exp_month), exp_year: Number(card.exp_year) };
}

/** The card on file and billing email, read from Stripe now (nothing is stored). A deleted customer is forgotten. */
export async function readCard(d: BillingDeps, ws: Ws, fallbackEmail: string | null): Promise<CardView> {
  const q = billingQueries(d.db, ws.id).customer;
  const id = await q.get();
  if (!id) return { customer: false, card: null, email: fallbackEmail };
  try {
    const c = await d.stripe.retrieveCustomer(id);
    if (c.deleted === true) { await q.clear(id); return { customer: false, card: null, email: fallbackEmail }; }
    return { customer: true, card: cardOf(c), email: typeof c.email === 'string' ? c.email : fallbackEmail };
  } catch (e) {
    if (e instanceof StripeError && e.isNotFound) { await q.clear(id); return { customer: false, card: null, email: fallbackEmail }; }
    console.error('[billing] card read failed');
    return { customer: true, card: null, email: fallbackEmail, unavailable: true };
  }
}

// ── Adding a card (Stripe Checkout, mode=setup) ─────────────

export async function startCardSession(d: BillingDeps, ws: Ws, actor: Actor, returnPath: string, origin: string): Promise<{ url: string }> {
  await rateLimit(d, 'session', ws.id, actor.userId);
  const q = billingQueries(d.db, ws.id);
  try {
    const customerId = await ensureCustomer(d, ws, actor.email);
    const ref = `bcs_${hex32()}`;
    // The binding exists before Stripe is called; the Stripe session id is attached once Stripe answers.
    await q.sessions.insert({ ref, user_id: actor.userId, purpose: 'add_card', return_path: returnPath, stripe_customer_id: customerId });
    let session: StripeObject;
    try {
      session = await d.stripe.createSetupSession({
        ref, customerId, workspaceId: ws.id, purpose: 'add_card',
        // Stripe substitutes the placeholder; it must stay literal.
        successUrl: `${origin}/api/billing/checkout/return?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: appUrl(origin, ws.id, returnPath, { card: 'canceled' }),
      });
    } catch (e) {
      await q.sessions.drop(ref);
      throw e;
    }
    if (typeof session.url !== 'string' || !session.url) throw new Error('billing: Checkout session has no url');
    await q.sessions.attach(ref, session.id);
    logAudit({ db: d.db, workspaceId: ws.id }, { actor_id: actor.userId, actor_email: actor.email, action: 'billing.card_session_started', resource_type: 'billing', resource_id: ref }, d.ctx);
    return { url: session.url };
  } catch (e) {
    throw e instanceof BillingError ? e : stripeFailure(e);
  }
}

export type SetupResult = 'completed' | 'incomplete' | 'mismatch';

/**
 * Make the card the customer just saved at Stripe the workspace's default, if everything agrees. Shared by the return URL and the webhook, whichever
 * comes first (the second finds the default already set, and the conditional completion means one audit entry). It never touches an order.
 */
export async function completeSetupSession(d: BillingDeps, row: CheckoutSessionRow): Promise<SetupResult> {
  if (!row.stripe_session_id) return 'mismatch';
  const q = billingQueries(d.db, row.workspace_id);
  const workspaceCustomer = await q.customer.get();
  if (!workspaceCustomer || workspaceCustomer !== row.stripe_customer_id) return 'mismatch';
  const s = await d.stripe.retrieveCheckoutSession(row.stripe_session_id);
  const meta = (s.metadata ?? {}) as Record<string, unknown>;
  if (s.id !== row.stripe_session_id || s.mode !== 'setup' || idOf(s.customer) !== workspaceCustomer
    || meta.workspace_id !== row.workspace_id || s.client_reference_id !== row.workspace_id || meta.checkout_ref !== row.ref) return 'mismatch';
  if (s.status !== 'complete') return 'incomplete';
  const si = s.setup_intent && typeof s.setup_intent === 'object' ? (s.setup_intent as StripeObject) : null;
  const pm = si ? idOf(si.payment_method) : null;
  if (!si || si.status !== 'succeeded' || !pm) return 'incomplete';
  if (si.customer != null && idOf(si.customer) !== workspaceCustomer) return 'mismatch';
  await d.stripe.setDefaultPaymentMethod(workspaceCustomer, pm);
  if (await q.sessions.complete(row.ref)) {
    logAudit({ db: d.db, workspaceId: row.workspace_id }, { actor_id: row.user_id, actor_email: await emailOf(d.env, row.user_id), action: 'billing.card_added', resource_type: 'billing', resource_id: row.ref }, d.ctx);
  }
  return 'completed';
}

export async function startPortalSession(d: BillingDeps, ws: Ws, actor: Actor, origin: string): Promise<{ url: string }> {
  await rateLimit(d, 'session', ws.id, actor.userId);
  const customerId = await billingQueries(d.db, ws.id).customer.get();
  if (!customerId) throw new BillingError(409, 'no_customer', 'There is nothing to manage yet: add a card first.');
  try {
    const p = await d.stripe.createPortalSession({ customerId, returnUrl: appUrl(origin, ws.id, '/settings') });
    if (typeof p.url !== 'string' || !p.url) throw new Error('billing: portal session has no url');
    return { url: p.url };
  } catch (e) {
    throw stripeFailure(e);
  }
}

// ── The price ───────────────────────────────────────────────

/** The offer's price, or a BillingError: 502 `price_misconfigured` (the price is wrong), 503 `stripe_unavailable`. */
export async function offerPrice(d: BillingDeps, fresh = false): Promise<OfferPrice> {
  try {
    return await resolvePrice(d.db, d.stripe, priceLookupKey(d.env), { fresh, now: () => d.now() * 1000 });
  } catch (e) {
    if (e instanceof PriceMisconfiguredError) { console.error(`[billing] ${e.message}`); throw new BillingError(502, 'price_misconfigured', 'This offer is not available right now.'); }
    if (e instanceof PriceUnavailableError) throw new BillingError(503, 'stripe_unavailable', 'The price could not be read. Try again in a minute.');
    throw stripeFailure(e);
  }
}

// ── Buying ──────────────────────────────────────────────────

/** A pending order this old with an unfinished payment may be resumed with the same idempotency keys (a crash between steps must not wedge a domain). */
export const RESUME_AFTER_SECONDS = 60;

export interface PurchaseResult {
  order: OrderView;
  outcome: 'processing' | 'requires_action' | 'failed';
  action_url?: string;
  message?: string;
}

/** The price the buyer was shown: the order is created only if Stripe's fresh price is exactly this. */
export interface PurchaseInput { domainId: number; expectedAmount: number; expectedCurrency: string }

/**
 * Buy "Fix one domain" for a domain of this workspace, charging the card on file. The order row is inserted FIRST (a unique slot per workspace,
 * domain and offer); the Stripe objects follow with idempotency keys derived from the order id, so a retry or a double click repeats the same
 * invoice and the same payment. The answer never marks the order paid: the webhook (or the reconcile) does, after re-reading the invoice.
 */
export async function purchase(d: BillingDeps, ws: Ws, actor: Actor, input: PurchaseInput): Promise<PurchaseResult> {
  await rateLimit(d, 'order', ws.id, actor.userId);
  const scope = forWorkspace(d.db, ws.id);
  const domain = await scope.domains.getById(input.domainId);
  if (!domain) throw new BillingError(404, 'domain_not_found', 'That domain was not found.');
  if (isUnprovenRow(domain) || domain.proof_lost_at) throw new BillingError(409, 'domain_unproven', 'Prove that you control this domain before buying work on it.');
  const price = await offerPrice(d, true);
  if (input.expectedAmount !== price.amount || input.expectedCurrency.toLowerCase() !== price.currency) {
    throw new BillingError(409, 'price_changed', 'The price changed. Review it and confirm again.', { amount: price.amount, currency: price.currency });
  }
  const customerId = await scope.billing.customer.get();
  const view = customerId ? await readCard(d, ws, actor.email) : null;
  if (!customerId || !view?.card) throw new BillingError(409, 'card_required', 'Add a card first.');

  const q = scope.billing.orders;
  const order: OrderRow | null = await (async () => {
    const id = `ord_${hex32()}`;
    const inserted = await q.insert({
      id, workspace_name: ws.name, domain_id: domain.id, domain_name: domain.domain, offer: OFFER_ID, stripe_price_id: price.price_id,
      amount: price.amount, currency: price.currency, stripe_customer_id: customerId, buyer_user_id: actor.userId, buyer_email: actor.email,
      amount_refunded: 0, stripe_invoice_id: null, stripe_payment_intent_id: null, stripe_charge_id: null, hosted_invoice_url: null,
      failure_code: null, failure_message: null, note: null, owner_notified_at: null, paid_at: null, started_at: null, done_at: null, refunded_at: null, failed_at: null,
    });
    if (inserted.ok) {
      const row = await q.get(id);
      if (row) auditOrder(d.env, d.ctx, row, 'billing.order_created', actor, { amount: row.amount, currency: row.currency });
      return row;
    }
    // Lost the slot: someone else's confirm (or a double click) is the order. Resume it only if it clearly stalled.
    const e = inserted.existing;
    if (e.status === 'pending' && d.now() - e.updated_at > RESUME_AFTER_SECONDS && e.note !== 'action_required' && e.stripe_customer_id === customerId) return e;
    throw new BillingError(409, 'order_open', 'There is already an order for this domain.', { order: orderView(e) });
  })();
  if (!order) throw new Error('billing: order was not stored');
  return runCharge(d, order);
}

/** The Stripe steps of one order, each repeatable: invoice → item → finalize → pay. */
export async function runCharge(d: BillingDeps, order: OrderRow): Promise<PurchaseResult> {
  const q = billingQueries(d.db, order.workspace_id).orders;
  const customerId = order.stripe_customer_id!;
  let current = order;
  try {
    let invoiceId = order.stripe_invoice_id;
    if (!invoiceId) {
      const inv = await d.stripe.createInvoice({
        orderId: order.id, workspaceId: order.workspace_id, customerId, currency: order.currency, domain: order.domain_name, offer: order.offer,
        description: `${OFFER_NAME}: ${order.domain_name}`,
      });
      invoiceId = inv.id;
      await q.patch(order.id, { stripe_invoice_id: invoiceId });
    }
    const item = await d.stripe.createInvoiceItem({ orderId: order.id, customerId, invoiceId, priceId: order.stripe_price_id, description: `${OFFER_NAME}: ${order.domain_name}` });
    // Defense in depth: before anything can be charged, the draft must be exactly what the buyer confirmed (one line, our price, the order's amount and currency).
    const draft = await d.stripe.retrieveInvoice(invoiceId);
    if (draft.status === 'draft' || draft.status === 'open') {
      const problem = soldProblem(order, draft) ?? (draft.amount_due !== order.amount ? `amount due ${String(draft.amount_due)} is not the order's ${order.amount}` : null);
      if (problem) {
        console.error(`[billing] order ${order.id}: invoice ${invoiceId} is not what was confirmed (${problem}); it is discarded, nothing was charged`);
        if (draft.status === 'draft' && typeof item.id === 'string') await d.stripe.deleteInvoiceItem(item.id).catch((e) => { if (!(e instanceof StripeError)) throw e; });
        return notStarted(d, q, (await q.get(order.id)) ?? current, { code: 'invoice_mismatch', message: 'We could not start the payment. You have not been charged.' });
      }
    }
    const fin = await d.stripe.finalizeInvoice(order.id, invoiceId);
    if (typeof fin.hosted_invoice_url === 'string') await q.patch(order.id, { hosted_invoice_url: fin.hosted_invoice_url });
    current = (await q.get(order.id)) ?? order;
    await d.stripe.payInvoice(order.id, invoiceId);
    // Paid at Stripe. The order stays pending until the webhook (or the reconcile) re-reads the invoice: this answer never marks it paid.
    return { order: orderView(current), outcome: 'processing' };
  } catch (e) {
    current = (await q.get(order.id)) ?? current; // the invoice id may have been stored since `order` was read
    if (e instanceof StripeError) {
      if (e.code === 'invoice_payment_intent_requires_action') {
        await q.patch(order.id, { note: 'action_required' });
        const row = (await q.get(order.id)) ?? current;
        return { order: orderView(row), outcome: 'requires_action', ...(row.hosted_invoice_url ? { action_url: row.hosted_invoice_url } : {}), message: 'Your bank needs you to confirm this payment.' };
      }
      if (e.isCardError) {
        const result = await failOrder(d, current, { code: e.declineCode ?? e.code ?? 'card_error', message: e.message });
        const row = (await q.get(order.id)) ?? current;
        if (result === 'paid') return { order: orderView(row), outcome: 'processing' };
        return { order: orderView(row), outcome: 'failed', message: row.failure_message ?? e.message };
      }
      // A refusal that retrying cannot fix (bad request, missing object): end the order, nothing was charged. Server errors and rate limits stay pending.
      if (e.status >= 400 && e.status < 500 && e.status !== 429 && e.status !== 409) {
        console.error(`[billing] order ${order.id} could not start: status=${e.status} type=${e.type} code=${e.code ?? '-'}`);
        return notStarted(d, q, current, { code: e.code ?? 'stripe_error', message: 'We could not start the payment. You have not been charged.' });
      }
    }
    const failure = stripeFailure(e);
    throw new BillingError(failure.status, failure.code, failure.message, { order: orderView((await q.get(order.id)) ?? current) });
  }
}

/** End an order whose payment could not be started (the draft invoice is voided or deleted), as the answer to the buyer. */
async function notStarted(d: BillingDeps, q: ReturnType<typeof billingQueries>['orders'], order: OrderRow, why: { code: string; message: string }): Promise<PurchaseResult> {
  const result = await failOrder(d, order, why);
  const row = (await q.get(order.id)) ?? order;
  if (result === 'paid') return { order: orderView(row), outcome: 'processing' };
  return { order: orderView(row), outcome: 'failed', message: row.failure_message ?? why.message };
}

/** One order of the workspace; a pending order older than an hour is settled from Stripe first. */
export async function readOrder(d: BillingDeps, ws: string, id: string): Promise<OrderRow | null> {
  const q = billingQueries(d.db, ws).orders;
  const o = await q.get(id);
  if (!o) return null;
  return o.status === 'pending' && d.now() - o.updated_at > RECONCILE_AFTER_SECONDS ? reconcileOne(d, o) : o;
}

export const RECONCILE_AFTER_SECONDS = 3600;

async function reconcileOne(d: BillingDeps, o: OrderRow): Promise<OrderRow> {
  try { await reconcileOrder(d, o); } catch { /* Stripe is unavailable: show the order as it is */ }
  return (await billingQueries(d.db, o.workspace_id).orders.get(o.id)) ?? o;
}
