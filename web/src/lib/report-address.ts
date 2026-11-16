import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { domainKeys, invalidateDomain, setupStatusKey } from './domain-queries';
import { HOSTED_CONFIG_KEY } from './hosted';
import { reportsRefusalOf, type ReportsRefusal } from './dmarc-step';
import { useHosted } from './session';
import { useCheckSummary } from './domain-queries';
import type { ReportVisibilityFields } from './uncounted';

/**
 * Connecting a domain's DMARC reports on the hosted service (GET/POST/DELETE /api/domains/:id/report-address): one
 * fixed address for every domain. Dormant unless GET /api/hosted/config says `reports: true` (MODE=saas with INTAKE_DOMAIN).
 * Every field mirrors src/hosted/report-address.ts; the plan comes from packages/dns-checks/src/dmarc-rua.ts.
 */
export type ReportAddressState = 'not_connected' | 'not_published' | 'written' | 'waiting' | 'receiving' | 'unknown';

export interface RecordOption {
	/** The published entry (one of the first two) that ours replaces. */
	replaces: string;
	record: string;
}

/** What Apply would do, from src/hosted/report-address.ts (`ReportRecordOutcome`): the server builds every record shown here, the browser sends none. */
export type ReportRecordOutcome =
	| { kind: 'write'; action: 'create' | 'update'; after: string; reason: string }
	| { kind: 'present'; reason: string }
	| { kind: 'choose'; existing: string[]; options: { replaces: string; after: string }[]; reason: string }
	| { kind: 'blocked'; reason: string };

/** The live record as Cloudflare holds it, what Apply does about it, and the hash the apply must carry (`ReportRecordReview`). */
export interface ReportRecordReview {
	source: 'cloudflare' | 'public_dns';
	name: string;
	address: string;
	now: string | null;
	inherited: { from: string; record: string } | null;
	hash: string;
	outcome: ReportRecordOutcome;
}

/** Which of the two choices the person made: add ours after the addresses there, or replace one of the first two (as published). */
export type ReportChoice = { kind: 'add' } | { kind: 'replace'; address: string };

export type OwnPlan =
	| { kind: 'published'; name: string; record: string }
	| { kind: 'add'; name: string; current: string | null; record: string; created: boolean }
	| { kind: 'choose'; name: string; current: string | null; existing: string[]; options: RecordOption[]; created: boolean };

export type ReportAddressPlan =
	| OwnPlan
	| { kind: 'multiple'; name: string; records: string[] }
	| { kind: 'invalid'; name: string; record: string; issues: string[] }
	| { kind: 'inherited'; from: string; parent_record: string; policy: string; policy_tag: 'sp' | 'p'; parent_has_address: boolean; own: OwnPlan };

export interface ReportAddressView {
	available: true;
	domain_id: number;
	domain: string;
	managed_by: 'hosted_records' | null;
	can_connect: boolean;
	refusal: string | null;
	address: string | null;
	connected_at: number | null;
	/** The newest COUNTED report since connecting; counted reports, and all reports, since then; reports before this connection. */
	last_report_at: number | null;
	counted_since_connect: number;
	reports_since_connect: number;
	reports_before_connect: number;
	visibility?: ReportVisibilityFields | null;
	state: ReportAddressState;
	dns: { checked_at: number; error: string | null; plan: ReportAddressPlan | null } | null;
	/** A Cloudflare connection reaches this domain's zone, so Apply can write its DMARC record. */
	apply_via_cloudflare?: boolean;
	/** Apply reaches the zone: the record in the zone now, what Apply does about it, and the hash the apply carries. */
	review?: ReportRecordReview | null;
	parent?: { domain_id: number; domain: string; connected: boolean } | null;
}

export type ReportIntakeStatus = { available: false } | ReportAddressView;

export const reportAddressKey = (id: number) => [...domainKeys.all(id), 'report-address'] as const;

/** Can this deployment issue report addresses? Shares the hosted-config query; any failure counts as "no". */
export function useReportIntakeEnabled(): boolean {
	const q = useQuery({
		queryKey: HOSTED_CONFIG_KEY,
		queryFn: () => api<{ enabled: boolean; reports?: boolean; records?: boolean }>('/api/hosted/config'),
		staleTime: Infinity,
		retry: false,
	});
	return q.data?.enabled === true && q.data.reports === true;
}

/**
 * Why reports cannot be connected for `domainId`, from the domain's own summary (`report_connect` on
 * GET /api/domains/:id/check-summary), the same server decision the overview's batch gives each row, so the overview and the
 * domain page decide each domain the same way without a single-domain screen loading the whole batch.
 * `pending` while it loads. No refusal on a self-hosted instance, or when the summary could not be loaded.
 */
export function useReportsRefusal(domainId: number, enabled = true): { pending: boolean; refusal: ReportsRefusal | null } {
	// Self-hosted: no hosted report intake, so nothing is refused (the server sends report_connect null there).
	const hosted = useHosted();
	const summary = useCheckSummary(domainId, hosted && enabled);
	if (!hosted || !enabled) return { pending: false, refusal: null };
	if (summary.isPending) return { pending: true, refusal: null };
	return { pending: false, refusal: reportsRefusalOf(summary.data) };
}

export function useReportAddress(domainId: number, enabled = true) {
	return useQuery({
		queryKey: reportAddressKey(domainId),
		queryFn: () => api<ReportIntakeStatus>(`/api/domains/${domainId}/report-address`),
		enabled,
		// The state is live DNS plus stored reports: a screen that mounts shows what is true now, not what a screen before it read.
		refetchOnMount: 'always',
	});
}

export function useReportAddressMutations(domainId: number) {
	const qc = useQueryClient();
	const base = `/api/domains/${domainId}/report-address`;
	// The new status is the truth at once; the domain list (rua_address) and every per-domain view refresh after.
	const settle = (s: ReportIntakeStatus) => {
		qc.setQueryData(reportAddressKey(domainId), s);
		void invalidateDomain(qc, domainId);
		// A setup step reads the domain's report address from its own status: connecting or disconnecting changes what it says.
		void qc.invalidateQueries({ queryKey: setupStatusKey(domainId) });
	};
	const connect = useMutation({ mutationFn: () => api<ReportIntakeStatus>(base, { method: 'POST', body: {} }), onSuccess: settle });
	const disconnect = useMutation({ mutationFn: () => api<ReportIntakeStatus>(base, { method: 'DELETE' }), onSuccess: settle });
	// The one write of our address into a DMARC record: the reviewed hash and the choice, never a record. 409 `record_changed` carries the fresh review (ApiError.body).
	const apply = useMutation({
		mutationFn: (input: { reviewed: string; choice: ReportChoice }) => api<{ ok: boolean; wrote: boolean; status: ReportIntakeStatus }>(`${base}/apply`, { method: 'POST', body: input }),
		onSuccess: (out) => settle(out.status),
		// Whatever the outcome (a failed write can still have connected the reports), the status is read again.
		onError: () => void invalidateDomain(qc, domainId),
	});
	return { connect, disconnect, apply };
}

/** "Check again": read the live DNS again everywhere this domain's reports are shown, the setup step's status included. */
export function useCheckReportsAgain(domainId: number) {
	const qc = useQueryClient();
	return () => {
		void qc.invalidateQueries({ queryKey: reportAddressKey(domainId) });
		void qc.invalidateQueries({ queryKey: setupStatusKey(domainId) });
	};
}
