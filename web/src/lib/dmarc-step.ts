import { dmarcSteps, hostedInForce, policyInForce, publicSuffixParent, type DmarcEvidence, type DmarcStep, type PolicyInForce, type ReportsRefusal, type StepWho } from '@ready-set-mail/dns-checks/dmarc-next-step';
import { hasReportAddress } from './dmarc-record';
import { emptyReportsMessage, emptyReportsState, type ReportVisibilityFields } from './uncounted';
import type { Domain, DomainCheckSummary } from './types';

/**
 * The dashboard's side of the one DMARC rule (packages/dns-checks/src/dmarc-next-step.ts): the overview row and the domain
 * page both build the policy in force and the evidence here, from the same stored summary, and render the same steps.
 */
export const WHO_WORDS: Record<StepWho, string> = {
	dns: 'You or your DNS manager',
	providers: 'You and your email providers',
	approver: 'An owner or admin',
	you: 'You',
	nobody: 'Nobody',
};

/** The policy in force from the stored summary; a hosted domain's comes from the record we serve (`hostedPolicy`). */
export function forceFor(name: string, s: Pick<DomainCheckSummary, 'dmarc_policy' | 'dmarc_issue' | 'dmarc_inherited_from' | 'dmarc_pct' | 'dmarc_p' | 'dmarc_sp' | 'dmarc_rua'>, opts: { read: boolean; hosted?: { policy: string | null; reportsConnected: boolean } }): PolicyInForce {
	if (opts.hosted) {
		const p = opts.hosted.policy;
		return p === 'none' || p === 'quarantine' || p === 'reject' ? hostedInForce(name, p, opts.hosted.reportsConnected) : { kind: 'none' };
	}
	return policyInForce(name, s, opts.read);
}

/**
 * Report evidence for one domain: without a reports address no pass share is used (old totals are not a current claim).
 * `extra.visibility`: the server's report-visibility fields, so an empty window that still had reports (dropped, limited,
 * not counted) is said as such (emptyReportsState), never as "none arrived". `extra.alignment`: the governing record's
 * adkim=/aspf=, read live, so an offered record of the name's own keeps them.
 */
export function evidenceFor(
	domain: Pick<Domain, 'rua_address'>,
	reports: { total: number; passed: number; days: number } | null | undefined,
	suffixParent?: string | null,
	extra: { visibility?: ReportVisibilityFields | null; alignment?: DmarcEvidence['alignment']; reportsRefusal?: ReportsRefusal | null } = {},
): DmarcEvidence {
	const emptyReportsNote = reports && reports.total === 0 && emptyReportsState(0, extra.visibility) !== 'none' ? emptyReportsMessage(0, extra.visibility) : null;
	return {
		reportsAddress: hasReportAddress(domain.rua_address),
		ruaAddress: domain.rua_address,
		reports: reports ? { total: reports.total, passed: reports.passed, days: reports.days } : reports,
		suffixParent: suffixParent ?? null,
		alignment: extra.alignment ?? null,
		reportsRefusal: extra.reportsRefusal ?? null,
		emptyReportsNote,
	};
}

export type { ReportsRefusal };

/** Why reports cannot be connected for a domain, from the server's per-domain answer in its summary (null: they can, or not known). */
export function reportsRefusalOf(s: Pick<DomainCheckSummary, 'report_connect'> | null | undefined): ReportsRefusal | null {
	const c = s?.report_connect;
	return c && !c.can_connect && c.refusal_kind ? { kind: c.refusal_kind, reason: c.refusal ?? '' } : null;
}

/** Where a step happens, as a dashboard link. A change at a listed parent opens the parent's page. */
export function stepLink(step: DmarcStep, page: string, parentId?: number): string | undefined {
	switch (step.where) {
		case 'parent':
			// A parent that is not in this workspace has no page here: no link (the domain page offers to add it).
			return parentId !== undefined ? `/domains/${parentId}` : undefined;
		case 'dmarc-wizard':
			return `${page}/dmarc-wizard`;
		case 'dmarc-setup':
			return `${page}/setup/4`;
		case 'senders':
			return `${page}/analytics`;
		case 'self':
		case 'connect-reports':
		case 'recheck':
		case 'reload-reports':
			return page;
		default:
			return undefined;
	}
}

/** The same public-suffix rule the agent tools use (packages/dns-checks/src/dmarc-next-step.ts). */
export const suffixParentOf = publicSuffixParent;

export { dmarcSteps };
export type { DmarcStep, PolicyInForce };
