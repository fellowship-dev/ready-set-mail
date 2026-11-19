import { and, eq, isNull } from 'drizzle-orm';
import { batchStatements, unwrapDriverError, type Db } from '../client';
import { domains, settings } from '../schema';
import { sql } from 'drizzle-orm';
import { nearestListedAncestorId } from './parent';
import { PlanLimitError, changesOf, freeNameStatements, proofValues, slotsUsed, type ZoneProofColumns } from './plan-limit';

/**
 * The wizard's first step as one batch: the domain row (when new) and the derived settings (base domain,
 * reports domain, from address, a forgotten zone) are written together or not at all. A hostname or a
 * reports domain another workspace already owns makes the whole batch fail with a UNIQUE error
 * (domains.domain, idx_settings_reports_domain), leaving nothing half-written.
 *
 * `maxDomains` (hosted plan cap): the domain INSERT is conditional on the workspace's live-domain count, inside the same
 * batch (one D1 transaction; writes are serialised, so the cap holds exactly: margin 0). It goes first, and every settings
 * upsert is conditional on the domain existing, so a refused insert leaves the settings untouched too; PlanLimitError is thrown.
 */
export function baseDomainQueries(db: Db, workspaceId: string) {
	const upsert = (key: string, value: string) =>
		db
			.insert(settings)
			.values({ workspace_id: workspaceId, key, value })
			.onConflictDoUpdate({
				target: [settings.workspace_id, settings.key],
				set: { value: sql`excluded.value`, updated_at: sql`unixepoch()` as any },
			});

	return {
		/** Returns the new domain's id, or null when the workspace already had the domain. */
		async apply(d: { domain: string; rua_address: string; verified_via?: string; proof?: ZoneProofColumns; settings: Record<string, string> }, opts: { maxDomains?: number; freeing?: number } = {}): Promise<number | null> {
			const existing = await db.select({ id: domains.id }).from(domains).where(and(eq(domains.workspace_id, workspaceId), isNull(domains.evicted_at), eq(domains.domain, d.domain))).get();
			const pv = existing ? {} as ReturnType<typeof proofValues> : proofValues(d.domain, d.verified_via, d.proof); // a zone proof without its servers is refused before anything is written
			const parentId = existing ? null : await nearestListedAncestorId(db, workspaceId, d.domain);
			const max = opts.maxDomains;
			const capped = !existing && max !== undefined;
			const domainInsert = capped
				? sql`INSERT INTO domains (workspace_id, domain, rua_address, parent_id, verified_via, cf_account_id, cf_zone_id, verified_at, cf_zone_name, cf_name_servers, cf_connection_id)
					SELECT ${workspaceId}, ${d.domain}, ${d.rua_address}, ${parentId}, ${d.verified_via ?? 'legacy'}, ${pv.cf_account_id ?? null}, ${pv.cf_zone_id ?? null}, ${pv.verified_at ?? null}, ${pv.cf_zone_name ?? null}, ${pv.cf_name_servers ?? null}, ${pv.cf_connection_id ?? null}
					WHERE ${slotsUsed(workspaceId, d.domain)} < ${max}`
				: db.insert(domains).values({ workspace_id: workspaceId, domain: d.domain, rua_address: d.rua_address, parent_id: parentId, verified_via: d.verified_via, ...pv });
			// Under a cap the settings follow the domain: written only when the workspace has the (live) domain row.
			const upsertIfDomain = (key: string, value: string) =>
				sql`INSERT OR REPLACE INTO settings (workspace_id, key, value) SELECT ${workspaceId}, ${key}, ${value}
					WHERE EXISTS (SELECT 1 FROM domains WHERE workspace_id = ${workspaceId} AND domain = ${d.domain} AND evicted_at IS NULL)`;
			const free = !existing && opts.freeing !== undefined ? freeNameStatements(opts.freeing, workspaceId, max, d.domain) : []; // an unproven holder of the name, detached in the same transaction
			const stmts: any[] = [
				...free,
				...(existing ? [] : [domainInsert]),
				...Object.entries(d.settings).map(([k, v]) => (capped ? upsertIfDomain(k, v) : upsert(k, v))),
			];
			try {
				const res = capped || free.length ? await batchStatements(db, stmts) : await db.batch(stmts as [any, ...any[]]);
				if (capped && changesOf(res[free.length]) === 0) throw new PlanLimitError('domains_per_workspace', max!);
				return existing ? null : ((res[free.length] as any).meta?.last_row_id as number);
			} catch (e) {
				if (e instanceof PlanLimitError) throw e;
				throw unwrapDriverError(e); // callers match on 'UNIQUE'
			}
		},
	};
}
