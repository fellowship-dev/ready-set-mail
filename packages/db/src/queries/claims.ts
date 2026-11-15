/**
 * Domain ownership claims. A claim is a workspace saying "this domain is ours" before proving it; `domains` only ever
 * holds verified domains, so several workspaces can have a pending claim on the same name while at most one can own it.
 */
import { and, asc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { getDb, type Db, type DbLike } from '../client';
import { domainClaims, domains, intakeTokens } from '../schema';

export type DomainClaimRow = typeof domainClaims.$inferSelect;

export function claimQueries(db: Db, workspaceId: string) {
	const mine = eq(domainClaims.workspace_id, workspaceId);
	/** Open claims only: a settled claim (it became a domain) is kept for a repeat verify and is invisible to everything else. */
	const open = and(mine, isNull(domainClaims.settled_at));
	return {
		list() {
			return db.select().from(domainClaims).where(open).orderBy(asc(domainClaims.id)).all();
		},
		count(): Promise<number> {
			return db.select({ n: sql<number>`count(*)` }).from(domainClaims).where(open).get().then((r) => r?.n ?? 0);
		},
		get(domain: string) {
			return db.select().from(domainClaims).where(and(open, eq(domainClaims.domain, domain))).get().then((r) => r ?? null);
		},
		/** By id, settled or not: the verify route answers a repeat verify of a settled claim. Check `settled_at`. */
		getById(id: number) {
			return db.select().from(domainClaims).where(and(mine, eq(domainClaims.id, id))).get().then((r) => r ?? null);
		},
		/** Create the claim, or return the existing one (the token never changes, so published TXT instructions stay valid). */
		async upsert(domain: string, token: string): Promise<DomainClaimRow> {
			// The domain was removed since a claim of it settled: that row would block the (workspace, domain) key and is no use now.
			await db.delete(domainClaims).where(and(mine, eq(domainClaims.domain, domain), isNotNull(domainClaims.settled_at))).run();
			await db.insert(domainClaims).values({ workspace_id: workspaceId, domain, token }).onConflictDoNothing().run();
			return (await db.select().from(domainClaims).where(and(mine, eq(domainClaims.domain, domain))).get())!;
		},
		markLost(id: number) {
			return db.update(domainClaims).set({ status: 'lost' }).where(and(open, eq(domainClaims.id, id))).run();
		},
		/** The claim became this domain: keep the row, hidden, so a repeat verify finds the domain. Idempotent: the first settle's time stands. */
		settle(domain: string, domainId: number) {
			return db.update(domainClaims).set({ settled_at: sql`coalesce(${domainClaims.settled_at}, unixepoch())` as any, settled_domain_id: domainId })
				.where(and(mine, eq(domainClaims.domain, domain))).run();
		},
		recordCheck(id: number, error: string | null) {
			return db.update(domainClaims).set({ last_checked_at: sql`unixepoch()` as any, last_error: error }).where(and(mine, eq(domainClaims.id, id))).run();
		},
		delete(id: number) {
			return db.delete(domainClaims).where(and(mine, eq(domainClaims.id, id))).run();
		},
	};
}

/** D1 allows 100 bound parameters per statement: id lists go in parts. */
const chunks = <T,>(xs: T[], n = 50): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

export interface ZoneHolder { id: number; workspace_id: string; domain: string; cf_zone_id: string | null; cf_zone_name: string | null; cf_name_servers: string | null; cf_account_id: string | null; cf_connection_id: string | null; proof_checked_at: number | null; proof_suspected_at: number | null }

/**
 * A row that proves nothing against another workspace's proof: unproven (`legacy`), or verified through Cloudflare without recorded name servers
 * (what the claim Verify button of release 2.0.0 stored: nothing to re-check it against, so a proof of the name by someone else wins, see src/domains/proof-recheck.ts).
 */
export const unprovenRow = sql`(${domains.verified_via} = 'legacy' OR (${domains.verified_via} = 'cloudflare' AND ${domains.cf_name_servers} IS NULL))`;
const provenRow = sql`NOT ${unprovenRow}`;
/** The same rule for a row already in hand (provenByParent): keep it in step with `unprovenRow`. */
export const isUnprovenRow = (r: { verified_via: string; cf_name_servers: string | null }): boolean => r.verified_via === 'legacy' || (r.verified_via === 'cloudflare' && r.cf_name_servers === null);
const zoneHolderColumns = { id: domains.id, workspace_id: domains.workspace_id, domain: domains.domain, cf_zone_id: domains.cf_zone_id, cf_zone_name: domains.cf_zone_name, cf_name_servers: domains.cf_name_servers, cf_account_id: domains.cf_account_id, cf_connection_id: domains.cf_connection_id, proof_checked_at: domains.proof_checked_at, proof_suspected_at: domains.proof_suspected_at };

/** The claim queries that deliberately span workspaces: "who verified this name first". They return no tenant data beyond that. */
export function claimLookups(dbLike: DbLike) {
	const db = getDb(dbLike);
	return {
		/** Is this name already a verified domain of some workspace other than `workspaceId`? Unproven rows (`unprovenRow`) never count. */
		ownedByOther(domain: string, workspaceId: string): Promise<boolean> {
			return db.select({ id: domains.id }).from(domains /* workspace-scope-exempt: uniqueness of a verified domain is global */)
				.where(and(eq(domains.domain, domain), ne(domains.workspace_id, workspaceId), provenRow)).get().then((r) => !!r);
		},
		/**
		 * Does another workspace hold a verified domain that is a parent or a child of `domain` (not the name itself)? A Cloudflare
		 * zone alone must not prove a name next to someone else's verified one. Plain string comparison: no LIKE, `_` is a wildcard there.
		 */
		relatedOwnedByOther(domain: string, workspaceId: string): Promise<boolean> {
			return db.select({ id: domains.id }).from(domains /* workspace-scope-exempt: ownership of related names is global */)
				.where(and(
					ne(domains.workspace_id, workspaceId), provenRow, isNull(domains.evicted_at),
					sql`(substr(${domain}, -(length(${domains.domain}) + 1)) = '.' || ${domains.domain} OR substr(${domains.domain}, -(length(${domain}) + 1)) = '.' || ${domain})`,
				)).get().then((r) => !!r);
		},
		/**
		 * The Cloudflare-zone-verified rows of other workspaces that this name collides with: the name itself, a parent of it or a child of it.
		 * What a proof of the name makes them show: that their zone is still theirs (src/domains/ownership.ts, reassessHolders).
		 */
		zoneVerifiedNear(domain: string, workspaceId: string): Promise<ZoneHolder[]> {
			return db.select(zoneHolderColumns).from(domains /* workspace-scope-exempt: other workspaces' zone proofs on a name someone else is proving */)
				.where(and(
					ne(domains.workspace_id, workspaceId), eq(domains.verified_via, 'cloudflare'), isNull(domains.evicted_at),
					sql`(${domains.domain} = ${domain} OR substr(${domain}, -(length(${domains.domain}) + 1)) = '.' || ${domains.domain} OR substr(${domains.domain}, -(length(${domain}) + 1)) = '.' || ${domain})`,
				)).all();
		},
		/**
		 * Zone-verified live rows due for the daily re-check, in two queues so rows that never answer cannot delay the ones that do:
		 *  - answered: got a real answer (proof_answered_at) within `answeredWithinSeconds` of now; at most `limit - reserved` of them, oldest LOOKED-AT first;
		 *  - the rest (never answered, or silent for longer than that, or new): the remaining slots, at least `reserved` of them whenever the first queue
		 *    is full, never-attempted first, then oldest looked-at. A queue that cannot use its slots lends them to the other.
		 * Both are ordered by when the job last LOOKED at a row, not by when it got a verdict, so a row whose lookups never answer rotates to the back like any other.
		 */
		async zoneVerifiedDue(limit: number, nowSeconds: number, opts: { reserved: number; answeredWithinSeconds: number }): Promise<ZoneHolder[]> {
			const live = and(eq(domains.verified_via, 'cloudflare'), isNull(domains.evicted_at));
			const answered = sql`${domains.proof_answered_at} >= ${nowSeconds - opts.answeredWithinSeconds}`;
			const first = await db.select(zoneHolderColumns).from(domains /* workspace-scope-exempt: the daily job runs across workspaces */)
				.where(and(live, answered)).orderBy(sql`${domains.proof_attempted_at} IS NOT NULL`, asc(domains.proof_attempted_at), asc(domains.id)).limit(Math.max(0, limit - opts.reserved)).all();
			const rest = await db.select(zoneHolderColumns).from(domains /* workspace-scope-exempt: the daily job runs across workspaces */)
				.where(and(live, sql`NOT COALESCE(${answered}, 0)`)).orderBy(sql`${domains.proof_attempted_at} IS NOT NULL`, asc(domains.proof_attempted_at), asc(domains.id)).limit(limit - first.length).all();
			const spare = limit - first.length - rest.length; // the reserved slots found nobody to use them: more answering rows
			const more = spare > 0 ? await db.select(zoneHolderColumns).from(domains /* workspace-scope-exempt: the daily job runs across workspaces */)
				.where(and(live, answered)).orderBy(sql`${domains.proof_attempted_at} IS NOT NULL`, asc(domains.proof_attempted_at), asc(domains.id)).limit(spare).offset(first.length).all() : [];
			return [...first, ...more, ...rest];
		},
		/** The job got a real answer for these rows (public DNS said match or differs, or their servers were recorded). */
		async markProofAnswered(ids: number[], nowSeconds: number): Promise<void> {
			for (const part of chunks(ids)) await db.update(domains /* workspace-scope-exempt: same rows, by id */).set({ proof_answered_at: nowSeconds }).where(inArray(domains.id, part)).run();
		},
		/** The job looked at these rows (whatever came of it): they go to the back of the queue. */
		async markProofAttempted(ids: number[], nowSeconds: number): Promise<void> {
			for (const part of chunks(ids)) await db.update(domains /* workspace-scope-exempt: same rows, by id */).set({ proof_attempted_at: nowSeconds }).where(inArray(domains.id, part)).run();
		},
		/** The delegation was seen to match: remember when, and forget any suspicion. */
		async markProofChecked(ids: number[], nowSeconds: number): Promise<void> {
			for (const part of chunks(ids)) await db.update(domains /* workspace-scope-exempt: same rows, by id */).set({ proof_checked_at: nowSeconds, proof_suspected_at: null }).where(and(inArray(domains.id, part), eq(domains.verified_via, 'cloudflare'))).run();
		},
		/** A read says the proof does not hold: remember the first time (never moved by later reads). True when this read is the first. */
		async markProofSuspected(id: number, nowSeconds: number): Promise<boolean> {
			const r = await db.update(domains /* workspace-scope-exempt: same row, by id */).set({ proof_suspected_at: nowSeconds }).where(and(eq(domains.id, id), eq(domains.verified_via, 'cloudflare'), isNull(domains.proof_suspected_at))).run();
			return (r.meta.changes ?? 0) > 0;
		},
		/** For a proof made before servers were kept: the zone, its servers and the account, once Cloudflare and public DNS agree on them. */
		recordNameServers(id: number, p: { zoneId: string; accountId: string | null; zoneName: string; servers: string[] }, nowSeconds: number): Promise<void> {
			return db.update(domains /* workspace-scope-exempt: same row, by id */).set({ cf_zone_id: p.zoneId, cf_account_id: p.accountId, cf_zone_name: p.zoneName, cf_name_servers: JSON.stringify([...p.servers].sort()), proof_checked_at: nowSeconds, proof_suspected_at: null })
				.where(and(eq(domains.id, id), eq(domains.verified_via, 'cloudflare'), isNull(domains.cf_name_servers))).run().then(() => undefined);
		},
		/**
		 * The proof lapsed: the row becomes unproven ('legacy', exactly what an unproven row is everywhere: intake stops accepting its reports, any proof of
		 * the name by another workspace evicts it) and the time is kept. True only for the call that changed it, so the workspace is told once.
		 */
		async markProofLost(id: number, nowSeconds: number): Promise<boolean> {
			const r = await db.update(domains /* workspace-scope-exempt: same row, by id */).set({ verified_via: 'legacy', proof_lost_at: nowSeconds })
				.where(and(eq(domains.id, id), eq(domains.verified_via, 'cloudflare'), isNull(domains.evicted_at))).run();
			return (r.meta.changes ?? 0) > 0;
		},
		/**
		 * The unproven holder (`unprovenRow`) of `domain` in another workspace, if any: what a proven claim evicts.
		 */
		findLegacyHolder(domain: string, winnerWorkspaceId: string): Promise<{ domainId: number; workspaceId: string } | null> {
			return db.select({ id: domains.id, workspace_id: domains.workspace_id }).from(domains /* workspace-scope-exempt: finding the unproven holder of a name someone else just proved */)
				.where(and(eq(domains.domain, domain), ne(domains.workspace_id, winnerWorkspaceId), unprovenRow, isNull(domains.evicted_at))).get()
				.then((r) => (r ? { domainId: r.id, workspaceId: r.workspace_id } : null));
		},
		/**
		 * Detach (not delete) an evicted domain: the name is freed, the row is hidden, and its reports stay for export until
		 * the retention job purges it. Its intake token stops working and its alerts stop.
		 */
		async detach(domainId: number, nowSeconds: number): Promise<void> {
			await db.update(domains /* workspace-scope-exempt: same row, by id */)
				.set({ evicted_at: nowSeconds, evicted_name: sql`${domains.domain}`, domain: sql`'evicted-' || ${domains.id} || '.invalid'`, is_default: 0, alerts_enabled: 0, cf_connection_id: null, dns_record_id: null })
				.where(eq(domains.id, domainId)).run();
			await db.delete(intakeTokens /* workspace-scope-exempt: same domain, by id */).where(eq(intakeTokens.domain_id, domainId)).run();
		},
		/** A workspace verified `domain`: every other workspace's pending claim on it is now lost. */
		markLost(domain: string, winnerWorkspaceId: string) {
			return db.update(domainClaims /* workspace-scope-exempt: other workspaces' claims on a name someone else just verified */).set({ status: 'lost' })
				.where(and(eq(domainClaims.domain, domain), ne(domainClaims.workspace_id, winnerWorkspaceId), isNull(domainClaims.settled_at))).run();
		},
	};
}
