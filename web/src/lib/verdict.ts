import { STATUS_RANK, statusRank, type Level, type StatusKind } from '@ready-set-mail/ui';
import { inForceSentence, READY } from '@ready-set-mail/dns-checks/dmarc-next-step';
import { hasReportAddress } from './dmarc-record';
import { dmarcSteps, evidenceFor, forceFor, stepLink, WHO_WORDS, type DmarcStep } from './dmarc-step';
import { formatNumber, timeAgo } from './format';
import { applyHostedInputs, assessDomain, didNotResolve, dnsCheckLine, SPF_LOOKUP_LIMIT, type HostedLevelInput } from './levels';
import type { Domain, DomainCheckSummary } from './types';
import { HELP_PRIORITY } from '../components/TalkToMax';

/**
 * "Am I done?" for one domain, in the status vocabulary shared with the website: one state, the level under it, one
 * sentence of what is true now (scoped: public DNS, then reports), and exactly one next action with who acts.
 *
 * Built only from what the overview already loads: the stored DNS facts (refreshed by the daily monitor and every time the
 * domain page reads DNS: SPF, the effective DMARC policy with its pct= and sp=, the SPF lookup count) and the report totals.
 *
 * The DMARC part (the policy in force and the next step) is the one rule in packages/dns-checks/src/dmarc-next-step.ts,
 * the same the domain page and the agent tools call, so they cannot disagree.
 *
 * Truth rules:
 *  - Unknown is never "not found": a field that was never read, or a check that failed, is Unknown and says so.
 *  - Verified only from a successful check that is current (not older than STALE_DAYS, latest attempt not failed), at
 *    p=reject on all mail (pct=100, own subdomains not weaker), with SPF within 10 lookups and report evidence that is
 *    known (absent is known; failed to load is not). p=quarantine is never Verified: its next step is p=reject.
 *  - p=none is never Verified and never "nothing to do".
 *  - No pass-rate claim without a current reports address, whatever old totals the window holds.
 */
export interface NextAction {
	label: string;
	/** Who acts, in plain words. */
	who: string;
	/** Where the action happens. Absent when there is nothing to open. */
	to?: string;
}

export interface DomainVerdict {
	status: StatusKind;
	/** Null when the level is not known (not checked, failed, does not resolve). */
	level: Level | null;
	/** What is true now, with its scope. */
	sentence: string;
	/** What the reports show, or that there are none. Null when it would add nothing. */
	evidence: string | null;
	/** When DNS was last read, or null for hosted domains (their level comes from pointer checks). */
	checked: string | null;
	next: NextAction;
	/** True only when reports were loaded and at least 95% of reported mail passed: "done" then rests on DNS and reports. */
	reportsConfirmed: boolean;
	/**
	 * True when no DMARC report can reach this dashboard for the domain: it has no report address (`rua_address` empty;
	 * on the hosted service that means report intake is not connected). The evidence line then says so, never "0 reports".
	 */
	reportsNotConnected: boolean;
	/**
	 * Slot for one contextual "Talk to Max" link where a person may be stuck: a name that does not resolve, DNS checks
	 * that fail, a summary that cannot load. `lead` is the question shown before the link. Rendered by DomainRow's
	 * ContextHelp, which shows nothing until the help link exists (PR 142's TalkToMax, shown only when configured).
	 */
	help: { lead: string; about: string; priority: number } | null;
}

/** Report totals for the window, or null when they failed to load (undefined: still loading). */
export interface ReportTotals {
	total: number;
	passed: number;
	failed: number;
	/** Rounded, for display only. Thresholds use passed / total. */
	passRate: number | null;
	days: number;
}

export const WHO = WHO_WORDS;

/** Exact pass share in percent (not rounded: 94.6 is below 95). Null without reported mail. */
export const exactRate = (r: Pick<ReportTotals, 'total' | 'passed'> | null | undefined): number | null => (r && r.total > 0 ? (r.passed / r.total) * 100 : null);

/** The report totals stored with the summary (30 days, counted once per report). */
export const totalsFromSummary = (s: Pick<DomainCheckSummary, 'total_messages' | 'pass_messages' | 'fail_messages'>, days = 30): ReportTotals => ({
	total: s.total_messages,
	passed: s.pass_messages,
	failed: s.fail_messages,
	passRate: s.total_messages > 0 ? Math.round((s.pass_messages / s.total_messages) * 100) : null,
	days,
});

/** A successful check older than this is not current: the domain is not called Verified on it. */
export const STALE_DAYS = 7;

/** Same condition as PR 142's useReportsNotConnected, minus the hosted-mode gate (an empty address means no reports in either mode). */
export const reportsNotConnected = (domain: Pick<Domain, 'rua_address'>): boolean => !hasReportAddress(domain.rua_address);

function reportsLine(domain: Pick<Domain, 'rua_address'>, r: ReportTotals | null | undefined): string {
	// Without a current reports address no pass share is claimed, whatever older totals the window still holds.
	if (reportsNotConnected(domain)) return 'Reports are not connected for this domain, so nobody has confirmed that every sender passes.';
	if (r === undefined) return 'Report totals are loading.';
	if (r === null) return 'Report totals could not be loaded, so whether every sender passes is unknown.';
	if (r.total > 0 && r.passRate !== null) return `${r.passRate}% of ${formatNumber(r.total)} reported messages passed DMARC in the last ${r.days} days.`;
	return `No DMARC reports in the last ${r.days} days, so nobody has confirmed that every sender passes.`;
}

type Core = Omit<DomainVerdict, 'reportsNotConnected' | 'help' | 'reportsConfirmed'>;

export function domainVerdict(
	domain: Pick<Domain, 'id' | 'domain' | 'rua_address'>,
	s: DomainCheckSummary,
	reports: ReportTotals | null | undefined,
	hosted: HostedLevelInput | null = null,
	now = Date.now() / 1000,
	/** `hostedMode`: the hosted service (MODE=saas). There, a domain with no report address has no report intake. */
	opts: {
		hostedMode?: boolean;
		/** The workspace's domains by name: a fix that belongs on a listed parent links to its page. */
		idByName?: ReadonlyMap<string, number>;
		/** A listed parent whose own record does not cover this name (a public suffix): see suffixParentOf. */
		suffixParent?: string | null;
	} = {},
): DomainVerdict {
	const intakeOff = !!opts.hostedMode && reportsNotConnected(domain);
	const core = coreVerdict(domain, s, reports, hosted, now, intakeOff, opts.idByName, opts.suffixParent ?? null);
	const about = `about ${domain.domain}`;
	const unresolved = hosted ? null : didNotResolve(s);
	const help = unresolved ? { lead: 'Sure this is the right name?', about, priority: HELP_PRIORITY.dnsFailing } : !hosted && s.dns_check_status === 'failed' ? { lead: 'DNS checks keep failing?', about, priority: HELP_PRIORITY.dnsFailing } : null;
	const rate = reportsNotConnected(domain) ? null : exactRate(reports);
	return { ...core, reportsConfirmed: rate !== null && rate >= READY, reportsNotConnected: reportsNotConnected(domain), help };
}

function coreVerdict(
	domain: Pick<Domain, 'id' | 'domain' | 'rua_address'>,
	s: DomainCheckSummary,
	reports: ReportTotals | null | undefined,
	hosted: HostedLevelInput | null,
	now: number,
	intakeOff: boolean,
	idByName: ReadonlyMap<string, number> | undefined,
	suffixParent: string | null,
): Core {
	const page = `/domains/${domain.id}`;
	const name = domain.domain;
	const checked = hosted ? null : dnsCheckLine(s);
	const evidence = reportsLine(domain, reports);
	const checkAgain: NextAction = { label: 'Open the domain to check it again', who: WHO.you, to: page };

	const unresolved = hosted ? null : didNotResolve(s);
	if (unresolved === 'now') {
		return { status: 'attention', level: null, sentence: `DNS says ${name} does not exist, so it has no SPF or DMARC records to check.`, evidence: null, checked, next: { label: 'Check the spelling, or remove this domain', who: WHO.you, to: `${page}/settings` } };
	}
	if (unresolved === 'at-last-good-check') {
		return { status: 'unknown', level: null, sentence: 'At the last good check DNS said this name does not exist. The latest check got no answer, so this may have changed.', evidence: null, checked, next: checkAgain };
	}

	const { summary: sum, unverified } = hosted ? applyHostedInputs(s, hosted) : { summary: s, unverified: [] as string[] };
	// Hosted with no report intake: no advice may lean on reports (PR 142).
	const a = assessDomain(sum, hosted ? { nullMeans: 'missing', reports: !intakeOff } : intakeOff ? { reports: false } : undefined);
	const nullMeansUnknown = !hosted && !s.dns_checked_at;
	const hasSpf = !!sum.spf_record;
	const policy = sum.dmarc_policy;
	const issue = policy ? null : (sum.dmarc_issue ?? null);
	const spfUnknown = !hasSpf && nullMeansUnknown;
	const dmarcUnknown = !policy && !issue && nullMeansUnknown;
	// DMARC known to give no policy settles level 0 whatever SPF is; otherwise both must be known.
	const levelKnown = (!spfUnknown && !dmarcUnknown) || (!dmarcUnknown && !policy);
	const level: Level | null = levelKnown ? a.level : null;
	const at = `_dmarc.${sum.dmarc_inherited_from ?? name}`;
	const setup = (step: number) => `${page}/setup/${step}`;

	// Records we wrote in our zone that the customer's DNS does not point to yet.
	if (hosted && unverified.length > 0) {
		const failed = unverified.some((p) => hosted.pointer_status[p as keyof HostedLevelInput['pointer_status']] === 'error');
		const names = unverified.map((p) => ({ spf: 'SPF', dmarc: 'DMARC', mta_sts: 'MTA-STS' })[p as 'spf']).join(', ');
		return {
			status: failed ? 'unknown' : 'prepared',
			level,
			sentence: failed ? `The last lookup of your ${names} pointer failed, so it is not counted as published.` : `Your ${names} record is written, but public DNS does not point to it yet.`,
			evidence,
			checked,
			next: failed ? { label: 'Open the domain to check the pointers again', who: WHO.you, to: page } : { label: 'Add the pointer records to your DNS', who: WHO.dns, to: page },
		};
	}

	// Nothing read yet, or every read failed: nothing is confirmed.
	if (spfUnknown || dmarcUnknown) {
		const failed = s.dns_check_status === 'failed';
		const known = [hasSpf ? 'SPF is published' : null, policy ? `DMARC is at p=${policy}` : null].filter(Boolean).join(' and ');
		const rest = failed ? (known ? 'The last DNS check failed, so the rest is not confirmed.' : 'The last DNS check failed, so nothing is confirmed yet.') : known ? 'The rest has not been read from DNS yet.' : 'Nothing has been read from DNS for this domain yet.';
		// A known problem (an ignored DMARC record) is still a problem; everything else waits for a read.
		if (issue === 'invalid') return { ...dmarcNext(), level, sentence: `The DMARC record at ${at} has no valid p= policy, so receivers ignore it.`, evidence: null, checked };
		if (issue === 'multiple') return { ...dmarcNext(), level, sentence: `Public DNS shows several DMARC records at ${at}, so receivers ignore all of them.`, evidence: null, checked };
		return { status: 'unknown', level, sentence: known ? `${known}. ${rest}` : rest, evidence: null, checked, next: { label: failed ? 'Open the domain to check it again' : 'Open the domain to read its records from DNS', who: WHO.you, to: page } };
	}

	const base = statedVerdict();
	if (hosted) return base;

	// The latest attempt failed after an earlier good check: what is shown is the last good check, never Verified.
	if (s.dns_check_status === 'failed') {
		// No check ever completed: what is shown came from partial reads, not from a "last good check".
		const from = s.dns_checked_at ? 'the last good check' : 'partial reads (no check has completed yet)';
		if (base.status === 'attention') return { ...base, sentence: `${base.sentence} (From ${from}; the latest check failed.)` };
		return { ...base, status: 'unknown', sentence: `The latest DNS check failed. From ${from}: ${lower(base.sentence)}`, next: checkAgain };
	}
	// A good check that is too old is not current, whatever it said: no advice rests on it before a re-check. A problem it
	// found keeps its status (it was real then), but the next step is the re-check either way.
	const age = s.dns_checked_at ? now - s.dns_checked_at : 0;
	if (age > STALE_DAYS * 86400) {
		const stale = `${base.sentence} That was ${timeAgo(s.dns_checked_at!, now)}, so it may have changed.`;
		return { ...base, status: base.status === 'attention' ? 'attention' : 'unknown', sentence: stale, next: checkAgain };
	}
	return base;

	function statedVerdict(): Core {
		// What public DNS shows that is wrong, most basic first (the setup wizard's order: SPF, then DMARC).
		if (!hasSpf && !policy && !issue) return { status: 'attention', level, sentence: `Public DNS shows no SPF and no DMARC record, so receivers cannot verify mail from ${name}.`, evidence: null, checked, next: { label: 'Publish an SPF record', who: WHO.dns, to: setup(2) } };
		if (!hasSpf) return { status: 'attention', level, sentence: `Public DNS shows no SPF record, so receivers cannot tell which servers may send for ${name}.`, evidence: null, checked, next: { label: 'Publish an SPF record', who: WHO.dns, to: setup(2) } };
		if (!policy) {
			const sentence = issue === 'multiple' ? `Public DNS shows several DMARC records at ${at}, so receivers ignore all of them.` : issue === 'invalid' ? `The DMARC record at ${at} has no valid p= policy, so receivers ignore it.` : 'Public DNS shows SPF but no DMARC record, so receivers get no instruction for mail that fails.';
			return { ...dmarcNext(), level, sentence, evidence: null, checked };
		}
		const lookups = s.spf_lookup_count ?? null;
		if (!hosted && lookups !== null && lookups > SPF_LOOKUP_LIMIT) {
			return { status: 'attention', level, sentence: `Public DNS shows an SPF record that needs ${lookups} DNS lookups. Past ${SPF_LOOKUP_LIMIT}, receivers treat SPF as an error, so it stops vouching for your mail.`, evidence, checked, next: { label: `Bring SPF down to ${SPF_LOOKUP_LIMIT} DNS lookups or fewer`, who: WHO.dns, to: `${page}/spf-flatten` } };
		}

		const force = dmarcForce();
		const inForce = force.kind === 'own' || force.kind === 'inherited' ? inForceSentence(force) : null;
		const sentence = inForce ? `Public DNS shows SPF. ${inForce}` : `Public DNS shows SPF and DMARC at p=${policy}${sum.dmarc_inherited_from ? `, inherited from ${sum.dmarc_inherited_from}` : ''}.`;
		return { ...dmarcNext(), level, sentence, evidence, checked };
	}

	// DMARC: the one rule (dmarc-next-step), from the same stored facts the domain page reads.
	function dmarcForce() {
		return forceFor(name, sum, { read: true, hosted: hosted ? { policy, reportsConnected: hasReportAddress(domain.rua_address) } : undefined });
	}
	function dmarcNext(): Pick<Core, 'status' | 'next'> {
		const step = dmarcStepsFor(domain, s, reports, hosted, suffixParent)[0];
		if (!step) return { status: 'unknown', next: { label: 'Wait for the report totals to load', who: WHO.nobody } };
		const parentId = sum.dmarc_inherited_from ? idByName?.get(sum.dmarc_inherited_from) : undefined;
		return { status: step.status, next: { label: step.do, who: WHO[step.who], to: stepLink(step, page, parentId) } };
	}
}

/**
 * The DMARC steps for one domain, most urgent first, from its stored summary: the overview row shows [0], the domain page
 * lists them. Both call this, so they say the same thing. Hosted domains read the record we serve (applyHostedInputs).
 */
export function dmarcStepsFor(
	domain: Pick<Domain, 'domain' | 'rua_address'>,
	s: DomainCheckSummary,
	reports: ReportTotals | null | undefined,
	hosted: HostedLevelInput | null,
	suffixParent: string | null = null,
): DmarcStep[] {
	const sum = hosted ? applyHostedInputs(s, hosted).summary : s;
	const force = forceFor(domain.domain, sum, { read: true, hosted: hosted ? { policy: sum.dmarc_policy, reportsConnected: hasReportAddress(domain.rua_address) } : undefined });
	return dmarcSteps(domain.domain, force, evidenceFor(domain, reports, suffixParent));
}

const lower = (s: string) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/** A domain whose summary could not be loaded: unknown, never a guessed level. */
export function unavailableVerdict(message: string, domain?: string): DomainVerdict {
	return {
		reportsNotConnected: false,
		reportsConfirmed: false,
		help: { lead: 'Still failing after a retry?', about: domain ? `about ${domain}` : 'about this domain', priority: HELP_PRIORITY.loadError },
		status: 'unknown',
		level: null,
		sentence: `What we know about this domain could not be loaded: ${message}`,
		evidence: null,
		checked: null,
		next: { label: 'Try again', who: WHO.you },
	};
}

/** Sort key: most urgent first, then by name. */
export const byUrgency = <T extends { status: StatusKind; name: string }>(a: T, b: T): number => statusRank(a.status) - statusRank(b.status) || a.name.localeCompare(b.name);

const PHRASE: Record<StatusKind, [one: string, many: string]> = {
	attention: ['needs attention', 'need attention'],
	approval: ['is awaiting your approval', 'are awaiting your approval'],
	improve: ['is worth fixing', 'are worth fixing'],
	unknown: ['is unknown', 'are unknown'],
	gathering: ['is still gathering evidence', 'are still gathering evidence'],
	prepared: ['has a change prepared', 'have a change prepared'],
	verified: ['is verified', 'are verified'],
	note: ['has a note', 'have notes'],
};

const list = (parts: string[]) => (parts.length < 2 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);

/**
 * The one-sentence answer to "Am I done?" for the whole workspace. `null` entries are still loading.
 * "Done" only when every domain is Verified (a successful, current check at full enforcement, with known evidence) and no
 * domain is waiting for proof; the sentence names what it rests on: public DNS only, or public DNS and reports.
 */
export function workspaceAnswer(rows: Array<{ name: string; verdict: DomainVerdict | null }>, claims = 0): string {
	const n = rows.length;
	const waiting = claims === 1 ? '1 domain is waiting for proof that it is yours' : `${claims} domains are waiting for proof that they are yours`;
	if (n === 0) return claims > 0 ? `Not yet: ${waiting}.` : 'Nothing to check yet: this workspace has no domains.';
	if (rows.some((r) => !r.verdict)) return `Checking where your ${n === 1 ? 'domain stands' : `${n} domains stand`}…`;
	const kinds = rows.map((r) => r.verdict!.status);
	if (kinds.every((k) => k === 'verified')) {
		const scope = rows.every((r) => r.verdict!.reportsConfirmed) ? 'from public DNS and reports' : 'from public DNS only';
		const all = n === 1 ? `${rows[0]!.name} is verified` : `all ${n} domains are verified`;
		if (claims > 0) return `Not yet: ${all} (${scope.replace('from ', '')}), but ${waiting}.`;
		return `Done, ${scope}: ${all}.`;
	}
	const tail = claims > 0 ? ` ${waiting.charAt(0).toUpperCase()}${waiting.slice(1)}.` : '';
	if (n === 1) return `Not yet: ${rows[0]!.name} ${PHRASE[kinds[0]!][0]}.${tail}`;
	const counts = STATUS_RANK.map((k) => [k, kinds.filter((x) => x === k).length] as const).filter(([, c]) => c > 0);
	return `Not yet. Of ${n} domains, ${list(counts.map(([k, c]) => `${c} ${PHRASE[k][c === 1 ? 0 : 1]}`))}.${tail}`;
}
