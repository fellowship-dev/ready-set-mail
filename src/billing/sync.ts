// Turning what Stripe says into order state. Every path that changes an order from Stripe's side (the webhook, the daily reconcile, the
// declined-card answer) goes through here, and every one RE-FETCHES the object from Stripe: an event body only says where to look.
//
// An order is bound to Stripe by: our order id in the invoice's metadata, the Stripe customer, and (once set) the invoice id. All three
// must agree with what the re-fetch returns, and for `paid` the amount and currency too; otherwise nothing changes (`mismatch`).
import { billingLookups, billingQueries, type OrderRow } from '@ready-set-mail/db';
import { auditOrder, onOrderPaid } from './notify';
import { predecessorsOf, STAMP } from './orders';
import { StripeError, type StripeObject } from './stripe-client';
import { idOf, type BillingDeps } from './deps';

export type SyncResult = 'paid' | 'failed' | 'canceled' | 'pending' | 'refunded' | 'partial_refund' | 'noop' | 'mismatch' | 'closed_but_paid';

const scoped = (d: BillingDeps, o: Pick<OrderRow, 'workspace_id'>) => billingQueries(d.db, o.workspace_id).orders;

/** Does the re-fetched invoice belong to this order? */
function invoiceMatches(order: OrderRow, inv: StripeObject): boolean {
  const meta = (inv.metadata ?? {}) as Record<string, unknown>;
  return idOf(inv.customer) === order.stripe_customer_id
    && order.stripe_customer_id !== null
    && meta.order_id === order.id
    && (order.stripe_invoice_id === null || order.stripe_invoice_id === inv.id);
}

/** The payment intent and charge that paid an invoice, from `payments` expanded with its payment intent. */
export function paymentOf(inv: StripeObject): { paymentIntentId: string | null; chargeId: string | null } {
  const list = (inv.payments as { data?: Array<{ status?: string; payment?: { type?: string; payment_intent?: unknown } }> } | undefined)?.data ?? [];
  const paid = list.find((p) => p.payment?.type === 'payment_intent' && p.status === 'paid') ?? list.find((p) => p.payment?.type === 'payment_intent');
  const pi = paid?.payment?.payment_intent;
  return { paymentIntentId: idOf(pi), chargeId: pi && typeof pi === 'object' ? idOf((pi as { latest_charge?: unknown }).latest_charge) : null };
}

/** Bring an order in line with its invoice at Stripe. `invoiceId` defaults to the order's own. */
export async function applyInvoice(d: BillingDeps, order: OrderRow, invoiceId = order.stripe_invoice_id): Promise<SyncResult> {
  if (!invoiceId) return 'noop';
  if (order.stripe_invoice_id && order.stripe_invoice_id !== invoiceId) return 'mismatch';
  const inv = await d.stripe.retrieveInvoice(invoiceId);
  if (!invoiceMatches(order, inv)) return 'mismatch';
  const q = scoped(d, order);

  if (inv.status === 'paid') {
    if (inv.amount_paid !== order.amount || inv.currency !== order.currency) return 'mismatch';
    const { paymentIntentId, chargeId } = paymentOf(inv);
    const paidAt = (inv.status_transitions as { paid_at?: unknown } | undefined)?.paid_at;
    const moved = await q.move(order.id, predecessorsOf('paid'), 'paid', {
      paid_at: typeof paidAt === 'number' ? paidAt : d.now(),
      stripe_invoice_id: inv.id, stripe_payment_intent_id: paymentIntentId, stripe_charge_id: chargeId, note: null,
    });
    if (moved) {
      const fresh = await q.get(order.id);
      if (fresh) await onOrderPaid(d.env, d.ctx, fresh);
      return 'paid';
    }
    const now = await q.get(order.id);
    if (now && (now.status === 'failed' || now.status === 'canceled')) {
      console.error(`[billing] order ${order.id} is ${now.status} but its invoice is paid: refund it in Stripe`);
      return 'closed_but_paid';
    }
    // Already past pending: fill in the charge if an earlier path did not know it yet.
    if (now && !now.stripe_charge_id && chargeId) await q.patch(order.id, { stripe_charge_id: chargeId, stripe_payment_intent_id: paymentIntentId });
    return 'noop';
  }
  if (inv.status === 'void' || inv.status === 'uncollectible') {
    const moved = await q.move(order.id, ['pending'], 'canceled', { failed_at: d.now(), failure_code: 'invoice_void', failure_message: 'The payment was canceled.' });
    if (moved) auditOrder(d.env, d.ctx, order, 'billing.order_canceled');
    return moved ? 'canceled' : 'noop';
  }
  // open or draft: not paid yet.
  if (order.hosted_invoice_url !== inv.hosted_invoice_url && typeof inv.hosted_invoice_url === 'string') await q.patch(order.id, { hosted_invoice_url: inv.hosted_invoice_url });
  return 'pending';
}

/**
 * The payment did not go through: void the invoice (so it can never be paid later) and end the order. If the void shows the invoice
 * was paid after all, the order goes paid instead. If it cannot be told, the error propagates and the order stays pending.
 */
export async function failOrder(d: BillingDeps, order: OrderRow, why: { code: string | null; message: string }, to: 'failed' | 'canceled' = 'failed'): Promise<SyncResult> {
  if (order.stripe_invoice_id) {
    try {
      await d.stripe.voidInvoice(order.id, order.stripe_invoice_id);
    } catch (e) {
      if (!(e instanceof StripeError)) throw e;
      // Not voidable: find out why. Paid after all → paid. Already void, gone, or a draft (deleted, a draft cannot be voided) → fine. Anything else → still unknown.
      let inv: StripeObject | null = null;
      try { inv = await d.stripe.retrieveInvoice(order.stripe_invoice_id); } catch (e2) { if (!(e2 instanceof StripeError && e2.isNotFound)) throw e2; }
      if (inv?.status === 'paid') return applyInvoice(d, order);
      if (inv?.status === 'draft') await d.stripe.deleteInvoice(inv.id);
      else if (inv && inv.status !== 'void') throw e;
    }
  }
  const moved = await scoped(d, order).move(order.id, ['pending'], to, { failed_at: d.now(), failure_code: why.code, failure_message: why.message.slice(0, 300), note: null });
  if (moved) auditOrder(d.env, d.ctx, order, to === 'failed' ? 'billing.order_failed' : 'billing.order_canceled', undefined, { code: why.code });
  return moved ? to : 'noop';
}

/** A refund at Stripe: record the refunded amount; a full refund ends the order (from paid, started or done). */
export async function applyRefund(d: BillingDeps, order: OrderRow, chargeId: string): Promise<SyncResult> {
  const charge = await d.stripe.retrieveCharge(chargeId);
  if (idOf(charge.customer) !== order.stripe_customer_id || order.stripe_customer_id === null) return 'mismatch';
  const piId = idOf(charge.payment_intent);
  let belongs = order.stripe_charge_id === charge.id || (!!piId && order.stripe_payment_intent_id === piId);
  if (!belongs && piId && order.stripe_invoice_id) {
    // The order did not learn its charge yet (the invoice's own event is late): ask Stripe which invoice this payment paid.
    const link = (await d.stripe.findInvoicePayment(piId)).data[0] as { invoice?: unknown } | undefined;
    belongs = !!link && idOf(link.invoice) === order.stripe_invoice_id;
  }
  if (!belongs) return 'mismatch';
  const q = scoped(d, order);
  // An order still pending whose invoice is in fact paid: catch up first, so the refund has a legal predecessor.
  if (order.status === 'pending') {
    await applyInvoice(d, order);
    order = (await q.get(order.id)) ?? order;
  }
  const refunded = typeof charge.amount_refunded === 'number' ? charge.amount_refunded : 0;
  const full = charge.refunded === true || (typeof charge.amount === 'number' && refunded >= charge.amount);
  await q.patch(order.id, { amount_refunded: Math.max(order.amount_refunded, refunded), stripe_charge_id: charge.id, ...(piId ? { stripe_payment_intent_id: piId } : {}) });
  if (!full) return 'partial_refund';
  const moved = await q.move(order.id, predecessorsOf('refunded'), 'refunded', { [STAMP.refunded!]: d.now() });
  if (moved) auditOrder(d.env, d.ctx, order, 'billing.order_refunded', undefined, { amount_refunded: refunded });
  return moved ? 'refunded' : 'noop';
}

/**
 * A pending order that has not completed: pay it if its invoice turns out paid (a lost webhook), else end it. No invoice: `failed`.
 * A paid or void invoice is settled from Stripe; an open one is voided and the order `canceled` (the buyer never finished confirming).
 */
export async function reconcileOrder(d: BillingDeps, order: OrderRow): Promise<SyncResult> {
  if (order.status !== 'pending') return 'noop';
  if (!order.stripe_invoice_id) return failOrder(d, order, { code: 'incomplete', message: 'The payment was never started. You have not been charged.' });
  let inv: StripeObject;
  try {
    inv = await d.stripe.retrieveInvoice(order.stripe_invoice_id);
  } catch (e) {
    if (e instanceof StripeError && e.isNotFound) return failOrder(d, order, { code: 'invoice_missing', message: 'The payment could not be found. You have not been charged.' });
    throw e;
  }
  if (inv.status === 'paid' || inv.status === 'void' || inv.status === 'uncollectible') return applyInvoice(d, order);
  return failOrder(d, order, { code: 'abandoned', message: 'The payment was not confirmed in time. You have not been charged.' }, 'canceled');
}

/** The order for a Stripe invoice, charge or payment intent (across workspaces: Stripe names no workspace). */
export async function orderForCharge(d: BillingDeps, chargeId: string, paymentIntentId: string | null): Promise<OrderRow | null> {
  const lookups = billingLookups(d.db);
  const direct = await lookups.orderByCharge(chargeId, paymentIntentId);
  if (direct) return direct;
  if (!paymentIntentId) return null;
  const link = (await d.stripe.findInvoicePayment(paymentIntentId)).data[0] as { invoice?: unknown } | undefined;
  const invoiceId = link ? idOf(link.invoice) : null;
  return invoiceId ? lookups.orderByInvoice(invoiceId) : null;
}
