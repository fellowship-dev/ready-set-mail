// Cloudflare first run: every active zone a connection can see becomes a verified domain of the workspace, without a click.
//
//  - The zone list is Cloudflare's, read through the stored connection. Nothing from the browser names a zone but an id, and an id is accepted
//    only when it is in that list.
//  - A zone is imported only when ownership is proven under the rule of src/domains/ownership.ts (cloudflareProof): active, a full setup, in the
//    connection's account, DNS edit for the token, public name servers are Cloudflare's, not a public suffix, no other workspace has the name or
//    something next to it. A zone that fails is skipped: no domain, no claim, and it leaves the allow-list again.
//  - Nothing is written to the importing user's DNS. Adding a domain reads public DNS once (its first check), as adding one by hand does. The one
//    exception is not theirs: when the proof evicts another workspace's UNPROVEN holder of the name, the removal path deletes that workspace's own hosted
//    records and report-authorisation record through its own connection (the existing eviction rule, src/domains/ownership.ts finishEviction).
//  - Hosted plan: the cap on domains per workspace is the one adding a domain already enforces (domainCap, enforced in domains.insert). When the
//    zones would not all fit, nothing is imported and the person chooses; asking for more than fits is refused.
//  - Idempotent: a domain the workspace already has is left alone; a name the person removed stays removed (removed_domains) unless they ask for it
//    by id; a second grant for the same account adds nothing twice.
import { isPublicSuffix } from '@ready-set-mail/dns-checks';
import type { TenantContext } from '../tenancy/context';
import { logAudit } from '../audit/log';
import { admitByZone, within } from '../domains/ownership';
import { DomainServiceError, assertDomainRoom, commitVerifiedDomain, domainCap, planLimitError, planRefusal } from '../domains/service';
import { PlanLimitError } from '@ready-set-mail/db';
import { insertRoom, loadPlanState, planEnforced, unitOf } from '../hosted/plan';
import { ConnectionInputError } from './service';
import { getMode } from '../tenancy/mode';

/** Domains added by one request: each one costs Cloudflare and DNS reads, and a request has a budget. The caller asks again while `more` > 0. */
export const IMPORT_PER_REQUEST = 10;

export interface ZoneChoice { id: string; name: string; account_id: string | null; account_name: string | null }
export interface ImportResult {
  imported: { domain: string; domain_id: number }[];
  /** Zones whose domain the workspace already had. */
  already: number;
  /** Zones not added, each with a plain reason. */
  skipped: { domain: string; reason: string }[];
  /** Zones left out because the person removed that domain earlier (they are suggestions). */
  removed: number;
  /** Zones still to import when this request hit its limit: ask again. */
  more: number;
  /** The Cloudflare accounts the added domains belong to, with the names Cloudflare gave them. */
  accounts: { id: string | null; name: string | null }[];
  /** Importing everything would exceed the plan: nothing was imported, these are the zones to choose from. */
  needs_selection?: { room: number; cap: number; zones: ZoneChoice[] };
  /**
   * Hosted plan (HOSTED_PLAN on): the zones that did not fit the free domain, offered once as "Also in your Cloudflare account". Adding any of
   * them is a paid domain: the owner confirms them in one step (POST /api/billing/domains/bulk), never here.
   */
  other_zones?: ZoneChoice[];
  /** Pending claims that were verified through the allow-list. */
  verified_claims: string[];
}

export const NOT_PROVEN = 'Cloudflare does not answer for this domain\'s DNS yet, or the connection cannot edit it, so ownership could not be confirmed through it. Add it with the DNS record instead.';

/** A zone refused because a parent or a subdomain of the name is verified by another workspace: said apart from "not proven", and without saying who. */
export const RELATED_VERIFIED = 'A parent or a subdomain of this name is already verified in another workspace, so a Cloudflare zone cannot prove it here. Add it with the DNS record instead.';

interface Caller { id?: string | null; email?: string | null }

/** Is there room for this domain without paying (advisory; the insert enforces)? Always true when no plan is enforced. */
async function fits(tenant: TenantContext, domain: string): Promise<boolean> {
  try { await assertDomainRoom(tenant, domain); return true; } catch (e) { if (e instanceof DomainServiceError) return false; throw e; }
}

const choice = (z: { id: string; name: string; cfAccountId?: string; cfAccountName?: string }): ZoneChoice => ({ id: z.id, name: z.name, account_id: z.cfAccountId ?? null, account_name: z.cfAccountName ?? null });

/** Settle pending claims the allow-list now proves (no click). Returns the names verified. */
export async function verifyPendingClaims(tenant: TenantContext, caller: Caller, ctx?: ExecutionContext): Promise<string[]> {
  if (getMode(tenant.env) !== 'saas') return [];
  const done: string[] = [];
  const cap = domainCap(tenant);
  let held = cap === undefined ? 0 : (await tenant.scope.domains.list()).length;
  for (const claim of await tenant.scope.claims.list()) {
    if (claim.status !== 'pending' || claim.settled_at !== null) continue;
    if (cap !== undefined && held >= cap) break; // a full plan: nothing is verified, and nobody's domain is taken, for a domain that cannot be added
    if (!(await tenant.scope.domains.getByName(claim.domain)) && !(await fits(tenant, claim.domain))) continue; // no room under the plan: the claim stays pending, nobody is billed or evicted
    const r = await admitByZone(tenant, claim.domain);
    if (r.kind !== 'verified') continue;
    try {
      await commitVerifiedDomain(tenant, claim.domain, r.via, caller.email ?? undefined, ctx, caller.id ?? undefined); // linked to the proving connection (proofColumns)
      done.push(claim.domain);
      held++;
    } catch (e) {
      if (!(e instanceof DomainServiceError)) throw e; // a full plan leaves the claim as it was
    }
  }
  return done;
}

/**
 * Self-host only: link an imported domain to the connection it came from, unless it already has a working link. On the hosted service the zone proof
 * links the row as it is written (proofColumns in src/domains/ownership.ts), the same for every path.
 */
async function linkToConnection(tenant: TenantContext, domainId: number, domain: string, caller: Caller, target: string): Promise<void> {
  const row = await tenant.scope.domains.getById(domainId);
  if (!row || row.cf_connection_id === target) return;
  if (row.cf_connection_id && (await tenant.scope.connections.get(row.cf_connection_id))?.status === 'active') return;
  if (!(await tenant.scope.domains.setConnection(domainId, target))) return;
  logAudit(tenant, { actor_id: caller.id ?? null, actor_email: caller.email ?? null, actor_type: 'user', action: 'domain.cf_connection', resource_type: 'cf_connection', resource_id: String(domainId), resource_name: domain, before_value: { connection_id: row.cf_connection_id }, after_value: { connection_id: target } });
}

export async function importZones(tenant: TenantContext, connectionId: string, input: { zoneIds?: string[]; preferredDomain?: string | null }, caller: Caller, ctx?: ExecutionContext): Promise<ImportResult> {
  const svc = tenant.connections;
  const conn = await svc.get(connectionId);
  if (!conn) throw new ConnectionInputError('connection not found', 404);
  if (conn.status !== 'active') throw new ConnectionInputError(`this connection is ${conn.status}: reconnect it first`, 409, `cf_connection_${conn.status}`);

  const saas = getMode(tenant.env) === 'saas';
  const visible = (await svc.availableZones(connectionId)).filter(z => !isPublicSuffix(z.name));
  const byId = new Map(visible.map(z => [z.id, z]));
  const have = new Map((await tenant.scope.domains.list()).map(d => [d.domain.toLowerCase(), d]));
  const removedNames = await tenant.scope.removals.names();

  const explicit = input.zoneIds !== undefined;
  const unknown = (input.zoneIds ?? []).filter(id => !byId.has(id));
  if (unknown.length) throw new ConnectionInputError('not a zone this Cloudflare connection can see');
  const wanted = explicit ? [...new Set(input.zoneIds)].map(id => byId.get(id)!) : visible;
  const result: ImportResult = { imported: [], already: 0, skipped: [], removed: 0, more: 0, accounts: [], verified_claims: [] };

  const fresh: typeof visible = [];
  for (const z of wanted) {
    if (have.has(z.name)) result.already++;
    else if (!explicit && removedNames.has(z.name)) result.removed++;
    else fresh.push(z);
  }

  // The hosted plan (HOSTED_PLAN on): room is units. The domain the person typed (else the zone of their sign-up email's domain) is imported without a
  // question; the other zones are returned as `other_zones` (a paid domain each, confirmed elsewhere). Neither matches: one choice, as before.
  if (saas && planEnforced(tenant.env)) {
    const state = await loadPlanState(tenant.env, tenant.db, tenant.workspaceId);
    const room = insertRoom(tenant.env, state, 'example.com');
    const free = room.units ? Math.max(0, room.units.max - state.units) : Math.max(0, (room.maxDomains ?? Infinity) - have.size);
    const held = new Set(state.rows.map(r => r.org));
    const needed = new Set(fresh.filter(z => !held.has(unitOf(z.name))).map(z => unitOf(z.name)));
    if (needed.size > free) {
      // The zones that did not fit stay verifiable through the connection (never added by themselves): the owner's paid confirm for one of them proves it on the spot.
      await svc.setAllowedZones(connectionId, [...new Set([...(conn.zones ?? []).map(z => z.id), ...visible.map(z => z.id)])]);
      if (explicit) throw await planRefusal(tenant, new PlanLimitError('plan_units', room.units?.max ?? free), fresh[0]?.name ?? '');
      const wanted1 = [input.preferredDomain, caller.email?.split('@')[1]].map(d => (d ? unitOf(d) : null));
      const pick = free > 0 ? wanted1.map(u => (u ? fresh.find(z => unitOf(z.name) === u) : undefined)).find(Boolean) : undefined;
      if (!pick && free > 0) return { ...result, imported: [], needs_selection: { room: free, cap: room.units?.max ?? free, zones: fresh.map(choice) } };
      const others = fresh.filter(z => z !== pick && !(pick && unitOf(z.name) === unitOf(pick.name)));
      const sub = pick ? await importZones(tenant, connectionId, { zoneIds: [pick.id] }, caller, ctx) : { ...result };
      return { ...sub, other_zones: others.map(choice) };
    }
  }

  // The plan: hosted workspaces hold a limited number of domains. If they would not all fit, the person chooses.
  const cap = saas && !planEnforced(tenant.env) ? domainCap(tenant) : undefined;
  if (cap !== undefined && fresh.length > Math.max(0, cap - have.size)) {
    const room = Math.max(0, cap - have.size);
    if (explicit) throw planLimitError(tenant, cap);
    return { ...result, imported: [], needs_selection: { room, cap, zones: fresh.map(choice) } };
  }

  // The allow-list: what it held, the zones of domains the workspace already has, and the zones to add. Zones that turn out unproven leave it again.
  const keep = new Set<string>((conn.zones ?? []).map(z => z.id).filter(id => byId.has(id)));
  for (const z of visible) if (have.has(z.name)) keep.add(z.id);
  const batch = fresh.sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name)).slice(0, IMPORT_PER_REQUEST);
  result.more = fresh.length - batch.length;
  await svc.setAllowedZones(connectionId, [...new Set([...keep, ...batch.map(z => z.id)])]);

  const failed = new Set<string>();
  for (const z of batch) {
    const admitted = saas ? await admitByZone(tenant, z.name) : { kind: 'verified' as const, via: 'selfhost' as const };
    if (admitted.kind === 'taken') { failed.add(z.id); result.skipped.push({ domain: z.name, reason: 'Another workspace has already verified this domain.' }); continue; }
    if (admitted.kind === 'related') { failed.add(z.id); result.skipped.push({ domain: z.name, reason: RELATED_VERIFIED }); continue; }
    if (admitted.kind === 'unproven') { failed.add(z.id); result.skipped.push({ domain: z.name, reason: NOT_PROVEN }); continue; }
    try {
      const added = await commitVerifiedDomain(tenant, z.name, admitted.via, caller.email ?? undefined, ctx, caller.id ?? undefined);
      if (!saas) await linkToConnection(tenant, added.domain.id, z.name, caller, connectionId);
      result.imported.push({ domain: z.name, domain_id: added.domain.id });
      result.accounts.push({ id: z.cfAccountId ?? null, name: z.cfAccountName ?? null });
    } catch (e) {
      if (!(e instanceof DomainServiceError)) throw e;
      failed.add(z.id);
      result.skipped.push({ domain: z.name, reason: e.message });
    }
  }
  if (failed.size) await svc.setAllowedZones(connectionId, [...new Set([...keep, ...batch.filter(z => !failed.has(z.id)).map(z => z.id)])]);

  result.verified_claims = await verifyPendingClaims(tenant, caller, ctx);
  const seen = new Set<string>();
  result.accounts = result.accounts.filter(a => !seen.has(String(a.id)) && !!seen.add(String(a.id)));
  logAudit(tenant, {
    actor_id: caller.id ?? null, actor_email: caller.email ?? null, actor_type: 'user',
    action: 'cf_connection.import', resource_type: 'cf_connection', resource_id: connectionId, resource_name: conn.label,
    after_value: { imported: result.imported.map(i => i.domain), skipped: result.skipped.map(s => s.domain), already: result.already, removed: result.removed },
  }, ctx);
  return result;
}

/**
 * Zones of the workspace's working connections that are not domains of it yet (removed ones included): what Add domain offers. A zone on the
 * connection's saved allow-list whose name is a pending claim is not offered as new: that claim is verified on the next overview load
 * (autoVerifyClaims). A claimed zone that is not on the list is offered: Add imports, verifies and links it.
 */
export async function suggestedZones(tenant: TenantContext): Promise<{ connection_id: string; account_id: string | null; account_name: string | null; zone_id: string; name: string; removed: boolean }[]> {
  const have = new Set((await tenant.scope.domains.list()).map(d => d.domain.toLowerCase()));
  const claimed = new Set((await tenant.scope.claims.list()).filter(c => c.status === 'pending').map(c => c.domain.toLowerCase()));
  const removed = await tenant.scope.removals.names();
  const out: Awaited<ReturnType<typeof suggestedZones>> = [];
  const seen = new Set<string>();
  for (const c of await tenant.scope.connections.list()) {
    if (c.status !== 'active') continue;
    let zones: Awaited<ReturnType<typeof tenant.connections.availableZones>>;
    try { zones = await tenant.connections.availableZones(c.id); } catch { continue; } // an unreadable connection suggests nothing
    for (const z of zones) {
      if (isPublicSuffix(z.name) || have.has(z.name) || seen.has(z.name) || (z.allowed && claimed.has(z.name))) continue;
      seen.add(z.name);
      out.push({ connection_id: c.id, account_id: z.cfAccountId ?? null, account_name: z.cfAccountName ?? null, zone_id: z.id, name: z.name, removed: removed.has(z.name) });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * At most one automatic live check per pending claim per this interval. A check that fails is nearly always a delegation still moving (name servers
 * being changed at the registrar), which takes minutes to hours: an hour bounds the cost, while the claim's Verify button stays for an immediate retry.
 */
export const CLAIM_AUTOCHECK_SECONDS = 3600;
/** At most this many claims are checked by one request (the ones whose last automatic check is oldest, never checked first). */
export const CLAIM_AUTOCHECKS_PER_REQUEST = 5;
/** settings key `<prefix><claim id>:` holds the unix time until which that claim is not checked automatically again (the trailing ':' keeps id 1 apart from 12). */
export const CLAIM_AUTOCHECK_PREFIX = 'cf_claim_autocheck:';
const autocheckKey = (claimId: number) => `${CLAIM_AUTOCHECK_PREFIX}${claimId}:`;

/**
 * Pending claims inside a zone on an active connection's SAVED allow-list (cloudflare_connection_zones), verified and linked to the proving connection
 * when the domain list loads (GET /api/domains), with no click. Only owners and admins trigger it (the caller checks): members are read-only.
 *  - The saved list only says a live check is worth making; it is never the proof. admitByZone is, unchanged (the live server-side check: active,
 *    full, in the connection's account, DNS edit, public name servers equal the zone's; the conflict, unproven-row, public-suffix and label-boundary rules).
 *  - Nothing here writes the allow-list. A claim whose zone is visible but not on the list stays pending (Add domain imports it with a click).
 *  - Cost: at most CLAIM_AUTOCHECKS_PER_REQUEST claims per request, each at most once per CLAIM_AUTOCHECK_SECONDS (the next allowed time is stored
 *    before the check, through settings.claim, so two loads at once cannot both check one claim). Per claim checked: one Cloudflare zone read per
 *    matching allowed zone (normally one) and one public NS lookup; the rival re-check any proof makes (holders of the name in other workspaces, on
 *    their own cooldown); and, when it verifies, the first DNS read adding a domain makes. A load with no matching claim costs no outgoing request.
 * Returns the names verified.
 */
export async function autoVerifyClaims(tenant: TenantContext, caller: Caller, ctx?: ExecutionContext, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string[]> {
  if (getMode(tenant.env) !== 'saas') return [];
  const claims = (await tenant.scope.claims.list()).filter(c => c.status === 'pending' && c.settled_at === null);
  if (claims.length === 0) return [];
  const conns = (await tenant.scope.connections.list()).filter(c => c.status === 'active');
  if (conns.length === 0) return [];
  const saved: string[] = [];
  for (const c of conns) for (const z of await tenant.scope.connections.zones(c.id)) if (!isPublicSuffix(z.zone_name)) saved.push(z.zone_name.toLowerCase());
  const candidates = claims.filter(c => saved.some(z => within(c.domain.toLowerCase(), z)));
  if (candidates.length === 0) return [];

  // Due: never checked, or its interval is over. Oldest check first, at most CLAIM_AUTOCHECKS_PER_REQUEST.
  const next = await tenant.scope.settings.getMany(candidates.map(c => autocheckKey(c.id)));
  const due = candidates
    .map(c => ({ claim: c, until: Number(next.get(autocheckKey(c.id)) ?? 0) }))
    .filter(x => x.until <= nowSeconds)
    .sort((a, b) => a.until - b.until || a.claim.id - b.claim.id)
    .slice(0, CLAIM_AUTOCHECKS_PER_REQUEST);

  const cap = domainCap(tenant);
  let held = cap === undefined ? 0 : (await tenant.scope.domains.list()).length;
  const done: string[] = [];
  for (const { claim } of due) {
    if (cap !== undefined && held >= cap) break; // a full plan: nothing is checked, nothing verified, nobody evicted
    if (!(await tenant.scope.domains.getByName(claim.domain)) && !(await fits(tenant, claim.domain))) continue;
    const key = autocheckKey(claim.id);
    await tenant.scope.settings.deleteExpired(key, nowSeconds);
    if (!(await tenant.scope.settings.claim(key, String(nowSeconds + CLAIM_AUTOCHECK_SECONDS)))) continue; // another request took it
    const r = await admitByZone(tenant, claim.domain);
    if (r.kind !== 'verified') continue;
    try {
      await commitVerifiedDomain(tenant, claim.domain, r.via, caller.email ?? undefined, ctx, caller.id ?? undefined); // linked to the proving connection (proofColumns)
      done.push(claim.domain);
      held++;
    } catch (e) {
      if (!(e instanceof DomainServiceError)) throw e; // a full plan leaves the claim as it was
    }
  }
  if (done.length) tenant.invalidate();
  return done;
}
