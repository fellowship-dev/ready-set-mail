// What every non-transactional email (onboarding sequence, change alerts, weekly digests) goes through:
//   - a suppression check before the send,
//   - a one-click unsubscribe link (signed token, no login) in the body and in List-Unsubscribe / List-Unsubscribe-Post,
//   - the postal address (POSTAL_ADDRESS) in the footer.
// Transactional mail (password reset, invites, the confirmation link itself) does not use this.

import { funnelQueries } from '@ready-set-mail/db';
import type { BoundEnv } from '../index';
import { hostedEnabled } from '../hosted/config';
import { postalAddress, publicBaseUrl } from '../funnel/config';
import type { Mailer, MailMessage, SendResult } from './mailer';
import { appUrl } from '../billing/paths';
import { senderAddress } from '../auth/mail';
import { signToken } from './tokens';
import { lightColors as c } from '../../packages/ui/src/tokens/tokens';

export type NonTransactionalResult = SendResult | { ok: false; kind: 'suppressed' | 'blocked'; error: string };

export async function isSuppressed(env: Pick<BoundEnv, 'DB'>, email: string): Promise<boolean> {
  return funnelQueries(env.DB).suppression.has(email);
}

export async function unsubscribeUrl(env: BoundEnv, email: string): Promise<string | null> {
  const base = publicBaseUrl(env);
  if (!base) return null;
  return `${base}/api/unsubscribe?t=${encodeURIComponent(await signToken(env, { p: 'unsub', e: email.trim().toLowerCase() }))}`;
}

/**
 * The sender of every email to an account holder (first report, records live, no reports, weekly summary, tips, change alerts, connection broken,
 * proof lost, and the sign-in emails): the platform's (src/auth/mail.ts `senderAddress`, the `from_email` of the implicit workspace). On self-host
 * the workspace's own `fromEmail` takes precedence when it has one; on the hosted service a workspace has no sender of its own, so never.
 */
export async function accountSender(env: BoundEnv, tenant?: { settings: { fromEmail?: string } }): Promise<string | undefined> {
  if (!hostedEnabled(env) && tenant?.settings.fromEmail) return tenant.settings.fromEmail;
  return senderAddress(env);
}

/**
 * A link into the dashboard for an email, `<public origin>/#/w/<workspace>/<path>`: the origin is PUBLIC_BASE_URL, else BETTER_AUTH_URL
 * (`publicBaseUrl`), never a workers.dev host and never the reports or intake domain. Null when no public origin is configured.
 */
export function appLink(env: BoundEnv, workspaceId: string, path = '/'): string | null {
  const base = publicBaseUrl(env);
  return base ? appUrl(base, workspaceId, path) : null;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function footerText(unsubscribe: string | null, address: string | null): string {
  const lines = ['', '--', address ? `Ready Set Mail, ${address.replace(/\s*\n\s*/g, ', ')}` : 'Ready Set Mail'];
  if (unsubscribe) lines.push(`Unsubscribe: ${unsubscribe}`);
  return lines.join('\n');
}

export function footerHtml(unsubscribe: string | null, address: string | null): string {
  const parts = [`Ready Set Mail${address ? `, ${esc(address).replace(/\s*\n\s*/g, ', ')}` : ''}`];
  if (unsubscribe) parts.push(`<a href="${esc(unsubscribe)}" style="color:${c['ink-2']};">Unsubscribe</a>`);
  return `<div style="max-width:600px;margin:0 auto;padding:12px 24px 24px;font-family:Arial,sans-serif;font-size:11px;color:${c['ink-2']};text-align:center;">${parts.join(' &middot; ')}</div>`;
}

/**
 * Send one non-transactional email. Never throws.
 *
 * `requireLink` (default: on for the hosted service): refuse to send when no unsubscribe link can be built because
 * PUBLIC_BASE_URL is unset. Self-host alerts to the instance's own team may go out without a link; they are still
 * suppression-checked and carry the footer.
 *
 * `unsubscribeUrl`: the link to use instead of the address-wide one (a preference link that turns off one kind of email: src/lifecycle/email/).
 * The footer and both List-Unsubscribe headers carry it, and the suppression check and postal footer apply as always.
 */
export async function sendNonTransactional(
  env: BoundEnv,
  mailer: Mailer,
  m: Omit<MailMessage, 'headers'> & { headers?: Record<string, string> },
  opts: { requireLink?: boolean; unsubscribeUrl?: string } = {},
): Promise<NonTransactionalResult> {
  const to = m.to.trim().toLowerCase();
  let message: MailMessage;
  // Everything before the provider call: a failure here means nothing was sent (an internal error, not a transient one).
  try {
    if (await isSuppressed(env, to)) return { ok: false, kind: 'suppressed', error: 'recipient is on the suppression list' };
    const link = opts.unsubscribeUrl ?? await unsubscribeUrl(env, to);
    if (!link && (opts.requireLink ?? hostedEnabled(env))) return { ok: false, kind: 'blocked', error: 'no unsubscribe link: PUBLIC_BASE_URL is not set' };
    const address = postalAddress(env);
    message = {
      ...m,
      to,
      text: m.text + footerText(link, address),
      html: m.html ? m.html.replace(/<\/body>/i, `${footerHtml(link, address)}</body>`) : undefined,
      headers: {
        ...m.headers,
        ...(link ? { 'List-Unsubscribe': `<${link}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : {}),
      },
    };
  } catch (e) {
    return { ok: false, kind: 'config', error: `internal error before sending: ${e instanceof Error ? e.message : 'unknown'}` };
  }
  // The provider call: an exception here leaves the outcome unknown.
  try {
    return await mailer.send(message);
  } catch (e) {
    return { ok: false, kind: 'transient', error: e instanceof Error ? e.message : 'send failed' };
  }
}
