// Names people type (a display name, a workspace name) shown back to them and to their teammates.
//
// Rendered as text everywhere (React, escaped server pages), so markup is not the risk; these are: control and format
// characters (bidi overrides, zero-width joiners, line breaks) that make a name read as something else, and length.

/** Longest name kept, in characters. */
export const MAX_NAME = 80;

/** A name made safe to show: control and invisible format characters removed, whitespace collapsed, cut to `max` characters. */
export function cleanName(raw: unknown, max = MAX_NAME): string {
  if (typeof raw !== 'string') return '';
  const flat = raw.normalize('NFC').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim();
  return [...flat].slice(0, max).join('').trim();
}

/** Free-mail providers with one address per name: matched exactly (the registrable domain) or, below, as a family with country variants. */
const FREE_MAIL_FIXED: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com', 'msn.com', 'ymail.com', 'rocketmail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me',
  'protonmail.com', 'protonmail.ch', 'pm.me', 'web.de', 'mail.com', 'mail.ru', 'yandex.com', 'yandex.ru', 'zoho.com', 'fastmail.com',
  'hey.com', 'tutanota.com', 'tuta.io', 'qq.com', '163.com',
]);
/** Providers that run one mailbox service under many country domains (hotmail.es, outlook.fr, live.com.mx, yahoo.co.jp, gmx.at). */
const FREE_MAIL_FAMILIES: ReadonlySet<string> = new Set(['hotmail', 'outlook', 'live', 'yahoo', 'gmx']);
/** What may follow a family label: a country code, or a generic/second-level suffix then a country code ("co.uk", "com.mx", "co.jp"), or "com"/"net". No other label, so live.example-corp.com is a company. */
const FAMILY_SUFFIX = /^(?:com|net|org|[a-z]{2}|(?:co|com|ne|or)\.[a-z]{2})$/;

/**
 * Is this a free-mail domain? The registrable domain is the whole of what follows the "@" (a subdomain such as mail.company.com or
 * hotmail.company.com is the company's own): either one of the fixed names, or a provider family label (hotmail, outlook, live, yahoo, gmx)
 * followed by a country or generic suffix only (hotmail.co.uk, outlook.es, live.com.mx, yahoo.co.jp, gmx.at). "outlookdesign.com" and
 * "live.example-corp.com" are not free mail.
 */
export function isFreeMailDomain(domain: string): boolean {
  const d = domain.toLowerCase().trim().replace(/\.$/, '');
  if (FREE_MAIL_FIXED.has(d)) return true;
  const dot = d.indexOf('.');
  return dot > 0 && FREE_MAIL_FAMILIES.has(d.slice(0, dot)) && FAMILY_SUFFIX.test(d.slice(dot + 1));
}

/**
 * The workspace name a new account starts with: from the name the person gave, else from their email's domain, else (a
 * free-mail address) "My workspace".
 */
export function defaultWorkspaceName(name: string, email: string): string {
  const clean = cleanName(name);
  if (clean) return cleanName(`${clean}'s workspace`);
  const domain = email.split('@')[1]?.toLowerCase().trim() ?? '';
  return cleanName(domain && !isFreeMailDomain(domain) ? `${domain} workspace` : 'My workspace');
}

/** What an agency's first workspace is called until its first client domain is added (it is then named after that domain). */
export const NEW_CLIENT_WORKSPACE = 'New client';

/**
 * Workspace setting (existing `settings` table, no migration) that says the workspace's NAME is the product's placeholder, not the person's:
 * set when an agency's first workspace is made, and the only thing that lets the first client domain name it. A workspace that happens to
 * be called "New client" by its owner has no such row and is never renamed. The row stays while the name was derived from a domain and no
 * other domain or claim exists (a typo corrected: the name follows), and goes when the owner renames the workspace.
 */
export const PLACEHOLDER_NAME_KEY = 'name_is_placeholder';

/**
 * The name of the first workspace a sign-up makes, from what the person said about whose email they are setting up
 * (src/auth/profile.ts):
 *  - "My company's" and "Just looking around": the organization name they typed.
 *  - "My clients'" (an agency or IT provider): the organization name is the agency's own name, kept on the account and not used
 *    for a workspace; each client's workspace is named after its domain, so this first one waits for its first domain.
 * Without a profile (a sign-up that skipped the question) it is `defaultWorkspaceName`.
 */
export function firstWorkspaceName(profile: { organization: string; whose_email: 'company' | 'clients' | 'looking' } | null, name: string, email: string): string {
  if (!profile) return defaultWorkspaceName(name, email);
  if (profile.whose_email === 'clients') return NEW_CLIENT_WORKSPACE;
  return cleanName(profile.organization, MAX_NAME) || defaultWorkspaceName(name, email);
}
