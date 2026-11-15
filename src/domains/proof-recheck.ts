// A Cloudflare zone proof says who controlled the zone when it was made. It is not a permanent title: domains are sold, zones move to another
// account, delegations change. Two things keep it honest:
//
//  1. When ANOTHER workspace proves the same name (TXT or zone), the holder first shows it still holds it (reassessZoneHolders): public DNS must
//     still delegate the zone to the name servers stored with the proof, and, where one of the holder's tokens still works, Cloudflare must still
//     serve the zone, active and full, in that account. A holder that fails is marked unproven ('legacy'), which is what makes the new proof win
//     (the existing eviction rule: an unproven holder is evicted by the proof that follows, see ownership.ts).
//  2. A daily job (recheckZoneProofs, run by the hosted cron) compares public DNS with the stored servers for every zone-verified domain. When the
//     delegation no longer matches, the domain becomes unproven the same way: intake stops accepting its reports and the workspace is emailed and audited.
//
// A revoked or expired token alone never downgrades anything: the proof was made once and public delegation still matching is enough. Only a definite
// answer counts (an NS set that differs, NXDOMAIN, an empty answer, Cloudflare saying the zone is gone or no longer active): a failed lookup or an
// unreachable Cloudflare changes nothing and is tried again.
import { claimLookups, type ZoneHolder } from '@ready-set-mail/db';
import { normalizeName, type Resolver } from '@ready-set-mail/dns-checks';
import { logAudit } from '../audit/log';
import { sendProofLostNotice } from '../auth/mail';
import { mapLimit } from '../cron';
import { resolverFor } from '../dns/resolver';
import type { BoundEnv } from '../index';
import { CfNotFoundError } from '../tenancy/cf-client';
import type { TenantContext } from '../tenancy/context';
import { loadTenant } from '../tenancy/load';
import { demoteOrphanedSubdomains } from './ownership';

/** Zone-verified domains the daily job looks at in one run (oldest check first). Each costs at most one DNS-over-HTTPS query, shared by every domain of the same zone. */
export const RECHECK_PER_RUN = 200;
/** A holder that has shown it holds the name is not asked again for this long, so repeated claims on its name cannot make us hammer its Cloudflare account. */
export const RECHECK_COOLDOWN_SECONDS = 600;
const CONCURRENCY = 5;

export type Delegation = 'match' | 'differs' | 'unknown';

/**
 * Does public DNS delegate `zoneName` to exactly the name servers `wanted`? Every NS answer must be owned by the zone name itself: a recursive
 * resolver follows a CNAME, so a name that is an alias of another domain answers with that domain's servers under that domain's name, and says
 * nothing about who runs the zone at this one. The two sets must be equal: a subset is a delegation to someone else too. 'unknown': nothing
 * to compare with, or the lookup failed.
 */
export async function checkDelegation(resolver: Resolver, zoneName: string, wanted: readonly string[] | null | undefined): Promise<Delegation> {
  const want = new Set((wanted ?? []).map(normalizeName));
  if (want.size === 0) return 'unknown';
  const zone = normalizeName(zoneName);
  try {
    const r = await resolver.resolve(zone, 'NS');
    if (r.status === 'error') return 'unknown';
    if (r.status !== 'ok') return 'differs'; // NXDOMAIN or no NS records at all
    if (r.answers.some(a => normalizeName(a.name) !== zone)) return 'differs';
    const have = new Set(r.answers.map(a => normalizeName(a.data)));
    return have.size === want.size && [...have].every(h => want.has(h)) ? 'match' : 'differs';
  } catch { return 'unknown'; }
}

export const parseServers = (stored: string | null): string[] | null => {
  try { const v = stored ? JSON.parse(stored) : null; return Array.isArray(v) && v.every(x => typeof x === 'string') && v.length ? v : null; } catch { return null; }
};

type Live = { kind: 'ok'; name: string; servers: string[] } | { kind: 'bad' } | { kind: 'unusable' };

/** What Cloudflare says now about the zone, through a connection of the holder's workspace whose token still works. Unreadable: `unusable` (no verdict). */
async function liveZone(holderTenant: TenantContext, holder: ZoneHolder): Promise<Live> {
  if (!holder.cf_zone_id) return { kind: 'unusable' };
  const q = holderTenant.scope.connections;
  const candidates: string[] = [];
  for (const c of await q.list()) {
    if (c.status !== 'active') continue;
    if (c.id === holder.cf_connection_id || (await q.zones(c.id)).some(z => z.zone_id === holder.cf_zone_id)) candidates.push(c.id);
  }
  for (const id of candidates) {
    try {
      const z = await (await holderTenant.connections.clientFor(id)).getZone(holder.cf_zone_id);
      const name = (z.name ?? '').toLowerCase();
      const sameZone = z.status === 'active' && z.type === 'full' && (!holder.cf_zone_name || name === holder.cf_zone_name) && (!holder.cf_account_id || z.account?.id === holder.cf_account_id);
      return sameZone ? { kind: 'ok', name, servers: (z.name_servers ?? []).map(normalizeName) } : { kind: 'bad' };
    } catch (e) {
      if (e instanceof CfNotFoundError) return { kind: 'bad' }; // the zone is not in that account any more
      // a revoked or refused token, an outage, a connection that cannot be built: no verdict from this connection
    }
  }
  return { kind: 'unusable' };
}

/** Why a zone proof no longer holds, or null when it does (or cannot be shown not to). */
export type Lapse = 'cloudflare' | 'delegation';

async function lapseOf(env: BoundEnv, holder: ZoneHolder, resolver: Resolver): Promise<Lapse | null> {
  const stored = parseServers(holder.cf_name_servers);
  const live = await liveZone(await loadTenant(env, { workspaceId: holder.workspace_id }), holder);
  if (live.kind === 'bad') return 'cloudflare';
  const servers = stored ?? (live.kind === 'ok' ? live.servers : null); // a proof from before the servers were kept: only what Cloudflare says now is there to compare with
  const zone = holder.cf_zone_name ?? (live.kind === 'ok' ? live.name : null);
  if (!servers || !zone) return null;
  return (await checkDelegation(resolver, zone, servers)) === 'differs' ? 'delegation' : null;
}

/** The proof no longer holds: the row becomes unproven, its subdomains admitted through it too, and the workspace is told (once). */
export async function withdrawProof(env: BoundEnv, holder: ZoneHolder, why: Lapse): Promise<boolean> {
  if (!(await claimLookups(env.DB).markProofLost(holder.id, Math.floor(Date.now() / 1000)))) return false;
  const tenant = await loadTenant(env, { workspaceId: holder.workspace_id });
  await demoteOrphanedSubdomains(tenant);
  logAudit(tenant, {
    actor_type: 'system', action: 'domain.proof_lost', resource_type: 'domain', resource_id: String(holder.id), resource_name: holder.domain,
    meta: { reason: why === 'delegation' ? 'public DNS no longer delegates the zone to the name servers recorded at the proof' : 'Cloudflare no longer serves the zone, active and full, in the account that proved it', zone: holder.cf_zone_name, name_servers: parseServers(holder.cf_name_servers) },
  });
  const owners = (await tenant.scope.team.list()).filter(m => m.role === 'owner').map(m => m.email);
  await sendProofLostNotice(env, owners, holder.domain, why);
  return true;
}

/**
 * Another workspace is proving `domain`: every Cloudflare-zone holder of that name, a parent or a child must show it still holds it. The ones that
 * cannot lose their proof (and so the name, once the new proof is committed). A holder checked within RECHECK_COOLDOWN_SECONDS is not asked again.
 */
export async function reassessZoneHolders(tenant: TenantContext, domain: string, resolver: Resolver = resolverFor(tenant.env)): Promise<void> {
  const lookups = claimLookups(tenant.db);
  const now = Math.floor(Date.now() / 1000);
  for (const holder of await lookups.zoneVerifiedNear(domain, tenant.workspaceId)) {
    if (holder.proof_checked_at !== null && now - holder.proof_checked_at < RECHECK_COOLDOWN_SECONDS) continue;
    try {
      const lapse = await lapseOf(tenant.env, holder, resolver);
      if (lapse) await withdrawProof(tenant.env, holder, lapse);
      else await lookups.markProofChecked([holder.id], now);
    } catch (e) {
      console.warn(`[proof] re-check of ${holder.domain} failed (the holder keeps the name):`, e instanceof Error ? e.message : e);
    }
  }
}

export interface RecheckResult { checked: number; downgraded: number; inconclusive: number; recorded: number }

/**
 * The daily job: public DNS against the name servers stored at each zone proof.
 *
 * Cost per run: one D1 read for the batch, then for each zone among the (at most `limit`, default RECHECK_PER_RUN) domains one DNS-over-HTTPS NS query,
 * shared by every domain of that zone: at most RECHECK_PER_RUN subrequests, 5 at a time. A proof from before the servers were kept costs one Cloudflare
 * read as well, only when one of the holder's connections still works, to record them. Oldest check first, never-checked first, so a larger fleet
 * is covered over several days. Writes: one UPDATE for the confirmed ones, a few statements and one email per downgrade.
 */
export async function recheckZoneProofs(env: BoundEnv, opts: { limit?: number; resolver?: Resolver; now?: () => number } = {}): Promise<RecheckResult> {
  const lookups = claimLookups(env.DB);
  const resolver = opts.resolver ?? resolverFor(env);
  const now = Math.floor((opts.now?.() ?? Date.now()) / 1000);
  const out: RecheckResult = { checked: 0, downgraded: 0, inconclusive: 0, recorded: 0 };
  const rows = await lookups.zoneVerifiedDue(opts.limit ?? RECHECK_PER_RUN);
  const held: number[] = [];
  const asked = new Map<string, Promise<Delegation>>(); // one query per zone and server set
  await mapLimit(rows, CONCURRENCY, async holder => {
    try {
      const stored = parseServers(holder.cf_name_servers);
      if (!stored || !holder.cf_zone_name) { // from before the servers were kept: record them when Cloudflare and public DNS agree, never downgrade for the missing record
        const live = await liveZone(await loadTenant(env, { workspaceId: holder.workspace_id }), holder);
        if (live.kind === 'ok' && live.servers.length && (await checkDelegation(resolver, live.name, live.servers)) === 'match') { await lookups.recordNameServers(holder.id, live.name, live.servers, now); out.recorded++; }
        out.checked++;
        return;
      }
      const key = `${holder.cf_zone_name}|${holder.cf_name_servers}`;
      if (!asked.has(key)) asked.set(key, checkDelegation(resolver, holder.cf_zone_name, stored));
      const verdict = await asked.get(key)!;
      if (verdict === 'unknown') { out.inconclusive++; return; }
      out.checked++;
      if (verdict === 'match') held.push(holder.id);
      else if (await withdrawProof(env, holder, 'delegation')) out.downgraded++;
    } catch (e) {
      out.inconclusive++;
      console.error(`[proof] re-check of domain ${holder.id} failed:`, e instanceof Error ? e.message : e);
    }
  });
  await lookups.markProofChecked(held, now);
  return out;
}
