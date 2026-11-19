// Who gets which lifecycle email, and what a person has chosen.
//
//   records live, first report, no reports   the workspace's owners, plus the admin who added the domain (when the audit log recorded who). Transactional: no preference.
//   weekly summary                           owners: on unless turned off. Admins: off unless turned on. Members are not offered it.
//   tips                                     owners and admins, only when they turned them on themselves: off by default for everyone. (The instance sends none either until LIFECYCLE_EMAILS_ON names `tips`, kinds.ts.)
//
// A preference is a row in email_preferences (user, workspace, kind); no row is the default above. The job reads the rows when it sends, so a
// change is effective on the next send.

import type { EmailPreferenceKind, MembershipRole, PreferenceRow, RecipientRow } from '@ready-set-mail/db';
import { publicBaseUrl } from '../../funnel/config';
import { signToken } from '../../mail/tokens';
import type { BoundEnv } from '../../index';
import { appUrl } from '../../billing/paths';
import type { LifecycleEnv } from './kinds';

export interface Recipient { userId: string; email: string; name: string; role: MembershipRole }

/** The first name when `users.name` is a real name (sign-up stores the email address when none was given), else null. */
export function firstName(name: string | null | undefined): string | null {
  const flat = (name ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!flat || flat.includes('@')) return null;
  return flat.split(' ')[0] || null;
}
export const greeting = (name: string | null | undefined): string => {
  const n = firstName(name);
  return n ? `Hi ${n},` : 'Hi,';
};

/** Is this kind of email offered to this role at all? (Members are offered neither.) */
export const offered = (role: MembershipRole): boolean => role === 'owner' || role === 'admin';

/** Does this person get the email of this preference? A stored choice wins; else the default of the role. */
export function preferenceOn(role: MembershipRole, kind: EmailPreferenceKind, row: Pick<PreferenceRow, 'enabled'> | undefined): boolean {
  if (!offered(role)) return false;
  if (row) return row.enabled === 1;
  return role === 'owner' && kind === 'summary';
}

const toRecipient = (r: RecipientRow): Recipient => ({ userId: r.user_id, email: r.email, name: r.name, role: r.role });

/**
 * Verified addresses only; `requireVerified` is off only for self-host, where nobody is asked to verify an address (src/auth/session.ts).
 * Owners, plus (when given) the admins who added the domain.
 */
export function milestoneRecipients(people: readonly RecipientRow[], adders: ReadonlySet<string>, requireVerified: boolean): Recipient[] {
  return people
    .filter((p) => (!requireVerified || p.email_verified === 1) && (p.role === 'owner' || (p.role === 'admin' && adders.has(p.user_id))))
    .map(toRecipient);
}

/** Owners and admins who have this preference on, verified addresses only. */
export function preferenceRecipients(people: readonly RecipientRow[], prefs: readonly PreferenceRow[], kind: EmailPreferenceKind): Recipient[] {
  return people
    .filter((p) => p.email_verified === 1 && preferenceOn(p.role, kind, prefs.find((x) => x.user_id === p.user_id && x.kind === kind)))
    .map(toRecipient);
}

// ── Links ────────────────────────────────────────────────────

/** `<origin>/api/email-preferences/off?t=<token>`: turns off one kind of email for one person in one workspace; null when no public origin is set. */
export async function preferenceOffUrl(env: BoundEnv, userId: string, workspaceId: string, kind: EmailPreferenceKind): Promise<string | null> {
  const base = publicBaseUrl(env);
  if (!base) return null;
  return `${base}/api/email-preferences/off?t=${encodeURIComponent(await signToken(env, { p: 'pref', u: userId, w: workspaceId, k: kind }))}`;
}

/** The dashboard's route to a domain: `<origin>/#/w/<workspace>/domains/<id>` (the hash router keeps the workspace in the URL). */
export function domainUrl(env: BoundEnv, workspaceId: string, domainId: number): string | null {
  const base = publicBaseUrl(env);
  return base ? appUrl(base, workspaceId, `/domains/${domainId}`) : null;
}

/** Settings, where the email choices live. */
export function settingsUrl(env: BoundEnv, workspaceId: string): string | null {
  const base = publicBaseUrl(env);
  return base ? appUrl(base, workspaceId, '/settings') : null;
}

export const KIND_WORDS: Readonly<Record<EmailPreferenceKind, { title: string; off: string }>> = {
  summary: { title: 'the weekly summary', off: 'Turn off the weekly summary' },
  tips: { title: 'tips about your domains', off: 'Turn off tips about your domains' },
};
