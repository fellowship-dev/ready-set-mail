// The daily MTA-STS job: ONE function for both modes (ADR 0015).
//   saas       runHostedCron (11:00 UTC, once for the whole database): `refreshMtaStsHosted`
//   self-host  the per-workspace 08:00 branch of src/cron.ts: `refreshMtaStsForTenant`
// For every enabled row, oldest check first and at most REFRESH_PER_RUN per run (about ten subrequests each, so the run stays well inside a
// Worker's budget; the default ceiling of policy hosts is the same number, so every hosted row is reached daily), five at a time:
//   - setup not finished: look again (certificate, records) and move it forward;
//   - the MX hosts: a DNS error changes nothing; no MX at all never changes the published policy (a notice says so); a changed list is a new policy id
//     (and, when it grew while enforcing, testing again), written to the stored policy first and then to the record;
//   - hosted: remove operator-side leftovers (a custom hostname or Worker route this product made that no enabled row owns), a few per run.
// Rerun with nothing changed in DNS: nothing changes (only `last_checked_at`).

import { forWorkspace, intakeLookups, type MtaStsRow } from '@ready-set-mail/db';
import { mapLimit } from '../cron';
import type { BoundEnv } from '../index';
import { resolverFor } from '../dns/resolver';
import { loadTenant } from '../tenancy/load';
import type { TenantContext } from '../tenancy/context';
import { getMode } from '../tenancy/mode';
import { mtaStsHostedConfigured, RECONCILE_PER_RUN, REFRESH_PER_RUN } from './config';
import { OperatorZone } from './policy-host';
import { advanceMtaSts, applyMxChange, CREATING_STALE_SECONDS, readMx, teardownMtaSts } from './service';

const CONCURRENCY = 5;
const NO_MX_NOTICE = 'No MX records were found at the last check, so the policy was left unchanged. Check your MX records.';

export interface RefreshStats { visited: number; changed: number; errors: number; removed: number }

/** One row: its setup, then its MX hosts. Never throws. */
async function refreshOne(tenant: TenantContext, row: MtaStsRow, ec: ExecutionContext | undefined, stats: RefreshStats): Promise<void> {
  const domain = await tenant.scope.domains.getById(row.domain_id);
  if (!domain || (domain as { evicted_at?: number | null }).evicted_at) return;
  const c = { tenant, domain, ec };
  stats.visited++;
  if (row.state === 'creating') {
    // An enable in the middle of its work is left alone; one that crashed (no row finishes after this long) is torn down with the ids it stored.
    if (Math.floor(Date.now() / 1000) - row.created_at > CREATING_STALE_SECONDS) await teardownMtaSts(c, row).catch((e) => console.warn(`[mta-sts] ${domain.domain}: stale enable not removed:`, e instanceof Error ? e.message : e));
    return;
  }
  try {
    const { row: current } = await advanceMtaSts(c, row);
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
  const stats: RefreshStats = { visited: 0, changed: 0, errors: 0, removed: 0 };
  const rows = await tenant.scope.mtaSts.dueForRefresh(limit);
  await mapLimit(rows, CONCURRENCY, (row) => refreshOne(tenant, row, ec, stats));
  return stats;
}

/** Hosted: due rows of every workspace, then the operator-side reconcile. */
export async function refreshMtaStsHosted(env: BoundEnv, ec?: ExecutionContext, limit = REFRESH_PER_RUN): Promise<RefreshStats> {
  const stats: RefreshStats = { visited: 0, changed: 0, errors: 0, removed: 0 };
  const due = await intakeLookups(env.DB).dueMtaSts(limit);
  const tenants = new Map<string, Promise<TenantContext>>();
  const tenantFor = (ws: string) => { if (!tenants.has(ws)) tenants.set(ws, loadTenant(env, { workspaceId: ws })); return tenants.get(ws)!; };
  await mapLimit(due, CONCURRENCY, async (d) => {
    try {
      const tenant = await tenantFor(d.workspace_id);
      const row = await forWorkspace(env.DB, d.workspace_id).mtaSts.get(d.domain_id);
      if (row?.enabled) await refreshOne(tenant, row, ec, stats);
    } catch (e) {
      stats.errors++;
      console.error(`[mta-sts] workspace ${d.workspace_id} refresh failed:`, e instanceof Error ? e.message : e);
    }
  });
  try { stats.removed = await reconcileOperatorZone(env); } catch (e) { console.error('[mta-sts] operator reconcile failed:', e instanceof Error ? e.message : e); }
  return stats;
}

/**
 * Hosted: delete the Worker routes this product made (`mta-sts.<d>/*` to this Worker) whose domain has no row in any state (an enable stores its row
 * first, so one in the middle of its work is never taken back), and the custom hostname of
 * the same name. Anything else in the operator's zone is left alone. At most RECONCILE_PER_RUN routes per run. Returns how many it removed.
 */
export async function reconcileOperatorZone(env: BoundEnv, limit = RECONCILE_PER_RUN): Promise<number> {
  if (getMode(env) !== 'saas' || !mtaStsHostedConfigured(env)) return 0;
  const zone = await OperatorZone.open(env);
  const keep = await intakeLookups(env.DB).mtaStsDomainNames();
  let removed = 0;
  for (const route of (await zone.listRoutes()).filter((r) => zone.ownsRoute(r))) {
    if (removed >= limit) break;
    const domain = OperatorZone.domainOf(route.pattern);
    if (!domain || keep.has(domain)) continue;
    try {
      await zone.deleteRoute(route.id, domain);
      const ch = await zone.findHostname(domain).catch(() => null);
      if (ch) await zone.deleteHostname(ch.id, domain);
      removed++;
    } catch (e) {
      console.warn(`[mta-sts] could not remove the leftover policy host of ${domain}:`, e instanceof Error ? e.message : e);
    }
  }
  return removed;
}
