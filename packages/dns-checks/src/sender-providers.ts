// Who is behind a sending IP? Matches what a DMARC aggregate report tells us about a source (reverse DNS,
// the IP's network owner, and the domains it authenticated as) against the same provider registry the SPF and
// DKIM checks use (`email-service-providers`), so "add the include / set up DKIM" advice names real records.
//
// Sources: `include` links an entry to the registry (which carries each provider's published SPF include and
// setup guide). `hosts` are the providers' own sending / bounce / reverse-DNS domains (the registry includes, and
// the domains in their delivery documentation). `orgs` match the network owner and are used only for networks
// that exist to send mail: never for general cloud networks (Google Cloud, Azure, AWS), whose servers would be
// mislabelled as Workspace, Microsoft 365 or SES. These are matching heuristics, not authoritative; we do not
// ship DKIM record values here, because providers issue them per account (their guide is linked instead).

import { SPF_PROVIDERS, type EmailProvider } from './email-service-providers';
import { aligned } from './alignment';

export interface SenderSignals {
	reverse_dns?: string | null;
	base_domain?: string | null;
	org?: string | null;
	spf_domain?: string | null;
	dkim_domain?: string | null;
}

export interface SenderProvider {
	id: string;
	name: string;
	/** The SPF-registry entry (include, DKIM selectors, setup guide), when this provider has one. */
	registry: EmailProvider | null;
	/** What matched, strongest first: the domain it authenticated as, then reverse DNS, then the network owner. */
	evidence: string;
}

interface Signature {
	id: string;
	name: string;
	/** Registry `include` this provider maps to, if any. */
	include?: string;
	/** Domain suffixes seen in reverse DNS, base domain, or authenticated domains. */
	hosts: string[];
	/** Network owner names; weaker than hosts (a cloud ASN hosts many unrelated senders). */
	orgs?: RegExp[];
}

const SIGNATURES: Signature[] = [
	{ id: 'google-workspace', name: 'Google Workspace', include: '_spf.google.com', hosts: ['google.com', 'googlemail.com'] },
	{ id: 'microsoft-365', name: 'Microsoft 365', include: 'spf.protection.outlook.com', hosts: ['outlook.com', 'protection.outlook.com', 'office365.com'] },
	{ id: 'sendgrid', name: 'SendGrid', include: 'sendgrid.net', hosts: ['sendgrid.net', 'sendgrid.com'], orgs: [/sendgrid/i] },
	{ id: 'amazon-ses', name: 'Amazon SES', include: 'amazonses.com', hosts: ['amazonses.com'] },
	{ id: 'mailgun', name: 'Mailgun', include: 'mailgun.org', hosts: ['mailgun.org', 'mailgun.net'], orgs: [/mailgun/i] },
	{ id: 'mailchimp', name: 'Mailchimp', include: 'servers.mcsv.net', hosts: ['mcsv.net', 'mailchimp.com', 'rsgsv.net', 'mcdlv.net'], orgs: [/mailchimp|rocket science/i] },
	{ id: 'mandrill', name: 'Mandrill (Mailchimp)', include: 'mandrillapp.com', hosts: ['mandrillapp.com', 'mandrill.com'] },
	{ id: 'brevo', name: 'Brevo', include: 'spf.brevo.com', hosts: ['brevo.com', 'sendinblue.com', 'sendibt.com'], orgs: [/sendinblue|brevo/i] },
	{ id: 'mailjet', name: 'Mailjet', include: 'mailjet.com', hosts: ['mailjet.com'], orgs: [/mailjet/i] },
	{ id: 'postmark', name: 'Postmark', include: 'spf.postmarkapp.com', hosts: ['postmarkapp.com', 'mtasv.net'], orgs: [/postmark|wildbit/i] },
	{ id: 'resend', name: 'Resend', include: 'resend.com', hosts: ['resend.com', 'resend.dev'] },
	{ id: 'proton', name: 'Proton Mail', include: '_spf.protonmail.ch', hosts: ['protonmail.ch', 'proton.me'], orgs: [/proton/i] },
	{ id: 'hubspot', name: 'HubSpot', include: 'hubspot.net', hosts: ['hubspot.net', 'hubspot.com', 'hubspotemail.net'], orgs: [/hubspot/i] },
	{ id: 'zendesk', name: 'Zendesk', include: 'mail.zendesk.com', hosts: ['zendesk.com'], orgs: [/zendesk/i] },
	{ id: 'zoho', name: 'Zoho Mail', include: 'zoho.com', hosts: ['zoho.com', 'zoho.eu', 'zohomail.com'], orgs: [/zoho/i] },
	{ id: 'mxroute', name: 'MXRoute', include: 'mxroute.com', hosts: ['mxroute.com'] },
	{ id: 'fastmail', name: 'Fastmail', hosts: ['messagingengine.com', 'fastmail.com'], orgs: [/fastmail|messagingengine/i] },
	{ id: 'sparkpost', name: 'SparkPost', hosts: ['sparkpostmail.com', 'sparkpost.com'], orgs: [/sparkpost|messagebird/i] },
	{ id: 'shopify', name: 'Shopify Email', hosts: ['shopifyemail.com', 'shopify.com'], orgs: [/shopify/i] },
];

const norm = (v: string | null | undefined) => (v ?? '').trim().toLowerCase().replace(/\.$/, '');
const underHost = (name: string, host: string) => name === host || name.endsWith(`.${host}`);

/** The provider behind a report source, or null when we do not recognise it. */
export function identifySender(s: SenderSignals): SenderProvider | null {
	const probes: Array<[string, string]> = [
		['authenticated as', norm(s.spf_domain)],
		['authenticated as', norm(s.dkim_domain)],
		['reverse DNS', norm(s.reverse_dns)],
		['network', norm(s.base_domain)],
	];
	for (const [how, name] of probes) {
		if (!name) continue;
		const sig = SIGNATURES.find((g) => g.hosts.some((h) => underHost(name, h)));
		if (sig) return toProvider(sig, `${how} ${name}`);
	}
	const org = (s.org ?? '').trim();
	if (org) {
		const sig = SIGNATURES.find((g) => g.orgs?.some((re) => re.test(org)));
		if (sig) return toProvider(sig, `network owner ${org}`);
	}
	return null;
}

function toProvider(sig: Signature, evidence: string): SenderProvider {
	const registry = sig.include ? (SPF_PROVIDERS.find((p) => p.include === sig.include) ?? null) : null;
	return { id: sig.id, name: sig.name, registry, evidence };
}

/** Whose failure a failing source is: see `classifySource`. */
export type SourceClass = 'yours' | 'service_not_set_up' | 'not_yours';

export type SourceFacts = SenderSignals & { spf_pass: number | boolean; dkim_pass: number | boolean };

/**
 * The ONE judgement of "is this failing source the owner's to fix", read by the next step, the names panel, Analytics and the agent report.
 *   yours: SPF or DKIM passed for a name in `domain`'s organizational domain, so the owner's own authentication is what failed to align.
 *   service_not_set_up: otherwise, a known sending service (`identifySender`), or a source whose SPF AND DKIM both passed for its own
 *     (non-owner) domain: a real mail service sending as the owner's domain without being set up for it (custom return-path and DKIM).
 *   not_yours: everything else: not a known service, nothing aligned, not both checks passing for its own domain. Nothing to fix.
 */
export function classifySource(s: SourceFacts, domain: string): SourceClass {
	const own = (name: string | null | undefined) => aligned(name, domain, 'r');
	if ((s.spf_pass && own(s.spf_domain)) || (s.dkim_pass && own(s.dkim_domain))) return 'yours';
	if (identifySender(s)) return 'service_not_set_up';
	if (s.spf_pass && s.dkim_pass && norm(s.spf_domain) && norm(s.dkim_domain)) return 'service_not_set_up';
	return 'not_yours';
}

const CLASS_RANK: Record<SourceClass, number> = { not_yours: 0, service_not_set_up: 1, yours: 2 };

/** One source's class from the classes of its groups: the one that asks the most of the owner. */
export const strongestClass = (a: SourceClass, b: SourceClass): SourceClass => (CLASS_RANK[a] >= CLASS_RANK[b] ? a : b);

/** `classifySource(...) === 'not_yours'`: a failure from such a source is nothing to fix. */
export function likelyNotYours(s: SourceFacts, domain: string): boolean {
	return classifySource(s, domain) === 'not_yours';
}

const joinNames = (names: readonly string[]): string => (names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/** The one sentence for a `service_not_set_up` source, wherever it is said (next step, names panel, Analytics, agent). `names`: the names it sent as. */
export function serviceNotSetUpSentence(names: string | readonly string[]): string {
	const list = typeof names === 'string' ? [names] : names;
	const all = joinNames(list);
	return list.length > 1
		? `services sending as ${all} that are not set up for them: if they are yours, set up their custom return-path and DKIM for ${all}; if not, nothing to do`
		: `a service sending as ${all} that is not set up for it: if it is yours, set up its custom return-path and DKIM for ${all}; if not, nothing to do`;
}

/** What to do about it, as a step's title: "Check the service sending as <name> that is not set up for it". */
export function serviceNotSetUpAction(names: string | readonly string[]): string {
	const list = typeof names === 'string' ? [names] : names;
	return list.length > 1 ? `Check the services sending as ${joinNames(list)} that are not set up for them` : `Check the service sending as ${list[0]} that is not set up for it`;
}
