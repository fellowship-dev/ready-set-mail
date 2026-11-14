import type { StatusKind } from '@ready-set-mail/ui';
import type { HostedLevelInput } from '../levels';
import type { Domain, DomainCheckSummary } from '../types';
import { domainVerdict, totalsFromSummary, type DomainVerdict } from '../verdict';

export interface Recommendation {
	domain: string;
	severity: 'critical' | 'warning' | 'info';
	message: string;
}

/** What the overview knows about a domain besides its summary, so the PDF's verdict is the overview's. */
export interface PdfDomainContext {
	domain: Pick<Domain, 'id' | 'domain' | 'rua_address'>;
	hosted: HostedLevelInput | null;
	hostedMode?: boolean;
	idByName?: ReadonlyMap<string, number>;
	suffixParent?: string | null;
	reportsAvailable?: boolean;
}

const SEVERITY: Record<StatusKind, Recommendation['severity'] | null> = {
	attention: 'critical',
	improve: 'warning',
	approval: 'warning',
	unknown: 'warning',
	gathering: 'info',
	prepared: 'info',
	note: 'info',
	verified: null,
};

function passRate(pass: number, total: number): number | null {
	if (total === 0) return null;
	return pass / total;
}

/** The domain's verdict, exactly as the overview row computes it (the shared DMARC rule, report visibility included). */
export function pdfVerdict(summary: DomainCheckSummary, ctx: PdfDomainContext): DomainVerdict {
	return domainVerdict(ctx.domain, summary, totalsFromSummary(summary), ctx.hosted, undefined, { hostedMode: ctx.hostedMode, idByName: ctx.idByName, suffixParent: ctx.suffixParent ?? null, reportsAvailable: ctx.reportsAvailable });
}

export function getRecommendations(summary: DomainCheckSummary, ctx: PdfDomainContext): Recommendation[] {
	const recs: Recommendation[] = [];

	// DMARC, its policy and its reports: the overview's verdict in its own words (what is true now, the evidence, the next
	// step), never rules of the PDF's own. A verified domain needs no recommendation.
	const v = pdfVerdict(summary, ctx);
	const severity = SEVERITY[v.status];
	if (severity) {
		recs.push({ domain: summary.domain, severity, message: [v.sentence, v.evidence, `Next: ${v.next.label}.`].filter(Boolean).join(' ') });
	}

	// SPF pass rate
	const spfRate = passRate(summary.spf_pass, summary.spf_total);
	if (spfRate !== null && spfRate < 0.9) {
		recs.push({
			domain: summary.domain,
			severity: 'warning',
			message: `SPF pass rate is ${Math.round(spfRate * 100)}%. Ensure all sending services are included in your SPF record.`,
		});
	}

	// DKIM pass rate
	const dkimRate = passRate(summary.dkim_pass, summary.dkim_total);
	if (dkimRate !== null && dkimRate < 0.9) {
		recs.push({
			domain: summary.domain,
			severity: 'warning',
			message: `DKIM pass rate is ${Math.round(dkimRate * 100)}%. Verify DKIM signing is configured for all sending services.`,
		});
	}

	// MTA-STS not enabled
	if (!summary.mta_sts_enabled) {
		recs.push({
			domain: summary.domain,
			severity: 'info',
			message: 'MTA-STS is not enabled. Enabling it forces TLS for inbound mail delivery.',
		});
	}

	return recs;
}

/** `contexts[i]` belongs to `summaries[i]`. */
export function getAllRecommendations(summaries: DomainCheckSummary[], contexts: readonly PdfDomainContext[]): Recommendation[] {
	return summaries.flatMap((s, i) => getRecommendations(s, contexts[i] ?? { domain: { id: s.domain_id, domain: s.domain, rua_address: '' }, hosted: null }));
}
