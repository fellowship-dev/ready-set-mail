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
// A LAPSE MUST BE CONFIRMED BEFORE A PROOF IS WITHDRAWN. One empty answer, an NXDOMAIN, or a subset of the name servers (a resolver glitch, a
// truncated reply, an outage at the resolver) is not the domain moving away, and withdrawing a proof on it would let a flaky read lock a real owner out:
//  - a truncated (TC) answer is unknown, never "differs";
//  - daily job: the differing read is stored as "suspected since" (domains.proof_suspected_at) and the proof is withdrawn only when a later read, at
//    least CONFIRM_AFTER_SECONDS (24 hours) after the first, differs again. A read that matches clears the suspicion. NXDOMAIN for the zone name
//    on two reads a day apart is a real lapse (it is one of the differing answers);
//  - rival claim: waiting a day would lock a legitimate new owner out, so the same request reads twice, CONFIRM_DELAY_MS apart, and
//    both reads must show the lapse. Where one of the holder's tokens still works, Cloudflare's own answer must agree as well: public DNS alone
//    differing while Cloudflare still serves the zone active and full in that account does not withdraw the proof (the daily job decides then);
//  - a lookup that fails or is refused is no verdict at all and changes nothing.
// A revoked or expired token alone never downgrades anything: the proof was made once and public delegation still matching is enough.
//
// Proofs from release 2.0.0: its claim Verify button (src/domains/ownership.ts provenByCloudflare, through admitDomain/verifyClaim) stored
// verified_via = 'cloudflare' and nothing else: no zone, no name servers. Nothing can be compared with public DNS for them, so such a row is unproven
// as against another workspace (unprovenRow): that workspace's completed proof of the name (a TXT record only the DNS controller can publish, or a
// zone with the exact delegation) takes the name, the old row is detached and keeps its reports read-only for 30 days. A claim alone, with no proof, moves
// nothing. The daily job records zone, account and name servers for such a row when one of the holder's connections still works AND public DNS
// delegates the zone to exactly the servers Cloudflare reports; from then on it is a normal row. With no working token it records nothing: today's DNS
// could just as well be the new owner's, and pinning it would make the old holder's row look proven.
import { claimLookups, type ZoneHolder } from '@ready-set-mail/db';
import { isPublicSuffix, normalizeName, type Resolver } from '@ready-set-mail/dns-checks';
import { logAudit } from '../audit/log';
import { sendProofLostNotice } from '../auth/mail';
import { mapLimit } from '../cron';
import { confirmResolverFor, resolverFor } from '../dns/resolver';
import type { BoundEnv } from '../index';
import { CfNotFoundError } from '../tenancy/cf-client';
import type { TenantContext } from '../tenancy/context';
import { loadTenant } from '../tenancy/load';
import { EVICTED_KEEP_DAYS, demoteOrphanedSubdomains, within } from './ownership';

/** Zone-verified domains the daily job looks at in one run (oldest check first). Each costs at most one DNS-over-HTTPS query, shared by every domain of the same zone. */
export const RECHECK_PER_RUN = 200;
/** A holder that has shown it holds the name is not asked again for this long, so repeated claims on its name cannot make us hammer its Cloudflare account. */
export const RECHECK_COOLDOWN_SECONDS = 600;
/** Of those, the slots kept for rows with no recent real answer (never answered, new, or silent for ANSWERED_WINDOW_SECONDS) whenever answering rows would fill the run. */
export const RECHECK_RESERVED_UNANSWERED = 40;
/** A row counts as answering while its last real answer is this recent. */
export const ANSWERED_WINDOW_SECONDS = 30 * 24 * 60 * 60;
const CONCURRENCY = 5;
/** The daily job withdraws a proof only when a read at least this long after the first differing one differs again. */
export const CONFIRM_AFTER_SECONDS = 24 * 60 * 60;
/** For a rival claim: the second read comes this long after the first, in the same request. */
export const CONFIRM_DELAY_MS = 2000;
/** Outside tests the wait is never shorter than this, whatever PROOF_CONFIRM_DELAY_MS says: two back-to-back reads are one read. */
export const MIN_CONFIRM_DELAY_MS = 1000;
const sleep = (ms: number): Promise<void> => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve());
const underTest = (): boolean => typeof process !== 'undefined' && !!process.env?.VITEST;
/** PROOF_CONFIRM_DELAY_MS overrides the wait; below MIN_CONFIRM_DELAY_MS (0 included) it is honoured only under test (vitest sets VITEST), else clamped up to it. */
export const confirmDelayMs = (env: { PROOF_CONFIRM_DELAY_MS?: string }, testing = underTest()): number => {
  const n = Number(env.PROOF_CONFIRM_DELAY_MS ?? CONFIRM_DELAY_MS);
  if (!Number.isFinite(n) || n < 0) return CONFIRM_DELAY_MS;
  return testing ? n : Math.max(n, MIN_CONFIRM_DELAY_MS);
};

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
    if (r.status === 'error' || r.truncated) return 'unknown'; // a cut-short answer lists only some of the servers: not a verdict
    if (r.status !== 'ok') return 'differs'; // NXDOMAIN or no NS records at all
    if (r.answers.some(a => normalizeName(a.name) !== zone)) return 'differs';
    const have = new Set(r.answers.map(a => normalizeName(a.data)));
    return have.size === want.size && [...have].every(h => want.has(h)) ? 'match' : 'differs';
  } catch { return 'unknown'; }
}

export const parseServers = (stored: string | null): string[] | null => {
  try { const v = stored ? JSON.parse(stored) : null; return Array.isArray(v) && v.every(x => typeof x === 'string') && v.length ? v : null; } catch { return null; }
};

type Live = { kind: 'ok'; zoneId: string; accountId: string | null; name: string; servers: string[] } | { kind: 'bad' } | { kind: 'unusable' };

/**
 * What Cloudflare says now about the holder's zone, through a connection of the holder's workspace whose token still works. Unreadable: `unusable` (no
 * verdict). A proof without a recorded zone (release 2.0.0) is looked for in the allow-listed zones of the workspace's connections that contain the name.
 */
async function liveZone(holderTenant: TenantContext, holder: ZoneHolder): Promise<Live> {
  const q = holderTenant.scope.connections;
  const candidates: Array<{ connection: string; zoneId: string | null; accountId: string | null }> = [];
  for (const c of await q.list()) {
    if (c.status !== 'active') continue;
    const zones = await q.zones(c.id);
    if (holder.cf_zone_id) {
      if (c.id === holder.cf_connection_id || zones.some(z => z.zone_id === holder.cf_zone_id)) candidates.push({ connection: c.id, zoneId: holder.cf_zone_id, accountId: c.cf_account_id });
    } else {
      for (const z of zones) if (!isPublicSuffix(z.zone_name) && within(holder.domain, z.zone_name.toLowerCase())) candidates.push({ connection: c.id, zoneId: z.zone_id, accountId: z.cf_account_id ?? c.cf_account_id });
    }
  }
  let verdict: Live = { kind: 'unusable' };
  for (const cand of candidates) {
    try {
      const z = await (await holderTenant.connections.clientFor(cand.connection)).getZone(cand.zoneId!);
      const name = (z.name ?? '').toLowerCase();
      const sameZone = z.status === 'active' && z.type === 'full' && within(holder.domain, name) && (!holder.cf_zone_name || name === holder.cf_zone_name) && (!holder.cf_account_id || z.account?.id === holder.cf_account_id) && (!cand.accountId || z.account?.id === cand.accountId);
      if (sameZone) return { kind: 'ok', zoneId: cand.zoneId!, accountId: z.account?.id ?? cand.accountId, name, servers: (z.name_servers ?? []).map(normalizeName) };
      verdict = { kind: 'bad' };
    } catch (e) {
      if (e instanceof CfNotFoundError) verdict = { kind: 'bad' }; // the zone is not in that account any more
      // a revoked or refused token, an outage, a connection that cannot be built: no verdict from this connection
    }
  }
  return verdict;
}

/** Why a zone proof no longer holds, or null when it does (or cannot be shown not to). */
export type Lapse = 'cloudflare' | 'delegation';

/** One read of the evidence: the lapse it shows (or none), and whether Cloudflare itself could be asked and still serves the zone. */
async function readLapse(env: BoundEnv, holder: ZoneHolder, resolver: Resolver): Promise<{ lapse: Lapse | null; cloudflareStillServes: boolean }> {
  const stored = parseServers(holder.cf_name_servers);
  const live = await liveZone(await loadTenant(env, { workspaceId: holder.workspace_id }), holder);
  if (live.kind === 'bad') return { lapse: 'cloudflare', cloudflareStillServes: false };
  const servers = stored ?? (live.kind === 'ok' ? live.servers : null); // a proof from before the servers were kept: only what Cloudflare says now is there to compare with
  const zone = holder.cf_zone_name ?? (live.kind === 'ok' ? live.name : null);
  if (!servers || !zone) return { lapse: null, cloudflareStillServes: live.kind === 'ok' };
  return { lapse: (await checkDelegation(resolver, zone, servers)) === 'differs' ? 'delegation' : null, cloudflareStillServes: live.kind === 'ok' };
}

/**
 * A lapse for a rival claim, confirmed (see the header): two reads CONFIRM_DELAY_MS apart, the second through a different resolver (confirmResolverFor), that both show it, and, where a token of the
 * holder still works, Cloudflare's own answer agreeing (a delegation that differs while Cloudflare still serves the zone is not enough).
 */
async function confirmedLapse(env: BoundEnv, holder: ZoneHolder, resolver: Resolver, secondResolver: Resolver): Promise<Lapse | null> {
  const first = await readLapse(env, holder, resolver);
  if (!first.lapse) return null;
  await sleep(confirmDelayMs(env));
  const second = await readLapse(env, holder, secondResolver);
  if (second.lapse !== first.lapse) return null;
  if (second.lapse === 'delegation' && second.cloudflareStillServes) return null;
  return second.lapse;
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
  await sendProofLostNotice(env, owners, holder.domain, why, EVICTED_KEEP_DAYS);
  return true;
}

/**
 * A proof from before the servers were kept: when one of the holder's connections still serves the zone and public DNS delegates it to exactly the
 * servers Cloudflare reports, record zone, account and servers on the row (it is a normal row from then on). True when recorded.
 */
async function recordServersIfAgreed(env: BoundEnv, holder: ZoneHolder, resolver: Resolver, now: number): Promise<boolean> {
  const live = await liveZone(await loadTenant(env, { workspaceId: holder.workspace_id }), holder);
  if (live.kind !== 'ok' || live.servers.length === 0) return false;
  if ((await checkDelegation(resolver, live.name, live.servers)) !== 'match') return false;
  await claimLookups(env.DB).recordNameServers(holder.id, { zoneId: live.zoneId, accountId: live.accountId, zoneName: live.name, servers: live.servers }, now);
  return true;
}

/**
 * Another workspace is proving `domain`: every Cloudflare-zone holder of that name, a parent or a child must show it still holds it. The ones that
 * cannot lose their proof (and so the name, once the new proof is committed): only on a confirmed lapse (confirmedLapse). A holder checked within
 * RECHECK_COOLDOWN_SECONDS is not asked again. A holder whose proof has no recorded servers gets them recorded when Cloudflare and public DNS agree.
 */
export async function reassessZoneHolders(tenant: TenantContext, domain: string, injected?: Resolver): Promise<void> {
  const resolver = injected ?? resolverFor(tenant.env);
  const second = injected ?? confirmResolverFor(tenant.env); // a resolver handed in (tests) is used for both reads
  const lookups = claimLookups(tenant.db);
  const now = Math.floor(Date.now() / 1000);
  for (const holder of await lookups.zoneVerifiedNear(domain, tenant.workspaceId)) {
    if (holder.proof_checked_at !== null && now - holder.proof_checked_at < RECHECK_COOLDOWN_SECONDS) continue;
    try {
      if (!parseServers(holder.cf_name_servers) && (await recordServersIfAgreed(tenant.env, holder, resolver, now))) continue; // it holds, and can be checked from now on
      const lapse = await confirmedLapse(tenant.env, holder, resolver, second);
      if (lapse) await withdrawProof(tenant.env, holder, lapse);
      else if (parseServers(holder.cf_name_servers)) await lookups.markProofChecked([holder.id], now);
    } catch (e) {
      console.warn(`[proof] re-check of ${holder.domain} failed (the holder keeps the name):`, e instanceof Error ? e.message : e);
    }
  }
}

export interface RecheckResult { checked: number; downgraded: number; inconclusive: number; recorded: number; suspected: number }

/**
 * The daily job: public DNS against the name servers stored at each zone proof.
 *
 * Cost per run: one D1 read for the batch and one UPDATE marking it attempted, then for each zone among the (at most `limit`, default RECHECK_PER_RUN)
 * domains one DNS-over-HTTPS NS query, shared by every domain of that zone: at most RECHECK_PER_RUN subrequests, 5 at a time. A proof from before the
 * servers were kept costs one Cloudflare read as well, only when one of the holder's connections still works, to record them. Two queues, each ordered by
 * when a row was last ATTEMPTED (never first): rows with a real answer in the last 30 days (160 slots), then the rest (40 slots, plus any the first leaves unused). Every row taken is marked attempted whatever comes of it, so a fleet larger than one run is covered
 * over several days and rows that never answer rotate to the back. Writes: one UPDATE for the confirmed ones, a few statements and one email per downgrade.
 * A differing read starts a suspicion; the proof is withdrawn only by a differing read CONFIRM_AFTER_SECONDS after it (see the header).
 */
export async function recheckZoneProofs(env: BoundEnv, opts: { limit?: number; resolver?: Resolver; now?: () => number } = {}): Promise<RecheckResult> {
  const lookups = claimLookups(env.DB);
  const resolver = opts.resolver ?? resolverFor(env);
  const now = Math.floor((opts.now?.() ?? Date.now()) / 1000);
  const out: RecheckResult = { checked: 0, downgraded: 0, inconclusive: 0, recorded: 0, suspected: 0 };
  const limit = opts.limit ?? RECHECK_PER_RUN;
  const rows = await lookups.zoneVerifiedDue(limit, now, { reserved: Math.min(RECHECK_RESERVED_UNANSWERED, Math.ceil(limit / 5)), answeredWithinSeconds: ANSWERED_WINDOW_SECONDS });
  await lookups.markProofAttempted(rows.map(r => r.id), now);
  const held: number[] = [];
  const answered: number[] = []; // rows that got a real answer: they move to (or stay in) the first queue
  const asked = new Map<string, Promise<Delegation>>(); // one query per zone and server set
  await mapLimit(rows, CONCURRENCY, async holder => {
    try {
      const stored = parseServers(holder.cf_name_servers);
      if (!stored || !holder.cf_zone_name) { // from before the servers were kept: record them when Cloudflare and public DNS agree, never downgrade for the missing record
        if (await recordServersIfAgreed(env, holder, resolver, now)) { out.recorded++; answered.push(holder.id); }
        out.checked++;
        return;
      }
      const key = `${holder.cf_zone_name}|${holder.cf_name_servers}`;
      if (!asked.has(key)) asked.set(key, checkDelegation(resolver, holder.cf_zone_name, stored));
      const verdict = await asked.get(key)!;
      if (verdict === 'unknown') { out.inconclusive++; return; }
      out.checked++;
      answered.push(holder.id);
      if (verdict === 'match') { held.push(holder.id); return; }
      // The delegation differs. One read is a suspicion; a differing read a day after it is a lapse.
      const first = holder.proof_suspected_at ?? ((await lookups.markProofSuspected(holder.id, now)) ? now : null);
      if (first !== null && now - first >= CONFIRM_AFTER_SECONDS) { if (await withdrawProof(env, holder, 'delegation')) out.downgraded++; }
      else out.suspected++;
    } catch (e) {
      out.inconclusive++;
      console.error(`[proof] re-check of domain ${holder.id} failed:`, e instanceof Error ? e.message : e);
    }
  });
  await lookups.markProofAnswered(answered, now);
  await lookups.markProofChecked(held, now);
  return out;
}
