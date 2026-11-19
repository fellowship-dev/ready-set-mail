import { formatDate, formatDateTime } from './format';
import type { MtaStsCheckState, MtaStsState, MtaStsStatus, MtaStsUnavailable } from './types';

/** The one plain sentence of what MTA-STS is, said first on every state of the page. */
export const mtaStsExplainer = (domain: string | null): string =>
	`MTA-STS asks other mail servers to encrypt delivery to ${domain ?? 'your domain'} and to report how it went.`;

/** "Google or Microsoft": the senders whose signed TLS reports count, as the server lists them (the registry's TLS identities, operator additions included). */
export const senderNames = (labels: readonly string[] | undefined): string => {
	const l = labels?.length ? labels : ['Google', 'Microsoft'];
	return l.length < 2 ? l.join('') : `${l.slice(0, -1).join(', ')} or ${l[l.length - 1]}`;
};

/** What a sender may keep an enforce policy for: `MAX_AGE_ENFORCE` in src/mta-sts/config.ts (a week). */
export const ENFORCE_MAX_AGE = 604800;

/** A time, short and the same for everyone: "2026-11-17 14:03 UTC". */
export const utc = (sec: number): string => `${new Date(sec * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC`;

/**
 * How long senders may hold the policy, true for the mode AND for what came before it: after leaving enforce, a sender that fetched the enforce policy may
 * keep it until the week is over (`disable.after`, the server's left_enforce_at + 604800), not for the testing policy's one day.
 */
export function holdSentence(maxAge: number, heldUntil: number | null | undefined): string {
	return heldUntil ? `Senders that fetched the enforce policy may keep it until ${utc(heldUntil)}.` : `Senders keep it up to ${maxAgeWords(maxAge)}.`;
}

export const policyUrl = (domain: string): string => `https://mta-sts.${domain}/.well-known/mta-sts.txt`;

/** The reason, short enough for a card. The page shows the server's own sentence. */
export const SHORT_REASON: Record<MtaStsUnavailable, string> = {
	not_configured: 'not set up on this service',
	not_allowed: 'not open to this workspace yet',
	ceiling: 'this service is full',
	hosted_records: 'this domain uses hosted records',
	unproven: 'prove the domain first',
	zone_subdomain: 'not for names inside the service zone',
	needs_cloudflare: 'needs a Cloudflare connection',
	reports_domain_missing: 'no reports domain yet',
};

export type CardState = 'off' | 'setting_up' | 'testing' | 'enforced' | 'unavailable';

/** What the DNS tools card says: Off, Setting up, Testing, Enforced or Not available. Every word is for the state the server reports. */
export function cardState(s: MtaStsStatus): { state: CardState; word: string; detail: string } {
	const c = s.config;
	if (c?.enabled) {
		if (c.state !== 'active') return { state: 'setting_up', word: 'Setting up', detail: stateSentence(c.state, c.mode) };
		return c.mode === 'enforce'
			? { state: 'enforced', word: 'Enforced', detail: 'Senders that check MTA-STS deliver only over a verified encrypted connection.' }
			: { state: 'testing', word: 'Testing', detail: 'Senders deliver as before; those that send TLS reports tell you about problems.' };
	}
	if (!s.available) {
		const reason = s.unavailable_reason === 'none' ? null : SHORT_REASON[s.unavailable_reason];
		return { state: 'unavailable', word: reason ? `Not available: ${reason}` : 'Not available', detail: s.unavailable_message ?? '' };
	}
	return { state: 'off', word: 'Off', detail: 'Ask other mail servers to encrypt delivery to this domain and report problems.' };
}

/** Where setup stands, in a sentence that is true for exactly that state. */
export function stateSentence(state: MtaStsState, mode: 'testing' | 'enforce'): string {
	switch (state) {
		case 'creating': return 'Setting up the policy server and the records.';
		case 'waiting_records': return 'Waiting for the DNS records you add at your DNS host.';
		case 'waiting_certificate': return 'Waiting for the certificate. This takes a few minutes.';
		case 'waiting_policy': return 'Waiting for the policy file to be reachable.';
		case 'waiting_txt': return 'Waiting for the last record, the one that tells senders a policy exists.';
		case 'active': return mode === 'enforce'
			? 'Enforcing: senders that check MTA-STS deliver only over a verified encrypted connection to a listed MX host.'
			: 'Testing: mail is delivered as before, and senders that send TLS reports tell you about problems.';
	}
}

export const CHECK_WORDS: Record<MtaStsCheckState, string> = {
	ok: 'In place',
	pending: 'Waiting',
	missing: 'Not found yet',
	wrong: 'Wrong',
	error: "Couldn't check",
	not_applicable: 'Not needed',
};

export function formatPeriod(start: number, end: number): string {
	const a = formatDate(start);
	const b = formatDate(end);
	return a === b ? a : `${a} to ${b}`;
}

export { formatDateTime };

/** What a failure type means, in plain words (RFC 8460). Unknown types are shown as they are, hyphens as spaces. */
const FAILURE_WORDS: Record<string, string> = {
	'starttls-not-supported': 'your mail server did not offer encryption',
	'certificate-host-mismatch': "your mail server's certificate is for another name",
	'certificate-expired': "your mail server's certificate has expired",
	'certificate-not-trusted': "your mail server's certificate is not trusted",
	'validation-failure': 'the connection could not be checked',
	'sts-policy-fetch-error': 'the policy could not be fetched',
	'sts-policy-invalid': 'the policy was not valid',
	'sts-webpki-invalid': "the policy server's certificate was not valid",
};
export const failureWords = (type: string): string => FAILURE_WORDS[type] ?? type.replace(/-/g, ' ');

export const maxAgeWords = (seconds: number): string => {
	if (seconds % 86400 === 0) {
		const d = seconds / 86400;
		return `${d} ${d === 1 ? 'day' : 'days'}`;
	}
	if (seconds % 3600 === 0) {
		const h = seconds / 3600;
		return `${h} ${h === 1 ? 'hour' : 'hours'}`;
	}
	return `${seconds} seconds`;
};
