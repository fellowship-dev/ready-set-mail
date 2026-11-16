// The daily MTA-STS job: ONE function for both modes (ADR 0021).
//   saas       runHostedCron (11:00 UTC, once for the whole database): `refreshMtaStsHosted`
//   self-host  the per-workspace 08:00 branch of src/cron.ts: `refreshMtaStsForTenant`
// For every enabled row, oldest check first and at most REFRESH_PER_RUN per run (about ten subrequests each, so the run stays well inside a
// Worker's budget; the default ceiling of policy hosts is the same number, so every hosted row is reached daily), five at a time:
//   - the reconcile first (src/mta-sts/reconcile.ts): the custom hostname exists and is not moved, the declared route is in the zone, and the FETCH of the policy
//     URL proves the policy is served;
//   - setup not finished: look again (certificate, records, the fetch) and move it forward; one still not finished after 7 days is stopped (its slot is free);
//   - the MX hosts: a DNS error changes nothing; no MX at all never changes the published policy (a notice says so); a changed list is a new policy id
//     (and, when it grew while enforcing, testing again), written to the stored policy first and then to the record;
//   - retired policies whose time is up (src/mta-sts/retire.ts): the custom hostname, the records, the entry;
//   - hosted: remove operator-side leftovers (a custom hostname, or a per-domain route of an earlier build, that no row owns), a few per run.
// Rerun with nothing changed in DNS: nothing changes (only `last_checked_at`).

import { forWorkspace, intakeLookups, type MtaStsRow } from '@ready-set-mail/db';
import { mapLimit } from '../cron';
import type { BoundEnv } from '../index';
import { resolverFor } from '../dns/resolver';
import { loadTenant } from '../tenancy/load';
import type { TenantContext } from '../tenancy/context';
import { getMode } from '../tenancy/mode';
import { mtaStsHostedConfigured, RECONCILE_PER_RUN, REFRESH_PER_RUN, SETUP_EXPIRED_NOTICE, SETUP_EXPIRES_AFTER_SECONDS } from './config';
import { finishRetirements } from './retire';
import { OperatorZone } from './policy-host';
import type { ReconcileShared } from './reconcile';
import { advanceMtaSts, applyMxChange, CREATING_STALE_SECONDS, readMx, teardownMtaSts } from './service';

const CONCURRENCY = 5;
const NO_MX_NOTICE = 'No MX records were found at the last check, so the policy was left unchanged. Check your MX records.';

export interface RefreshStats { visited: number; changed: number; errors: number; removed: number; served: number; notServed: number }

/** One row: its setup, then its MX hosts. Never throws. */
async function refreshOne(tenant: TenantContext, row: MtaStsRow, ec: ExecutionContext | undefined, stats: RefreshStats, shared?: ReconcileShared): Promise<void> {
  const domain = await tenant.scope.domains.getById(row.domain_id);
  if (!domain || (domain as { evicted_at?: number | null }).evicted_at) return;
  const c = { tenant, domain, ec };
  stats.visited++;
  if (row.state === 'creating') {
    // An enable in the middle of its work is left alone; one that crashed (no row finishes after this long) is torn down with the ids it stored.
    if (Math.floor(Date.now() / 1000) - row.created_at > CREATING_STALE_SECONDS) await teardownMtaSts(c, row).catch((e) => console.warn(`[mta-sts] ${domain.domain}: stale enable not removed:`, e instanceof Error ? e.message : e));
    return;
  }
  // A setup nobody finished is stopped, and its slot is free (the custom hostname is deleted; the row stays, off, only for its notice).
  if (row.state !== 'active' && Math.floor(Date.now() / 1000) - row.created_at > SETUP_EXPIRES_AFTER_SECONDS) {
    await teardownMtaSts(c, row, { stopped: SETUP_EXPIRED_NOTICE }).catch((e) => console.warn(`[mta-sts] ${domain.domain}: expired setup not stopped:`, e instanceof Error ? e.message : e));
    stats.removed++;
    return;
  }
  try {
    // The reconcile first (advanceMtaSts runs it): hostname, declared route and the fetch that proves the policy, then setup and the MX hosts.
    const { row: current } = await advanceMtaSts(c, row, undefined, shared);
    if (current.fetch_ok === 1) stats.served++; else stats.notServed++;
    const mx = await readMx(domain.domain, resolverFor(tenant.env));
    if (mx.status === 'error') { await tenant.scope.mtaSts.updateError(domain.id, `MX lookup failed: ${mx.error}`); return; }
    if (mx.status === 'none') {
      if (current.notice !== NO_MX_NOTICE) await tenant.scope.mtaSts.update(domain.id, { notice: NO_MX_NOTICE, notice_at: Math.floor(Date.now() / 1000) });
      return;
    }
    const r = await applyMxChange(c, current, mx.hosts);
    if (r.changed) stats.changed++;
  } catch (e) {
    stats.errors++;
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[mta-sts] ${domain.domain}: refresh error — ${msg}`);
    await tenant.scope.mtaSts.update(domain.id, { last_error: msg, last_checked_at: Math.floor(Date.now() / 1000) }).catch(() => undefined);
  }
}

/** Self-host: this workspace's due rows. */
export async function refreshMtaStsForTenant(tenant: TenantContext, ec?: ExecutionContext, limit = REFRESH_PER_RUN): Promise<RefreshStats> {
  const stats: RefreshStats = { visited: 0, changed: 0, errors: 0, removed: 0, served: 0, notServed: 0 };
  const rows = await tenant.scope.mtaSts.dueForRefresh(limit);
  await mapLimit(rows, CONCURRENCY, (row) => refreshOne(tenant, row, ec, stats));
  try { stats.removed += await finishRetirements(tenant.env as BoundEnv, { tenant }); } catch (e) { console.error('[mta-sts] finishing retired policies failed:', e instanceof Error ? e.message : e); }
  return stats;
}

/** Hosted: due rows of every workspace, then the operator-side reconcile. */
export async function refreshMtaStsHosted(env: BoundEnv, ec?: ExecutionContext, limit = REFRESH_PER_RUN): Promise<RefreshStats> {
  const stats: RefreshStats = { visited: 0, changed: 0, errors: 0, removed: 0, served: 0, notServed: 0 };
  const due = await intakeLookups(env.DB).dueMtaSts(limit);
  const shared: ReconcileShared = {}; // the operator zone and the declared route, looked up once for the whole run
  const tenants = new Map<string, Promise<TenantContext>>();
  const tenantFor = (ws: string) => { if (!tenants.has(ws)) tenants.set(ws, loadTenant(env, { workspaceId: ws })); return tenants.get(ws)!; };
  await mapLimit(due, CONCURRENCY, async (d) => {
    try {
      const tenant = await tenantFor(d.workspace_id);
      const row = await forWorkspace(env.DB, d.workspace_id).mtaSts.get(d.domain_id);
      if (row?.enabled) await refreshOne(tenant, row, ec, stats, shared);
    } catch (e) {
      stats.errors++;
      console.error(`[mta-sts] workspace ${d.workspace_id} refresh failed:`, e instanceof Error ? e.message : e);
    }
  });
  try { stats.removed += await finishRetirements(env); } catch (e) { console.error('[mta-sts] finishing retired policies failed:', e instanceof Error ? e.message : e); }
  try { stats.removed += await reconcileOperatorZone(env); } catch (e) { console.error('[mta-sts] operator reconcile failed:', e instanceof Error ? e.message : e); }
  return stats;
}

/**
 * Hosted: take away what this product made in the operator's zone that no row owns any more: a custom hostname `mta-sts.<d>` whose domain has no MTA-STS row in
 * any state (an enable stores its row first, so one in the middle of its work is never taken back), and a per-domain Worker route an earlier build made for such a
 * domain. The declared route is shared and never touched here. Anything else in the zone is left alone. At most `limit` per run. Returns how many it removed.
 */
export async function reconcileOperatorZone(env: BoundEnv, limit = RECONCILE_PER_RUN): Promise<number> {
  if (getMode(env) !== 'saas' || !mtaStsHostedConfigured(env)) return 0;
  const zone = await OperatorZone.open(env);
  const keep = await intakeLookups(env.DB).mtaStsDomainNames();
  let removed = 0;
  for (const ch of await zone.listHostnames()) {
    if (removed >= limit) break;
    const domain = OperatorZone.domainOf(ch.hostname);
    if (!domain || keep.has(domain)) continue;
    try {
      if (await zone.deleteHostname(ch.id, domain)) removed++;
    } catch (e) {
      console.warn(`[mta-sts] could not remove the leftover custom hostname of ${domain}:`, e instanceof Error ? e.message : e);
    }
  }
  for (const route of (await zone.listRoutes()).filter((r) => zone.ownsRoute(r))) {
    if (removed >= limit) break;
    const domain = OperatorZone.domainOf(route.pattern);
    if (!domain || keep.has(domain)) continue;
    try {
      if (await zone.deleteRoute(route.id, domain)) removed++;
    } catch (e) {
      console.warn(`[mta-sts] could not remove the leftover policy-host route of ${domain}:`, e instanceof Error ? e.message : e);
    }
  }
  return removed;
}
