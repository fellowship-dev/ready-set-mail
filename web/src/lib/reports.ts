import type { CheckStatus } from '@ready-set-mail/ui';
import { SPF_LOOKUP_LIMIT, spfLookupCount, spfLookupJudgement } from '@ready-set-mail/dns-checks/spf-record';
import { alignmentFix, dmarcVerdict, explainAlignment, identifierAlignment, whyNotAligned, type AlignModes, type DmarcVerdict } from '@ready-set-mail/dns-checks/alignment';
import { effectivePolicySentence, type EffectivePolicy } from '@ready-set-mail/dns-checks/effective-policy';
import type { AnomalySource, CheckResult, ReportSource } from './types';

/** Pure helpers for the report, source, email-check and audit screens. */

export type AuthSource = Pick<ReportSource, 'source_ip' | 'header_from' | 'spf_domain' | 'dkim_domain' | 'spf_pass' | 'dkim_pass' | 'base_domain' | 'org'> &
	Partial<Pick<ReportSource, 'spf_aligned' | 'dkim_aligned' | 'dmarc_fail' | 'aspf' | 'adkim' | 'verdict'>>;

/** The receiver's DMARC verdict of a source's records: the server's `verdict`, else the one rule applied to the stored columns (`dmarcVerdict`). */
export const verdictOf = (src: Pick<AuthSource, 'spf_aligned' | 'dkim_aligned' | 'verdict'>): DmarcVerdict => src.verdict ?? dmarcVerdict(src);

export const WINDOWS = [7, 30, 90] as const;
export type WindowDays = (typeof WINDOWS)[number];
export const DEFAULT_WINDOW: WindowDays = 30;

/** A source not seen in this many days is probably fixed already. */
export const STALE_AFTER_DAYS = 2;

type VerdictInput = Pick<AuthSource, 'spf_aligned' | 'dkim_aligned' | 'verdict'>;

/** Failing: the receiver's verdict is that DMARC failed (neither SPF nor DKIM passed and aligned with the From domain, RFC 9989 section 5.3.5). */
export const isFailing = (src: VerdictInput): boolean => verdictOf(src) === 'failed';
/** Passed DMARC on one check only: the other did not align, so there is no backup. */
export const isOneCheck = (src: VerdictInput): boolean => verdictOf(src) === 'passed-one';
/** Stored before the receiver's verdict was kept (or not recoverable): whether it passed is not recorded. */
export const isUnrecorded = (src: VerdictInput): boolean => verdictOf(src) === 'not-recorded';

/** The sentence for mail whose verdict is not recorded (stored before migration 0017 kept it). */
export const NOT_RECORDED = "This report was stored before Ready Set Mail kept each receiver's DMARC verdict, so whether this mail passed DMARC is not recorded.";

/** The sending service, when it differs from the From domain. */
export function serviceVia(src: Pick<AuthSource, 'spf_domain' | 'dkim_domain' | 'header_from'>): string | null {
	const auth = src.spf_domain || src.dkim_domain;
	if (!auth || auth === src.header_from) return null;
	return auth;
}

/** "Google" / "mailchimp.com", or null when the IP has no known owner. */
export const providerName = (src: Pick<AuthSource, 'org' | 'base_domain'>): string | null => src.org || src.base_domain || null;

/** Which raw result failed, for a source that FAILED DMARC (`isFailing`); 'Alignment' when SPF and DKIM both passed but for another domain. */
export function failLabel(src: Pick<AuthSource, 'spf_pass' | 'dkim_pass'>): 'SPF + DKIM' | 'SPF' | 'DKIM' | 'Alignment' {
	if (!src.spf_pass && !src.dkim_pass) return 'SPF + DKIM';
	if (src.spf_pass && src.dkim_pass) return 'Alignment';
	return !src.spf_pass ? 'SPF' : 'DKIM';
}

/** The alignment modes of the policy the receiver applied to this source ('s' when any report said strict; relaxed when not stored). */
export const alignModesOf = (src: Partial<Pick<AuthSource, 'aspf' | 'adkim'>>): AlignModes => ({ spf: src.aspf === 's' ? 's' : 'r', dkim: src.adkim === 's' ? 's' : 'r' });

/**
 * The domain's DMARC policy as the page knows it: a `p=` value, `'no-record'` when DNS has no DMARC record,
 * or null when it could not be read.
 */
export type KnownPolicy = string | null;

/** The live record's tags that change what failing mail meets: the domain it belongs to, `sp=` and `pct=`. */
export interface LiveDmarc {
	domain: string;
	/** A valid sp= (none / quarantine / reject); null when absent or not valid. */
	sp: string | null;
	/** An sp= value that is not a policy, as written; it is ignored, so subdomains inherit p=. */
	invalidSp?: string | null;
	pct: number;
	/** The domain is itself a monitored subdomain: sp= on its own record does not reach its children. */
	monitoredSubdomain?: boolean;
}

const isSubdomainOf = (from: string | null, domain: string) => !!from && from.toLowerCase().endsWith(`.${domain.toLowerCase()}`);

/** What a policy value asks receivers to do with failing mail; `pct` below 100 limits it to that share. */
function asks(policy: string, pct: number): string | null {
	const verb = policy === 'reject' ? 'reject' : policy === 'quarantine' ? 'send to spam' : null;
	if (!verb) return null;
	return pct < 100 ? `${verb} only ${pct}% of it, and the rest is handled one policy level weaker` : verb === 'reject' ? 'reject it' : 'send it to spam';
}

/** The policy a name was found to be under, from `GET /api/domains/:id/names` (the shared `effectivePolicy`): its true source. */
export type NamePolicy = Pick<EffectivePolicy, 'policy' | 'tag' | 'at' | 'source' | 'exists' | 'status'> & { pct?: number };

/**
 * What receivers do with mail that fails DMARC, from the policy. Only says what the record actually asks for:
 * `pct=` limits it to a share of mail. For mail from a subdomain, `named` (the name's own policy and where it comes from,
 * read by the server) says the true source; without it the text says that the subdomain's own record, if there is one,
 * decides, and otherwise `sp=` (or `p=`) on the organizational domain's record (RFC 9989 section 4.10.1).
 */
export function failingMailFate(policy: KnownPolicy, live?: LiveDmarc, headerFrom?: string | null, named?: NamePolicy | null): string {
	const isPolicy = policy === 'none' || policy === 'quarantine' || policy === 'reject';
	if (live && isPolicy && isSubdomainOf(headerFrom ?? null, live.domain)) {
		if (named && named.status !== 'error') {
			const how = named.policy ? effectivePolicySentence(headerFrom!, named as EffectivePolicy) : null;
			if (named.policy && how) {
				const ask = asks(named.policy, named.pct ?? 100);
				return `${how} ${ask ? `That asks receivers to ${ask}.` : 'Receivers still deliver it unless their own filters stop it.'}`;
			}
			if (named.status === 'none') return `No DMARC record covers ${headerFrom}, so receivers still deliver it unless their own filters stop it.`;
			return `The DMARC record that applies to ${headerFrom} gives receivers no policy as written, so what they do with it is up to their own filters.`;
		}
		// Not read: say what decides it, never that it "inherits" (the subdomain may publish a record of its own).
		const lead = `${headerFrom} is a subdomain of ${live.domain}. We have not read whether it publishes a DMARC record of its own: if it does, that record decides what receivers do with this mail.`;
		// sp= counts only on the organizational domain's record. On a monitored subdomain's own record it reaches nobody: receivers look
		// for a record of the sender's domain, then for the organizational domain's, never a parent subdomain's (RFC 9989 section 4.7).
		if (live.monitoredSubdomain) {
			return `${lead} If it does not, the organizational domain's record applies, not ${live.domain}'s: p= and sp= on ${live.domain} do not decide this mail. We have not read the organizational domain's record here.`;
		}
		if (live.invalidSp) {
			return `${lead} If it does not, ${live.domain}'s record applies, and its sp=${live.invalidSp} is not a valid policy, so receivers do not apply that record as written: they act as if it said p=none when it has a valid rua=, and apply no DMARC otherwise.`;
		}
		const effective = live.sp ?? policy;
		const ask = asks(effective, live.pct);
		return `${lead} If it does not, ${live.sp ? `sp=${live.sp}` : `p=${policy}`} on ${live.domain}'s record applies to it${live.sp ? ` instead of p=${policy}` : ''}, which ${ask ? `asks receivers to ${ask}` : 'leaves it delivered unless receivers\' own filters stop it'}.`;
	}
	const pct = live?.pct ?? 100;
	if (policy === 'reject' || policy === 'quarantine') {
		return `Your DMARC policy (p=${policy}${pct < 100 ? `; pct=${pct}` : ''}) asks receivers to ${asks(policy, pct)}.`;
	}
	if (policy === 'none') return 'Your DMARC policy is p=none, so receivers still deliver it unless their own filters stop it.';
	if (policy === 'no-record') return 'Your domain has no DMARC record, so receivers still deliver it unless their own filters stop it.';
	return 'What receivers do with it depends on your DMARC policy, which could not be read right now.';
}

/** One line for a source whose SPF and DKIM passed but whose mail failed DMARC: which identifier did not align, and why. Null when there is nothing to say. */
export function alignmentNote(src: AuthSource): string | null {
	if (!isFailing(src) || (!src.spf_pass && !src.dkim_pass)) return null;
	const v = explainAlignment({ ...src, spf_aligned: 0, dkim_aligned: 0 }, alignModesOf(src));
	return v.lines.length > 0 ? v.lines.map((l) => l.sentence).join(' ') : null;
}

/** The sentence for the identifier that did not give the pass on a source that passed DMARC on the other one alone. */
function otherCheck(src: AuthSource, other: 'SPF' | 'DKIM'): string {
	const from = src.header_from ?? null;
	if (other === 'SPF' && !src.spf_pass) {
		const rp = src.spf_domain?.trim() || null;
		const fromName = from ?? 'your domain';
		if (!rp) return 'SPF did not pass for its return-path (MAIL FROM) domain, which the report does not name.';
		if (rp.toLowerCase().replace(/\.$/, '') === from?.toLowerCase().replace(/\.$/, '')) {
			return `SPF did not pass for ${fromName}, which is also its return-path (MAIL FROM) domain, so the SPF record at ${fromName} must authorize this server: add the service's SPF include or the server's address there.`;
		}
		return `SPF did not pass for its return-path (MAIL FROM) domain ${rp}, the name where SPF is checked for this mail, so an SPF record at ${fromName} does not apply to it. To fix SPF, the SPF record of ${rp} must authorize this server: add it there, or in the sending service's own settings if the service manages that domain.`;
	}
	const modes = alignModesOf(src);
	const a = other === 'SPF'
		? identifierAlignment('spf', src.spf_domain, !!src.spf_pass, from, modes.spf)
		: identifierAlignment('dkim', src.dkim_domain, !!src.dkim_pass, from, modes.dkim);
	return `${whyNotAligned(a, from)} ${alignmentFix(a, from)}`.trim();
}

/** Plain-language explanation and fix for a source, by the receiver's DMARC verdict (failed, passed on one check, not recorded). */
export function explain(src: AuthSource, policy: KnownPolicy = null, live?: LiveDmarc, named?: NamePolicy | null): string {
	const from = src.header_from ? `"${src.header_from}"` : 'your domain';
	const service = serviceVia(src) ?? 'this server';
	const fate = () => failingMailFate(policy, live, src.header_from, named);
	const verdict = verdictOf(src);

	if (verdict === 'not-recorded') return NOT_RECORDED;
	if (verdict === 'passed') return `${service} passed DMARC as ${from}.`;
	if (verdict === 'passed-one') {
		const ok = src.spf_aligned === 1 ? 'SPF' : 'DKIM';
		const other = ok === 'SPF' ? 'DKIM' : 'SPF';
		return (
			`${service} passed DMARC as ${from} on ${ok} alone. ${otherCheck(src, other)} ` +
			// RFC 9989 section 7.4: relayed mail most likely fails SPF; DKIM signatures generally survive.
			(ok === 'SPF'
				? 'Worth fixing so there is a backup: forwarded mail usually fails SPF, and then this mail fails DMARC.'
				: 'Worth fixing so there is a backup: if the DKIM signature breaks on the way, this mail fails DMARC.')
		);
	}
	// Failed (RFC 9989 section 5.3.5): neither identifier passed and aligned.
	if (!src.spf_pass && !src.dkim_pass) {
		return (
			`${service} has no authorization to send as ${from}. ` +
			`If you don't recognize it, it's likely spoofed mail. ${fate()} ` +
			`If it's a service you added recently, set up DKIM signing as ${src.header_from ?? 'your domain'} for it (and, where the service allows it, a custom return-path domain): DMARC needs SPF or DKIM to pass AND align with that domain.`
		);
	}
	// At least one identifier passed, and DMARC still failed: say which identifier did not align, and why (RFC 9989 section 4.4).
	const v = explainAlignment({ ...src, spf_aligned: 0, dkim_aligned: 0 }, alignModesOf(src));
	const lines = v.lines.map((l) => `${l.sentence} ${l.fix}`).join(' ');
	return `DMARC failed for ${service} sending as ${from}: SPF and DKIM do not align with it. ${lines} ${fate()}`;
}

/** Still failing recently (`last_seen` is YYYY-MM-DD). */
export function isActive(lastSeen: string, now: Date = new Date()): boolean {
	const cutoff = new Date(now);
	cutoff.setDate(cutoff.getDate() - STALE_AFTER_DAYS);
	return new Date(lastSeen) >= cutoff;
}

export function splitActive<T extends Pick<AnomalySource, 'last_seen'>>(sources: T[], now: Date = new Date()): { active: T[]; older: T[] } {
	return { active: sources.filter((s) => isActive(s.last_seen, now)), older: sources.filter((s) => !isActive(s.last_seen, now)) };
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString()} ${n === 1 ? one : many}`;

// ── Dates ──────────────────────────────────────────────────────────────

/** Unix seconds to YYYY-MM-DD in UTC (the report-detail route key). */
export const isoDay = (unix: number): string => new Date(unix * 1000).toISOString().slice(0, 10);

function toDate(value: number | string): Date {
	if (typeof value === 'number') return new Date(value * 1000);
	const [y = 0, m = 1, d = 1] = value.split('-').map(Number);
	return new Date(y, m - 1, d);
}

/** Unix seconds or YYYY-MM-DD to "Mar 18, 2026". */
export const formatDay = (value: number | string): string => toDate(value).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

export function formatTimestamp(unix: number): string {
	return new Date(unix * 1000).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

export function relativeTime(value: number | string, now = Date.now()): string {
	const diff = now - toDate(value).getTime();
	const abs = Math.abs(diff);
	const suffix = diff >= 0 ? ' ago' : ' from now';
	const MIN = 60_000;
	const DAY = 86_400_000;
	if (abs < MIN) return 'just now';
	if (abs < 60 * MIN) return `${Math.round(abs / MIN)}m${suffix}`;
	if (abs < DAY) return `${Math.round(abs / (60 * MIN))}h${suffix}`;
	if (abs < 7 * DAY) return `${Math.round(abs / DAY)}d${suffix}`;
	if (abs < 30 * DAY) return `${Math.round(abs / (7 * DAY))}w${suffix}`;
	if (abs < 365 * DAY) return `${Math.round(abs / (30 * DAY))}mo${suffix}`;
	return `${Math.round(abs / (365 * DAY))}y${suffix}`;
}

export const formatDayWithRelative = (value: number | string, now = Date.now()): string => `${formatDay(value)} · ${relativeTime(value, now)}`;

/** Pass rate as a whole percent, or null when nothing was sent. */
export const passRate = (passed: number, total: number): number | null => (total > 0 ? Math.round((passed / total) * 100) : null);

export type RateTone = 'success' | 'warning' | 'danger';
export const rateTone = (pct: number): RateTone => (pct >= 95 ? 'success' : pct >= 70 ? 'warning' : 'danger');

// ── Email check ────────────────────────────────────────────────────────

export const CHECK_POLL_MS = 3000;
/** After this long without an email we stop polling and say so. */
export const CHECK_GIVE_UP_MS = 5 * 60 * 1000;

/** Raw protocol result to the design-system status. `softfail` is a warning, anything unexpected a fail. */
export function protocolStatus(result: string | null): CheckStatus {
	if (!result || result === 'none') return 'missing';
	if (result === 'pass') return 'pass';
	if (result === 'softfail' || result === 'neutral') return 'warn';
	return 'fail';
}

export function spfStatus(result: string | null, lookups: number | null): CheckStatus {
	const s = protocolStatus(result);
	if (s === 'pass' && lookups !== null) return spfLookupJudgement(lookups).status;
	return s;
}

export function spfAdvice(result: string | null, lookupCount: number | null): string {
	if (!result || result === 'none') return 'No SPF record found. Add a TXT record to your DNS: v=spf1 include:your-mail-provider.com ~all';
	if (result === 'permerror') {
		return `SPF permerror — your record requires ${lookupCount ?? '?'} DNS lookups, exceeding the ${SPF_LOOKUP_LIMIT}-lookup limit. Receivers treat this as a fail. Flatten your SPF record or use a dynamic SPF service.`;
	}
	const j = lookupCount === null ? null : spfLookupJudgement(lookupCount);
	if (j?.level === 'over') {
		return `SPF passed for this message, but your record needs ${lookupCount} DNS lookups, more than the limit of ${SPF_LOOKUP_LIMIT}. Receivers that enforce the limit treat the record as a permanent error, and then SPF fails for your mail. Remove includes you no longer use, or flatten the record.`;
	}
	if (j && j.level !== 'ok') {
		return `SPF passed. Your record uses ${spfLookupCount(lookupCount!)}: ${j.label.toLowerCase()}. ${j.detail}`;
	}
	if (result === 'pass') return `SPF passed — the sending server is authorized by your DNS record.${lookupCount !== null ? ` Uses ${spfLookupCount(lookupCount)}.` : ''}`;
	if (result === 'softfail') return "SPF soft-failed (~all). Consider tightening to -all once you've verified all senders.";
	if (result === 'fail') return "SPF hard-failed. The sending server is not listed in your SPF record. Check you've included all mail providers.";
	return `SPF returned "${result}". Review your SPF record for syntax errors or missing includes.`;
}

export function dkimAdvice(result: string | null): string {
	if (!result || result === 'none') return 'No DKIM signature found. Configure DKIM signing in your email provider and add the public key to DNS.';
	if (result === 'pass') return 'DKIM passed — this email was cryptographically signed by your domain.';
	return "DKIM failed. The signature didn't match — check your private key is correctly configured in your mail provider.";
}

/**
 * `hosted`: the hosted service has no `reports.<your domain>` address to send reports to, so the example record
 * there carries no rua= (self-host keeps its reports-subdomain example).
 */
export function dmarcAdvice(result: string | null, policy: string | null, record: string | null, opts: { hosted?: boolean } = {}): string {
	if (!record && opts.hosted) return 'No DMARC record found. Add a TXT record at _dmarc.yourdomain.com: "v=DMARC1; p=none" monitors without blocking any mail.';
	if (!record) return 'No DMARC record found. Add: _dmarc.yourdomain.com TXT "v=DMARC1; p=none; rua=mailto:rua@reports.yourdomain.com"';
	if (!result || result === 'none') return "DMARC record exists but couldn't evaluate alignment. Check SPF and DKIM are passing first.";
	if (result === 'pass' && policy === 'reject') return 'DMARC passed with p=reject — maximum protection enabled.';
	if (result === 'pass' && policy === 'quarantine') return "DMARC passed. Consider upgrading to p=reject for full protection once you're confident all legitimate mail passes.";
	if (result === 'pass' && policy === 'none') return "DMARC passed but policy is p=none — you're in monitoring mode. Upgrade to p=quarantine then p=reject when ready.";
	if (result === 'fail') return "DMARC failed — SPF or DKIM alignment isn't matching your From: domain. Check that your mail provider sends from the same domain.";
	return `DMARC result: ${result}. Policy: ${policy ?? 'none'}.`;
}

export type OverallStatus = CheckResult['overall_status'];
export const OVERALL: Record<OverallStatus, { label: string; variant: 'success' | 'warning' | 'danger' }> = {
	protected: { label: 'Protected', variant: 'success' },
	at_risk: { label: 'At risk', variant: 'warning' },
	exposed: { label: 'Exposed', variant: 'danger' },
};
export const overallMeta = (status: string) => OVERALL[status as OverallStatus] ?? OVERALL.exposed;

// ── Audit log ──────────────────────────────────────────────────────────

export const AUDIT_PAGE_SIZE = 50;
export const AUDIT_FILTERS = [
	{ label: 'All', value: '' },
	{ label: 'Auth', value: 'auth.' },
	{ label: 'DNS', value: 'dns.' },
	{ label: 'Domains', value: 'domain.' },
	{ label: 'SPF', value: 'spf_flatten.' },
	{ label: 'MTA-STS', value: 'mta_sts.' },
	{ label: 'Members', value: 'team.' },
	{ label: 'Cron', value: 'cron.' },
] as const;

export type BadgeTone = 'brand' | 'success' | 'warning' | 'danger' | 'neutral' | 'outline';
const ACTION_TONE: Array<[string, BadgeTone]> = [
	['auth.', 'brand'],
	['domain.', 'success'],
	['dns.', 'warning'],
	['spf_flatten.', 'brand'],
	['mta_sts.', 'success'],
	['team.', 'warning'],
];
export function actionTone(action: string): BadgeTone {
	return ACTION_TONE.find(([prefix]) => action.startsWith(prefix))?.[1] ?? 'neutral';
}

/** Pretty-prints stored JSON; non-JSON strings are shown as they are. */
export function prettyJson(value: string): string {
	try {
		return JSON.stringify(JSON.parse(value), null, 2);
	} catch {
		return value;
	}
}

