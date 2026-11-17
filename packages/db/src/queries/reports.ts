import { and, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../client';
import { aggregateReports, domains, reportRecords, tlsReports } from '../schema';
import { counted, type CountingMode } from './counting';
import { batchStatements } from '../client';
import { storeStatements, type StoreReportInput } from './report-store';
import { verdictSql, type DmarcVerdict } from './verdict';
import { classifySource, strongestClass, type SourceClass } from '@ready-set-mail/dns-checks/sender-providers';

export interface DomainWeeklyStat {
	domain_id: number;
	domain: string;
	dmarc_policy: string | null;
	total_messages: number;
	pass_messages: number;
	fail_messages: number;
	report_count: number;
	/** Reports in the window that are stored but left out of the numbers above (only when counting is `proven`). */
	uncounted_reports: number;
}

/** A source whose mail FAILED DMARC (verdict 'failed', see verdict.ts): `total` counts the failed messages only. */
export interface FailingSource {
	source_ip: string;
	total: number;
	header_from: string | null;
	/** What SPF and DKIM authenticated, and whether each raw result was pass, in the source's largest group of failed records. */
	spf_domain: string | null;
	dkim_domain: string | null;
	spf_pass: number;
	dkim_pass: number;
	reverse_dns: string | null;
	base_domain?: string | null;
	org?: string | null;
	/** Whose failure it is (`classifySource`, the one judgement): the strongest class among the source's groups. */
	source_class: SourceClass;
	/** `source_class === 'not_yours'`: nothing to fix. */
	likely_not_yours: boolean;
}

/** Sources and messages in one DMARC verdict (`verdictTally`). */
export interface VerdictCount { sources: number; messages: number }

export interface AnomalySource {
	source_ip: string;
	header_from: string | null;
	spf_domain: string | null;
	dkim_domain: string | null;
	total: number;
	spf_pass: number; // 1 if any record had spf pass in window
	dkim_pass: number; // 1 if any record had dkim pass in window
	/** The receiver's own alignment verdict (policy_evaluated), 1 if any record aligned; null: stored before 0022. */
	spf_aligned: number | null;
	dkim_aligned: number | null;
	/** The receiver's DMARC verdict of these records (`verdictSql`); each row is one verdict. */
	verdict: DmarcVerdict;
	/** 1 when `verdict` is 'failed'. */
	dmarc_fail: number;
	/** The alignment modes of the policy the receiver applied ('s' if any report said strict); null: not stored. */
	aspf: string | null;
	adkim: string | null;
	first_seen: string; // YYYY-MM-DD
	last_seen: string; // YYYY-MM-DD
	base_domain: string | null;
	org: string | null;
}

/** One subdomain of a domain seen in its reports: as the From domain or as the SPF (return-path) domain, with what the receivers decided. */
export interface NameSeenRow {
	name: string;
	role: 'from' | 'return-path';
	messages: number;
	/** Messages the receiver passed (SPF or DKIM aligned) and failed (neither); the rest have no recorded verdict. */
	passed: number;
	failed: number;
	/** Of `failed` (From role only), the messages from sources that are `service_not_set_up` and `not_yours` (`classifySource`); the rest are `yours`. */
	failed_service: number;
	failed_not_yours: number;
}

export interface DailyDomainStat {
	day: string;
	total: number;
	passed: number;
	failed: number;
}

export interface ReportSource {
	source_ip: string;
	header_from: string | null;
	spf_domain: string | null;
	dkim_domain: string | null;
	count: number;
	spf_pass: number;
	dkim_pass: number;
	spf_aligned: number | null;
	dkim_aligned: number | null;
	verdict: DmarcVerdict;
	dmarc_fail: number;
	aspf: string | null;
	adkim: string | null;
	disposition: string;
	reporters: string; // comma-separated org names
}

export interface DayReportSummary {
	total: number;
	passed: number;
	failed: number;
}

export interface ExportRow {
	date: string;
	org_name: string;
	total_count: number;
	pass_count: number;
	fail_count: number;
	source_ip: string | null;
	header_from: string | null;
	spf_result: string | null;
	spf_domain: string | null;
	dkim_result: string | null;
	dkim_domain: string | null;
	record_count: number | null;
	disposition: string | null;
	/** 1: the report counts toward the numbers; 0: it was stored but is not counted (unproven sender). */
	counted: number;
}

export interface DomainCheckSummary {
	domain_id: number;
	domain: string;
	dmarc_policy: string | null;
	spf_record: string | null;
	dns_checked_at: number | null;
	dns_check_attempted_at: number | null;
	dns_check_status: string | null;
	dmarc_issue: string | null;
	dmarc_inherited_from: string | null;
	dns_last_good_status: string | null;
	total_messages: number;
	pass_messages: number;
	fail_messages: number;
	dkim_total: number;
	dkim_pass: number;
	spf_total: number;
	spf_pass: number;
	/**
	 * What the reports say about the mail sent AS this name (header_from equal to the domain), from the receiver's own verdict (0022):
	 * the messages, those whose DKIM aligned, those whose SPF domain (the return-path) was this name itself, and those stored before the
	 * verdict was kept. Evidence for whether a missing SPF record at the name matters (`spfNotNeededAtName`).
	 */
	from_messages?: number;
	from_dkim_aligned?: number;
	from_spf_at_name?: number;
	from_unjudged?: number;
	/** Messages in the window whose verdict is 'failed', by whose failure it is (`classifySource`): from sources that are `not_yours` (nothing to fix)... */
	failed_not_yours?: number;
	/** ...and from `service_not_set_up` sources (a real service sending as the domain without being set up for it), with the From names they sent as (at most 5). */
	failed_service?: number;
	failed_service_names?: string[];
	/** Failed messages (report totals) of the window's counted reports whose records have no recorded verdict (stored before 0022 kept it, or not recoverable): whose they are is not recorded. */
	failed_unrecorded?: number;
	mta_sts_enabled: number; // 0 or 1
	mta_sts_mode: string | null;
	/** SPF DNS lookups at the last refresh (null: not counted). */
	spf_lookup_count: number | null;
	/** The governing DMARC record at the last read (0012): pct=, p=, sp= as written (null: no tag), and whether its rua= names this domain's reports address (1/0). dmarc_p null with a policy: not read since 0012. */
	dmarc_pct: number | null;
	dmarc_p: string | null;
	dmarc_sp: string | null;
	dmarc_rua: number | null;
}

/** One reporter behind the counted numbers. */
export interface CountedReporter { reporter: string; label: string; reports: number; messages: number }

/** Which domains a statement covers: one id, an id range, or (null) the whole workspace. */
type DomainScope = number | null | { fromId: number; toId: number };

export const emptySummary = (): UncountedSummary => ({ reports: 0, messages: 0, latest_at: null, unknown: 0, unauthenticated: 0, by_reporter: [] });

export interface UncountedSummary {
	reports: number;
	messages: number;
	latest_at: number | null;
	/** Of `reports`: authenticated but not in the registry (tier unknown), and not authenticated (tier unauthenticated). */
	unknown: number;
	unauthenticated: number;
	/**
	 * The reporters that account for most of them (at most 5): an authenticated sender by its authenticated domain; a sender that was NOT
	 * authenticated is `reporter: 'unverified sender'`, `unverified: true`, and the org name it wrote only as `claims` (anyone can write "google.com").
	 */
	by_reporter: Array<{ reporter: string; reports: number; unverified?: boolean; claims?: string | null }>;
}

type NewReport = Omit<typeof aggregateReports.$inferInsert, 'id' | 'created_at' | 'workspace_id'>;
type NewRecord = Omit<typeof reportRecords.$inferInsert, 'id' | 'created_at' | 'workspace_id'>;
type NewTlsReport = Omit<typeof tlsReports.$inferInsert, 'id' | 'created_at' | 'workspace_id'>;

/** Sanitized references only: source payloads and authentication headers never enter reports. */
export interface ReportEvidenceRow {
  id: number;
  source_report_id: string | null;
  reporter: string;
  date_begin: number;
  date_end: number;
  created_at: number;
  total_count: number;
  pass_count: number;
  fail_count: number;
}
interface EvidenceSummaryRow {
  report_count: number;
  latest_period_end: number | null;
  latest_received_at: number | null;
}

/**
 * Stored DNS facts plus report totals for the window. Report totals and record counts are summed in separate subqueries:
 * joining report_records straight onto aggregate_reports repeats each report once per record, which multiplied the totals.
 * Both subqueries apply the workspace's counting filter (`C`, see counting.ts), so a hosted workspace's rates count only counted reports.
 */
function summarySql(A: SQL, C: (alias: string) => SQL, since: number, where: SQL, tail: SQL): SQL {
	return sql`
		SELECT
			d.id            AS domain_id,
			d.domain,
			d.dmarc_policy,
			d.spf_record,
			d.dns_checked_at,
			d.dns_check_attempted_at,
			d.dns_check_status,
			d.dmarc_issue,
			d.dmarc_inherited_from,
			d.dns_last_good_status,
			d.spf_lookup_count,
			d.dmarc_pct,
			d.dmarc_p,
			d.dmarc_sp,
			d.dmarc_rua,
			COALESCE(ar.total, 0)     AS total_messages,
			COALESCE(ar.pass, 0)      AS pass_messages,
			COALESCE(ar.fail, 0)      AS fail_messages,
			COALESCE(ar.fail_unrecorded, 0) AS failed_unrecorded,
			COALESCE(rr.total, 0)     AS dkim_total,
			COALESCE(rr.dkim_pass, 0) AS dkim_pass,
			COALESCE(rr.total, 0)     AS spf_total,
			COALESCE(rr.spf_pass, 0)  AS spf_pass,
			COALESCE(rr.from_messages, 0)     AS from_messages,
			COALESCE(rr.from_dkim_aligned, 0) AS from_dkim_aligned,
			COALESCE(rr.from_spf_at_name, 0)  AS from_spf_at_name,
			COALESCE(rr.from_unjudged, 0)     AS from_unjudged,
			COALESCE(m.enabled, 0)    AS mta_sts_enabled,
			m.mode                    AS mta_sts_mode
		FROM domains d
		LEFT JOIN (
			SELECT domain_id, SUM(total_count) AS total, SUM(pass_count) AS pass, SUM(fail_count) AS fail,
				SUM(CASE WHEN EXISTS (SELECT 1 FROM report_records r WHERE r.report_id = aggregate_reports.id AND ${verdictSql('r')} = 'not-recorded') THEN fail_count ELSE 0 END) AS fail_unrecorded
			FROM aggregate_reports
			WHERE workspace_id = ${A} AND date_begin >= ${since} AND ${C('aggregate_reports')}
			GROUP BY domain_id
		) ar ON ar.domain_id = d.id
		LEFT JOIN (
			SELECT a.domain_id,
				SUM(r.count) AS total,
				SUM(CASE WHEN r.dkim_result = 'pass' THEN r.count ELSE 0 END) AS dkim_pass,
				SUM(CASE WHEN r.spf_result  = 'pass' THEN r.count ELSE 0 END) AS spf_pass,
				SUM(CASE WHEN lower(r.header_from) = lower(dd.domain) THEN r.count ELSE 0 END) AS from_messages,
				SUM(CASE WHEN lower(r.header_from) = lower(dd.domain) AND r.dkim_aligned = 1 THEN r.count ELSE 0 END) AS from_dkim_aligned,
				SUM(CASE WHEN lower(r.header_from) = lower(dd.domain) AND lower(r.spf_domain) = lower(dd.domain) THEN r.count ELSE 0 END) AS from_spf_at_name,
				SUM(CASE WHEN lower(r.header_from) = lower(dd.domain) AND ${verdictSql('r')} = 'not-recorded' THEN r.count ELSE 0 END) AS from_unjudged
			FROM report_records r
			JOIN aggregate_reports a ON a.id = r.report_id AND a.workspace_id = ${A}
			JOIN domains dd ON dd.id = a.domain_id AND dd.workspace_id = ${A}
			WHERE r.workspace_id = ${A} AND a.date_begin >= ${since} AND ${C('a')}
			GROUP BY a.domain_id
		) rr ON rr.domain_id = d.id
		LEFT JOIN mta_sts_config m ON m.domain_id = d.id AND m.workspace_id = ${A}
		WHERE d.workspace_id = ${A} ${where}
		${tail}
	`;
}

interface FailedGroup {
	domain_id: number;
	domain: string;
	source_ip: string;
	header_from: string | null;
	spf_domain: string | null;
	dkim_domain: string | null;
	spf_pass: number;
	dkim_pass: number;
	total: number;
	reverse_dns: string | null;
	base_domain: string | null;
	org: string | null;
}

/** A failed group with the class of its source: decided per (domain, source IP) over all the source's groups (`strongestClass`). */
type ClassifiedGroup = FailedGroup & { source_class: SourceClass };

function classifyGroups(groups: readonly FailedGroup[]): ClassifiedGroup[] {
	const byDomainSource = new Map<string, SourceClass>();
	const key = (g: FailedGroup) => `${g.domain_id}|${g.source_ip}`;
	for (const g of groups) {
		const c = classifySource({ ...g }, g.domain);
		const seen = byDomainSource.get(key(g));
		byDomainSource.set(key(g), seen ? strongestClass(seen, c) : c);
	}
	return groups.map((g) => ({ ...g, source_class: byDomainSource.get(key(g))! }));
}

/** One domain's failed groups (largest first) rolled up per source IP, largest source first. */
function rollUpFailing(groups: readonly FailedGroup[]): FailingSource[] {
	const bySource = new Map<string, FailingSource>();
	for (const g of classifyGroups(groups)) {
		const seen = bySource.get(g.source_ip);
		if (seen) {
			seen.total += Number(g.total);
		} else {
			bySource.set(g.source_ip, {
				source_ip: g.source_ip, total: Number(g.total), header_from: g.header_from, spf_domain: g.spf_domain, dkim_domain: g.dkim_domain,
				spf_pass: Number(g.spf_pass), dkim_pass: Number(g.dkim_pass), reverse_dns: g.reverse_dns, base_domain: g.base_domain, org: g.org,
				source_class: g.source_class, likely_not_yours: g.source_class === 'not_yours',
			});
		}
	}
	return [...bySource.values()].sort((a, b) => b.total - a.total);
}

/** Which time a report window is measured on: the period it covers (`date_begin`) or when it was received (`created_at`). */
export type ReportWindow = 'period' | 'received';

export function reportQueries(db: Db, workspaceId: string, counting: CountingMode = 'registry') {
	const A = sql`${workspaceId}`;
	/** The statement counts this report (see counting.ts). */
	const C = (alias: string) => counted(alias, counting);

	/** The window column: `period` (the default) is the period a report covers (date_begin); `received` is when we stored it (created_at). */
	const windowCol = (by: ReportWindow) => (by === 'received' ? sql`aggregate_reports.created_at` : sql`aggregate_reports.date_begin`);
	/** Which domains a statement covers: one (`domainId`), a range of ids (a page of the overview), or the whole workspace (null). */
	const scopeOf = (s: DomainScope) =>
		s === null ? sql`` : typeof s === 'number' ? sql`AND aggregate_reports.domain_id = ${s}` : sql`AND aggregate_reports.domain_id BETWEEN ${s.fromId} AND ${s.toId}`;
	/**
	 * Stored reports in the window matching `excluded`, per domain (`domain_id` 0 when the scope is the whole workspace): ONE statement,
	 * grouped by reporter, folded here into the totals and the top 5 reporters (reports desc, then reporter), so a page of domains costs
	 * the same as one.
	 */
	const summariseByDomain = async (s: DomainScope, since: number, excluded: ReturnType<typeof sql>, on: ReportWindow = 'period'): Promise<Map<number, UncountedSummary>> => {
		const w = windowCol(on);
		/** Not authenticated: what the report says about its sender is only a claim. */
		const unverified = sql`(COALESCE(aggregate_reports.reporter_tier, '') = 'unauthenticated' OR COALESCE(aggregate_reports.reporter_auth, '') <> 'pass')`;
		const dom = s === null ? sql`0` : sql`aggregate_reports.domain_id`;
		const byDom = s === null ? sql`` : sql`aggregate_reports.domain_id, `;
		const rows = await db.all<{ dk: number; reporter: string; unverified: number; claims: string | null; reports: number; messages: number; latest_at: number | null; unknown: number | null; unauthenticated: number | null }>(sql`
			SELECT ${dom} AS dk,
				CASE WHEN ${unverified} THEN 'unverified sender' ELSE COALESCE(aggregate_reports.reporter_auth_domain, aggregate_reports.org_name) END AS reporter,
				CASE WHEN ${unverified} THEN 1 ELSE 0 END AS unverified, CASE WHEN ${unverified} THEN aggregate_reports.org_name END AS claims,
				COUNT(*) AS reports, COALESCE(SUM(total_count), 0) AS messages, MAX(created_at) AS latest_at,
				SUM(CASE WHEN aggregate_reports.reporter_tier = 'unknown' THEN 1 ELSE 0 END) AS unknown, SUM(CASE WHEN aggregate_reports.reporter_tier = 'unauthenticated' THEN 1 ELSE 0 END) AS unauthenticated
			FROM aggregate_reports WHERE aggregate_reports.workspace_id = ${A} ${scopeOf(s)} AND ${w} >= ${since} AND ${excluded}
			GROUP BY ${byDom}reporter, unverified, claims`);
		const groups = new Map<number, typeof rows>();
		for (const r of rows) groups.set(r.dk, [...(groups.get(r.dk) ?? []), r]);
		const out = new Map<number, UncountedSummary>();
		for (const [id, g] of groups) {
			const top = [...g].sort((a, b) => b.reports - a.reports || (a.reporter < b.reporter ? -1 : a.reporter > b.reporter ? 1 : 0)).slice(0, 5);
			out.set(id, {
				reports: g.reduce((n, r) => n + Number(r.reports), 0),
				messages: g.reduce((n, r) => n + Number(r.messages), 0),
				latest_at: g.reduce<number | null>((m, r) => (r.latest_at !== null && (m === null || r.latest_at > m) ? r.latest_at : m), null),
				unknown: g.reduce((n, r) => n + Number(r.unknown ?? 0), 0),
				unauthenticated: g.reduce((n, r) => n + Number(r.unauthenticated ?? 0), 0),
				by_reporter: top.map((r) => (r.unverified ? { reporter: r.reporter, reports: r.reports, unverified: true, claims: r.claims } : { reporter: r.reporter, reports: r.reports })),
			});
		}
		return out;
	};
	const summarise = async (domainId: number | null, since: number, excluded: ReturnType<typeof sql>, on: ReportWindow = 'period'): Promise<UncountedSummary> =>
		(await summariseByDomain(domainId, since, excluded, on)).get(domainId ?? 0) ?? emptySummary();
	/** Counted reports per reporter, per domain (top 20 by messages): the statement behind `counted`. */
	const countedByDomain = async (s: DomainScope, since: number, by: ReportWindow = 'period'): Promise<Map<number, CountedReporter[]>> => {
		const dom = s === null ? sql`0` : sql`aggregate_reports.domain_id`;
		const byDom = s === null ? sql`` : sql`aggregate_reports.domain_id, `;
		const rows = await db.all<{ dk: number; reporter: string; known_as: string | null; org: string | null; reports: number; messages: number }>(sql`
			SELECT ${dom} AS dk, COALESCE(aggregate_reports.reporter_identity, aggregate_reports.reporter_auth_domain, aggregate_reports.org_name) AS reporter,
				MAX(aggregate_reports.reporter_known_as) AS known_as, MAX(aggregate_reports.org_name) AS org, COUNT(*) AS reports, COALESCE(SUM(aggregate_reports.total_count), 0) AS messages
			FROM aggregate_reports WHERE aggregate_reports.workspace_id = ${A} ${scopeOf(s)} AND ${windowCol(by)} >= ${since} AND ${C('aggregate_reports')}
			GROUP BY ${byDom}reporter`);
		const out = new Map<number, CountedReporter[]>();
		for (const r of rows) out.set(r.dk, [...(out.get(r.dk) ?? []), { reporter: r.reporter, label: (r.known_as ?? r.org) as string, reports: r.reports, messages: r.messages }]);
		for (const [id, list] of out) out.set(id, list.sort((a, b) => b.messages - a.messages).slice(0, 20));
		return out;
	};

	/**
	 * The records that FAILED DMARC (`verdictSql` 'failed'), grouped by source and by what was authenticated, per domain: ONE statement
	 * behind `topFailingSources` and `failed_not_yours`. The raw SPF / DKIM results are grouped too, so a group is one set of facts.
	 */
	const failedGroups = (where: ReturnType<typeof sql>, since: number, limit: number) =>
		db.all<FailedGroup>(sql`
			SELECT ar.domain_id, d.domain, rr.source_ip, rr.header_from, rr.spf_domain, rr.dkim_domain,
			       CASE WHEN rr.spf_result = 'pass' THEN 1 ELSE 0 END AS spf_pass, CASE WHEN rr.dkim_result = 'pass' THEN 1 ELSE 0 END AS dkim_pass,
			       SUM(rr.count) AS total, MAX(rr.reverse_dns) AS reverse_dns, MAX(rr.base_domain) AS base_domain, MAX(rr.org) AS org
			FROM report_records rr
			JOIN aggregate_reports ar ON ar.id = rr.report_id
			JOIN domains d ON d.id = ar.domain_id AND d.workspace_id = ${A}
			WHERE ar.workspace_id = ${A} AND rr.workspace_id = ${A} AND ${C('ar')} ${where} AND ar.date_begin >= ${since}
			  AND ${verdictSql('rr')} = 'failed'
			GROUP BY ar.domain_id, rr.source_ip, rr.header_from, rr.spf_domain, rr.dkim_domain, spf_pass, dkim_pass
			ORDER BY total DESC
			LIMIT ${limit}
		`);
	/** The failed messages per domain id in the range, by whose failure it is (`classifySource`): one statement. */
	const failedByClassByDomain = async (range: { fromId: number; toId: number }, since: number): Promise<Map<number, { not_yours: number; service: number; service_names: string[] }>> => {
		const rows = classifyGroups(await failedGroups(sql`AND ar.domain_id BETWEEN ${range.fromId} AND ${range.toId}`, since, 2000));
		const out = new Map<number, { not_yours: number; service: number; service_names: string[] }>();
		for (const g of rows) {
			const e = out.get(g.domain_id) ?? { not_yours: 0, service: 0, service_names: [] };
			if (g.source_class === 'not_yours') e.not_yours += Number(g.total);
			if (g.source_class === 'service_not_set_up') {
				e.service += Number(g.total);
				const name = (g.header_from || g.domain).toLowerCase();
				if (!e.service_names.includes(name) && e.service_names.length < 5) e.service_names.push(name);
			}
			out.set(g.domain_id, e);
		}
		for (const e of out.values()) e.service_names.sort();
		return out;
	};
	const noClasses = { not_yours: 0, service: 0, service_names: [] as string[] };
	const classFields = (c: { not_yours: number; service: number; service_names: string[] } | undefined) => {
		const e = c ?? noClasses;
		return { failed_not_yours: e.not_yours, failed_service: e.service, failed_service_names: e.service_names };
	};

	return {
		insertAggregate(r: NewReport) {
			// Re-delivered reports (same domain_id + report_id) are ignored.
			return db.insert(aggregateReports).values({ ...r, workspace_id: workspaceId }).onConflictDoNothing().run();
		},

		/**
		 * Store one report and all its records in ONE db.batch() (one D1 query, one transaction: all or nothing). `stored` is false when
		 * the (domain, report id) already existed: nothing was written then, records and counters included.
		 */
		async storeAtomic(input: Omit<StoreReportInput, 'workspaceId'>): Promise<{ stored: boolean; reportId: number; statements: number; superseded: number }> {
			const stmts = storeStatements({ ...input, workspaceId });
			const res = await batchStatements(db, stmts);
			const at = input.supersedeXmlId !== undefined ? 3 : 0; // the supersede statements come first
			const first = res[at]?.meta;
			const stored = (first?.changes ?? 0) > 0;
			return { stored, reportId: stored ? Number(first?.last_row_id ?? 0) : 0, statements: stmts.length, superseded: stored && at ? Number(res[2]?.meta?.changes ?? 0) : 0 };
		},

		/**
		 * Is this report already stored? Keyed on (domain, reporter identity, report id) and checked AFTER the sender is classified. Every report with
		 * an identity is stored as '<identity>|<id>' (the registry id for a counted report), so two known reporters may reuse one report id.
		 *   - the same identity's report with that id is a duplicate (redelivery);
		 *   - a LEGACY row, stored under the plain report id (before 0010 or by a build that kept counted reports plain), is a duplicate when its
		 *     identity is unknown (NULL) or the same: it cannot be told apart from this reporter's own report;
		 *   - an UNCOUNTED report is also a duplicate of any counted report or plain-id row with that id (a forgery never displaces or doubles a counted report).
		 */
		async isDuplicate(domainId: number, identity: string, xmlId: string, counted: boolean): Promise<boolean> {
			const mine = sql`report_id = ${identity + '|' + xmlId}`;
			const legacy = counted ? sql`(report_id = ${xmlId} AND (reporter_identity IS NULL OR reporter_identity = ${identity}))` : sql`report_id = ${xmlId}`;
			const countedElsewhere = counted ? sql`` : sql` OR (reporter_tier = 'counted' AND substr(report_id, instr(report_id, '|') + 1) = ${xmlId})`;
			const rows = await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM aggregate_reports WHERE workspace_id = ${A} AND domain_id = ${domainId}
				AND (${mine} OR ${legacy}${countedElsewhere})`);
			return (rows[0]?.n ?? 0) > 0;
		},

		/** The id of an already stored report with this (domain, report id), or null. */
		async findReportId(domainId: number, reportId: string): Promise<number | null> {
			const row = await db.select({ id: aggregateReports.id }).from(aggregateReports)
				.where(and(eq(aggregateReports.workspace_id, workspaceId), eq(aggregateReports.domain_id, domainId), eq(aggregateReports.report_id, reportId))).get();
			return row?.id ?? null;
		},

		/**
		 * Who the COUNTED numbers in the window come from: counted reports per reporter (identity, label, reports, messages). Every percentage
		 * shown can name them; advice needs a major reporter (google, microsoft) here.
		 */
		async counted(domainId: number | null, since: number, by: ReportWindow = 'period'): Promise<CountedReporter[]> {
			return (await countedByDomain(domainId, since, by)).get(domainId ?? 0) ?? [];
		},

		/**
		 * `counted`, `uncounted` and `unrecognised` for every domain whose id is in `range`, in one statement each (two in `all` mode), keyed by
		 * domain id. A domain with no such reports is absent from the maps. What a page of the overview reads in place of one call per domain.
		 */
		async visibilityByDomain(range: { fromId: number; toId: number }, since: number, by: ReportWindow = 'period') {
			const [unrecognised, uncounted, countedBy] = await Promise.all([
				summariseByDomain(range, since, sql`aggregate_reports.reporter_tier IS NOT 'counted'`, by),
				counting === 'all' ? Promise.resolve(new Map<number, UncountedSummary>()) : summariseByDomain(range, since, sql`NOT (${C('aggregate_reports')})`, by),
				countedByDomain(range, since, by),
			]);
			return { unrecognised, uncounted, counted: countedBy };
		},

		/**
		 * Reports in the window that are stored but NOT counted in this workspace's counting mode (empty in `all` mode), with the
		 * authenticated reporter domains behind them. `domainId` null: the whole workspace.
		 */
		async uncounted(domainId: number | null, since: number, by: ReportWindow = 'period'): Promise<UncountedSummary> {
			if (counting === 'all') return { reports: 0, messages: 0, latest_at: null, unknown: 0, unauthenticated: 0, by_reporter: [] };
			return summarise(domainId, since, sql`NOT (${C('aggregate_reports')})`, by);
		},

		/**
		 * Reports in the window from senders we do not recognise (the intake did not class them 'counted'), whatever the counting mode:
		 * in `all` mode they are counted, and this is how a dashboard can still say so.
		 */
		unrecognised(domainId: number | null, since: number, by: ReportWindow = 'period'): Promise<UncountedSummary> {
			return summarise(domainId, since, sql`aggregate_reports.reporter_tier IS NOT 'counted'`, by);
		},

		insertRecords(records: NewRecord[]) {
			const rows = records.map((r) => db.insert(reportRecords).values({ ...r, workspace_id: workspaceId }));
			return db.batch(rows as [(typeof rows)[number], ...(typeof rows)[number][]]);
		},

		/** Most recent aggregate reports across the workspace's domains. */
		recent(limit = 30) {
			return db
				.select({ r: aggregateReports, domain: domains.domain })
				.from(aggregateReports)
				.innerJoin(domains, and(eq(domains.id, aggregateReports.domain_id), eq(domains.workspace_id, workspaceId), isNull(domains.evicted_at)))
				// Reports that do not count never push ones that do out of "latest N".
				.where(eq(aggregateReports.workspace_id, workspaceId))
				.orderBy(...(counting === 'all' ? [] : [sql`(${C('aggregate_reports')}) DESC`]), desc(aggregateReports.date_begin))
				.limit(limit)
				.all()
				.then((rows) => rows.map((x) => ({ ...x.r, domain: x.domain })));
		},

		/** One report with its domain name, or null. */
		getWithDomain(id: number) {
			return db
				.select({ r: aggregateReports, domain: domains.domain })
				.from(aggregateReports)
				.innerJoin(domains, and(eq(domains.id, aggregateReports.domain_id), eq(domains.workspace_id, workspaceId), isNull(domains.evicted_at)))
				.where(and(eq(aggregateReports.workspace_id, workspaceId), eq(aggregateReports.id, id)))
				.get()
				.then((x) => (x ? { ...x.r, domain: x.domain } : null));
		},

		records(reportId: number) {
			return db
				.select()
				.from(reportRecords)
				.where(and(eq(reportRecords.workspace_id, workspaceId), eq(reportRecords.report_id, reportId)))
				.orderBy(desc(reportRecords.count))
				.all();
		},

		countForDomain(domainId: number) {
			return db
				.select({ cnt: sql<number>`COUNT(*)` })
				.from(aggregateReports)
				/* the first-report notice is about a report that counts */
				.where(and(eq(aggregateReports.workspace_id, workspaceId), eq(aggregateReports.domain_id, domainId), C('aggregate_reports')))
				.get()
				.then((r) => r?.cnt ?? 0);
		},

		// ── Digest / dashboard aggregates ─────────────────────────

		weeklyDomainStats(since: number) {
			return db.all<DomainWeeklyStat>(sql`
				SELECT
					d.id AS domain_id,
					d.domain,
					d.dmarc_policy,
					COALESCE(SUM(r.total_count), 0) AS total_messages,
					COALESCE(SUM(r.pass_count),  0) AS pass_messages,
					COALESCE(SUM(r.fail_count),  0) AS fail_messages,
					COUNT(r.id) AS report_count,
					${counting !== 'all'
						? sql`(SELECT COUNT(*) FROM aggregate_reports u WHERE u.workspace_id = ${A} AND u.domain_id = d.id AND u.date_begin >= ${since} AND NOT (${C('u')}))`
						: sql`0`} AS uncounted_reports
				FROM domains d
				LEFT JOIN aggregate_reports r ON r.domain_id = d.id AND r.workspace_id = ${A} AND r.date_begin >= ${since} AND ${C('r')}
				WHERE d.workspace_id = ${A} AND d.evicted_at IS NULL
				GROUP BY d.id, d.domain, d.dmarc_policy
				ORDER BY d.domain
			`);
		},

		/**
		 * The sources whose mail FAILED DMARC (verdict 'failed': the receiver found neither SPF nor DKIM aligned, RFC 9989 section 5.3.5), by failed
		 * messages. Grouped in SQL by what was authenticated (largest 500 groups), rolled up per source here: the largest group names the
		 * authenticated domains, and a source is `likely_not_yours` only when every group is.
		 */
		async topFailingSources(domainId: number, since: number, limit = 5): Promise<FailingSource[]> {
			const rows = await failedGroups(sql`AND ar.domain_id = ${domainId}`, since, 500);
			return rollUpFailing(rows).slice(0, limit);
		},

		/**
		 * How many counted reports hold a record whose verdict is not recorded (stored before 0022 kept it, or not recoverable), in the window
		 * (`since`) or on one day (`date`): the one count the Anomalies page and the day's report page lead with, so they cannot differ.
		 */
		async unrecordedReports(domainId: number, win: { since: number } | { date: string }): Promise<number> {
			const when = 'date' in win ? sql`date(datetime(ar.date_begin, 'unixepoch')) = ${win.date}` : sql`ar.date_begin >= ${win.since}`;
			const rows = await db.all<{ n: number }>(sql`
				SELECT COUNT(DISTINCT ar.id) AS n FROM report_records rr JOIN aggregate_reports ar ON ar.id = rr.report_id
				WHERE ar.workspace_id = ${A} AND rr.workspace_id = ${A} AND ${C('ar')} AND ar.domain_id = ${domainId} AND ${when} AND ${verdictSql('rr')} = 'not-recorded'`);
			return Number(rows[0]?.n ?? 0);
		},

		/**
		 * The COUNTED reports filed under this domain: how many and how many messages since `since` (by the period they cover, as the page's totals),
		 * and when the newest one ever was stored. What the report-address view says of how reports reach a name (`reach`).
		 */
		async reachCounts(domainId: number, since: number): Promise<{ reports: number; messages: number; last_report_at: number | null }> {
			const rows = await db.all<{ reports: number; messages: number; last_at: number | null }>(sql`
				SELECT COALESCE(SUM(CASE WHEN aggregate_reports.date_begin >= ${since} THEN 1 ELSE 0 END), 0) AS reports,
					COALESCE(SUM(CASE WHEN aggregate_reports.date_begin >= ${since} THEN aggregate_reports.total_count ELSE 0 END), 0) AS messages,
					MAX(aggregate_reports.created_at) AS last_at
				FROM aggregate_reports WHERE aggregate_reports.workspace_id = ${A} AND aggregate_reports.domain_id = ${domainId} AND ${C('aggregate_reports')}`);
			const r = rows[0];
			return { reports: Number(r?.reports ?? 0), messages: Number(r?.messages ?? 0), last_report_at: r?.last_at ?? null };
		},

		/** Per verdict, how many sources and messages the domain's counted reports hold since `since`: what the failing-sources list leaves out. */
		async verdictTally(domainId: number, since: number): Promise<Record<DmarcVerdict, VerdictCount>> {
			const rows = await db.all<{ verdict: DmarcVerdict; sources: number; messages: number }>(sql`
				SELECT ${verdictSql('rr')} AS verdict, COUNT(DISTINCT rr.source_ip) AS sources, COALESCE(SUM(rr.count), 0) AS messages
				FROM report_records rr
				JOIN aggregate_reports ar ON ar.id = rr.report_id
				WHERE ar.workspace_id = ${A} AND rr.workspace_id = ${A} AND ${C('ar')} AND ar.domain_id = ${domainId} AND ar.date_begin >= ${since}
				GROUP BY verdict
			`);
			const out: Record<DmarcVerdict, VerdictCount> = { failed: { sources: 0, messages: 0 }, passed: { sources: 0, messages: 0 }, 'passed-one': { sources: 0, messages: 0 }, 'not-recorded': { sources: 0, messages: 0 } };
			for (const r of rows) out[r.verdict] = { sources: Number(r.sources), messages: Number(r.messages) };
			return out;
		},

		/** Every record group that did not pass on both identifiers (verdict not 'passed'), one row per verdict. */
		anomalySources(domainId: number, since: number) {
			return db.all<AnomalySource>(sql`
				SELECT
					rr.source_ip,
					rr.header_from,
					rr.spf_domain,
					rr.dkim_domain,
					SUM(rr.count) AS total,
					MAX(CASE WHEN rr.spf_result  = 'pass' THEN 1 ELSE 0 END) AS spf_pass,
					MAX(CASE WHEN rr.dkim_result = 'pass' THEN 1 ELSE 0 END) AS dkim_pass,
					rr.spf_aligned AS spf_aligned,
					rr.dkim_aligned AS dkim_aligned,
					${verdictSql('rr')} AS verdict,
					CASE WHEN ${verdictSql('rr')} = 'failed' THEN 1 ELSE 0 END AS dmarc_fail,
					MAX(ar.aspf) AS aspf,
					MAX(ar.adkim) AS adkim,
					MIN(date(datetime(ar.date_begin, 'unixepoch'))) AS first_seen,
					MAX(date(datetime(ar.date_begin, 'unixepoch'))) AS last_seen,
					MAX(rr.base_domain) AS base_domain,
					MAX(rr.org) AS org
				FROM report_records rr
				JOIN aggregate_reports ar ON ar.id = rr.report_id
				WHERE ar.workspace_id = ${A} AND rr.workspace_id = ${A} AND ${C('ar')}
				  AND ar.domain_id = ${domainId}
				  AND ar.date_begin >= ${since}
				  AND ${verdictSql('rr')} <> 'passed'
				GROUP BY rr.source_ip, rr.header_from, rr.spf_domain, rr.dkim_domain, rr.spf_aligned, rr.dkim_aligned
				ORDER BY total DESC
			`);
		},

		allSources(domainId: number, since: number) {
			return db.all<AnomalySource>(sql`
				SELECT
					rr.source_ip,
					rr.header_from,
					rr.spf_domain,
					rr.dkim_domain,
					SUM(rr.count) AS total,
					MAX(CASE WHEN rr.spf_result  = 'pass' THEN 1 ELSE 0 END) AS spf_pass,
					MAX(CASE WHEN rr.dkim_result = 'pass' THEN 1 ELSE 0 END) AS dkim_pass,
					rr.spf_aligned AS spf_aligned,
					rr.dkim_aligned AS dkim_aligned,
					${verdictSql('rr')} AS verdict,
					CASE WHEN ${verdictSql('rr')} = 'failed' THEN 1 ELSE 0 END AS dmarc_fail,
					MAX(ar.aspf) AS aspf,
					MAX(ar.adkim) AS adkim,
					MIN(date(datetime(ar.date_begin, 'unixepoch'))) AS first_seen,
					MAX(date(datetime(ar.date_begin, 'unixepoch'))) AS last_seen,
					MAX(rr.base_domain) AS base_domain,
					MAX(rr.org) AS org
				FROM report_records rr
				JOIN aggregate_reports ar ON ar.id = rr.report_id
				WHERE ar.workspace_id = ${A} AND rr.workspace_id = ${A} AND ${C('ar')}
				  AND ar.domain_id = ${domainId}
				  AND ar.date_begin >= ${since}
				GROUP BY rr.source_ip, rr.header_from, rr.spf_domain, rr.dkim_domain, rr.spf_aligned, rr.dkim_aligned
				ORDER BY total DESC
			`);
		},

		/**
		 * Every subdomain of `domain` seen in this domain's counted reports, as a From domain (`header_from`) or as the SPF domain
		 * (the return-path, what the report calls the envelope), with its volume and the receiver's pass / fail. The domain itself is not a
		 * subdomain and is left out. One row per name and role.
		 */
		async namesSeen(domainId: number, domain: string, since: number): Promise<NameSeenRow[]> {
			const suffix = `.${domain}`;
			const rows = await db.all<Omit<NameSeenRow, 'failed_service' | 'failed_not_yours'>>(sql`
				SELECT n.name AS name, n.role AS role, SUM(n.count) AS messages,
				       SUM(CASE WHEN n.verdict IN ('passed', 'passed-one') THEN n.count ELSE 0 END) AS passed,
				       SUM(CASE WHEN n.verdict = 'failed' THEN n.count ELSE 0 END) AS failed
				FROM (
					SELECT lower(rr.header_from) AS name, 'from' AS role, rr.count, ${verdictSql('rr')} AS verdict
					FROM report_records rr JOIN aggregate_reports ar ON ar.id = rr.report_id
					WHERE ar.workspace_id = ${A} AND rr.workspace_id = ${A} AND ${C('ar')} AND ar.domain_id = ${domainId} AND ar.date_begin >= ${since}
					UNION ALL
					SELECT lower(rr.spf_domain), 'return-path', rr.count, ${verdictSql('rr')}
					FROM report_records rr JOIN aggregate_reports ar ON ar.id = rr.report_id
					WHERE ar.workspace_id = ${A} AND rr.workspace_id = ${A} AND ${C('ar')} AND ar.domain_id = ${domainId} AND ar.date_begin >= ${since}
				) n
				WHERE n.name IS NOT NULL AND length(n.name) > ${suffix.length} AND substr(n.name, -${suffix.length}) = ${suffix}
				GROUP BY n.name, n.role
				ORDER BY messages DESC, n.name
			`);
			// Whose failure each name's failed mail is: the same classes as the domain's own totals (`failedByClassByDomain`).
			const byName = new Map<string, { service: number; notYours: number }>();
			if (rows.some((r) => r.role === 'from' && r.failed > 0)) {
				for (const g of classifyGroups(await failedGroups(sql`AND ar.domain_id = ${domainId}`, since, 2000))) {
					const name = (g.header_from ?? '').toLowerCase();
					const e = byName.get(name) ?? { service: 0, notYours: 0 };
					if (g.source_class === 'service_not_set_up') e.service += Number(g.total);
					if (g.source_class === 'not_yours') e.notYours += Number(g.total);
					byName.set(name, e);
				}
			}
			return rows.map((r) => ({ ...r, failed_service: r.role === 'from' ? byName.get(r.name)?.service ?? 0 : 0, failed_not_yours: r.role === 'from' ? byName.get(r.name)?.notYours ?? 0 : 0 }));
		},

		dailyStats(domainId: number, since: number) {
			return db.all<DailyDomainStat>(sql`
				SELECT
					date(datetime(date_begin, 'unixepoch')) AS day,
					SUM(total_count) AS total,
					SUM(pass_count)  AS passed,
					SUM(fail_count)  AS failed
				FROM aggregate_reports
				WHERE workspace_id = ${A} AND domain_id = ${domainId} AND date_begin >= ${since} AND ${C('aggregate_reports')}
				GROUP BY day
				ORDER BY day ASC
			`);
		},

		sourcesByDate(domainId: number, date: string) {
			return db.all<ReportSource>(sql`
				SELECT
					rr.source_ip,
					rr.header_from,
					rr.spf_domain,
					rr.dkim_domain,
					SUM(rr.count) AS count,
					MAX(CASE WHEN rr.spf_result  = 'pass' THEN 1 ELSE 0 END) AS spf_pass,
					MAX(CASE WHEN rr.dkim_result = 'pass' THEN 1 ELSE 0 END) AS dkim_pass,
					rr.spf_aligned AS spf_aligned,
					rr.dkim_aligned AS dkim_aligned,
					${verdictSql('rr')} AS verdict,
					CASE WHEN ${verdictSql('rr')} = 'failed' THEN 1 ELSE 0 END AS dmarc_fail,
					MAX(ar.aspf) AS aspf,
					MAX(ar.adkim) AS adkim,
					rr.disposition,
					GROUP_CONCAT(DISTINCT ar.org_name) AS reporters
				FROM report_records rr
				JOIN aggregate_reports ar ON ar.id = rr.report_id
				WHERE ar.workspace_id = ${A} AND rr.workspace_id = ${A} AND ${C('ar')}
				  AND ar.domain_id = ${domainId}
				  AND date(datetime(ar.date_begin, 'unixepoch')) = ${date}
				GROUP BY rr.source_ip, rr.header_from, rr.spf_domain, rr.dkim_domain, rr.spf_aligned, rr.dkim_aligned, rr.disposition
				ORDER BY count DESC
			`);
		},

		async daySummary(domainId: number, date: string): Promise<DayReportSummary | null> {
			const rows = await db.all<DayReportSummary>(sql`
				SELECT
					COALESCE(SUM(total_count), 0) AS total,
					COALESCE(SUM(pass_count),  0) AS passed,
					COALESCE(SUM(fail_count),  0) AS failed
				FROM aggregate_reports
				WHERE workspace_id = ${A}
				  AND domain_id = ${domainId} AND ${C('aggregate_reports')}
				  AND date(datetime(date_begin, 'unixepoch')) = ${date}
			`);
			return rows[0] ?? null;
		},

		exportData(domainId: number) {
			return db.all<ExportRow>(sql`
				SELECT
					date(datetime(ar.date_begin, 'unixepoch')) AS date,
					ar.org_name,
					ar.total_count,
					ar.pass_count,
					ar.fail_count,
					rr.source_ip,
					rr.header_from,
					rr.spf_result,
					rr.spf_domain,
					rr.dkim_result,
					rr.dkim_domain,
					rr.count AS record_count,
					rr.disposition,
					CASE WHEN ${C('ar')} THEN 1 ELSE 0 END AS counted
				FROM aggregate_reports ar
				LEFT JOIN report_records rr ON rr.report_id = ar.id AND rr.workspace_id = ${A}
				WHERE ar.workspace_id = ${A} AND ar.domain_id = ${domainId}
				ORDER BY ar.date_begin DESC, rr.count DESC
			`);
		},

		async checkSummary(domainId: number, since: number): Promise<DomainCheckSummary | null> {
			const rows = await db.all<DomainCheckSummary>(summarySql(A, C, since, sql`AND d.id = ${domainId}`, sql``));
			const row = rows[0];
			if (!row) return null;
			return { ...row, ...classFields((await failedByClassByDomain({ fromId: domainId, toId: domainId }, since)).get(domainId)) };
		},

		/**
		 * checkSummary for every live domain in the workspace, by id, a page at a time (`afterId` is the last id of the previous
		 * page). One query for the overview instead of one request per domain.
		 */
		async checkSummaries(since: number, page: { afterId?: number; limit: number }): Promise<DomainCheckSummary[]> {
			const rows = await db.all<DomainCheckSummary>(summarySql(A, C, since, sql`AND d.evicted_at IS NULL AND d.id > ${page.afterId ?? 0}`, sql`ORDER BY d.id LIMIT ${page.limit}`));
			if (rows.length === 0) return rows;
			const classes = await failedByClassByDomain({ fromId: rows[0].domain_id, toId: rows[rows.length - 1].domain_id }, since);
			return rows.map((r) => ({ ...r, ...classFields(classes.get(r.domain_id)) }));
		},

		// ── TLS-RPT ───────────────────────────────────────────────

		insertTls(r: NewTlsReport) {
			return db
				.insert(tlsReports)
				.values({ ...r, workspace_id: workspaceId })
				.onConflictDoUpdate({
					target: [tlsReports.domain_id, tlsReports.org_name, tlsReports.date_begin],
					set: {
						total_success: sql`excluded.total_success`,
						total_failure: sql`excluded.total_failure`,
						failure_details: sql`excluded.failure_details`,
						raw_json: sql`excluded.raw_json`,
					},
				})
				.run();
		},

    /** Bounded source references; summary and observed dates cover the entire selected range. */
    async evidence(domainId: number, since: number, until: number) {
      const [dmarc, tls, dmarcSummary, tlsSummary, dmarcDates, tlsDates] = await Promise.all([
        db.all<ReportEvidenceRow>(sql`SELECT id, CASE WHEN reporter_identity IS NOT NULL AND substr(report_id, 1, length(reporter_identity) + 1) = reporter_identity || '|' THEN substr(report_id, length(reporter_identity) + 2) ELSE report_id END AS source_report_id, org_name AS reporter, date_begin, date_end, created_at, total_count, pass_count, fail_count FROM aggregate_reports WHERE workspace_id = ${A} AND domain_id = ${domainId} AND date_begin >= ${since} AND date_begin <= ${until} AND ${C('aggregate_reports')} ORDER BY date_begin DESC, id DESC LIMIT 201`),
        db.all<ReportEvidenceRow>(sql`SELECT id, NULL AS source_report_id, org_name AS reporter, date_begin, date_end, created_at, total_success + total_failure AS total_count, total_success AS pass_count, total_failure AS fail_count FROM tls_reports WHERE workspace_id = ${A} AND domain_id = ${domainId} AND date_begin >= ${since} AND date_begin <= ${until} ORDER BY date_begin DESC, id DESC LIMIT 201`),
        db.all<EvidenceSummaryRow>(sql`SELECT COUNT(*) AS report_count, MAX(date_end) AS latest_period_end, MAX(created_at) AS latest_received_at FROM aggregate_reports WHERE workspace_id = ${A} AND domain_id = ${domainId} AND date_begin >= ${since} AND date_begin <= ${until} AND ${C('aggregate_reports')}`),
        db.all<EvidenceSummaryRow>(sql`SELECT COUNT(*) AS report_count, MAX(date_end) AS latest_period_end, MAX(created_at) AS latest_received_at FROM tls_reports WHERE workspace_id = ${A} AND domain_id = ${domainId} AND date_begin >= ${since} AND date_begin <= ${until}`),
        db.all<{ day: string }>(sql`SELECT DISTINCT date(date_begin, 'unixepoch') AS day FROM aggregate_reports WHERE workspace_id = ${A} AND domain_id = ${domainId} AND date_begin >= ${since} AND date_begin <= ${until} AND ${C('aggregate_reports')} ORDER BY day`),
        db.all<{ day: string }>(sql`SELECT DISTINCT date(date_begin, 'unixepoch') AS day FROM tls_reports WHERE workspace_id = ${A} AND domain_id = ${domainId} AND date_begin >= ${since} AND date_begin <= ${until} ORDER BY day`),
      ]);
      const source = (rows: ReportEvidenceRow[], summary: EvidenceSummaryRow[], dates: { day: string }[]) => ({
        observations: rows.slice(0, 200), truncated: rows.length > 200,
        report_count: summary[0]?.report_count ?? 0,
        latest_period_end: summary[0]?.latest_period_end ?? null,
        latest_received_at: summary[0]?.latest_received_at ?? null,
        observed_dates: dates.map(row => row.day),
      });
      return { dmarc: source(dmarc, dmarcSummary, dmarcDates), tls: source(tls, tlsSummary, tlsDates) };
    },

		async tlsSummary(domainId: number, since: number, until?: number) {
			const rows = await db.all<{ total_success: number; total_failure: number; report_count: number }>(sql`
				SELECT
					COALESCE(SUM(total_success), 0) AS total_success,
					COALESCE(SUM(total_failure), 0) AS total_failure,
					COUNT(*) AS report_count
				FROM tls_reports
				WHERE workspace_id = ${A} AND domain_id = ${domainId} AND date_begin >= ${since}
				${until === undefined ? sql`` : sql`AND date_begin <= ${until}`}
			`);
			return rows[0] ?? null;
		},
	};
}
