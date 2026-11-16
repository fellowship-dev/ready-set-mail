// "First report received" notification — fires once per domain when
// the very first DMARC aggregate report is successfully stored.
// Delivery: Cloudflare Email Workers (SEND_EMAIL binding).
// Falls back to console.log if binding is absent.

import type { TenantContext } from '../tenancy/context';
import { senderAddress } from '../auth/mail';
import { publicBaseUrl } from '../funnel/config';

export interface ReportStats {
  totalMessages: number;
  passMessages: number;
  failMessages: number;
  sourceCount: number;
}

// ── Formatting ────────────────────────────────────────────────

/** A name that is an email address is no name: greet without it. */
const greeting = (name: string): string => (name.includes('@') ? 'Hi,' : `Hi ${name},`);

export function buildFirstReportBody(
  recipientName: string,
  domain: string,
  stats: ReportStats,
  dashboardUrl: string,
): string {
  const passRate = stats.totalMessages > 0
    ? Math.round((stats.passMessages / stats.totalMessages) * 100)
    : 0;

  const lines: string[] = [
    greeting(recipientName),
    '',
    `We just received the first DMARC aggregate report for ${domain}.`,
    '',
    'Here are the highlights:',
    `  - ${stats.totalMessages.toLocaleString()} email(s) analyzed`,
    `  - ${stats.sourceCount.toLocaleString()} sending source(s) detected`,
    `  - ${passRate}% pass rate (${stats.passMessages.toLocaleString()} passed, ${stats.failMessages.toLocaleString()} failed)`,
    '',
    `View the full report on your dashboard: ${dashboardUrl}`,
    '',
    'Reports from other mail providers usually follow, about once a day each.',
    '',
    '—',
    'Ready Set Mail notifications',
  ];

  return lines.join('\n');
}

// ── Delivery ──────────────────────────────────────────────────

export async function sendFirstReportNotification(
  tenant: TenantContext,
  domain: string,
  reportStats: ReportStats,
  domainId?: number,
): Promise<void> {
  // Dashboard URL: the configured public origin (hosted), else custom domain > {worker}.{subdomain}.workers.dev (self-host)
  const publicOrigin = publicBaseUrl(tenant.env);
  let dashboardUrl: string;
  if (publicOrigin) {
    dashboardUrl = domainId === undefined ? publicOrigin : `${publicOrigin}/#/w/${encodeURIComponent(tenant.workspaceId)}/domains/${domainId}`;
  } else {
    const customDomain = await tenant.scope.settings.get('custom_domain');
    if (customDomain?.value) {
      dashboardUrl = `https://${customDomain.value}`;
    } else {
      const workerName = tenant.workerName;
      const subdomain = await tenant.workersSubdomain();
      dashboardUrl = subdomain
        ? `https://${workerName}.${subdomain}.workers.dev`
        : `https://${workerName}.workers.dev`;
    }
  }

  // Get admin user email
  const admin = await tenant.scope.team.firstAdmin();
  if (!admin) {
    console.log('[first-report] no admin user found — skipping notification');
    return;
  }

  const subject = `First DMARC report for ${domain}`;
  const body = buildFirstReportBody(admin.name ?? 'there', domain, reportStats, dashboardUrl);

  if (!tenant.env.SEND_EMAIL) {
    console.log(`[first-report] SEND_EMAIL binding not configured — not sent: ${subject}`);
    return;
  }

  // Self-host: the workspace's sender. Hosted: the platform sender, the one sign-in email uses.
  const from = tenant.settings.fromEmail || (await senderAddress(tenant.env));
  if (!from) {
    console.log('[first-report] no sender address configured — not sent');
    return;
  }

  try {
    await tenant.env.SEND_EMAIL.send({
      from: { name: 'Ready Set Mail', email: from },
      to: [admin.email],
      subject,
      text: body,
    });
    console.log(`[first-report] sent notification for ${domain}`);
  } catch (e) {
    console.error(`[first-report] send failed for ${domain}:`, e);
  }
}
