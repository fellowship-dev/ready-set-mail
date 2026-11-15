/**
 * What the dashboard says on the first day (spec D1), replacing the "Get to your first answer" stepper. One state for the domain the
 * first run was about, from what the server already knows: whether the domain is proven, whether reports can reach this workspace,
 * whether its DMARC record names our report address, and whether any report has arrived. Never from a page that was visited.
 */
import { hasReportAddress } from './dmarc-record';
import type { Domain, DomainCheckSummary } from './types';

/** Days after which "no reports yet" stops being normal and says what to check. */
export const QUIET_AFTER_DAYS = 3;

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
	| { kind: 'live'; domain: string; readAt: number | null }
	/** Records live and nothing after QUIET_AFTER_DAYS days. */
	| { kind: 'quiet'; domain: string; domainId: number; readAt: number | null }
	/** The first reports are in. Shown once. */
	| { kind: 'arrived'; domain: string; total: number; passed: number };

export interface FirstDayInput {
	/** The domain the first run was about (focusDomainOf), if the workspace has one. */
	domain: Pick<Domain, 'id' | 'domain' | 'rua_address' | 'created_at' | 'cf_account_id' | 'verified_via' | 'proof_lost_at'> | undefined;
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

const unproven = (d: NonNullable<FirstDayInput['domain']>) => d.verified_via === 'legacy' || !!d.proof_lost_at;

/** The state to show, or null when the dashboard should show nothing extra (loading, or the normal overview takes over). */
export function firstDay(i: FirstDayInput): FirstDay | null {
	const waiting = i.claims.find((c) => c.status === 'pending');
	if (!i.domain) return waiting ? { kind: 'proof', domain: waiting.domain, lost: false } : { kind: 'empty' };
	const d = i.domain;
	if (unproven(d)) return { kind: 'proof', domain: d.domain, lost: true };
	const s = i.summary;
	if (!s) return null; // still loading, or its facts failed: say nothing rather than guess
	if (s.total_messages > 0) return i.arrivedSeen ? null : { kind: 'arrived', domain: d.domain, total: s.total_messages, passed: s.pass_messages };
	const refused = s.report_connect && !s.report_connect.can_connect;
	// Not connected and not refusable (self-host with no reports address, hosted before the address is written): reports are off only when they cannot be connected.
	if (refused || (!s.report_connect && !hasReportAddress(d.rua_address))) return { kind: 'reports_off', domain: d.domain, reason: refused ? (s.report_connect?.refusal ?? null) : null };
	if (s.dmarc_rua !== 1 || !hasReportAddress(d.rua_address)) return { kind: 'records', domain: d.domain, domainId: d.id, viaCloudflare: !!d.cf_account_id, applied: !!i.applied };
	const now = i.now ?? Math.floor(Date.now() / 1000);
	if (now - d.created_at >= QUIET_AFTER_DAYS * 86400) return { kind: 'quiet', domain: d.domain, domainId: d.id, readAt: s.dns_checked_at };
	return { kind: 'live', domain: d.domain, readAt: s.dns_checked_at };
}
