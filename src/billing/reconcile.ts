// The daily billing job (from runHostedCron, 11:00 UTC; hosted and configured only). Each step is bounded and independent.
//   1. pending orders that did not complete within an hour are settled from Stripe (paid if the invoice was paid and the webhook got lost,
//      otherwise voided and ended), so a stuck order never blocks its domain for good
//   2. paid orders whose notice to the instance owner did not go out are emailed again
//   3. pay as you go (src/billing/plan-service.ts reconcilePlans): each subscription re-read, quantity drift repaired (server count wins), what Stripe says has
//      ended lapsed; organizational domains filled in for rows that lack one; expired workspace intents dropped
//   4. housekeeping: events older than 90 days, checkout bindings that never reached Stripe, orders past the 7-year accounting period
import { billingLookups, planLookups } from '@ready-set-mail/db';
import type { BoundEnv } from '../index';
import { billingEnabled } from './config';
import { billingDeps } from './deps';
import { emailOwnerPaid } from './notify';
import { RECONCILE_AFTER_SECONDS } from './service';
import { reconcileOrder } from './sync';
import { reconcilePlans, type PlanSyncReport } from './plan-service';
import { ensureOrgDomains } from '../hosted/plan';

export const RECONCILE_BATCH = 25;
export const NOTICE_BATCH = 20;
export const EVENT_RETENTION_DAYS = 90;
/** Orders are accounting records: kept this long from creation, then deleted (docs/data-retention.md). */
export const ORDER_RETENTION_YEARS = 7;

export interface ReconcileReport { reconciled: number; failed: number; notified: number; purged_events: number; purged_sessions: number; purged_orders: number; plans: PlanSyncReport; org_domains_filled: number; purged_intents: number }

export async function runBillingJob(env: BoundEnv, ctx?: ExecutionContext, opts: { fetch?: typeof fetch; now?: () => number } = {}): Promise<ReconcileReport> {
  const report: ReconcileReport = { reconciled: 0, failed: 0, notified: 0, purged_events: 0, purged_sessions: 0, purged_orders: 0, plans: { synced: 0, repaired: 0, lapsed: 0, failed: 0 }, org_domains_filled: 0, purged_intents: 0 };
  if (!billingEnabled(env)) return report;
  const d = billingDeps(env, ctx, opts);
  const lookups = billingLookups(env.DB);
  const now = d.now();
  for (const order of await lookups.stalePending(now - RECONCILE_AFTER_SECONDS, RECONCILE_BATCH)) {
    try { await reconcileOrder(d, order); report.reconciled++; } catch { report.failed++; console.error(`[billing] reconcile of ${order.id} failed; it stays pending`); }
  }
  for (const order of await lookups.unnotified(NOTICE_BATCH)) {
    if (await emailOwnerPaid(env, order)) { await lookups.markNotified(order.workspace_id, order.id); report.notified++; }
  }
  report.plans = await reconcilePlans(d, RECONCILE_BATCH);
  for (const ws of await planLookups(env.DB).withoutOrgDomain(10)) { await ensureOrgDomains(env.DB, ws); report.org_domains_filled++; }
  report.purged_intents = await planLookups(env.DB).intents.purge(now - 86400);
  report.purged_events = await lookups.events.purgeBefore(now - EVENT_RETENTION_DAYS * 86400);
  report.purged_sessions = await lookups.purgeSessions(now);
  report.purged_orders = await lookups.purgeOrdersBefore(now - ORDER_RETENTION_YEARS * 365 * 86400);
  console.log(`[billing] daily ${JSON.stringify(report)}`);
  return report;
}
