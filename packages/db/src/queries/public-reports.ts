/**
 * Public, dated free-check reports (GLOBAL_TABLES: not tenant data). A row is written once and never updated, except that its
 * dedupe_key is cleared when the de-duplication window has passed. Deleted only with the delete token, or by the operator.
 */
import { and, desc, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
import { getDb, type DbLike } from '../client';
import { publicReports } from '../schema';

export type NewPublicReport = typeof publicReports.$inferInsert;

/** What a reader gets: never the delete-token hash or the dedupe key. */
const readable = {
	id: publicReports.id,
	domain: publicReports.domain,
	created_at: publicReports.created_at,
	schema_version: publicReports.schema_version,
	source: publicReports.source,
	result_json: publicReports.result_json,
};

export function publicReportQueries(dbLike: DbLike) {
	const db = getDb(dbLike);
	return {
		insert: (r: NewPublicReport) => db.insert(publicReports).values(r).run(),
		byId: (id: string) => db.select(readable).from(publicReports).where(eq(publicReports.id, id)).get().then((r) => r ?? null),
		/** The newest report with this dedupe key created at or after `sinceSeconds`, if any. */
		recentFor: (dedupeKey: string, sinceSeconds: number) =>
			db
				.select(readable)
				.from(publicReports)
				.where(and(eq(publicReports.dedupe_key, dedupeKey), gte(publicReports.created_at, sinceSeconds)))
				.orderBy(desc(publicReports.created_at))
				.limit(1)
				.get()
				.then((r) => r ?? null),
		/** Reports created at or after `sinceSeconds` (the daily cap). */
		createdSince: (sinceSeconds: number) =>
			db
				.select({ n: sql<number>`COUNT(*)` })
				.from(publicReports)
				.where(gte(publicReports.created_at, sinceSeconds))
				.get()
				.then((r) => Number(r?.n ?? 0)),
		/** Delete when the token hash matches. True when a row was deleted; an unknown id and a wrong token look the same. */
		deleteWithToken: (id: string, tokenHash: string) =>
			db
				.delete(publicReports)
				.where(and(eq(publicReports.id, id), eq(publicReports.delete_token_hash, tokenHash)))
				.returning({ id: publicReports.id })
				.all()
				.then((rows) => rows.length > 0),
		/** Forget dedupe keys older than the window: they only exist to answer a repeat within it. */
		clearDedupeBefore: (beforeSeconds: number) =>
			db
				.update(publicReports)
				.set({ dedupe_key: null })
				.where(and(isNotNull(publicReports.dedupe_key), lt(publicReports.created_at, beforeSeconds)))
				.run(),
	};
}
