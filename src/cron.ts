// Cron work, one workspace at a time.
//
// A scheduled event fans out over the workspaces (self-host: just the one). Each workspace runs in
// its own try/catch, so one workspace's failure (a revoked Cloudflare token answering 403, a broken
// row) is logged and skipped instead of stopping the workspaces after it.

import type { BoundEnv } from './index';
import { loadTenant } from './tenancy/load';
import type { TenantContext } from './tenancy/context';
import { listCronWorkspaces, type ResolvedWorkspace } from './tenancy/resolver';
import { checkSubscription, detectRollbackRisk } from './monitor/check';
import { sendChangeNotification } from './monitor/notify';
import { sendWeeklyDigests } from './digest/weekly';
import { logAudit } from './audit/log';
import { dailyAnalytics, dnsChecked } from './product-analytics/steps';
import { flattenSpf } from './email/spf-flattener';
import { snapshotDns } from './email/dns-snapshot';
import { runRetention } from './lifecycle/retention';
import { retryRevocations } from './lifecycle/revoke';
import { expireUnconfirmedMonitors, runFunnelCron } from './funnel/cron';
import { refreshMtaStsForTenant } from './mta-sts/refresh';

const SPF_REFRESH_CONCURRENCY = 5;

/** Run `fn` over `items` with at most `limit` in flight. `fn` must not throw. */
export async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => { while (next < items.length) await fn(items[next++]); };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export interface CronOptions {
  /** Workspaces to cover. Default: listCronWorkspaces(env). */
  workspaces?: string[];
  /** How to build each workspace's TenantContext. Default: loadTenant. */
  load?: (env: BoundEnv, workspace: ResolvedWorkspace) => Promise<TenantContext>;
}

export async function runCronForWorkspaces(
  event: ScheduledController,
  env: BoundEnv,
  ctx: ExecutionContext,
  opts: CronOptions = {},
): Promise<void> {
  // Its own trigger, its own invocation: the sweeps must not eat the query budget of the per-workspace jobs.
  if (event.cron === LIFECYCLE_CRON) return runDataLifecycle(env);
  const load = opts.load ?? loadTenant;
  const workspaces = opts.workspaces ?? await listCronWorkspaces(env);
  await runFunnelCron(event, env);
  for (const workspaceId of workspaces) {
    try {
      const tenant = await load(env, { workspaceId });
      await runCron(event, tenant, ctx);
    } catch (e) {
      console.error(`[cron ${event.cron}] workspace ${workspaceId} failed:`, e instanceof Error ? `${e.name}: ${e.message}` : 'unknown error');
    }
  }
}

/** Daily at 04:00 UTC, once for the whole database (not per workspace): retry failed Cloudflare revocations, then the retention sweeps. */
export const LIFECYCLE_CRON = '0 4 * * *';

export async function runDataLifecycle(env: BoundEnv): Promise<void> {
  // Revocations first: they are few, and leaving a grant live matters more than a late sweep.
  try { await retryRevocations(env); } catch (e) { console.error('[lifecycle] revocation retry failed:', e); }
  try { await runRetention(env); } catch (e) { console.error('[retention] failed:', e); }
}

/** One cron tick for one workspace. */
async function runCron(event: ScheduledController, tenant: TenantContext, ctx: ExecutionContext): Promise<void> {
  // Daily product analytics — every day 11am UTC: hosted with PostHog configured only (docs/analytics.md); a no-op everywhere else.
  if (event.cron === '0 11 * * *') {
    dailyAnalytics(tenant, ctx);
    return;
  }

  // Weekly digest — every Monday 9am UTC
  if (event.cron === '0 9 * * 1') {
    await sendWeeklyDigests(tenant);
    return;
  }

  // Daily SPF flatten refresh — every day 10am UTC
  if (event.cron === '0 10 * * *') {
    if (tenant.hasCloudflare()) {
      const configs = await tenant.scope.spf.allEnabled();
      console.log(`[spf-flatten] refreshing ${configs.length} flattened domains`);
      for (const config of configs) {
        const domain = await tenant.scope.domains.getById(config.domain_id);
        if (!domain) continue;
        try {
          const result = await flattenSpf(tenant, domain.domain, config.cf_record_id);
          await tenant.scope.spf.updateResult(config.domain_id, result.flattened_record, result.ip_count, result.cf_record_id);
          console.log(`[spf-flatten] ${domain.domain}: updated (${result.ip_count} IPs)`);
          logAudit(tenant, {
            actor_type: 'system',
            action: 'spf_flatten.update',
            resource_type: 'domain', resource_id: String(domain.id), resource_name: domain.domain,
            before_value: { spf_record: config.flattened_record ?? config.canonical_record },
            after_value: { spf_record: result.flattened_record, ip_count: result.ip_count },
            meta: { cron: '0 10 * * *' },
          }, ctx);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await tenant.scope.spf.updateError(config.domain_id, msg);
          console.error(`[spf-flatten] ${domain.domain}: error — ${msg}`);
        }
      }
    }
    return;
  }

  // Daily monitor check — every day 8am UTC (default / catch-all)
  await expireUnconfirmedMonitors(tenant);
  // Also refresh every domain's stored DNS facts: SPF lookup count, SPF record, the effective DMARC policy, and when read.
  // Subrequest cost per domain: the SPF walk (1 TXT at the apex + 1 per include/redirect/a/mx/exists term, 10 at most by
  // RFC 7208; mx terms can add address lookups) + 1 DMARC TXT at _dmarc.<domain>, + 1 more at the organizational domain
  // when the domain has no record of its own (RFC 7489): 2-3 DoH fetches for a plain record, ~12 for a deep one.
  // Workers allow 50 external subrequests per invocation on the free plan and 10,000 by default on paid: roughly 4-25
  // domains (free) or 800-5,000 (paid). The cron is not queued or chunked, so past that the later domains' lookups fail
  // and are skipped (their stored values are kept, the attempt is recorded as failed). Domains are visited never-checked
  // first, then the longest since a successful check, so the same ones are not skipped every day.
  // A failed lookup leaves that stored field alone (see recordDnsCheck); "no record" is stored as null.
  const allDomains = await tenant.scope.domains.listForDnsRefresh();
  // Awaited (a floating promise can be cut off when the invocation ends), a few at a time.
  await mapLimit(allDomains, SPF_REFRESH_CONCURRENCY, async d => {
    const found = await snapshotDns(d.domain); // one lookup after the other, so the pool stays at SPF_REFRESH_CONCURRENCY requests
    try {
      if (found.spf_lookup_count !== undefined) await tenant.scope.domains.updateSpfLookupCount(d.id, found.spf_lookup_count);
      await tenant.scope.domains.recordDnsCheck(d.id, { spf_record: found.spf_record, dmarc: found.dmarc, nxdomain: found.nxdomain, at: Math.floor(Date.now() / 1000) });
      dnsChecked(tenant, ctx, d, found.dmarc, 'daily'); // the row it has: no query unless the read shows the records live
    } catch (e) {
      console.warn(`[monitor] storing DNS check failed for ${d.domain}:`, e);
    }
  });

  // Rollback regression check — for domains actively in a staged rollout
  for (const d of allDomains) {
    if (!d.rollout_rec_policy || d.rollout_rec_pct == null) continue;
    try {
      const now = Math.floor(Date.now() / 1000);
      const [curr, prev] = await Promise.all([
        tenant.scope.reports.dailyStats(d.id, now - 7 * 86400),
        tenant.scope.reports.dailyStats(d.id, now - 14 * 86400),
      ]);
      const currRows = curr;
      const prevRows = prev.filter(r => r.day < new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10));
      const rate = (rows: typeof currRows) => {
        const t = rows.reduce((n, r) => n + r.total, 0);
        const p = rows.reduce((n, r) => n + r.passed, 0);
        return t > 0 ? Math.round((p / t) * 100) : null;
      };
      const currRate = rate(currRows);
      const prevRate = rate(prevRows);
      if (detectRollbackRisk(currRate, prevRate)) {
        console.warn(`[rollout] ${d.domain}: pass rate dropped from ${prevRate}% to ${currRate}% after step ${d.rollout_rec_policy}${d.rollout_rec_pct === 0 ? ' (t=y)' : ''} — rollback recommended`);
      }
    } catch (e) {
      console.error(`[rollout] regression check failed for ${d.domain}:`, e);
    }
  }

  // MTA-STS: look at every enabled row, oldest check first (src/mta-sts/refresh.ts). The hosted service does this once for the whole database
  // in its own 11:00 job (src/hosted/cron.ts), so it never runs here twice.
  if (tenant.mode !== 'saas' && tenant.hasCloudflare()) {
    try { await refreshMtaStsForTenant(tenant, ctx); } catch (e) { console.error('[mta-sts] refresh failed:', e instanceof Error ? e.message : e); }
  }

  const subscriptions = await tenant.scope.monitor.active(200);
  console.log(`[monitor] checking ${subscriptions.length} subscriptions`);

  for (const sub of subscriptions) {
    try {
      const { changes, newBaseline, errors } = await checkSubscription(sub);
      if (errors.spf || errors.dmarc) {
        console.warn(`[monitor] ${sub.domain}: DNS lookup failed, baseline kept (${[errors.spf, errors.dmarc].filter(Boolean).join('; ')})`);
      }
      await tenant.scope.monitor.updateBaseline(sub.id, newBaseline);

      if (changes.length > 0) {
        console.log(`[monitor] ${sub.domain} changed: ${changes.map(c => c.field).join(', ')}`);
        await sendChangeNotification(sub.email, sub.domain, changes, tenant);
      }
    } catch (e) {
      console.error(`[monitor] error checking ${sub.domain}:`, e);
    }
  }
}
