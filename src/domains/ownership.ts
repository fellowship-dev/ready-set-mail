// Who may monitor a domain: only a workspace that has proven it controls it.
//
//  self-host  every domain is the operator's own: verified on the spot.
//  saas       a domain starts as a *claim* (table domain_claims, not `domains`) and becomes a domain when one of these holds:
//               - parent    the workspace already verified a parent domain (`mail.acme.com` under `acme.com`)
//               - cloudflare its zone is on the allow-list of one of the workspace's active Cloudflare connections
//               - txt       the TXT record `_readysetmail.<domain>` holds the claim's token
//
// Because `domains` only ever holds verified domains, its global UNIQUE(domain) means "the first workspace to verify
// wins", and everything downstream of `domains` (reports, stats, check results, DNS writes, hosted records) never sees
// a pending claim. Several workspaces may hold a pending claim on the same name at once; when one verifies, the
// others are marked `lost`.
import { claimLookups, forWorkspace, isUnprovenRow, ProofIncompleteError, type DomainClaimRow, type DomainRow, type ZoneProofColumns } from '@ready-set-mail/db';
import { isPublicSuffix, normalizeName, type Resolver } from '@ready-set-mail/dns-checks';
import { logAudit } from '../audit/log';
import { sendEvictionNotice } from '../auth/mail';
import { loadTenant } from '../tenancy/load';
import { resolverFor } from '../dns/resolver';
import { removeAuthRecord, removeHostedRecords } from './remove';
import { checkDelegation, reassessZoneHolders } from './proof-recheck';
import type { TenantContext } from '../tenancy/context';
import { getMode } from '../tenancy/mode';

export type VerifiedVia = 'selfhost' | 'cloudflare' | 'txt' | 'parent' | 'existing';

/**
 * How a domain's ownership was proven, as a category (for product analytics and anything else that only needs the kind of proof):
 * the Cloudflare zone, the TXT record, a proven parent, self-host's own say-so, or `other` (an unproven `legacy` row, or `existing`).
 */
export type ProofMethod = 'cloudflare_zone' | 'txt' | 'parent' | 'selfhost' | 'other';
/** The way ownership was proven, in two words: through the connected Cloudflare zone, or by hand (TXT, parent, self-host, other). */
export type ProofPath = 'cloudflare' | 'manual';
/** What a caller passes to say which domain's proof it asks about: any row of `domains` (callers never name the proof column). */
export type ProofSource = Pick<DomainRow, 'verified_via'>;

/** The proof method of an admission (`VerifiedVia`, as `admitDomain` and `commitVerifiedDomain` pass it). */
export function proofMethodOfVia(via: VerifiedVia | string | null | undefined): ProofMethod {
  return via === 'cloudflare' ? 'cloudflare_zone' : via === 'txt' || via === 'parent' || via === 'selfhost' ? via : 'other';
}

/** The proof method of a stored domain. */
export const proofMethodOf = (row: ProofSource): ProofMethod => proofMethodOfVia(row.verified_via);

/** `cloudflare` when the proof is the Cloudflare zone, otherwise `manual`: how the ownership was proven, not how records were written. */
export const proofPathOf = (method: ProofMethod): ProofPath => (method === 'cloudflare_zone' ? 'cloudflare' : 'manual');

/** Most unproven claims one workspace may hold at a time. */
export const MAX_PENDING_CLAIMS = 25;

export const CLAIM_TXT_LABEL = '_readysetmail';
export const CLAIM_TXT_PREFIX = 'readysetmail-verify=';
/** The record a claim made before the rename to Ready Set Mail (2026-11-13) told its owner to publish. Still accepted; never shown. */
export const LEGACY_CLAIM_TXT_LABEL = '_inboxangel'; // @legacy-name
export const LEGACY_CLAIM_TXT_PREFIX = 'inboxangel-verify='; // @legacy-name

export type Admission =
  | { kind: 'verified'; via: VerifiedVia }
  | { kind: 'pending'; claim: DomainClaimRow }
  /** Another workspace already owns this domain. */
  | { kind: 'taken' }
  | { kind: 'limit' };

export interface ClaimView {
  id: number;
  domain: string;
  status: 'pending' | 'lost';
  txt_name: string;
  txt_value: string;
  created_at: number;
  last_checked_at: number | null;
  last_error: string | null;
}

export const claimTxtName = (domain: string): string => `${CLAIM_TXT_LABEL}.${domain}`;

export function claimView(c: DomainClaimRow): ClaimView {
  return {
    id: c.id,
    domain: c.domain,
    status: c.status === 'lost' ? 'lost' : 'pending',
    txt_name: claimTxtName(c.domain),
    txt_value: CLAIM_TXT_PREFIX + c.token,
    created_at: c.created_at,
    last_checked_at: c.last_checked_at,
    last_error: c.last_error,
  };
}

function newToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
}

export const within = (domain: string, zone: string): boolean => domain === zone || domain.endsWith(`.${zone}`);

/** What a Cloudflare zone proof establishes, kept in the audit entry of the domain it admitted (action `domain.proof`). */
export interface CloudflareProof {
  method: 'cloudflare_zone';
  connection_id: string;
  cf_account_id: string | null;
  zone_id: string;
  zone_name: string;
  /** The zone's name servers (Cloudflare's, lowercase, sorted): what public DNS delegated the zone to when it was proven. The daily re-check compares public DNS with them. */
  name_servers: string[];
  /** Unix seconds, when Cloudflare was asked. */
  at: number;
}

/**
 * Does the token behind a connection hold DNS edit on a zone? Two ways to know, neither assumed:
 *  - an OAuth grant whose scopes include a DNS write scope (Cloudflare names them; the deployment lists them in CF_OAUTH_SCOPES);
 *  - the zone read itself, when Cloudflare returns the token's `permissions` on it, containing `#dns_records:edit`.
 * When neither can be established the answer is no, and the TXT proof is the way.
 */
export function canEditDns(connection: { auth_type: string; scopes: string | null }, zone: { permissions?: string[] }): boolean {
  if ((zone.permissions ?? []).some(p => p.toLowerCase() === '#dns_records:edit')) return true;
  if (connection.auth_type !== 'oauth') return false;
  return (connection.scopes ?? '').split(/\s+/).some(sc => /dns/i.test(sc) && /(edit|write)/i.test(sc));
}

/**
 * Does an active Cloudflare connection of this workspace manage the domain's zone, as a real delegation? Returns what was established, or null.
 *  - the zone is on the allow-list of an active connection, is not a public suffix (`co.uk` proves nothing), and the domain is the zone's
 *    name or below it on a label boundary;
 *  - Cloudflare says now (read through the stored connection: the zone id and name are the server's, never the browser's) that it is `active`,
 *    a `full` setup (a `partial`, CNAME-style setup or a `secondary` zone does not mean the account controls the domain's DNS), the same zone,
 *    in the connection's own Cloudflare account (when the connection, or the allow-list entry of that zone, records one), and that the token can edit its DNS (canEditDns);
 *  - public DNS delegates the zone name to exactly the zone's own name servers (Cloudflare's `name_servers`): every NS answer is owned by the
 *    zone name (a name that is an alias of another domain is not delegated), and the two sets are equal, not a subset. Cloudflare assigns a
 *    zone exactly its set, and a domain delegated to only some of them is half-moved to another provider or to another account's zone, so it
 *    proves nothing. When either side cannot be read the answer is "not proven" and the TXT proof is the way (the safer fallback);
 *  - hosted: not when a parent or a child of the name is verified in another workspace; that takes the TXT proof.
 */
export async function cloudflareProof(tenant: TenantContext, domain: string, resolver: Resolver = resolverFor(tenant.env)): Promise<CloudflareProof | null> {
  if (getMode(tenant.env) === 'saas' && await claimLookups(tenant.db).relatedOwnedByOther(domain, tenant.workspaceId)) return null;
  const q = tenant.scope.connections;
  for (const c of await q.list()) {
    if (c.status !== 'active') continue;
    const zones = (await q.zones(c.id)).filter(z => !isPublicSuffix(z.zone_name) && within(domain, z.zone_name.toLowerCase()));
    if (zones.length === 0) continue;
    // A child zone that exists but is not allowed serves this name: the parent's zone says nothing about it.
    const blocked = (await q.blockedZones(c.id)).map(z => z.zone_name.toLowerCase());
    if (blocked.some(b => within(domain, b))) continue;
    // The stored allow-list can be stale (zone moved away, expired): ask Cloudflare now, through the connection.
    for (const zone of zones) {
      try {
        const live = await (await tenant.connections.clientFor(c.id)).getZone(zone.zone_id);
        if (live.status !== 'active' || live.type !== 'full' || live.name?.toLowerCase() !== zone.zone_name.toLowerCase()) continue;
        if (c.cf_account_id && live.account?.id !== c.cf_account_id) continue;
        if (zone.cf_account_id && live.account?.id !== zone.cf_account_id) continue;
        if (!canEditDns(c, live)) continue;
        if ((await checkDelegation(resolver, zone.zone_name, live.name_servers)) === 'match') {
          return { method: 'cloudflare_zone', connection_id: c.id, cf_account_id: live.account?.id ?? c.cf_account_id, zone_id: zone.zone_id, zone_name: zone.zone_name.toLowerCase(), name_servers: (live.name_servers ?? []).map(normalizeName).sort(), at: Math.floor(Date.now() / 1000) };
        }
      } catch { /* unreachable or refused: not proven */ }
    }
  }
  return null;
}

export const provenByCloudflare = async (tenant: TenantContext, domain: string, resolver?: Resolver): Promise<boolean> => (await cloudflareProof(tenant, domain, resolver)) !== null;

type ProofRow = { id: number; domain: string; verified_via: string };

/**
 * Which rows of a workspace are proven: verified directly (TXT, Cloudflare, self-host), or through a parent that is itself
 * proven and still in the workspace. 'legacy' rows are never proven.
 */
export function provenDomainIds(rows: ProofRow[]): Set<number> {
  const byLength = [...rows].sort((a, b) => a.domain.length - b.domain.length);
  const proven = new Set<number>();
  const provenNames = new Set<string>();
  for (const r of byLength) {
    if (r.verified_via === 'legacy') continue;
    const ok = r.verified_via !== 'parent' || [...provenNames].some((p) => r.domain.endsWith(`.${p}`));
    if (ok) { proven.add(r.id); provenNames.add(r.domain); }
  }
  return proven;
}

/** Is this live domain of the workspace still proven (see provenDomainIds)? */
export async function isDomainProven(tenant: TenantContext, domain: ProofRow): Promise<boolean> {
  if (domain.verified_via === 'legacy') return false;
  if (domain.verified_via !== 'parent') return true;
  return provenDomainIds(await tenant.scope.domains.list()).has(domain.id);
}

/**
 * After a domain leaves a workspace: subdomains that were admitted only through it (verified_via 'parent' with no other
 * proven parent left) become unproven ('legacy'), so they stop counting as owned and the real zone owner can prove them.
 */
export async function demoteOrphanedSubdomains(tenant: TenantContext): Promise<number[]> {
  const rows = await tenant.scope.domains.list();
  const proven = provenDomainIds(rows);
  const orphans = rows.filter((r) => r.verified_via === 'parent' && !proven.has(r.id)).map((r) => r.id);
  await tenant.scope.domains.markUnproven(orphans);
  return orphans;
}

/**
 * Does a parent in this workspace let it hold `domain`? A proven parent always does. A parent that proves nothing against another workspace
 * (unprovenRow: 'legacy', or the 2.0.0 Cloudflare row with no servers) never does when another workspace holds the name, since it would then evict
 * that holder on a proof nobody can check; with no rival it may still admit its own subdomain (nothing is evicted, nothing conflicts). A 'legacy'
 * parent never does at all.
 */
async function provenByParent(tenant: TenantContext, domain: string): Promise<boolean> {
  const labels = domain.split('.');
  let stale = false;
  for (let i = 1; i <= labels.length - 2; i++) {
    const parent = await tenant.scope.domains.getByName(labels.slice(i).join('.'));
    if (!parent || parent.verified_via === 'legacy') continue; // a legacy row was never proven, so it proves nothing about its subdomains
    if (!isUnprovenRow(parent)) return true;
    stale = true;
  }
  return stale && !(await claimLookups(tenant.db).findLegacyHolder(domain, tenant.workspaceId));
}

/** Is the claim's token published at `_readysetmail.<domain>`? Throws nothing: a lookup failure is reported as the reason. */
export async function provenByTxt(claim: DomainClaimRow, resolver: Resolver): Promise<{ ok: boolean; reason?: string; code?: UnprovenCode }> {
  const res = await resolver.txt(claimTxtName(claim.domain));
  if (res.status === 'error') return { ok: false, reason: `DNS lookup failed (${res.error ?? 'error'}) — try again in a minute`, code: 'lookup_failed' };
  const want = CLAIM_TXT_PREFIX + claim.token;
  const holds = (records: string[], value: string) => records.some(r => r.trim().replace(/^"|"$/g, '').trim() === value);
  if (holds(res.records, want)) return { ok: true };
  // A claim made before the rename may already be published under the old record name: accept it too.
  const legacy = await resolver.txt(`${LEGACY_CLAIM_TXT_LABEL}.${claim.domain}`);
  if (legacy.status !== 'error' && holds(legacy.records, LEGACY_CLAIM_TXT_PREFIX + claim.token)) return { ok: true };
  return { ok: false, reason: `TXT record ${claimTxtName(claim.domain)} = "${want}" not found yet (DNS changes can take a few minutes)`, code: 'not_found_yet' };
}

/** How long an evicted workspace can still export the report history of the domain it lost. */
export const EVICTED_KEEP_DAYS = 30;

/** What an eviction will do once the new holder's row is in (see planEviction): the holder, and its root row as it was. */
export interface EvictionPlan { holderWorkspaceId: string; holderDomainId: number; root: DomainRow | null; via: VerifiedVia }

/**
 * Proof established: an unproven (legacy) holder of the name in another workspace loses it. Two steps, so that nobody loses a domain unless somebody gets it:
 *  - planEviction (here, before the insert) only notes who the holder is. Nothing is changed. The caller passes `freeingFor(tenant, domain)` to the insert,
 *    which detaches the holder's row in the same transaction (the name is unique, so it has to be free for the insert; a full plan or a failed insert
 *    changes nothing);
 *  - finishEviction (settleClaims, after the insert committed) does the rest through the normal removal path (hosted records and their quota, the
 *    authorisation record, the holder's subdomains), leaves its reports for 30 days for export (the retention job purges them), emails the workspace's
 *    owners and audit-logs the eviction in their workspace. Those removals delete records through the EVICTED workspace's own connection.
 */
async function planEviction(tenant: TenantContext, domain: string, via: VerifiedVia): Promise<void> {
  tenant.evictions.delete(domain);
  const holder = await claimLookups(tenant.db).findLegacyHolder(domain, tenant.workspaceId);
  if (!holder) return;
  const root = await (await loadTenant(tenant.env, { workspaceId: holder.workspaceId })).scope.domains.getById(holder.domainId);
  tenant.evictions.set(domain, { holderWorkspaceId: holder.workspaceId, holderDomainId: holder.domainId, root, via });
}

/** The unproven holder's row the insert of `domain` must detach in its own transaction, if the proof just made evicts one. */
export const freeingFor = (tenant: TenantContext, domain: string): number | undefined => tenant.evictions.get(domain)?.holderDomainId;

async function finishEviction(tenant: TenantContext, domain: string): Promise<void> {
  const plan = tenant.evictions.get(domain);
  if (!plan) return;
  tenant.evictions.delete(domain);
  if (!(await tenant.scope.domains.getByName(domain))) return; // the insert did not happen: nobody was evicted
  const { holderWorkspaceId, holderDomainId, root, via } = plan;
  const lookups = claimLookups(tenant.db);
  const evicted = await loadTenant(tenant.env, { workspaceId: holderWorkspaceId });
  await forWorkspace(tenant.db, holderWorkspaceId).plan.subscription.markDirty().catch(() => undefined); // the holder owes one unit less: its plan quantity is repaired by the daily job

  // The domain and everything below it that this workspace had under it (its subdomains hang off it by parent_id):
  // deepest first, so no live child is left pointing at a detached parent.
  const tree: DomainRow[] = [];
  const walk = async (row: DomainRow) => {
    for (const child of await evicted.scope.domains.subdomains(row.id)) await walk(child);
    tree.push(row);
  };
  if (root) await walk(root);

  for (const row of tree) {
    let cleanup: 'removed' | 'none' | 'failed' = 'none';
    try {
      if (await removeHostedRecords(evicted, row)) cleanup = 'removed';
    } catch (e) {
      // The rightful owner must not stay blocked by a Cloudflare outage: carry on, and say so in the audit entry. The
      // hosted cron's diff flags any record left behind.
      cleanup = 'failed';
      console.warn(`[eviction] hosted cleanup failed for domain ${row.id}:`, e instanceof Error ? e.message : e);
    }
    await removeAuthRecord(evicted, row);
    if (row.id !== holderDomainId) await lookups.detach(row.id, Math.floor(Date.now() / 1000)); // the holder's own row went with the insert
    logAudit({ db: tenant.db, workspaceId: holderWorkspaceId }, {
      actor_type: 'system', action: 'domain.evicted', resource_type: 'domain', resource_id: String(row.id), resource_name: row.domain,
      meta: { reason: row.id === holderDomainId ? 'another workspace proved ownership' : `subdomain of ${domain}, evicted with it`, via, hosted_cleanup: cleanup, history_kept_days: EVICTED_KEEP_DAYS },
    });
  }
  const owners = (await evicted.scope.team.list()).filter(m => m.role === 'owner').map(m => m.email);
  await sendEvictionNotice(tenant.env, owners, domain, EVICTED_KEEP_DAYS);
}

/**
 * Decide what happens when this workspace asks to monitor `domain` (already validated and lowercased).
 * Creates the pending claim when proof is needed; never inserts into `domains` (the caller does, on 'verified').
 */
export async function admitDomain(tenant: TenantContext, domain: string): Promise<Admission> {
  if (getMode(tenant.env) !== 'saas') return { kind: 'verified', via: 'selfhost' };
  // Already ours and proven: the insert reports the duplicate. Ours but UNPROVEN (a proof that lapsed, a parent that left): not "existing", the proof
  // runs again below and, when it holds, restores the row in place (restoreInPlace), history and all. When it does not, a claim is opened for the TXT record.
  const own = await tenant.scope.domains.getByName(domain);
  if (own && own.verified_via !== 'legacy') return { kind: 'verified', via: 'existing' };

  await reassessZoneHolders(tenant, domain); // a holder whose zone moved away stops counting as the owner
  if (await claimLookups(tenant.db).ownedByOther(domain, tenant.workspaceId)) return { kind: 'taken' };
  if (await provenByParent(tenant, domain)) { await planEviction(tenant, domain, 'parent'); return { kind: 'verified', via: 'parent' }; }
  const zoneProof = await cloudflareProof(tenant, domain);
  if (zoneProof) { await planEviction(tenant, domain, 'cloudflare'); keepProof(tenant, domain, zoneProof); return { kind: 'verified', via: 'cloudflare' }; }

  const existing = await tenant.scope.claims.get(domain);
  if (existing) {
    if (existing.status === 'lost') await tenant.scope.claims.delete(existing.id); // the other workspace may have since let go: start again
    else return { kind: 'pending', claim: existing };
  }
  if ((await tenant.scope.claims.count()) >= MAX_PENDING_CLAIMS) return { kind: 'limit' };
  return { kind: 'pending', claim: await tenant.scope.claims.upsert(domain, newToken()) };
}

/**
 * Admit a name by its Cloudflare zone alone, never creating a claim: used where a zone the person connected is imported, and when pending
 * claims are re-examined after the allow-list changed. `unproven` leaves everything as it was.
 */
export async function admitByZone(tenant: TenantContext, domain: string, resolver?: Resolver): Promise<{ kind: 'verified'; via: 'cloudflare' } | { kind: 'taken' } | { kind: 'related' } | { kind: 'unproven' }> {
  if (getMode(tenant.env) === 'saas') {
    await reassessZoneHolders(tenant, domain, resolver);
    const lookups = claimLookups(tenant.db);
    if (await lookups.ownedByOther(domain, tenant.workspaceId)) return { kind: 'taken' };
    // a parent or a subdomain verified in another workspace: a zone cannot prove this name, only the TXT record can (a different thing from "Cloudflare does not answer")
    if (await lookups.relatedOwnedByOther(domain, tenant.workspaceId)) return { kind: 'related' };
  }
  const proof = await cloudflareProof(tenant, domain, resolver);
  if (!proof) return { kind: 'unproven' };
  await planEviction(tenant, domain, 'cloudflare');
  keepProof(tenant, domain, proof);
  return { kind: 'verified', via: 'cloudflare' };
}

/** Why a Verify did not prove the claim: the record is not visible (yet), or DNS could not be asked. Neither counts against anything. */
export type UnprovenCode = 'not_found_yet' | 'lookup_failed';

export type VerifyOutcome =
  | { kind: 'verified'; via: VerifiedVia }
  | { kind: 'taken' }
  | { kind: 'unproven'; reason: string; code?: UnprovenCode };

/** The "Verify" button: re-check every kind of proof for a pending claim. */
export async function verifyClaim(tenant: TenantContext, claim: DomainClaimRow, injected?: Resolver): Promise<VerifyOutcome> {
  const resolver = injected ?? resolverFor(tenant.env);
  await reassessZoneHolders(tenant, claim.domain, injected);
  if (await claimLookups(tenant.db).ownedByOther(claim.domain, tenant.workspaceId)) {
    await tenant.scope.claims.markLost(claim.id);
    return { kind: 'taken' };
  }
  if (await provenByParent(tenant, claim.domain)) { await planEviction(tenant, claim.domain, 'parent'); return { kind: 'verified', via: 'parent' }; }
  const zoneProof = await cloudflareProof(tenant, claim.domain, resolver);
  if (zoneProof) { await planEviction(tenant, claim.domain, 'cloudflare'); keepProof(tenant, claim.domain, zoneProof); return { kind: 'verified', via: 'cloudflare' }; }
  const txt = await provenByTxt(claim, resolver);
  await tenant.scope.claims.recordCheck(claim.id, txt.ok ? null : (txt.reason ?? null));
  if (txt.ok) await planEviction(tenant, claim.domain, 'txt');
  return txt.ok ? { kind: 'verified', via: 'txt' } : { kind: 'unproven', reason: txt.reason ?? 'not verified', ...(txt.code ? { code: txt.code } : {}) };
}

/**
 * After a successful insert into `domains`: settle our claim and tell everyone else's they lost. The claim row is kept, hidden, for a day
 * (the retention job purges it) so a repeat verify of it finds the domain: it is the only link from the claim id to the domain.
 */
export async function settleClaims(tenant: TenantContext, domain: string): Promise<void> {
  const added = await tenant.scope.domains.getByName(domain);
  if (added) await tenant.scope.claims.settle(domain, added.id);
  if (added) await recordProof(tenant, added.id, domain);
  await tenant.scope.removals.forget(domain);
  await claimLookups(tenant.db).markLost(domain, tenant.workspaceId);
  await finishEviction(tenant, domain); // the insert is in: now the holder it detached is cleaned up and told
}

// A Cloudflare proof is made by admitDomain / verifyClaim and committed by whichever caller inserts the row (the API, bulk import,
// the agent tools), always followed by settleClaims. The proof waits on the request's tenant until the insert takes it with the row.
function keepProof(tenant: TenantContext, domain: string, proof: CloudflareProof): void {
  tenant.cloudflareProofs.set(domain, proof);
}

/**
 * The zone proof the insert of `domain` must carry when it is verified through Cloudflare, written WITH the row (domains.cf_account_id, cf_zone_id,
 * verified_at, cf_zone_name, cf_name_servers). A zone proof without its name servers cannot be re-checked, so none is ever written: the proof is missing
 * or has no servers and the add fails (ProofIncompleteError, 409 `proof_incomplete`; the TXT record is the way). Release 2.0.0 could write such a row.
 *
 * The one place that decides a zone-proven row's connection: the connection whose zone made the proof (cf_connection_id), on an insert and on a
 * restore alike, for every path that admits a domain (claim Verify, Prove again, Add domain, bulk add, the wizard, the import, a claim settled
 * without a click). Apply via Cloudflare then finds it (TenantContext.cfFor). A TXT or parent proof links nothing.
 */
export function proofColumns(tenant: TenantContext, domain: string, via: VerifiedVia | string | undefined): ZoneProofColumns | undefined {
  if (via !== 'cloudflare') return undefined;
  const proof = tenant.cloudflareProofs.get(domain);
  if (!proof || proof.name_servers.length === 0) throw new ProofIncompleteError(domain);
  return { cf_account_id: proof.cf_account_id, cf_zone_id: proof.zone_id, verified_at: proof.at, cf_zone_name: proof.zone_name, cf_name_servers: proof.name_servers, cf_connection_id: proof.connection_id };
}

/**
 * An unproven row of this workspace was proven again (a lapsed zone proof through any current connection, a TXT record, a parent): the row is restored
 * IN PLACE: same id, its reports, checks and settings untouched, only how it is proven changes. Returns the row, or null when it was not unproven.
 */
export async function restoreInPlace(tenant: TenantContext, existing: DomainRow, via: VerifiedVia, actor?: { id?: string; email?: string }): Promise<DomainRow | null> {
  if (existing.verified_via !== 'legacy' || via === 'existing') return null;
  const proof = proofColumns(tenant, existing.domain, via);
  if (!(await tenant.scope.domains.restoreProof(existing.id, via, proof))) return null;
  await settleClaims(tenant, existing.domain);
  logAudit(tenant, { actor_id: actor?.id ?? null, actor_email: actor?.email ?? null, actor_type: 'user', action: 'domain.proof_restored', resource_type: 'domain', resource_id: String(existing.id), resource_name: existing.domain, meta: { via, history_kept: true } });
  return tenant.scope.domains.getById(existing.id);
}

/**
 * How a domain was proven through Cloudflare, in the audit log (action `domain.proof`, the detail in after_value): method, Cloudflare account, zone id
 * and name, connection, time. The columns on the domain row came with the insert (proofColumns). A record of what was true then: revoking the token later does not undo it.
 */
async function recordProof(tenant: TenantContext, domainId: number, domain: string): Promise<void> {
  const proof = tenant.cloudflareProofs.get(domain);
  if (!proof) return;
  tenant.cloudflareProofs.delete(domain);
  logAudit(tenant, { actor_type: 'system', action: 'domain.proof', resource_type: 'domain', resource_id: String(domainId), resource_name: domain, after_value: proof });
}

/** The workspace's claims for display, with any that another workspace has since won marked lost. */
export async function listClaims(tenant: TenantContext): Promise<ClaimView[]> {
  const out: ClaimView[] = [];
  for (const c of await tenant.scope.claims.list()) {
    const lost = c.status === 'lost' || (await claimLookups(tenant.db).ownedByOther(c.domain, tenant.workspaceId));
    out.push(claimView(lost ? { ...c, status: 'lost' } : c));
  }
  return out;
}

export { normalizeName };
