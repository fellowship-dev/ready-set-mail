import { dmarcSteps, hostedInForce, policyInForce, publicSuffixParent, type DmarcEvidence, type DmarcStep, type PolicyInForce, type ReportsRefusal, type StepWho } from '@ready-set-mail/dns-checks/dmarc-next-step';
import { dmarcEvidenceFor, reportsRefusalOf as refusalOfConnect } from '@ready-set-mail/dns-checks/dmarc-evidence';
import { storageDropNotice, type ReportVisibilityFields } from './uncounted';
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
 * Report evidence for one domain, from the ONE builder the agent tools use too (packages/dns-checks/src/dmarc-evidence.ts):
 * the dashboard only localises the time in a dropped-report sentence. `extra.visibility`: the server's report-visibility
 * fields; `extra.alignment`: the governing record's adkim=/aspf=, read live; `extra.reportsRefusal`: from `report_connect`.
 */
export function evidenceFor(
	domain: Pick<Domain, 'rua_address'>,
	reports: { total: number; passed: number; days: number } | null | undefined,
	suffixParent?: string | null,
	extra: { visibility?: ReportVisibilityFields | null; alignment?: DmarcEvidence['alignment']; reportsRefusal?: ReportsRefusal | null; nameExists?: boolean | null; failedNotYours?: number | null } = {},
): DmarcEvidence {
	return dmarcEvidenceFor({
		ruaAddress: domain.rua_address,
		reports,
		suffixParent,
		visibility: extra.visibility,
		alignment: extra.alignment,
		reportsRefusal: extra.reportsRefusal ?? null,
		nameExists: extra.nameExists,
		failedNotYours: extra.failedNotYours,
		dropText: (d) => storageDropNotice(d),
	});
}

export type { ReportsRefusal };

/** Why reports cannot be connected for a domain, from the server's per-domain answer in its summary (null: they can, or not known). */
export function reportsRefusalOf(s: Pick<DomainCheckSummary, 'report_connect'> | null | undefined): ReportsRefusal | null {
	return refusalOfConnect(s?.report_connect);
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
