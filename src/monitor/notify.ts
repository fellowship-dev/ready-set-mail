// Change notification emails for domain monitoring.
// Delivery: Cloudflare Email Workers (SEND_EMAIL binding).
// Falls back to console.log if binding is absent (wrangler dev has no local send_email support).
//
// Sender and links are the ones of every account-holder email (src/mail/compliance.ts `accountSender`, `appLink`): the platform sender on
// hosted, the workspace's own on self-host, and the public origin, never the reports domain. The alerts can be switched off with
// LIFECYCLE_EMAILS_OFF (`change_alerts`, `connection_alerts`); on hosted the change alerts are off until LIFECYCLE_EMAILS_ON names them
// (src/lifecycle/email/kinds.ts).

import { DomainChange } from './check';
import type { TenantContext } from '../tenancy/context';
import { buildDnsAlertHtml } from '../email/html-templates';
import { replyTo } from '../funnel/config';
import { hostedEnabled } from '../hosted/config';
import { alertEnabled } from '../lifecycle/email/kinds';
import { accountSender, appLink, sendNonTransactional } from '../mail/compliance';
import { ownerMailer } from '../mail/mailer';

function buildEmailBody(domain: string, changes: DomainChange[], openUrl: string | null, canReply: boolean): string {
  const lines: string[] = [
    `We detected changes to the email security configuration of ${domain}.`,
    '',
    ...changes.map(c =>
      `${c.field} (${c.severity})\n   Was: ${c.was || '(not set)'}\n   Now: ${c.now || '(removed)'}`
    ),
    '',
  ];

  const hasDegraded = changes.some(c => c.severity === 'degraded');
  if (hasDegraded) {
    lines.push("Some of these changes weaken the domain's email security settings.");
    if (openUrl) lines.push(`Open ${domain} in Ready Set Mail: ${openUrl}`);
    if (canReply) lines.push('Want us to fix it for you? Reply to this email.');
    lines.push('');
  } else {
    lines.push('No action required — these look like improvements or routine updates.');
    lines.push('');
  }

  lines.push('—');
  lines.push('Ready Set Mail domain monitoring');

  return lines.join('\n');
}

export async function sendChangeNotification(
  email: string,
  domain: string,
  changes: DomainChange[],
  tenant: TenantContext,
): Promise<void> {
  const env = tenant.env;
  if (!alertEnabled(env, hostedEnabled(env), 'change_alerts')) {
    console.log(`[notify] change alerts are off here (LIFECYCLE_EMAILS_ON / LIFECYCLE_EMAILS_OFF): ${domain} changed, nothing sent`);
    return;
  }
  const hasDegraded = changes.some(c => c.severity === 'degraded');
  const subject = hasDegraded
    ? `${domain} email security degraded`
    : `${domain} email security updated`;

  // The domain's own page when the workspace has it, else the dashboard.
  const known = await tenant.scope.domains.getByName(domain).catch(() => null);
  const openUrl = appLink(env, tenant.workspaceId, known ? `/domains/${known.id}` : '/');
  const reply = replyTo(env);
  const body = buildEmailBody(domain, changes, openUrl, !!reply);
  const html = buildDnsAlertHtml({ domain, changes, openUrl, canReply: !!reply, brand: tenant.brand });

  const mailer = ownerMailer(env);
  const from = await accountSender(env, tenant);
  if (!mailer || !from) {
    console.log(`[notify] ${!mailer ? 'no mail provider configured' : 'no sender address'} — would send to ${email}: ${subject}\n${body}`);
    return;
  }

  // Alerts are non-transactional: suppression check, unsubscribe link and headers, postal footer.
  const out = await sendNonTransactional(env, mailer, {
    from: { name: 'Ready Set Mail', email: from },
    to: email,
    subject,
    text: body,
    html,
    ...(reply ? { replyTo: reply } : {}),
  });
  if (!out.ok) console.error(`[notify] alert not sent (${out.kind}): ${out.error}`);
}

/**
 * Tell the workspace's owner and admins that a Cloudflare connection stopped working: DNS changes for the
 * domains behind it fail until someone reconnects. Same channel as the change alerts (SEND_EMAIL, else a log line).
 */
export async function notifyConnectionBroken(
  tenant: TenantContext,
  info: { id: string; label: string; detail: string },
): Promise<void> {
  const env = tenant.env;
  if (!alertEnabled(env, hostedEnabled(env), 'connection_alerts')) return;
  const team = await tenant.scope.team.list();
  const to = team.filter(m => m.role === 'owner' || m.role === 'admin').map(m => m.email);
  const settingsUrl = appLink(env, tenant.workspaceId, '/settings');
  const subject = `Cloudflare connection "${info.label}" needs attention`;
  const body = [
    `Ready Set Mail can no longer use your Cloudflare connection "${info.label}".`,
    '',
    info.detail,
    '',
    'DNS changes for the domains managed through it will fail until it is reconnected:',
    'open your dashboard → Settings → Cloudflare and reconnect it.',
    ...(settingsUrl ? [settingsUrl] : []),
    '',
    '—',
    'Ready Set Mail',
  ].join('\n');

  const from = await accountSender(env, tenant);
  if (!env.SEND_EMAIL || !from || to.length === 0) {
    console.warn(`[connections] ${tenant.workspaceId}: connection ${info.id} is broken (${info.detail}); no alert email could be sent`);
    return;
  }
  for (const email of to) {
    try {
      await env.SEND_EMAIL.send({ from: { name: 'Ready Set Mail', email: from }, to: [email], subject, text: body });
    } catch (e) {
      console.error(`[connections] alert to ${email} failed:`, e instanceof Error ? e.name : 'error');
    }
  }
}
