import { formatDate, formatDateTime } from './format';
import type { MtaStsCheckState, MtaStsState, MtaStsStatus, MtaStsUnavailable } from './types';

/** The one plain sentence of what MTA-STS is, said first on every state of the page. */
export const mtaStsExplainer = (domain: string | null): string =>
	`MTA-STS asks other mail servers to use an encrypted connection (TLS: the lock that keeps mail private on its way) when they deliver mail to ${domain ?? 'your domain'}, and to send you a report on how it went.`;

/** MX, CNAME and TXT get their plain reading once, where the records are listed. */
export const MX_READING = 'MX hosts are the servers that receive your mail.';
export const RECORD_READING = 'A CNAME record points one name at another; a TXT record holds a line of text that other servers read.';

export const policyUrl = (domain: string): string => `https://mta-sts.${domain}/.well-known/mta-sts.txt`;

/** The reason, short enough for a card. The page shows the server's own sentence. */
export const SHORT_REASON: Record<MtaStsUnavailable, string> = {
	not_configured: 'not set up on this service yet',
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
			? { state: 'enforced', word: 'Enforced', detail: 'Senders must use an encrypted connection to deliver to this domain.' }
			: { state: 'testing', word: 'Testing', detail: 'Senders deliver as before and report problems with encryption.' };
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
		case 'waiting_certificate': return 'Waiting for the certificate for the policy server. This usually takes a few minutes; if it takes longer than an hour, Check now says which record is missing.';
		case 'waiting_policy': return 'Waiting for the policy file to be reachable. Check now looks again.';
		case 'waiting_txt': return 'Waiting for the last record, the one that tells senders a policy exists.';
		case 'active': return mode === 'enforce'
			? 'Enforcing: senders must use an encrypted connection, or they do not deliver.'
			: 'Testing: senders deliver as before and report problems with encryption. Nothing is rejected.';
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
