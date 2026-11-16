/**
 * Lifecycle emails (0017): who may be written to, what was already sent, what the reports of a week say.
 *
 * Every statement is bound to the workspace. The report reads apply the workspace's counting filter (counting.ts), so the numbers in an email
 * are the numbers on the dashboard. `wk` is the zero-based week of a report's `date_begin` counted from the `from` the caller passed
 * (weeks are 7 x 86400 seconds, so a caller that passes a Monday 00:00 UTC gets ISO weeks).
 */
import { sql } from 'drizzle-orm';
import type { Db } from '../client';
import { counted, type CountingMode } from './counting';
import { changesOf } from './plan-limit';
import type { EmailPreferenceKind, LifecycleSendState, LiveSeenBy, MembershipRole } from '../schema';

export const WEEK_SECONDS = 7 * 86400;

export interface RecipientRow { user_id: string; email: string; name: string; role: MembershipRole; email_verified: number }
export interface MilestoneRow { domain_id: number; records_live_at: number | null; live_seen_by: LiveSeenBy | null }
export interface PreferenceRow { user_id: string; kind: EmailPreferenceKind; enabled: number }
export interface SendRow { user_id: string; domain_id: number; kind: string; period: string; state: LifecycleSendState; created_at: number }
export interface SendKey { userId: string; domainId: number; kind: string; period: string }
export interface WeekTotalRow { domain_id: number; wk: number; total: number; passed: number; reports: number }
export interface WeekSourceRow {
	domain_id: number;
	domain: string;
	wk: number;
	source_ip: string;
	header_from: string | null;
	spf_domain: string | null;
	spf_result: string | null;
	dkim_domain: string | null;
	dkim_result: string | null;
	messages: number;
	reverse_dns: string | null;
	base_domain: string | null;
	org: string | null;
}
export interface ReportRow {
	id: number;
	domain_id: number;
	org_name: string;
	reporter_known_as: string | null;
	date_begin: number;
	date_end: number;
	total_count: number;
	pass_count: number;
	fail_count: number;
	created_at: number;
}

export function lifecycleEmailQueries(db: Db, workspaceId: string, counting: CountingMode) {
	const A = sql`${workspaceId}`;
	const C = (alias: string) => counted(alias, counting);
	const sources = (where: ReturnType<typeof sql>, from: number) => db.all<WeekSourceRow>(sql`
		SELECT d.id AS domain_id, d.domain, CAST((ar.date_begin - ${from}) / ${WEEK_SECONDS} AS INTEGER) AS wk,
		       rr.source_ip, rr.header_from, rr.spf_domain, rr.spf_result, rr.dkim_domain, rr.dkim_result, SUM(rr.count) AS messages,
		       MAX(rr.reverse_dns) AS reverse_dns, MAX(rr.base_domain) AS base_domain, MAX(rr.org) AS org
		FROM report_records rr
		JOIN aggregate_reports ar ON ar.id = rr.report_id
		JOIN domains d ON d.id = ar.domain_id AND d.workspace_id = ${A}
		WHERE ar.workspace_id = ${A} AND rr.workspace_id = ${A} AND ${C('ar')} AND ${where}
		GROUP BY d.id, wk, rr.source_ip, rr.header_from, rr.spf_domain, rr.spf_result, rr.dkim_domain, rr.dkim_result
	`);

	return {
		/** Who may get mail: every member, with what the sender needs to decide (verified address, role). */
		recipients(): Promise<RecipientRow[]> {
			return db.all<RecipientRow>(sql`
				SELECT u.id AS user_id, u.email, u.name, m.role, u.email_verified
				FROM memberships m JOIN users u ON u.id = m.user_id
				WHERE m.workspace_id = ${A}
				ORDER BY m.created_at, u.created_at
			`);
		},

		/** domain id -> the person who added it (the audit log's `domain.add`), when it recorded one. */
		domainAdders(): Promise<Array<{ domain_id: number; actor_id: string }>> {
			return db.all(sql`
				SELECT CAST(resource_id AS INTEGER) AS domain_id, actor_id FROM audit_log
				WHERE workspace_id = ${A} AND action = 'domain.add' AND actor_type = 'user' AND actor_id IS NOT NULL AND resource_id IS NOT NULL
				ORDER BY id
			`);
		},

		milestones: {
			/** The first sight of a domain's records live: one INSERT OR IGNORE. True when this call wrote the row (a domain of another workspace writes nothing). */
			async recordLive(domainId: number, seenBy: LiveSeenBy, at: number): Promise<boolean> {
				const res = await db.run(sql`
					INSERT OR IGNORE INTO domain_milestones (domain_id, workspace_id, records_live_at, live_seen_by)
					SELECT d.id, ${A}, ${at}, ${seenBy} FROM domains d WHERE d.id = ${domainId} AND d.workspace_id = ${A}
				`);
				return changesOf(res) > 0;
			},
			list(): Promise<MilestoneRow[]> {
				return db.all<MilestoneRow>(sql`SELECT domain_id, records_live_at, live_seen_by FROM domain_milestones WHERE workspace_id = ${A}`);
			},
		},

		preferences: {
			all(): Promise<PreferenceRow[]> {
				return db.all<PreferenceRow>(sql`SELECT user_id, kind, enabled FROM email_preferences WHERE workspace_id = ${A}`);
			},
			async set(userId: string, kind: EmailPreferenceKind, enabled: boolean, at: number): Promise<void> {
				await db.run(sql`
					INSERT INTO email_preferences (user_id, workspace_id, kind, enabled, updated_at) VALUES (${userId}, ${A}, ${kind}, ${enabled ? 1 : 0}, ${at})
					ON CONFLICT (user_id, workspace_id, kind) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at
				`);
			},
			async removeFor(userId: string): Promise<void> {
				await db.run(sql`DELETE FROM email_preferences WHERE workspace_id = ${A} AND user_id = ${userId}`);
			},
		},

		sends: {
			all(): Promise<SendRow[]> {
				return db.all<SendRow>(sql`SELECT user_id, domain_id, kind, period, state, created_at FROM lifecycle_sends WHERE workspace_id = ${A}`);
			},
			/** Claim one email: true only for the caller whose insert wrote the row. */
			async claim(k: SendKey, at: number): Promise<boolean> {
				const res = await db.run(sql`
					INSERT OR IGNORE INTO lifecycle_sends (workspace_id, user_id, domain_id, kind, period, state, created_at)
					VALUES (${A}, ${k.userId}, ${k.domainId}, ${k.kind}, ${k.period}, 'claimed', ${at})
				`);
				return changesOf(res) > 0;
			},
			async settle(k: SendKey, state: Exclude<LifecycleSendState, 'claimed'>): Promise<void> {
				await db.run(sql`UPDATE lifecycle_sends SET state = ${state} WHERE workspace_id = ${A} AND user_id = ${k.userId} AND domain_id = ${k.domainId} AND kind = ${k.kind} AND period = ${k.period}`);
			},
			/** Give the claim back (nothing was sent, and a later run may try again). */
			async release(k: SendKey): Promise<void> {
				await db.run(sql`DELETE FROM lifecycle_sends WHERE workspace_id = ${A} AND user_id = ${k.userId} AND domain_id = ${k.domainId} AND kind = ${k.kind} AND period = ${k.period}`);
			},
		},

		reports: {
			/** Counted reports per domain and week in [from, to): their own totals (DMARC pass and fail as the reporter evaluated them). */
			weekTotals(from: number, to: number): Promise<WeekTotalRow[]> {
				return db.all<WeekTotalRow>(sql`
					SELECT ar.domain_id, CAST((ar.date_begin - ${from}) / ${WEEK_SECONDS} AS INTEGER) AS wk,
					       SUM(ar.total_count) AS total, SUM(ar.pass_count) AS passed, COUNT(*) AS reports
					FROM aggregate_reports ar JOIN domains d ON d.id = ar.domain_id AND d.workspace_id = ${A}
					WHERE ar.workspace_id = ${A} AND ${C('ar')} AND ar.date_begin >= ${from} AND ar.date_begin < ${to}
					GROUP BY ar.domain_id, wk
				`);
			},
			/** Stored reports in [from, to) that are left out of the numbers, per domain (none in `all` mode). */
			async uncountedWeek(from: number, to: number): Promise<Array<{ domain_id: number; reports: number }>> {
				if (counting === 'all') return [];
				return db.all(sql`
					SELECT ar.domain_id, COUNT(*) AS reports FROM aggregate_reports ar JOIN domains d ON d.id = ar.domain_id AND d.workspace_id = ${A}
					WHERE ar.workspace_id = ${A} AND NOT (${C('ar')}) AND ar.date_begin >= ${from} AND ar.date_begin < ${to}
					GROUP BY ar.domain_id
				`);
			},
			/** Whether a domain has reports stored (`created_at`) since a time, that count and that do not. Two existence checks, never a count: a busy domain costs the same. */
			async storedSince(domainId: number, since: number): Promise<{ counted: boolean; uncounted: boolean }> {
				const rows = await db.all<{ counted: number; uncounted: number }>(sql`
					SELECT
						EXISTS (SELECT 1 FROM aggregate_reports ar WHERE ar.workspace_id = ${A} AND ar.domain_id = ${domainId} AND ar.created_at >= ${since} AND ${C('ar')}) AS counted,
						EXISTS (SELECT 1 FROM aggregate_reports ar WHERE ar.workspace_id = ${A} AND ar.domain_id = ${domainId} AND ar.created_at >= ${since} AND NOT (${C('ar')})) AS uncounted
				`);
				return { counted: !!rows[0]?.counted, uncounted: !!rows[0]?.uncounted };
			},
			/** Domains whose FIRST counted report was stored at or after `since`, with that report's id. Starts from the recent reports, so a daily run does not read a workspace's whole history. */
			firstCountedSince(since: number): Promise<Array<{ domain_id: number; report_id: number; created_at: number }>> {
				return db.all(sql`
					SELECT ar.domain_id, MIN(ar.id) AS report_id, MIN(ar.created_at) AS created_at
					FROM aggregate_reports ar JOIN domains d ON d.id = ar.domain_id AND d.workspace_id = ${A}
					WHERE ar.workspace_id = ${A} AND ar.created_at >= ${since} AND ${C('ar')}
					  AND NOT EXISTS (SELECT 1 FROM aggregate_reports o WHERE o.workspace_id = ${A} AND o.domain_id = ar.domain_id AND o.created_at < ${since} AND ${C('o')})
					GROUP BY ar.domain_id
				`);
			},
			byId(reportId: number): Promise<ReportRow | null> {
				return db.all<ReportRow>(sql`
					SELECT ar.id, ar.domain_id, ar.org_name, ar.reporter_known_as, ar.date_begin, ar.date_end, ar.total_count, ar.pass_count, ar.fail_count, ar.created_at
					FROM aggregate_reports ar WHERE ar.workspace_id = ${A} AND ar.id = ${reportId}
				`).then((r) => r[0] ?? null);
			},
			/** The records of one report, grouped like the sender inventory (one row per source and authentication result). */
			reportSources(reportId: number): Promise<WeekSourceRow[]> {
				return sources(sql`ar.id = ${reportId}`, 0);
			},
			/** Sources of one domain in [from, to) by week, grouped like the sender inventory. */
			sourcesByWeek(domainId: number, from: number, to: number): Promise<WeekSourceRow[]> {
				return sources(sql`ar.domain_id = ${domainId} AND ar.date_begin >= ${from} AND ar.date_begin < ${to}`, from);
			},
		},
	};
}
