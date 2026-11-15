/**
 * Public, dated free-check reports (GLOBAL_TABLES: not tenant data). A row is written once and never updated, except that its
 * dedupe_key is cleared when the de-duplication window has passed. Deleted only with the delete token, or by the operator.
 * public_report_usage holds the running counters behind the storage budgets (one row, id 1).
 */
import { and, desc, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
import { getDb, type DbLike } from '../client';
import { publicReportUsage, publicReports } from '../schema';

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

const USAGE_ROW = 1;

export interface PublicReportUsage {
	day: string;
	day_reports: number;
	day_bytes: number;
	total_reports: number;
	total_bytes: number;
}

/** The limits one reservation must stay within. */
export interface PublicReportBudget {
	/** UTC day, YYYY-MM-DD. */
	day: string;
	dailyReports: number;
	dailyBytes: number;
	totalBytes: number;
}

const usageColumns = {
	day: publicReportUsage.day,
	day_reports: publicReportUsage.day_reports,
	day_bytes: publicReportUsage.day_bytes,
	total_reports: publicReportUsage.total_reports,
	total_bytes: publicReportUsage.total_bytes,
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
		/**
		 * Delete when the token hash matches, and give the report's bytes back to the counters. The bytes deleted, or null when
		 * nothing was deleted (an unknown id and a wrong token look the same).
		 */
		deleteWithToken: async (id: string, tokenHash: string): Promise<number | null> => {
			const rows = await db
				.delete(publicReports)
				.where(and(eq(publicReports.id, id), eq(publicReports.delete_token_hash, tokenHash)))
				.returning({ bytes: publicReports.result_bytes })
				.all();
			if (rows.length === 0) return null;
			const bytes = rows[0]!.bytes;
			await db
				.update(publicReportUsage)
				.set({ total_bytes: sql`MAX(0, ${publicReportUsage.total_bytes} - ${bytes})`, total_reports: sql`MAX(0, ${publicReportUsage.total_reports} - 1)` })
				.where(eq(publicReportUsage.id, USAGE_ROW))
				.run();
			return bytes;
		},
		/** Forget dedupe keys older than the window: they only exist to answer a repeat within it. */
		clearDedupeBefore: (beforeSeconds: number) =>
			db
				.update(publicReports)
				.set({ dedupe_key: null })
				.where(and(isNotNull(publicReports.dedupe_key), lt(publicReports.created_at, beforeSeconds)))
				.run(),

		/** The counters as they stand (a read, never a write). Null before the first report. */
		usage: (): Promise<PublicReportUsage | null> =>
			db.select(usageColumns).from(publicReportUsage).where(eq(publicReportUsage.id, USAGE_ROW)).get().then((r) => r ?? null),
		/**
		 * Reserve room for one report of `bytes`: one conditional upsert, so concurrent requests cannot all pass a stale read.
		 * Counts the report and its bytes for the day and in total only when every budget still holds; the counters after it,
		 * or null when refused (nothing counted). The caller keeps `bytes` within each budget, so the first row always fits.
		 */
		reserve: async (bytes: number, b: PublicReportBudget): Promise<PublicReportUsage | null> => {
			const u = publicReportUsage;
			const sameDay = sql`${u.day} = ${b.day}`;
			const rows = await db
				.insert(u)
				.values({ id: USAGE_ROW, day: b.day, day_reports: 1, day_bytes: bytes, total_reports: 1, total_bytes: bytes })
				.onConflictDoUpdate({
					target: u.id,
					set: {
						day: b.day,
						day_reports: sql`CASE WHEN ${sameDay} THEN ${u.day_reports} + 1 ELSE 1 END`,
						day_bytes: sql`CASE WHEN ${sameDay} THEN ${u.day_bytes} + ${bytes} ELSE ${bytes} END`,
						total_reports: sql`${u.total_reports} + 1`,
						total_bytes: sql`${u.total_bytes} + ${bytes}`,
					},
					setWhere: sql`${u.total_bytes} + ${bytes} <= ${b.totalBytes} AND (${u.day} <> ${b.day} OR (${u.day_reports} < ${b.dailyReports} AND ${u.day_bytes} + ${bytes} <= ${b.dailyBytes}))`,
				})
				.returning(usageColumns)
				.all();
			return rows[0] ?? null;
		},
		/** Give a reservation back (the report could not be stored after all). The day's count stays: it counts attempts. */
		release: (bytes: number) =>
			db
				.update(publicReportUsage)
				.set({ total_bytes: sql`MAX(0, ${publicReportUsage.total_bytes} - ${bytes})`, total_reports: sql`MAX(0, ${publicReportUsage.total_reports} - 1)` })
				.where(eq(publicReportUsage.id, USAGE_ROW))
				.run(),
		/** Recount the totals from the stored reports (the daily job): repairs drift and counts reports the operator deleted by hand. */
		recount: () =>
			db
				.update(publicReportUsage)
				.set({
					total_bytes: sql`(SELECT COALESCE(SUM(${publicReports.result_bytes}), 0) FROM ${publicReports})`,
					total_reports: sql`(SELECT COUNT(*) FROM ${publicReports})`,
				})
				.where(eq(publicReportUsage.id, USAGE_ROW))
				.returning(usageColumns)
				.all()
				.then((rows) => rows[0] ?? null),
	};
}
