// Cloudflare first run: every active zone a connection can see becomes a verified domain of the workspace, without a click.
//
//  - The zone list is Cloudflare's, read through the stored connection. Nothing from the browser names a zone but an id, and an id is accepted
//    only when it is in that list.
//  - A zone is imported only when ownership is proven under the rule of src/domains/ownership.ts (cloudflareProof): active, a full setup, in the
//    connection's account, DNS edit for the token, public name servers are Cloudflare's, not a public suffix, no other workspace has the name or
//    something next to it. A zone that fails is skipped: no domain, no claim, and it leaves the allow-list again.
//  - Nothing is written to DNS. Adding a domain reads public DNS once (its first check), as adding one by hand does.
//  - Hosted plan: the cap on domains per workspace is the one adding a domain already enforces (domainCap, enforced in domains.insert). When the
//    zones would not all fit, nothing is imported and the person chooses; asking for more than fits is refused.
//  - Idempotent: a domain the workspace already has is left alone; a name the person removed stays removed (removed_domains) unless they ask for it
//    by id; a second grant for the same account adds nothing twice.
import { isPublicSuffix } from '@ready-set-mail/dns-checks';
import type { TenantContext } from '../tenancy/context';
import { logAudit } from '../audit/log';
import { admitByZone } from '../domains/ownership';
import { DomainServiceError, commitVerifiedDomain, domainCap, planLimitError } from '../domains/service';
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
  /** Pending claims that were verified through the allow-list. */
  verified_claims: string[];
}

export const NOT_PROVEN = 'Cloudflare does not answer for this domain\'s DNS yet, or the connection cannot edit it, so ownership could not be confirmed through it. Add it with the DNS record instead.';

interface Caller { id?: string | null; email?: string | null }

const choice = (z: { id: string; name: string; cfAccountId?: string; cfAccountName?: string }): ZoneChoice => ({ id: z.id, name: z.name, account_id: z.cfAccountId ?? null, account_name: z.cfAccountName ?? null });

/** Settle pending claims the allow-list now proves (no click). Returns the names verified. */
export async function verifyPendingClaims(tenant: TenantContext, caller: Caller, ctx?: ExecutionContext): Promise<string[]> {
  if (getMode(tenant.env) !== 'saas') return [];
  const done: string[] = [];
  for (const claim of await tenant.scope.claims.list()) {
    if (claim.status !== 'pending' || claim.settled_at !== null) continue;
    const r = await admitByZone(tenant, claim.domain);
    if (r.kind !== 'verified') continue;
    try {
      const added = await commitVerifiedDomain(tenant, claim.domain, r.via, caller.email ?? undefined, ctx, caller.id ?? undefined);
      await linkToConnection(tenant, added.domain.id, claim.domain, caller);
      done.push(claim.domain);
    } catch (e) {
      if (!(e instanceof DomainServiceError)) throw e; // a full plan leaves the claim as it was
    }
  }
  return done;
}

/** Link a domain to the connection whose zone proved it (the first one that does), unless it already has a working link. */
async function linkToConnection(tenant: TenantContext, domainId: number, domain: string, caller: Caller, connectionId?: string): Promise<void> {
  const row = await tenant.scope.domains.getById(domainId);
  if (!row) return;
  const target = connectionId ?? (await auditedConnectionFor(tenant, domainId));
  if (!target || row.cf_connection_id === target) return;
  if (row.cf_connection_id && (await tenant.scope.connections.get(row.cf_connection_id))?.status === 'active') return;
  if (!(await tenant.scope.domains.setConnection(domainId, target))) return;
  logAudit(tenant, { actor_id: caller.id ?? null, actor_email: caller.email ?? null, actor_type: 'user', action: 'domain.cf_connection', resource_type: 'cf_connection', resource_id: String(domainId), resource_name: domain, before_value: { connection_id: row.cf_connection_id }, after_value: { connection_id: target } });
}

/** The connection a just-made proof came from: the proof is on the domain row's connection when the import made it, else the first active connection that allows the zone. */
async function auditedConnectionFor(tenant: TenantContext, domainId: number): Promise<string | null> {
  const row = await tenant.scope.domains.getById(domainId);
  if (!row?.cf_zone_id) return null;
  for (const c of await tenant.scope.connections.list()) {
    if (c.status !== 'active') continue;
    if ((await tenant.scope.connections.zones(c.id)).some(z => z.zone_id === row.cf_zone_id)) return c.id;
  }
  return null;
}

export async function importZones(tenant: TenantContext, connectionId: string, input: { zoneIds?: string[] }, caller: Caller, ctx?: ExecutionContext): Promise<ImportResult> {
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

  // The plan: hosted workspaces hold a limited number of domains. If they would not all fit, the person chooses.
  const cap = saas ? domainCap(tenant) : undefined;
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
    if (admitted.kind === 'unproven') { failed.add(z.id); result.skipped.push({ domain: z.name, reason: NOT_PROVEN }); continue; }
    try {
      const added = await commitVerifiedDomain(tenant, z.name, admitted.via, caller.email ?? undefined, ctx, caller.id ?? undefined);
      await linkToConnection(tenant, added.domain.id, z.name, caller, connectionId);
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

/** Zones of the workspace's working connections that are not domains of it yet (removed ones included): what Add domain offers. */
export async function suggestedZones(tenant: TenantContext): Promise<{ connection_id: string; account_id: string | null; account_name: string | null; zone_id: string; name: string; removed: boolean }[]> {
  const have = new Set((await tenant.scope.domains.list()).map(d => d.domain.toLowerCase()));
  const removed = await tenant.scope.removals.names();
  const out: Awaited<ReturnType<typeof suggestedZones>> = [];
  const seen = new Set<string>();
  for (const c of await tenant.scope.connections.list()) {
    if (c.status !== 'active') continue;
    let zones: Awaited<ReturnType<typeof tenant.connections.availableZones>>;
    try { zones = await tenant.connections.availableZones(c.id); } catch { continue; } // an unreadable connection suggests nothing
    for (const z of zones) {
      if (isPublicSuffix(z.name) || have.has(z.name) || seen.has(z.name)) continue;
      seen.add(z.name);
      out.push({ connection_id: c.id, account_id: z.cfAccountId ?? null, account_name: z.cfAccountName ?? null, zone_id: z.id, name: z.name, removed: removed.has(z.name) });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
