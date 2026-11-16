import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { domains, mtaStsConfig, spfFlattenConfig } from '../schema';

export type MtaStsMode = 'testing' | 'enforce';

export type SpfConfigRow = typeof spfFlattenConfig.$inferSelect;

/** What a state change writes. `undefined` leaves a column alone; `null` clears it. */
export interface SpfPatch {
	flattened_record?: string | null;
	previous_record?: string | null;
	cf_record_id?: string | null;
	ip_count?: number | null;
	lookup_count?: number | null;
	last_flattened_at?: number | null;
	last_refreshed_at?: number | null;
	problem_kind?: string | null;
	problem_since?: number | null;
	last_error?: string | null;
	last_error_at?: number | null;
}

const changed = (res: unknown): boolean => ((res as { meta?: { changes?: number } }).meta?.changes ?? 0) > 0;

/**
 * The rows behind SPF flattening. Every write that follows a Cloudflare write is a compare-and-set on `revision` (src/spf/refresh.ts):
 * a run claims the row first, writes DNS, then finishes only if nobody changed the row meanwhile.
 */
export function spfFlattenQueries(db: Db, workspaceId: string) {
	const mine = eq(spfFlattenConfig.workspace_id, workspaceId);
	const forDomain = (id: number) => and(mine, eq(spfFlattenConfig.domain_id, id));
	const touch = sql`unixepoch()` as any;

	return {
		get(domainId: number): Promise<SpfConfigRow | null> {
			return db.select().from(spfFlattenConfig).where(forDomain(domainId)).get().then((r) => r ?? null);
		},

		allEnabled() {
			return db.select().from(spfFlattenConfig).where(and(mine, eq(spfFlattenConfig.enabled, 1))).all();
		},

		/** Whether this workspace has any row (turned on, or turning off): the dashboard keeps the tool visible for it. */
		async any(): Promise<boolean> {
			return !!(await db.select({ d: spfFlattenConfig.domain_id }).from(spfFlattenConfig).where(mine).limit(1).get());
		},

		/**
		 * Enabled rows not looked at since `before` (unix seconds), never-looked-at first, then the longest ago. `before` null: all of them
		 * (a person pressed "Try again").
		 */
		due(before: number | null, limit: number) {
			return db
				.select()
				.from(spfFlattenConfig)
				.where(and(mine, eq(spfFlattenConfig.enabled, 1), before === null ? undefined : sql`(${spfFlattenConfig.last_attempt_at} IS NULL OR ${spfFlattenConfig.last_attempt_at} < ${before})`))
				.orderBy(sql`${spfFlattenConfig.last_attempt_at} IS NOT NULL`, spfFlattenConfig.last_attempt_at, spfFlattenConfig.domain_id)
				.limit(limit)
				.all();
		},

		/** Turning on, step one: the row exists (enabled, nothing written yet). False when the domain already has a row: nobody else may write. */
		async begin(c: { domain_id: number; canonical_record: string; lookup_count: number | null; cf_record_id: string | null }): Promise<boolean> {
			const res = await db
				.insert(spfFlattenConfig)
				.values({ workspace_id: workspaceId, domain_id: c.domain_id, enabled: 1, cf_record_id: c.cf_record_id, canonical_record: c.canonical_record, lookup_count: c.lookup_count })
				.onConflictDoNothing()
				.run();
			return changed(res);
		},

		/** Turning on, step two, after the record was written. */
		async activate(domainId: number, flattened_record: string, ip_count: number, at: number): Promise<boolean> {
			const res = await db
				.update(spfFlattenConfig)
				.set({ flattened_record, ip_count, last_flattened_at: at, last_refreshed_at: at, last_attempt_at: at, revision: 1, updated_at: touch })
				.where(and(forDomain(domainId), eq(spfFlattenConfig.enabled, 1), eq(spfFlattenConfig.revision, 0), isNull(spfFlattenConfig.flattened_record)))
				.run();
			return changed(res);
		},

		/** Turning on failed before anything was written: no half-enabled row stays behind. */
		async abandon(domainId: number): Promise<void> {
			await db.delete(spfFlattenConfig).where(and(forDomain(domainId), eq(spfFlattenConfig.revision, 0), isNull(spfFlattenConfig.flattened_record))).run();
		},

		/** A run takes the row. It must hold the revision it read; false: another run or a change got there first. Returns the new revision. */
		async claim(domainId: number, revision: number, at: number, leaseSeconds: number): Promise<number | null> {
			const res = await db
				.update(spfFlattenConfig)
				.set({ revision: revision + 1, lease_until: at + leaseSeconds, last_attempt_at: at, updated_at: touch })
				.where(and(forDomain(domainId), eq(spfFlattenConfig.enabled, 1), eq(spfFlattenConfig.revision, revision), sql`(${spfFlattenConfig.lease_until} IS NULL OR ${spfFlattenConfig.lease_until} < ${at})`))
				.run();
			return changed(res) ? revision + 1 : null;
		},

		/** Is the claim still ours (enabled, same revision)? Read just before the DNS write. */
		async holds(domainId: number, revision: number): Promise<boolean> {
			const r = await db.select({ r: spfFlattenConfig.revision }).from(spfFlattenConfig).where(and(forDomain(domainId), eq(spfFlattenConfig.enabled, 1), eq(spfFlattenConfig.revision, revision))).get();
			return !!r;
		},

		/** A run ends: write the outcome and let go of the row, only if the claim still holds. */
		async finish(domainId: number, claimed: number, patch: SpfPatch): Promise<boolean> {
			const res = await db
				.update(spfFlattenConfig)
				.set({ ...patch, revision: claimed + 1, lease_until: null, updated_at: touch })
				.where(and(forDomain(domainId), eq(spfFlattenConfig.enabled, 1), eq(spfFlattenConfig.revision, claimed)))
				.run();
			return changed(res);
		},

		/** Turning off, step one: stops every refresh at once, whatever run is in flight. False: not enabled. */
		async deactivate(domainId: number): Promise<boolean> {
			const res = await db
				.update(spfFlattenConfig)
				.set({ enabled: 0, revision: sql`${spfFlattenConfig.revision} + 1`, lease_until: null, updated_at: touch })
				.where(and(forDomain(domainId), eq(spfFlattenConfig.enabled, 1)))
				.run();
			return changed(res);
		},

		/** A row that is not on (turning off could not put the original back, or a review is open): a note without touching the revision rules. */
		setProblem(domainId: number, p: { kind: string | null; since: number | null; error: string | null; at: number | null }) {
			return db.update(spfFlattenConfig).set({ problem_kind: p.kind, problem_since: p.since, last_error: p.error, last_error_at: p.at, updated_at: touch }).where(forDomain(domainId)).run();
		},

		delete(domainId: number) {
			return db.delete(spfFlattenConfig).where(forDomain(domainId)).run();
		},
	};
}

export function mtaStsQueries(db: Db, workspaceId: string) {
	const mine = eq(mtaStsConfig.workspace_id, workspaceId);
	const forDomain = (id: number) => and(mine, eq(mtaStsConfig.domain_id, id));
	const touch = sql`unixepoch()` as any;

	return {
		get(domainId: number) {
			return db.select().from(mtaStsConfig).where(forDomain(domainId)).get().then((r) => r ?? null);
		},

		/** Enabled config for a hostname — used to serve /.well-known/mta-sts.txt. */
		getEnabledByDomain(domain: string) {
			return db
				.select({ m: mtaStsConfig })
				.from(mtaStsConfig)
				.innerJoin(domains, and(eq(domains.id, mtaStsConfig.domain_id), eq(domains.workspace_id, workspaceId), isNull(domains.evicted_at)))
				.where(and(mine, eq(domains.domain, domain), eq(mtaStsConfig.enabled, 1)))
				.get()
				.then((r) => r?.m ?? null);
		},

		allEnabled() {
			return db.select().from(mtaStsConfig).where(and(mine, eq(mtaStsConfig.enabled, 1))).all();
		},

		insert(c: { domain_id: number; mode: MtaStsMode; mx_hosts: string; policy_id: string; mta_sts_record_id: string | null; tls_rpt_record_id: string | null; cname_record_id: string | null }) {
			return db.insert(mtaStsConfig).values({ ...c, workspace_id: workspaceId }).run();
		},

		updateMode(domainId: number, mode: MtaStsMode, policy_id: string) {
			return db.update(mtaStsConfig).set({ mode, policy_id, last_error: null, updated_at: touch }).where(forDomain(domainId)).run();
		},

		updateMxHosts(domainId: number, mx_hosts: string, policy_id: string) {
			return db.update(mtaStsConfig).set({ mx_hosts, policy_id, updated_at: touch }).where(forDomain(domainId)).run();
		},

		updateError(domainId: number, error: string) {
			return db.update(mtaStsConfig).set({ last_error: error, updated_at: touch }).where(forDomain(domainId)).run();
		},

		delete(domainId: number) {
			return db.delete(mtaStsConfig).where(forDomain(domainId)).run();
		},
	};
}
