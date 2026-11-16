import { sql } from 'drizzle-orm';

/**
 * A conditional insert refused for lack of room. `domains_per_workspace`: the workspace already holds its maximum number of live domain rows
 * (the cap when no plan is enforced). `plan_units`: a new unit (a domain with all its subdomains) would not fit under the plan. `plan_subdomains`: the
 * organizational domain already has the most subdomain rows a free workspace keeps.
 */
export class PlanLimitError extends Error {
	constructor(readonly kind: 'domains_per_workspace' | 'plan_units' | 'plan_subdomains', readonly max: number) {
		super(`plan limit reached: ${kind} ${max}`);
		this.name = 'PlanLimitError';
	}
}

/**
 * Room under the hosted plan, checked inside the insert itself (one statement, so concurrent inserts cannot overfill it). A unit is
 * COALESCE(org_domain, domain). `max`: the units the workspace may hold after this insert. A row whose `org` is already a unit never needs room.
 * `subdomainMax`: rows one unit may hold (free workspaces). `rowMax`: rows in all (a safety bound).
 */
export interface UnitRoom { max: number; subdomainMax?: number; rowMax?: number }
export interface DomainRoom { maxDomains?: number; org?: string; units?: UnitRoom }

const LIVE_OF = (workspaceId: string) => sql`workspace_id = ${workspaceId} AND evicted_at IS NULL`;

/** The WHERE condition of a conditional domain insert, or null when nothing is capped. */
export function roomCondition(workspaceId: string, room: DomainRoom) {
	const parts = [] as ReturnType<typeof sql>[];
	if (room.maxDomains !== undefined) parts.push(sql`(SELECT COUNT(*) FROM domains WHERE ${LIVE_OF(workspaceId)}) < ${room.maxDomains}`);
	const u = room.units;
	if (u) {
		const org = room.org!;
		parts.push(sql`(EXISTS (SELECT 1 FROM domains WHERE ${LIVE_OF(workspaceId)} AND COALESCE(org_domain, domain) = ${org})
			OR (SELECT COUNT(DISTINCT COALESCE(org_domain, domain)) FROM domains WHERE ${LIVE_OF(workspaceId)}) < ${u.max})`);
		if (u.subdomainMax !== undefined) parts.push(sql`(SELECT COUNT(*) FROM domains WHERE ${LIVE_OF(workspaceId)} AND COALESCE(org_domain, domain) = ${org}) < ${u.subdomainMax}`);
		if (u.rowMax !== undefined) parts.push(sql`(SELECT COUNT(*) FROM domains WHERE ${LIVE_OF(workspaceId)}) < ${u.rowMax}`);
	}
	if (parts.length === 0) return null;
	return parts.reduce((a, b) => sql`${a} AND ${b}`);
}

/** Why a conditional insert wrote nothing (read after the fact, only to choose the answer). */
export async function whyRefused(db: { all: (q: any) => any }, workspaceId: string, room: DomainRoom): Promise<PlanLimitError> {
	const u = room.units;
	if (u?.subdomainMax !== undefined) {
		const row = (await db.all(sql`SELECT COUNT(*) AS n FROM domains WHERE ${LIVE_OF(workspaceId)} AND COALESCE(org_domain, domain) = ${room.org!}`))[0] as { n: number } | undefined;
		if ((row?.n ?? 0) >= u.subdomainMax) return new PlanLimitError('plan_subdomains', u.subdomainMax);
	}
	if (u) {
		const row = (await db.all(sql`SELECT COUNT(DISTINCT COALESCE(org_domain, domain)) AS n FROM domains WHERE ${LIVE_OF(workspaceId)}`))[0] as { n: number } | undefined;
		if ((row?.n ?? 0) >= u.max) return new PlanLimitError('plan_units', u.max);
	}
	return new PlanLimitError('domains_per_workspace', room.maxDomains ?? u?.rowMax ?? 0);
}

/**
 * What a Cloudflare zone proof stores on the domain row. `cf_connection_id`: the connection whose zone proved it, written with the row so that
 * Apply via Cloudflare and every later DNS change go through that connection (a domain verified through a zone and left unlinked could not be changed).
 */
export interface ZoneProofColumns { cf_account_id: string | null; cf_zone_id: string; verified_at: number; cf_zone_name: string; cf_name_servers: string[]; cf_connection_id?: string | null }

/** A row verified through a Cloudflare zone was about to be written without the zone and the name servers that proof rests on. Nothing is written. */
export class ProofIncompleteError extends Error {
	constructor(readonly domain: string) {
		super(`the Cloudflare proof for ${domain} has no zone or name servers recorded, so it cannot be kept`);
		this.name = 'ProofIncompleteError';
	}
}

/** The columns a zone proof writes (all absent for any other proof). */
export interface ProofValues { cf_account_id?: string | null; cf_zone_id?: string; verified_at?: number; cf_zone_name?: string; cf_name_servers?: string; cf_connection_id?: string }

/**
 * The one rule behind "a zone proof always has its name servers": a row whose `verified_via` is 'cloudflare' is written only together with the
 * zone, its name and a non-empty set of name servers (what the daily re-check and every rival claim compare public DNS with). Returns the
 * columns to write, JSON-encoded for the row. Release 2.0.0 could write such a row without them; nothing since can.
 */
export function proofValues(domain: string, verifiedVia: string | undefined, proof: ZoneProofColumns | undefined): ProofValues {
	if (verifiedVia !== 'cloudflare') return {};
	if (!proof || !proof.cf_zone_id || !proof.cf_zone_name || proof.cf_name_servers.length === 0) throw new ProofIncompleteError(domain);
	return {
		cf_account_id: proof.cf_account_id, cf_zone_id: proof.cf_zone_id, verified_at: proof.verified_at, cf_zone_name: proof.cf_zone_name, cf_name_servers: JSON.stringify([...proof.cf_name_servers].sort()),
		...(proof.cf_connection_id ? { cf_connection_id: proof.cf_connection_id } : {}),
	};
}

/**
 * The statements that free a name for an insert that follows in the SAME batch (one D1 transaction): the unproven ('legacy') holder row `holderId` of
 * another workspace is detached (renamed, hidden, its intake tokens dropped), because `domains.domain` is globally unique and the new row needs the name.
 * Written so the detach commits only with the insert: under a cap it is conditional on the winner's room, exactly like the insert, so a full plan
 * changes nothing; and an insert that fails (UNIQUE) rolls the whole batch back. The side effects of an eviction (hosted records, email, audit) are not
 * here: they follow once the insert is known to have committed.
 */
export function freeNameStatements(holderId: number, winnerWorkspaceId: string, roomRule: DomainRoom | number | undefined) {
	const rule = typeof roomRule === 'number' ? { maxDomains: roomRule } : roomRule;
	const cond = rule ? roomCondition(winnerWorkspaceId, rule) : null;
	const room = cond ? sql` AND ${cond}` : sql``;
	return [
		sql`UPDATE domains SET evicted_at = unixepoch(), evicted_name = domain, domain = 'evicted-' || id || '.invalid', is_default = 0, alerts_enabled = 0, cf_connection_id = NULL, dns_record_id = NULL
			WHERE id = ${holderId} AND NOT (workspace_id = ${winnerWorkspaceId}) AND (verified_via = 'legacy' OR (verified_via = 'cloudflare' AND cf_name_servers IS NULL)) AND evicted_at IS NULL${room}`,
		sql`DELETE FROM intake_tokens WHERE domain_id = ${holderId} AND workspace_id = (SELECT workspace_id FROM domains WHERE id = ${holderId} AND evicted_at IS NOT NULL)`,
	];
}

/** Rows changed by a D1 result, whichever driver shape it has. */
export const changesOf = (res: unknown): number => (res as any)?.meta?.changes ?? (res as any)?.changes ?? 0;
