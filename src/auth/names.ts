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

/** Common free-mail domains: a workspace named after one ("gmail.com workspace") would say nothing about whose it is. */
export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com', 'icloud.com',
  'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.net', 'gmx.de', 'web.de', 'mail.com',
  'yandex.com', 'yandex.ru', 'zoho.com', 'fastmail.com', 'hey.com', 'tutanota.com', 'tuta.io', 'qq.com', '163.com',
]);

/**
 * The workspace name a new account starts with: from the name the person gave, else from their email's domain, else (a
 * free-mail address) "My workspace".
 */
export function defaultWorkspaceName(name: string, email: string): string {
  const clean = cleanName(name);
  if (clean) return cleanName(`${clean}'s workspace`);
  const domain = email.split('@')[1]?.toLowerCase().trim() ?? '';
  return cleanName(domain && !FREE_MAIL_DOMAINS.has(domain) ? `${domain} workspace` : 'My workspace');
}

/** What an agency's first workspace is called until its first client domain is added (it is then named after that domain). */
export const NEW_CLIENT_WORKSPACE = 'New client';

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
