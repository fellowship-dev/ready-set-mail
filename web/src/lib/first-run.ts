/**
 * The first run on the hosted service, after sign-up: S4 (the domain, what public DNS says, how to set it up), C2 (review and Apply)
 * and what the dashboard says on day one (first-day.ts). Pure helpers live here so every branch can be tested without a screen.
 */
import type { ClaimPreviewData } from './claim-preview';
import type { CfConnection, CfConnections } from './cloudflare';
import { hostOf, isCloudflareHost, type DnsHost, type DnsHostProvider } from './dns-host';
import type { OnboardingStatus } from './types';

/**
 * "Not the one setting this up? Hand setup to a teammate →" (spec H1). The link is only shown while H1, H2 and I1 all exist (they do);
 * turn this off and it disappears from S4 and C2, nothing else changes. It is shown to owners only: only an owner can invite an admin.
 */
export const HAND_OFF_ENABLED = true;

/** Where the first-run screens are. The URL holds the step. */
export const SETUP_PATH = '/setup';
export const REVIEW_PATH = '/setup/review';

// ── What public DNS says, in one line ───────────────────────────

export interface PublicDns {
	/** DNS says the name itself does not exist. */
	nxdomain: boolean;
	spf: 'found' | 'missing' | 'error';
	dmarc: 'found' | 'missing' | 'error';
	dmarcPolicy: string | null;
	/** The DMARC record names a reporting address at all (null: unknown or no record). */
	dmarcHasRua: boolean | null;
	dkim: 'found' | 'not_found' | 'wildcard' | 'error';
}

const hasRuaTag = (record: string | null | undefined): boolean | null => (record ? /(^|;)\s*rua\s*=\s*\S+/i.test(record) : null);

/** From GET /api/domains/claims/:id/preview (a domain not yet proven). */
export function dnsFromPreview(p: ClaimPreviewData): PublicDns {
	return { nxdomain: p.nxdomain, spf: p.spf.status, dmarc: p.dmarc.status, dmarcPolicy: p.dmarc.policy, dmarcHasRua: p.dmarc.status === 'found' ? hasRuaTag(p.dmarc.record) : null, dkim: p.dkim.status };
}

/** From GET /api/domains/:id/onboarding-status (a domain already proven, for example by its Cloudflare zone). */
export function dnsFromStatus(s: OnboardingStatus): PublicDns {
	const failed = (s.dns_errors ?? []).map((e) => e.split(':')[0] ?? '');
	return {
		nxdomain: !!s.nxdomain,
		spf: failed.includes('spf') ? 'error' : s.spf.record ? 'found' : 'missing',
		dmarc: failed.includes('dmarc') ? 'error' : s.dmarc.found ? 'found' : 'missing',
		dmarcPolicy: s.dmarc.effective?.policy ?? null,
		dmarcHasRua: s.dmarc.found ? hasRuaTag(s.dmarc.current_record) : null,
		dkim: failed.some((f) => f.startsWith('dkim')) ? 'error' : s.dkim.wildcard ? 'wildcard' : s.dkim.selectors.length > 0 ? 'found' : 'not_found',
	};
}

/**
 * The one-line result of a domain, from public DNS only: how many things need fixing and the plain reason for each.
 * Counted: no SPF, no DMARC, DMARC that sends its reports nowhere. DKIM is only ever "not found at the usual names" (public DNS
 * cannot list every selector), so it is a sentence, not a count, unless nothing at all is published.
 */
export function resultLine(domain: string, d: PublicDns): string {
	if (d.nxdomain) return `${domain} doesn't exist in public DNS. Check the spelling.`;
	const unread = [d.spf === 'error' ? 'SPF' : null, d.dmarc === 'error' ? 'DMARC' : null].filter(Boolean);
	const parts: string[] = [];
	let count = 0;
	if (d.spf === 'missing' && d.dmarc === 'missing' && d.dkim === 'not_found') {
		count = 3;
		parts.push('No SPF, DKIM or DMARC record found.');
	} else {
		// A DMARC record that sends its reports nowhere is a thing to fix, except at p=reject, where the domain is already protected and only the reports are missing (said below).
		if (d.dmarc === 'found' && d.dmarcHasRua === false && d.dmarcPolicy !== 'reject') {
			count++;
			parts.push(`DMARC is published${d.dmarcPolicy ? ` (p=${d.dmarcPolicy})` : ''} but sends its reports nowhere.`);
		}
		if (d.spf === 'missing') {
			count++;
			parts.push('No SPF record.');
		}
		if (d.dmarc === 'missing') {
			count++;
			parts.push('No DMARC record.');
		}
		if (d.dkim === 'not_found') parts.push("We couldn't find a DKIM key at the usual names; reports will show which service signs.");
	}
	if (unread.length > 0) parts.push(`We couldn't read ${unread.join(' and ')} from public DNS just now.`);
	if (count === 0) {
		const quiet = d.dmarc === 'found' && d.dmarcHasRua === false ? " Its DMARC record doesn't send reports anywhere yet." : '';
		return unread.length > 0 ? `${domain}: ${parts.join(' ')}` : `${domain}: in good shape.${quiet}${parts.length ? ` ${parts.join(' ')}` : ''}`;
	}
	return `${domain}: ${count} ${count === 1 ? 'thing' : 'things'} to fix. ${parts.join(' ')}`;
}

// ── How to set it up, by who hosts DNS ──────────────────────────

/** What the person can do for this domain. */
export type SetupChoice =
	/** Name servers are Cloudflare's and a connection already holds the zone: continue with it (the only primary). */
	| { kind: 'continue'; account: string | null }
	/** Name servers are Cloudflare's and Cloudflare can be connected: the only primary; the records path is the quiet secondary. */
	| { kind: 'connect' }
	/** Anything else: the existing records path, with the provider named when known. Cloudflare name servers on an instance that cannot connect land here too, with no message about it. */
	| { kind: 'records'; provider: DnsHostProvider | null; onCloudflare: boolean };

/** An active connection whose zones (or the server's own token) reach `domain`. */
export function connectionHolding(domain: string, conns: CfConnections | undefined): CfConnection | null {
	if (!conns) return null;
	return conns.connections.find((c) => c.status === 'active' && (c.implicit || c.zones.some((z) => domain === z.name || domain.endsWith(`.${z.name}`)))) ?? null;
}

/** May a Cloudflare connection be made from here? Hosted needs the encryption key (a customer cannot set it) and a way to sign in or paste a token. */
export const canConnectCloudflare = (conns: CfConnections | undefined, canWrite: boolean): boolean => !!conns && canWrite && conns.encryption_configured && (conns.oauth.available || conns.token_paste);

export function setupChoice(domain: string, host: DnsHost | undefined, conns: CfConnections | undefined, canWrite: boolean): SetupChoice {
	const provider = hostOf(host);
	const onCloudflare = isCloudflareHost(provider);
	const holding = connectionHolding(domain, conns);
	if (onCloudflare && holding) return { kind: 'continue', account: holding.cf_account_name ?? (holding.implicit ? null : holding.label) };
	if (onCloudflare && canConnectCloudflare(conns, canWrite)) return { kind: 'connect' };
	return { kind: 'records', provider, onCloudflare };
}

/** The headline over the choice: who hosts DNS, or that we could not tell. */
export function hostSentence(domain: string, choice: SetupChoice, host: DnsHost | undefined): string {
	if (choice.kind === 'records' && !choice.provider) {
		return host?.status === 'mixed' ? `${domain}'s name servers point to more than one company.` : `We couldn't tell who hosts DNS for ${domain}.`;
	}
	return `${domain} uses ${choice.kind === 'records' ? choice.provider!.name : 'Cloudflare'} for DNS`;
}

// ── The domain the first run is about ───────────────────────────

const focusKey = (workspaceId: string | null) => `rsm_first_run_domain:${workspaceId ?? ''}`;

/** Remember which domain S4 was about, so C2 lands on the same one. Storage is only a hint: the server decides what exists. */
export function rememberFocusDomain(workspaceId: string | null, domain: string): void {
	try {
		localStorage.setItem(focusKey(workspaceId), domain);
	} catch {
		/* private mode: the oldest domain is used */
	}
}
export function readFocusDomain(workspaceId: string | null): string | null {
	try {
		return localStorage.getItem(focusKey(workspaceId));
	} catch {
		return null;
	}
}

/** How C2 was left: Applied (written to Cloudflare), or skipped. Either way it is not shown again by itself. */
const reviewDoneKey = (workspaceId: string | null) => `rsm_review_done:${workspaceId ?? ''}`;
export function markReviewDone(workspaceId: string | null, how: 'applied' | 'skipped' = 'skipped'): void {
	try {
		localStorage.setItem(reviewDoneKey(workspaceId), how);
	} catch {
		/* ignore */
	}
}
export function reviewOutcome(workspaceId: string | null): 'applied' | 'skipped' | null {
	try {
		const v = localStorage.getItem(reviewDoneKey(workspaceId));
		return v === 'applied' ? 'applied' : v ? 'skipped' : null;
	} catch {
		return null;
	}
}
export const reviewDone = (workspaceId: string | null): boolean => reviewOutcome(workspaceId) !== null;

/** The domain the first run is about: the one S4 was given, else the oldest in the workspace. */
export function focusDomainOf<T extends { domain: string }>(domains: T[], workspaceId: string | null): T | undefined {
	const named = readFocusDomain(workspaceId);
	return domains.find((d) => d.domain === named) ?? domains[0];
}
