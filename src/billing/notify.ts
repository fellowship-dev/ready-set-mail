// What happens around an order for people: the audit entries and the one email to the person who runs the instance.
// The buyer's receipt comes from Stripe; nothing is sent to the buyer from here, and nothing is sent automatically on "done".
import { billingLookups, billingQueries, globalQueries, type OrderRow } from '@ready-set-mail/db';
import { logAudit } from '../audit/log';
import { senderAddress } from '../auth/mail';
import { mailFooter } from '../auth/legal';
import type { BoundEnv } from '../index';
import { OFFER_NAME } from './offer';

export type BillingAuditAction =
  | 'billing.card_session_started' | 'billing.card_added'
  | 'billing.order_created' | 'billing.order_paid' | 'billing.order_failed' | 'billing.order_canceled'
  | 'billing.order_refunded' | 'billing.order_started' | 'billing.order_done';

export interface AuditActor { userId?: string | null; email?: string | null }

/** One audit entry in the order's workspace. `actor` absent = the system (a webhook or the daily job). */
export function auditOrder(env: Pick<BoundEnv, 'DB'>, ctx: ExecutionContext | undefined, order: Pick<OrderRow, 'id' | 'workspace_id' | 'domain_name'>, action: BillingAuditAction, actor?: AuditActor, after?: Record<string, unknown>): void {
  logAudit({ db: env.DB, workspaceId: order.workspace_id }, {
    actor_id: actor?.userId ?? null, actor_email: actor?.email ?? null, actor_type: actor ? 'user' : 'system',
    action, resource_type: 'billing_order', resource_id: order.id, resource_name: order.domain_name,
    ...(after ? { after_value: after } : {}),
  }, ctx);
}

/** Money for people: 14900 usd → "USD 149.00". Used only in the owner's email. */
export function formatAmount(amount: number, currency: string): string {
  return `${currency.toUpperCase()} ${(amount / 100).toFixed(2)}`;
}

export function ownerNoticeText(o: OrderRow): { subject: string; text: string } {
  return {
    subject: `New order: ${OFFER_NAME} for ${o.domain_name}`,
    text: [
      'An order has been paid.',
      '',
      `Workspace: ${o.workspace_name} (${o.workspace_id})`,
      `Domain: ${o.domain_name}`,
      `Buyer: ${o.buyer_email ?? 'unknown'}`,
      `Amount: ${formatAmount(o.amount, o.currency)}${o.amount_paid !== null && o.amount_paid !== o.amount ? ` (collected: ${formatAmount(o.amount_paid, o.currency)}, after a credit or coupon at Stripe)` : ''}`,
      `Order: ${o.id}`,
      `Stripe invoice: ${o.stripe_invoice_id ?? 'unknown'}`,
      '',
      'Next: write to the buyer about the access the work needs, then mark the order started and, once the written note went out, done (Orders, in the dashboard).',
      'A full refund is available until the done note; refunds are made in the Stripe dashboard.',
    ].join('\n'),
  };
}

/** One plain-text mail to OWNER_EMAIL. True when the provider accepted it. Never logs the address or the provider's error. */
async function sendToOwner(env: BoundEnv, order: OrderRow, { subject, text }: { subject: string; text: string }): Promise<boolean> {
  const to = env.OWNER_EMAIL?.trim();
  const from = await senderAddress(env);
  if (!to || !env.SEND_EMAIL || !from) {
    console.warn(`[billing] owner notice for ${order.id} not sent: ${!to ? 'OWNER_EMAIL is not set' : !env.SEND_EMAIL ? 'SEND_EMAIL binding not configured' : 'no sender address'}`);
    return false;
  }
  const footer = mailFooter(env);
  try {
    await env.SEND_EMAIL.send({ from: { name: 'Ready Set Mail', email: from }, to: [to], subject, text: `${text}\n\nReady Set Mail${footer ? `\n${footer}` : ''}` });
    return true;
  } catch {
    console.error(`[billing] owner notice for ${order.id} failed (provider error not logged)`);
    return false;
  }
}

/** Email the instance owner that an order was paid. */
export const emailOwnerPaid = (env: BoundEnv, order: OrderRow): Promise<boolean> => sendToOwner(env, order, ownerNoticeText(order));

export type AlertReason = 'invoice_not_as_sold' | 'paid_after_closed';

/** The email to the instance owner for an order that needs a person: Stripe took (or reports) money we did not book as this order. */
export function operatorAlertText(o: OrderRow, reason: AlertReason, detail: string): { subject: string; text: string } {
  const what = reason === 'paid_after_closed'
    ? `A payment arrived for an order that was already ${o.status}. The buyer was charged and no work is booked: refund it in the Stripe dashboard unless you want to reopen it.`
    : 'Stripe reports the invoice paid, but it is not what this order sold, so the order was NOT marked paid and still holds its domain. Check the invoice in the Stripe dashboard: book it by hand or refund it.';
  return {
    subject: `Order needs attention: ${OFFER_NAME} for ${o.domain_name}`,
    text: [
      what,
      '',
      `Why: ${detail}`,
      `Workspace: ${o.workspace_name} (${o.workspace_id})`,
      `Domain: ${o.domain_name}`,
      `Buyer: ${o.buyer_email ?? 'unknown'}`,
      `Order: ${o.id} (${o.status}), ${formatAmount(o.amount, o.currency)} expected`,
      `Stripe invoice: ${o.stripe_invoice_id ?? 'unknown'}`,
    ].join('\n'),
  };
}

/**
 * Email the instance owner (OWNER_EMAIL) that an order needs attention, once per order (the claim is a conditional update; it is released if the
 * mail did not go out, so the next event or the daily job tries again). Always logs an error line with the order id.
 */
export async function alertOperator(env: BoundEnv, order: OrderRow, reason: AlertReason, detail: string): Promise<void> {
  console.error(`[billing] order ${order.id} needs attention: ${reason} (${detail})`);
  const q = billingQueries(env.DB, order.workspace_id).orders;
  if (!(await q.alertOnce(order.id))) return;
  const sent = await sendToOwner(env, order, operatorAlertText(order, reason, detail));
  if (!sent) await q.patch(order.id, { operator_alerted_at: null });
}

/** The side effects of the one move to `paid`: the audit entry and the owner's email; the daily job retries an email that did not go out. */
export async function onOrderPaid(env: BoundEnv, ctx: ExecutionContext | undefined, order: OrderRow): Promise<void> {
  auditOrder(env, ctx, order, 'billing.order_paid', undefined, { amount: order.amount, currency: order.currency });
  if (await emailOwnerPaid(env, order)) await billingLookups(env.DB).markNotified(order.workspace_id, order.id);
}

/** Email of a user, for an audit entry. */
export async function emailOf(env: Pick<BoundEnv, 'DB'>, userId: string): Promise<string | null> {
  return (await globalQueries(env.DB).users.byId(userId))?.email ?? null;
}
