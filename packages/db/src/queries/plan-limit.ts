import { sql } from 'drizzle-orm';

/** A conditional insert refused because the workspace already holds its maximum number of live domains. */
export class PlanLimitError extends Error {
	constructor(readonly kind: 'domains_per_workspace', readonly max: number) {
		super(`plan limit reached: ${kind} ${max}`);
		this.name = 'PlanLimitError';
	}
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
export function freeNameStatements(holderId: number, winnerWorkspaceId: string, max: number | undefined) {
	const room = max === undefined ? sql`` : sql` AND (SELECT COUNT(*) FROM domains WHERE workspace_id = ${winnerWorkspaceId} AND evicted_at IS NULL) < ${max}`;
	return [
		sql`UPDATE domains SET evicted_at = unixepoch(), evicted_name = domain, domain = 'evicted-' || id || '.invalid', is_default = 0, alerts_enabled = 0, cf_connection_id = NULL, dns_record_id = NULL
			WHERE id = ${holderId} AND NOT (workspace_id = ${winnerWorkspaceId}) AND (verified_via = 'legacy' OR (verified_via = 'cloudflare' AND cf_name_servers IS NULL)) AND evicted_at IS NULL${room}`,
		sql`DELETE FROM intake_tokens WHERE domain_id = ${holderId} AND workspace_id = (SELECT workspace_id FROM domains WHERE id = ${holderId} AND evicted_at IS NOT NULL)`,
	];
}

/** Rows changed by a D1 result, whichever driver shape it has. */
export const changesOf = (res: unknown): number => (res as any)?.meta?.changes ?? (res as any)?.changes ?? 0;
