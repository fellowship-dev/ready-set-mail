import { statusRank, type StatusKind } from '@ready-set-mail/ui';
import { isDkimRecord } from '@ready-set-mail/dns-checks/dkim';
import { isRevokedDkimKey } from './dkim';
import { dkimWildcardSummary } from './dkim-wildcard';
import { invalidDmarcSp, parseDmarcPolicy } from './dmarc-record';
import { recordAlignment } from './dmarc-coverage';
import { stepLink, type DmarcStep } from './dmarc-step';
import type { DnsCheck, OnboardingResult } from './domain-queries';
import { SPF_LOOKUP_LIMIT, spfLookupJudgement } from '@ready-set-mail/dns-checks/spf-record';
import { didNotResolve, type HostedLevelInput } from './levels';
import type { Domain, DomainCheckSummary, FailingSource } from './types';
import { WHO, dmarcStepsFor, exactRate, totalsFromSummary } from './verdict';

/**
 * "Do this next" on a domain page: one to three actions, each as Do this / Why, built from what the page already
 * reads. Every item names who acts and, when there is one, where to do it. A lookup that failed is Unknown, never
 * "not found".
 *
 * DMARC comes from the one rule the overview row uses (`dmarcStepsFor`, packages/dns-checks/src/dmarc-next-step.ts),
 * on the same stored summary and 30-day report totals, refreshed by this page's live read: the two pages cannot
 * disagree. SPF, DKIM and lookup failures come from the live read.
 */
export interface DomainAction {
	key: string;
	status: StatusKind;
	/** The change, as a verb. */
	do: string;
	/** What it gets you, and the main uncertainty. */
	why: string;
	who: string;
	to?: string;
	/** Link text for `to`. */
	cta?: string;
	/** True when the action changes something in the dashboard (wizards): read-only members are not sent there. */
	writes?: boolean;
	/** For lookups that failed: run them again. */
	retry?: boolean;
	/** The exact record this step offers to publish, and where. */
	record?: string;
	recordAt?: string;
}

export interface ActionInput {
	domain: Pick<Domain, 'id' | 'domain' | 'rua_address'>;
	/** Undefined while loading, null when the request failed. */
	dns: DnsCheck | null | undefined;
	onboarding: OnboardingResult | null | undefined;
	summary: DomainCheckSummary | null | undefined;
	sources?: FailingSource[] | null;
	/** The parent domain's id when it is listed in this workspace: fixes that belong there link to its page. */
	parentId?: number;
	/**
	 * False when the stored summary was fetched before this page's live read (its facts may predate it): then nothing
	 * from it is used until the refetch lands. Default true.
	 */
	summaryFresh?: boolean;
	/** The hosted status when this domain's records are hosted (the overview reads the same). */
	hosted?: HostedLevelInput | null;
	/** A listed parent whose own record does not cover this name (a public suffix). */
	suffixParent?: string | null;
	/** False: this workspace cannot connect reports (hosted plan), so connecting is not a step for anyone here. */
	reportsAvailable?: boolean;
}

const MAX = 3;

const CTA: Partial<Record<DmarcStep['where'], string>> = {
	'dmarc-wizard': 'Review the change',
	'dmarc-setup': 'Open the DMARC step',
	senders: 'See who fails and why',
	'connect-reports': 'Connect reports',
};

/** One shared DMARC step as a page action. */
function fromStep(step: DmarcStep, page: string, parentId: number | undefined, sources: FailingSource[] | null | undefined): DomainAction {
	// The change belongs on a parent that is not in this workspace: say so and offer to add it, never a link to this page.
	if (step.where === 'parent' && parentId === undefined && step.at) {
		return {
			...fromStep({ ...step, where: 'none' }, page, parentId, sources),
			why: `${step.why} ${step.at} is not in this workspace, so its record cannot be checked or changed here.`,
			to: `/add?domain=${encodeURIComponent(step.at)}`,
			cta: `Add ${step.at} to this workspace`,
			writes: true,
		};
	}
	const to = step.where === 'recheck' || step.where === 'reload-reports' || step.where === 'self' || step.where === 'connect-reports' ? undefined : stepLink(step, page, parentId);
	const top = step.key === 'senders' && sources?.length ? ` The largest failing source is ${sources[0]!.org ?? sources[0]!.base_domain ?? sources[0]!.source_ip}.` : '';
	return {
		key: step.key,
		status: step.status,
		do: step.do,
		why: `${step.why}${top}`,
		who: WHO[step.who],
		...(to ? { to, cta: step.where === 'parent' ? (parentId !== undefined ? `Open ${step.at}` : undefined) : CTA[step.where] } : {}),
		...(step.where === 'dmarc-wizard' || step.where === 'dmarc-setup' ? { writes: true } : {}),
		...(step.where === 'recheck' || step.where === 'reload-reports' ? { retry: true } : {}),
		...(step.record ? { record: step.record, recordAt: step.recordAt } : {}),
	};
}

export function domainActions(input: ActionInput): DomainAction[] {
	const { domain, dns, onboarding, sources } = input;
	const summary = input.summaryFresh === false ? undefined : input.summary;
	const name = domain.domain;
	const page = `/domains/${domain.id}`;
	const out: DomainAction[] = [];

	if (onboarding?.nxdomain || (summary && didNotResolve(summary) === 'now')) {
		return [{ key: 'nxdomain', status: 'attention', do: 'Check the spelling, or remove this domain', why: `DNS says ${name} does not exist, so there are no SPF, DKIM or DMARC records to check.`, who: WHO.you, to: `${page}/settings`, cta: 'Open the domain settings', writes: true }];
	}

	const errors = onboarding?.dns_errors ?? [];
	const dnsFailed = dns === null || !!dns?.error;
	const spfFailed = onboarding === null || errors.some((e) => e.startsWith('spf:'));
	const dmarcFailed = dnsFailed || onboarding === null || errors.some((e) => e.startsWith('dmarc:'));
	if (dmarcFailed || spfFailed) {
		const what = [dmarcFailed ? 'DMARC' : null, spfFailed ? 'SPF' : null].filter(Boolean).join(' and ');
		out.push({ key: 'lookup', status: 'unknown', do: `Check ${what} again in a few minutes`, why: `The ${what} lookup did not complete, so we cannot tell whether the record exists. Nothing is assumed missing.`, who: WHO.you, retry: true });
	}

	// SPF, from the live read.
	if (onboarding && !spfFailed) {
		const spf = onboarding.spf;
		if (!spf.record) {
			out.push({ key: 'spf-missing', status: 'attention', do: 'Publish an SPF record that lists the services that send your mail', why: `Without it, receivers cannot tell which servers may send as ${name}.`, who: WHO.dns, to: `${page}/setup/2`, cta: 'Open the SPF step', writes: true });
		} else if (spf.lookup_count !== null && spfLookupJudgement(spf.lookup_count).level === 'over') {
			out.push({ key: 'spf-lookups', status: 'attention', do: `Bring SPF down to ${SPF_LOOKUP_LIMIT} DNS lookups or fewer`, why: `It needs ${spf.lookup_count}. Past ${SPF_LOOKUP_LIMIT}, receivers treat SPF as an error, so it stops vouching for your mail.`, who: WHO.dns, to: `${page}/spf-flatten`, cta: 'Open SPF flattening', writes: true });
		}
	}

	if (input.summary === null && !dmarcFailed) out.push({ key: 'summary-failed', status: 'unknown', do: 'Check DMARC again', why: 'What is stored about this domain could not be loaded, so its DMARC step is not known yet.', who: WHO.you, retry: true });

	// DMARC: the overview's rule on the same stored summary (stored by this page's live read) and the same 30-day totals.
	// The live read's governing record: an offered record of the name's own keeps its adkim=/aspf=, as the DNS records section does.
	const governing = onboarding?.dmarc.effective?.inherited_from ? (onboarding.dmarc.effective.record ?? null) : null;
	const dmarc = summary && !dmarcFailed ? dmarcStepsFor(domain, summary, totalsFromSummary(summary), input.hosted ?? null, input.suffixParent ?? null, governing ? recordAlignment(governing) : null, input.reportsAvailable) : null;
	const done = dmarc?.[0]?.key === 'done' ? fromStep(dmarc[0], page, input.parentId, sources) : null;
	for (const step of dmarc ?? []) if (step.key !== 'done') out.push(fromStep(step, page, input.parentId, sources));

	// The parent's sp= is present but not a valid policy: receivers ignore it and this name follows the parent's p= (the
	// policy in force above already does). Say so, with the fix.
	const eff = onboarding?.dmarc.effective;
	const badSp = eff?.inherited_from && !dmarcFailed ? invalidDmarcSp(eff.record ?? null) : null;
	if (eff?.inherited_from && badSp) {
		const p = parseDmarcPolicy(eff.record ?? null);
		out.push({
			key: 'parent-sp-invalid',
			status: 'note',
			do: `Fix sp=${badSp} at _dmarc.${eff.inherited_from}`,
			why: `${eff.inherited_from}'s DMARC record has sp=${badSp}, which is not a valid policy (none, quarantine or reject), so receivers ignore it and ${name} follows its p=${p ?? 'none'}. Set sp= to the policy you mean for its subdomains, or remove the tag.`,
			who: WHO.dns,
			...(input.parentId !== undefined ? { to: `/domains/${input.parentId}`, cta: `Open ${eff.inherited_from}` } : {}),
		});
	}

	// DKIM. DNS cannot list selectors: none found, or a wildcard answer, is Unknown, never missing. Revoked keys are
	// judged against the reports: when mail passes, the provider signs with a selector we did not check.
	const rate = summary ? exactRate(totalsFromSummary(summary)) : null;
	const dkimPasses = !!summary && summary.dkim_total > 0 && summary.dkim_pass / summary.dkim_total >= 0.95;
	if (onboarding && !errors.some((e) => e.startsWith('dkim'))) {
		const { selectors, wildcard } = onboarding.dkim;
		const revoked = selectors.filter((s) => isRevokedDkimKey(s.record)).length;
		// A TXT key main's DKIM rule accepts (not revoked), or a CNAME selector (a host name: the provider holds the key).
		const usable = selectors.filter((s) => !isRevokedDkimKey(s.record) && (isDkimRecord(s.record) || !/[=;]/.test(s.record))).length;
		if (wildcard) out.push({ key: 'dkim-wildcard', status: 'unknown', do: 'Ask your email provider which DKIM selector it signs with', why: `${dkimWildcardSummary(name)} Can't tell from public DNS whether DKIM is set up.`, who: WHO.providers });
		else if (selectors.length === 0) out.push({ key: 'dkim-unknown', status: 'unknown', do: 'Ask your email provider which DKIM selector it signs with', why: 'None of the common selectors we check has a key. Your provider may use another one, so this is not proof DKIM is missing.', who: WHO.providers });
		else if (usable === 0 && revoked > 0) {
			// Only revoked keys among the common selectors. With mail passing, the provider signs with another selector.
			if (dkimPasses || (rate !== null && rate >= 95)) {
				out.push({ key: 'dkim-revoked', status: 'note', do: `Remove the revoked DKIM ${revoked === 1 ? 'key' : 'keys'} when convenient`, why: `The ${revoked === 1 ? 'key' : 'keys'} at the common selectors ${revoked === 1 ? 'is' : 'are'} revoked (empty p=), but ${dkimPasses ? `${Math.round((summary!.dkim_pass / summary!.dkim_total) * 100)}% of reported mail passes DKIM` : 'reported mail passes DMARC'}, so your provider signs with another selector. Nothing breaks.`, who: WHO.nobody });
			} else {
				out.push({ key: 'dkim-revoked', status: 'unknown', do: 'Ask your email provider which DKIM selector it signs with', why: `Every DKIM key at the common selectors is revoked (empty p=). Your provider may sign with another selector; reports would show whether DKIM passes.`, who: WHO.providers });
			}
		} else if (usable > 0 && revoked > 0) out.push({ key: 'dkim-old', status: 'note', do: `${revoked} old DKIM ${revoked === 1 ? 'key is' : 'keys are'} revoked`, why: `${usable} other ${usable === 1 ? 'key works' : 'keys work'}, so nothing breaks. Remove the revoked ones when convenient.`, who: WHO.nobody });
	}

	// Order by consequence. When reports show mail passing, a DKIM selector DNS cannot find is not a problem in practice.
	if (rate !== null && rate >= 95) for (const a of out) if (a.key === 'dkim-unknown' || a.key === 'dkim-wildcard') a.status = 'note';
	const sorted = out.map((a, i) => [a, i] as const).sort((x, y) => statusRank(x[0].status) - statusRank(y[0].status) || x[1] - y[1]).map(([a]) => a);
	const blocking = sorted.filter((a) => a.status !== 'note');
	if (blocking.length > 0) return sorted.slice(0, MAX);
	if (actionsPending(input)) return [];
	// Notes only (for example, reports are not available on this plan): show them, never an empty list.
	if (!done) return sorted.slice(0, MAX);
	// Nothing to do: the DMARC rule said so (p=reject on all mail, evidence known) and nothing else needs a change.
	return [{ ...done, do: 'Nothing to do' }, ...sorted].slice(0, MAX);
}

/** Still reading: the list would change once DNS, onboarding or the stored summary (after the live read) answer. */
export const actionsPending = (i: Pick<ActionInput, 'dns' | 'onboarding' | 'summary' | 'summaryFresh'>) =>
	i.dns === undefined || i.onboarding === undefined || i.summary === undefined || i.summaryFresh === false;
