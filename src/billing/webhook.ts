// POST /api/stripe/webhook. Unauthenticated by session (no cookie, so no CSRF) and authenticated by Stripe's signature instead.
//
//   body        raw, at most 256 KiB (Content-Length and the bytes actually read)
//   signature   `Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>…]`; HMAC-SHA256 over `${t}.${rawBody}` with STRIPE_WEBHOOK_SECRET (WebCrypto `verify`,
//               constant time), any v1 may match, |now − t| ≤ 300 s; `livemode` must agree with the key's mode
//   idempotency insert-first by event id: a repeat does no work; an event that failed, or that has been "processing" for over a minute, is run again
//   handling    the event body only says where to look. Every transition re-fetches the invoice / charge / session / customer from Stripe.
// Logs carry the event id, type and outcome and nothing else: never the payload, a card, an email or a secret.
import { billingLookups, billingQueries } from '@ready-set-mail/db';
import type { BoundEnv } from '../index';
import { billingStatus } from './config';
import { billingDeps, idOf, type BillingDeps } from './deps';
import { completeSetupSession } from './service';
import { applySubscription, applySubscriptionInvoice, subscriptionOfInvoice } from './plan-service';
import { completeWorkspaceIntent } from './plan-workspaces';
import { applyInvoice, applyRefund, failOrder, orderForCharge, paymentOf, type SyncResult } from './sync';
import { StripeError, type StripeObject } from './stripe-client';

export const WEBHOOK_MAX_BYTES = 256 * 1024;
export const WEBHOOK_TOLERANCE_SECONDS = 300;
const STALE_PROCESSING_SECONDS = 60;

export function parseSignatureHeader(header: string | null): { t: number; v1: string[] } | null {
  if (!header || header.length > 1024) return null;
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === 't' && /^[0-9]{1,12}$/.test(v)) t = Number(v);
    else if (k === 'v1' && /^[0-9a-f]{64}$/i.test(v)) v1.push(v.toLowerCase());
  }
  return t !== null && v1.length > 0 ? { t, v1 } : null;
}

const hexBytes = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g)!, (b) => parseInt(b, 16));

/** True when one of the header's v1 signatures is the HMAC of `${t}.${rawBody}` and t is within the tolerance. */
export async function verifySignature(secret: string, raw: Uint8Array, header: string | null, nowSeconds: number): Promise<boolean> {
  const parsed = parseSignatureHeader(header);
  if (!parsed || Math.abs(nowSeconds - parsed.t) > WEBHOOK_TOLERANCE_SECONDS) return false;
  const prefix = new TextEncoder().encode(`${parsed.t}.`);
  const signed = new Uint8Array(prefix.length + raw.length);
  signed.set(prefix);
  signed.set(raw, prefix.length);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  let ok = false;
  for (const sig of parsed.v1) ok = (await crypto.subtle.verify('HMAC', key, hexBytes(sig), signed)) || ok; // every candidate is checked: no early exit on a match
  return ok;
}

/** Reads at most `max` bytes; null when the body is larger. */
async function readCapped(request: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) { await reader.cancel().catch(() => {}); return null; }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

interface StripeEvent { id: string; type: string; livemode: boolean; data: { object: StripeObject } }

function parseEvent(raw: Uint8Array): StripeEvent | null {
  let e: unknown;
  try { e = JSON.parse(new TextDecoder().decode(raw)); } catch { return null; }
  const ev = e as Partial<StripeEvent> | null;
  if (!ev || typeof ev.id !== 'string' || !/^evt_[A-Za-z0-9_]{1,200}$/.test(ev.id) || typeof ev.type !== 'string' || ev.type.length > 100
    || typeof ev.livemode !== 'boolean' || !ev.data || typeof ev.data !== 'object' || !ev.data.object || typeof ev.data.object !== 'object'
    || typeof (ev.data.object as { id?: unknown }).id !== 'string') return null;
  return ev as StripeEvent;
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, '?').slice(0, 80);

interface Handled { status: 'done' | 'ignored'; outcome: string }
const result = (r: SyncResult): Handled => ({ status: r === 'mismatch' || r === 'noop' ? 'ignored' : 'done', outcome: r });

export async function handleStripeWebhook(request: Request, env: BoundEnv, ctx: ExecutionContext, opts: { fetch?: typeof fetch; now?: () => number } = {}): Promise<Response> {
  const status = billingStatus(env);
  if (status.state !== 'configured') return json({ error: 'not found' }, 404);
  if (request.method.toUpperCase() !== 'POST') return json({ error: 'method not allowed' }, 405);
  const d = billingDeps(env, ctx, opts);
  const raw = await readCapped(request, WEBHOOK_MAX_BYTES);
  if (!raw) return json({ error: 'payload too large' }, 413);
  if (!(await verifySignature(env.STRIPE_WEBHOOK_SECRET!.trim(), raw, request.headers.get('stripe-signature'), d.now()))) return json({ error: 'invalid signature' }, 400);
  const event = parseEvent(raw);
  if (!event) return json({ error: 'invalid event' }, 400);
  if (event.livemode !== status.livemode) {
    console.warn(`[billing] webhook evt=${safe(event.id)} type=${safe(event.type)} outcome=livemode_mismatch`);
    return json({ error: 'livemode does not match this installation' }, 400);
  }

  const events = billingLookups(env.DB).events;
  if (!(await events.begin(event.id, event.type))) {
    const seen = await events.get(event.id);
    if (!seen || seen.status === 'done' || seen.status === 'ignored' || !(await events.reclaim(event.id, STALE_PROCESSING_SECONDS, d.now()))) {
      console.log(`[billing] webhook evt=${safe(event.id)} type=${safe(event.type)} outcome=duplicate`);
      return json({ received: true, duplicate: true });
    }
  }
  try {
    const handled = await dispatch(d, event);
    await events.finish(event.id, handled.status, handled.outcome);
    console.log(`[billing] webhook evt=${safe(event.id)} type=${safe(event.type)} outcome=${safe(handled.outcome)}`);
    return json({ received: true });
  } catch (e) {
    await events.finish(event.id, 'failed', 'error').catch(() => {});
    console.error(`[billing] webhook evt=${safe(event.id)} type=${safe(event.type)} outcome=error ${e instanceof StripeError ? `stripe_status=${e.status}` : (e as Error)?.name ?? ''}`);
    return json({ error: 'processing failed' }, 500); // Stripe retries
  }
}

async function dispatch(d: BillingDeps, event: StripeEvent): Promise<Handled> {
  const obj = event.data.object;
  const lookups = billingLookups(d.db);
  switch (event.type) {
    case 'checkout.session.completed': {
      if (obj.mode !== 'setup') return { status: 'ignored', outcome: 'not_setup' };
      const row = await lookups.sessionByStripeId(obj.id);
      if (!row) return { status: 'ignored', outcome: 'unknown_session' };
      if (row.purpose === 'create_workspace') { const made = await completeWorkspaceIntent(d, row, d.ctx); return { status: made === 'created' ? 'done' : 'ignored', outcome: `workspace_${made}` }; }
      const r = await completeSetupSession(d, row);
      return { status: r === 'completed' ? 'done' : 'ignored', outcome: `setup_${r}` };
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const r = await applySubscription(d, obj.id, { customerHint: idOf(obj.customer) });
      return { status: r === 'applied' || r === 'lapsed' || r === 'resumed' || r === 'recorded' ? 'done' : 'ignored', outcome: `subscription_${r}` };
    }
    case 'invoice.paid':
    case 'invoice.payment_failed':
    case 'invoice.payment_action_required': {
      // A renewal of the pay-as-you-go subscription is not an order: it names a subscription. Orders (Fix one domain) are handled below, untouched.
      const subscriptionId = subscriptionOfInvoice(obj);
      if (subscriptionId) { const r = await applySubscriptionInvoice(d, event.type as 'invoice.paid', obj.id, subscriptionId); return { status: r === 'applied' || r === 'lapsed' || r === 'resumed' || r === 'recorded' ? 'done' : 'ignored', outcome: `subscription_invoice_${r}` }; }
      const meta = (obj.metadata ?? {}) as Record<string, unknown>;
      let order = typeof meta.order_id === 'string' ? await lookups.orderById(meta.order_id) : null;
      order ??= await lookups.orderByInvoice(obj.id);
      if (!order) return { status: 'ignored', outcome: 'unknown_order' };
      if (!order.stripe_customer_id || idOf(obj.customer) !== order.stripe_customer_id) return { status: 'ignored', outcome: 'customer_mismatch' };
      if (order.stripe_invoice_id && order.stripe_invoice_id !== obj.id) return { status: 'ignored', outcome: 'invoice_mismatch' };
      if (event.type === 'invoice.paid') return result(await applyInvoice(d, order, obj.id));
      if (event.type === 'invoice.payment_action_required') {
        const r = await applyInvoice(d, order, obj.id);
        if (r === 'pending' && order.status === 'pending') await billingQueries(d.db, order.workspace_id).orders.patch(order.id, { note: 'action_required' });
        return result(r);
      }
      // invoice.payment_failed: only if Stripe still says the invoice is unpaid, and the payment is not merely waiting on the buyer. For a payment
      // that needs bank confirmation (3-D Secure) Stripe sends this event too, while the PaymentIntent is still requires_action: the buyer can
      // finish on the hosted page, so that is not a failure.
      const inv = await d.stripe.retrieveInvoice(obj.id);
      if (inv.status === 'paid') return result(await applyInvoice(d, order, obj.id));
      if (idOf(inv.customer) !== order.stripe_customer_id || (inv.metadata as Record<string, unknown> | undefined)?.order_id !== order.id) return { status: 'ignored', outcome: 'mismatch' };
      if (inv.status === 'open' && waitingOnBuyer(inv)) {
        if (order.status === 'pending') await billingQueries(d.db, order.workspace_id).orders.patch(order.id, { note: 'action_required' });
        return { status: 'done', outcome: 'awaiting_buyer' };
      }
      const { code, message } = lastPaymentError(inv);
      return result(await failOrder(d, order, { code, message: message ?? 'The payment did not go through. You have not been charged.' }));
    }
    case 'charge.refunded': {
      const order = await orderForCharge(d, obj.id, idOf(obj.payment_intent));
      if (!order) return { status: 'ignored', outcome: 'unknown_charge' };
      return result(await applyRefund(d, order, obj.id));
    }
    case 'customer.deleted': {
      const workspaceId = await lookups.workspaceByCustomer(obj.id);
      if (!workspaceId) return { status: 'ignored', outcome: 'unknown_customer' };
      let gone = false;
      try { gone = (await d.stripe.retrieveCustomer(obj.id)).deleted === true; } catch (e) { if (e instanceof StripeError && e.isNotFound) gone = true; else throw e; }
      if (!gone) return { status: 'ignored', outcome: 'customer_not_deleted' };
      await billingQueries(d.db, workspaceId).customer.clear(obj.id);
      return { status: 'done', outcome: 'customer_cleared' };
    }
    default:
      return { status: 'ignored', outcome: 'ignored_type' };
  }
}

/** PaymentIntent states in which the payment is still the buyer's (or the bank's) to finish. */
const isWaitingIntent = (status: unknown): boolean => status === 'requires_action' || status === 'requires_confirmation' || status === 'processing';

/** True when an open payment of the invoice (its expanded PaymentIntent) is still waiting on the buyer or the bank. */
function waitingOnBuyer(inv: StripeObject): boolean {
  const list = (inv.payments as { data?: Array<{ status?: string; payment?: { payment_intent?: unknown } }> } | undefined)?.data ?? [];
  return list.some((p) => {
    const pi = p.payment?.payment_intent;
    return p.status !== 'canceled' && !!pi && typeof pi === 'object' && isWaitingIntent((pi as { status?: unknown }).status);
  });
}

/** Stripe's words for why the latest attempt failed, from the invoice's expanded payment intent. */
function lastPaymentError(inv: StripeObject): { code: string | null; message: string | null } {
  const { paymentIntentId } = paymentOf(inv);
  const list = (inv.payments as { data?: Array<{ payment?: { payment_intent?: unknown } }> } | undefined)?.data ?? [];
  for (const p of list) {
    const pi = p.payment?.payment_intent;
    if (pi && typeof pi === 'object' && idOf(pi) === paymentIntentId) {
      const err = (pi as { last_payment_error?: { code?: string; decline_code?: string; message?: string } }).last_payment_error;
      if (err) return { code: err.decline_code ?? err.code ?? null, message: err.message ? err.message.slice(0, 300) : null };
    }
  }
  return { code: null, message: null };
}
