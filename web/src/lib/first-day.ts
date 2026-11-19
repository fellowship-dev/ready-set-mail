/**
 * What the dashboard says on the first day (spec D1), replacing the "Get to your first answer" stepper. One state for the domain the
 * first run was about, from what the server already knows: whether the domain is proven, whether reports can reach this workspace,
 * whether its DMARC record names our report address, and whether any report has arrived. Never from a page that was visited.
 */
import { isUnproven, type ProofShape } from './proof';
import { hasReportAddress } from './dmarc-record';
import type { Domain, DomainCheckSummary } from './types';
import type { DomainVerdict, ReportTotals } from './verdict';

/** Days after which "no reports yet" stops being normal and says what to check. */
export const QUIET_AFTER_DAYS = 3;

/**
 * The first-day card is for the setup the person has just finished. A domain older than this is an existing account's: it keeps what the
 * overview said before (its verdict, "Not yet"), with no card on top, whether or not reports have arrived.
 */
export const FIRST_RUN_WINDOW_DAYS = 14;

export type FirstDay =
	/** No domain and no claim: the one thing to do. */
	| { kind: 'empty' }
	/** Waiting for the DNS record that proves the domain is ours (a claim, or a proof that lapsed). */
	| { kind: 'proof'; domain: string; lost: boolean }
	/** Reports cannot reach this workspace (HOSTED_CONNECT_REPORTS, or no intake): DNS checks run, reports do not. `reason` is the server's own words. */
	| { kind: 'reports_off'; domain: string; reason: string | null }
	/** Waiting for the DMARC record to name our report address. */
	| { kind: 'records'; domain: string; domainId: number; viaCloudflare: boolean; /** The change was written to Cloudflare from the review: the record is there, public DNS has not shown it yet. */ applied: boolean }
	/** Records live, no report yet. */
	| { kind: 'live'; domain: string; domainId: number; readAt: number | null }
	/** Records live and nothing after QUIET_AFTER_DAYS days. */
	| { kind: 'quiet'; domain: string; domainId: number; readAt: number | null }
	/** The first reports are in. Shown once. */
	| { kind: 'arrived'; domain: string; total: number; passed: number };

export interface FirstDayInput {
	/** The domain the first run was about (focusDomainOf), if the workspace has one. */
	domain: (Pick<Domain, 'id' | 'domain' | 'rua_address' | 'created_at' | 'cf_account_id'> & ProofShape) | undefined;
	/** Pending claims in this workspace (open, unproven). */
	claims: Array<{ domain: string; status: string }>;
	/** The domain's stored facts and 30-day totals. Undefined while loading, null when they failed. */
	summary: DomainCheckSummary | null | undefined;
	/** Whether the person already dismissed the "first reports" card. */
	arrivedSeen: boolean;
	/** The review (C2) was applied from this browser. */
	applied?: boolean;
	now?: number;
}


/** The state to show, or null when the dashboard should show nothing extra (loading, or the normal overview takes over). */
export function firstDay(i: FirstDayInput): FirstDay | null {
	const waiting = i.claims.find((c) => c.status === 'pending');
	if (!i.domain) return waiting ? { kind: 'proof', domain: waiting.domain, lost: false } : { kind: 'empty' };
	const d = i.domain;
	if (isUnproven(d)) return { kind: 'proof', domain: d.domain, lost: true };
	const now = i.now ?? Math.floor(Date.now() / 1000);
	if (now - d.created_at >= FIRST_RUN_WINDOW_DAYS * 86400) return null;
	const s = i.summary;
	if (!s) return null; // still loading, or its facts failed: say nothing rather than guess
	if (s.total_messages > 0) return i.arrivedSeen ? null : { kind: 'arrived', domain: d.domain, total: s.total_messages, passed: s.pass_messages };
	const refused = s.report_connect && !s.report_connect.can_connect;
	// Not connected and not refusable (self-host with no reports address, hosted before the address is written): reports are off only when they cannot be connected.
	if (refused || (!s.report_connect && !hasReportAddress(d.rua_address))) return { kind: 'reports_off', domain: d.domain, reason: refused ? (s.report_connect?.refusal ?? null) : null };
	if (s.dmarc_rua !== 1 || !hasReportAddress(d.rua_address)) return { kind: 'records', domain: d.domain, domainId: d.id, viaCloudflare: !!d.cf_account_id, applied: !!i.applied };
	if (now - d.created_at >= QUIET_AFTER_DAYS * 86400) return { kind: 'quiet', domain: d.domain, domainId: d.id, readAt: s.dns_checked_at };
	return { kind: 'live', domain: d.domain, domainId: d.id, readAt: s.dns_checked_at };
}


/** A domain's first day, for what the overview says about it: 72 hours from when it was added. */
export const DAY_ONE_SECONDS = 72 * 3600;

const joinList = (parts: string[]) => (parts.length < 2 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);

/** Reports can arrive at this name: it has a report address of its own (or the one it follows, which the list carries as its own). */
export const reportsConnected = (d: Partial<Pick<Domain, 'rua_address'>>): boolean => !!d.rua_address?.trim();

/**
 * "No red on day one" (owner's rule): until a domain's first report arrives, and for its first 72 hours, the overview row says it is
 * waiting for reports. What is missing is "to fix after reports", in the neutral state, never "Needs attention" or red.
 * Only the overview row and its sentence change; the domain page's own "Do this next" is computed elsewhere and untouched.
 *
 * Real failures keep their words: a name that does not resolve, DNS checks that fail, a proof that lapsed, a domain whose facts could not
 * be read. Anything already neutral (Unknown, gathering, verified) stays as it is.
 */
export function dayOneVerdict(
	v: DomainVerdict,
	domain: Pick<Domain, 'created_at'> & Partial<Pick<Domain, 'rua_address'>> & ProofShape,
	s: DomainCheckSummary | null | undefined,
	totals: ReportTotals | null | undefined,
	now = Math.floor(Date.now() / 1000),
): DomainVerdict {
	if (!s || !totals || totals.total > 0) return v;
	if (v.status !== 'attention' && v.status !== 'improve' && v.status !== 'approval') return v;
	if (now - domain.created_at >= DAY_ONE_SECONDS || isUnproven(domain)) return v;
	if (s.dns_check_status === 'failed' || s.dns_check_status === 'nxdomain' || s.dns_last_good_status === 'nxdomain' || s.dmarc_issue) return v;
	const missing = [!s.spf_record ? 'SPF' : null, !s.dmarc_policy ? 'DMARC' : null].filter((x): x is string => !!x);
	return {
		...v,
		status: 'gathering',
		sentence: !reportsConnected(domain)
			? `Reports are not connected, so none will arrive.${missing.length > 0 ? ` ${joinList(missing.map((m) => `${m} is not published`))}.` : ''}`
			: missing.length > 0 ? `Waiting for reports. To fix after reports: ${joinList(missing.map((m) => `${m} is not published`))}.` : 'Waiting for reports. They usually arrive within a day or two.',
		evidence: null,
		next: { label: 'Nothing to do yet', who: 'Nobody' },
	};
}


/** The workspace sentence while every domain is on its first day: no "Not yet" and nothing to fix yet. Null when any domain is not. */
export function dayOneAnswer(rows: Array<{ name: string; verdict: DomainVerdict | null; dayOne: boolean; connected?: boolean }>): string | null {
	if (rows.length === 0 || rows.some((r) => !r.verdict || !r.dayOne)) return null;
	const some = rows.some((r) => r.connected !== false);
	// Reports that are not connected cannot arrive: say that, never "waiting".
	if (!some) return rows.length === 1 ? `No reports can arrive for ${rows[0]!.name} yet: reports are not connected.` : `No reports can arrive for ${rows.length} new domains yet: reports are not connected.`;
	if (rows.some((r) => r.connected === false)) return null;
	return rows.length === 1 ? `Waiting for the first reports on ${rows[0]!.name}. They usually arrive within a day or two.` : `Waiting for the first reports on ${rows.length} new domains. They usually arrive within a day or two.`;
}

/** A domain on its first day with no report yet: the overview shows no level ladder for it (it appears with the first report). Facts unknown: not first day. */
export function onFirstDay(d: Pick<Domain, 'created_at'>, totals: ReportTotals | null | undefined, now = Math.floor(Date.now() / 1000)): boolean {
	return !!totals && totals.total === 0 && now - d.created_at < DAY_ONE_SECONDS;
}

/** A real failure that stops progress, said as one compact line inside the first-day card (the full block stays below it). */
export type Blocker = { kind: 'connection'; label: string; count: number } | { kind: 'proof'; domain: string };

/**
 * What truly blocks: a Cloudflare connection that stopped or was revoked, or a domain whose proof lapsed. Anything that merely waits (a record, a first report) is
 * not a blocker. Connection first: with it nothing can be written to DNS at all.
 */
export function blockerOf(brokenConnections: Array<{ label: string }>, domains: Array<Pick<Domain, 'domain'> & ProofShape>): Blocker | null {
	if (brokenConnections.length > 0) return { kind: 'connection', label: brokenConnections[0]!.label, count: brokenConnections.length };
	const lost = domains.find(isUnproven);
	return lost ? { kind: 'proof', domain: lost.domain } : null;
}
