import { sql } from 'drizzle-orm';

/** A conditional insert refused because the workspace already holds its maximum number of live domains. */
export class PlanLimitError extends Error {
	constructor(readonly kind: 'domains_per_workspace', readonly max: number) {
		super(`plan limit reached: ${kind} ${max}`);
		this.name = 'PlanLimitError';
	}
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
			WHERE id = ${holderId} AND NOT (workspace_id = ${winnerWorkspaceId}) AND verified_via = 'legacy' AND evicted_at IS NULL${room}`,
		sql`DELETE FROM intake_tokens WHERE domain_id = ${holderId} AND workspace_id = (SELECT workspace_id FROM domains WHERE id = ${holderId} AND evicted_at IS NOT NULL)`,
	];
}

/** Rows changed by a D1 result, whichever driver shape it has. */
export const changesOf = (res: unknown): number => (res as any)?.meta?.changes ?? (res as any)?.changes ?? 0;
