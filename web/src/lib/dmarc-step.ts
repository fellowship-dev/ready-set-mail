import { dmarcSteps, hostedInForce, policyInForce, type DmarcEvidence, type DmarcStep, type PolicyInForce, type StepWho } from '@ready-set-mail/dns-checks/dmarc-next-step';
import { hasReportAddress } from './dmarc-record';
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

/** Report evidence for one domain: without a reports address no pass share is used (old totals are not a current claim). */
export function evidenceFor(domain: Pick<Domain, 'rua_address'>, reports: { total: number; passed: number; days: number } | null | undefined, suffixParent?: string | null): DmarcEvidence {
	return { reportsAddress: hasReportAddress(domain.rua_address), ruaAddress: domain.rua_address, reports: reports ? { total: reports.total, passed: reports.passed, days: reports.days } : reports, suffixParent: suffixParent ?? null };
}

/** Where a step happens, as a dashboard link. A change at a listed parent opens the parent's page. */
export function stepLink(step: DmarcStep, page: string, parentId?: number): string | undefined {
	switch (step.where) {
		case 'parent':
			return parentId !== undefined ? `/domains/${parentId}` : page;
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

/**
 * A listed parent whose own DMARC record does not cover this name (the parent is a public suffix such as gov.uk, so the
 * name is its own organization): only when the name has no record of its own and inherits none.
 */
export function suffixParentOf(
	s: Pick<DomainCheckSummary, 'dmarc_policy' | 'dmarc_issue' | 'dmarc_inherited_from' | 'dns_checked_at'> | null | undefined,
	parent: { domain: string; summary: Pick<DomainCheckSummary, 'dmarc_policy' | 'dmarc_inherited_from'> | null | undefined } | null | undefined,
): string | null {
	if (!s || !parent?.summary || !s.dns_checked_at) return null;
	const covered = !!s.dmarc_policy || !!s.dmarc_issue || !!s.dmarc_inherited_from;
	const parentOwn = !!parent.summary.dmarc_policy && !parent.summary.dmarc_inherited_from;
	return !covered && parentOwn ? parent.domain : null;
}

export { dmarcSteps };
export type { DmarcStep, PolicyInForce };
