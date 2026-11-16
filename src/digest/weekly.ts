// Weekly DMARC digest emails.
// Runs every Monday (cron "0 9 * * 1") and sends a summary of
// the past 7 days of DMARC aggregate reports.
//
// Delivery: Cloudflare Email Workers (SEND_EMAIL binding).
// Recipients must be verified destination addresses in CF Email Routing.
// Falls back to console.log if binding is absent (wrangler dev has no local send_email support).

import type { TenantContext } from '../tenancy/context';
import type { DomainWeeklyStat, FailingSource } from '@ready-set-mail/db';
import { buildWeeklyDigestHtml } from '../email/html-templates';
import { sendNonTransactional } from '../mail/compliance';
import { ownerMailer } from '../mail/mailer';
import { checkForUpdate, type UpdateInfo } from '../update-check';
import { uncountedNotice } from '../reports/visibility';
import { hostedEnabled } from '../hosted/config';

/** The update line of a digest: only when a newer published release exists (src/update-check.ts). */
export type DigestUpdate = Pick<UpdateInfo, 'current' | 'latest' | 'release_url' | 'upgrade_url'>;

// ── Formatting ────────────────────────────────────────────────

function pct(n: number, total: number): string {
  if (total === 0) return '0%';
  return `${Math.round((n / total) * 100)}%`;
}

function policyBadge(policy: string | null): string {
  if (policy === 'reject')     return 'reject ✅';
  if (policy === 'quarantine') return 'quarantine ⚠️';
  if (policy === 'none')       return 'none ❌';
  return '(not set) ❌';
}

function formatDomainSection(
  stat: DomainWeeklyStat,
  sources: FailingSource[],
  ruaAddress: string,
): string {
  const lines: string[] = [`Domain: ${stat.domain}`];
  lines.push(`DMARC policy: ${policyBadge(stat.dmarc_policy)}`);

  if (stat.total_messages === 0) {
    // Never "no reports" when reports arrived and were left out of the numbers.
    if (stat.uncounted_reports > 0) lines.push(`No counted reports this week. ${uncountedNotice(stat.uncounted_reports)}`);
    else {
      lines.push('No reports received this week.');
      lines.push(`Check that rua=mailto:${ruaAddress} is in your DMARC record.`);
    }
    return lines.join('\n');
  }

  lines.push(`Messages this week: ${stat.total_messages.toLocaleString()}`);
  lines.push(`  ✅ Passed: ${stat.pass_messages.toLocaleString()} (${pct(stat.pass_messages, stat.total_messages)})`);
  lines.push(`  ❌ Failed: ${stat.fail_messages.toLocaleString()} (${pct(stat.fail_messages, stat.total_messages)})`);
  if (stat.uncounted_reports > 0) lines.push(`  ${uncountedNotice(stat.uncounted_reports)}`);

  if (sources.length > 0) {
    lines.push('');
    lines.push('Top failing sources:');
    for (const s of sources) {
      const from = s.header_from ? ` (${s.header_from})` : '';
      lines.push(`  ${s.source_ip}${from} — ${s.total.toLocaleString()} failures`);
    }
  }

  return lines.join('\n');
}

export function buildDigestBody(
  recipientName: string,
  stats: DomainWeeklyStat[],
  sourcesByDomain: Map<number, FailingSource[]>,
  weekLabel: string,
  ruaAddress: string,
  reportsDomain: string,
  update: DigestUpdate | null = null,
): string {
  const lines: string[] = [
    `Hi ${recipientName},`,
    '',
    `Here's your DMARC summary for the week of ${weekLabel}.`,
    '',
  ];

  for (const stat of stats) {
    lines.push(formatDomainSection(stat, sourcesByDomain.get(stat.domain_id) ?? [], ruaAddress));
    lines.push('');
  }

  // CTA for degraded domains (policy = none or missing)
  const weak = stats.filter(s => s.dmarc_policy === 'none' || !s.dmarc_policy);
  if (weak.length > 0) {
    lines.push(`${weak.map(s => s.domain).join(', ')} ${weak.length === 1 ? 'is' : 'are'} not enforcing DMARC.`);
    lines.push(`Want us to fix it for you? Visit https://${reportsDomain.replace(/^reports\./, '')}`);
    lines.push('');
  }

  if (update?.latest) {
    lines.push('─────────────────────────────');
    lines.push(`📦 Ready Set Mail v${update.latest} is available (you're on v${update.current}).`);
    lines.push(`Release notes: ${update.release_url}`);
    lines.push(`How to upgrade: ${update.upgrade_url}`);
    lines.push('');
  }

  lines.push('—');
  lines.push('Ready Set Mail weekly digest');

  return lines.join('\n');
}

// ── Delivery ──────────────────────────────────────────────────

async function sendDigest(
  email: string,
  subject: string,
  body: string,
  html: string,
  tenant: TenantContext,
): Promise<void> {
  const mailer = ownerMailer(tenant.env);
  if (!mailer) {
    console.log(`[digest] no mail provider configured — would send to ${email}: ${subject}\n${body}`);
    return;
  }

  // Digests are non-transactional: suppression check, unsubscribe link and headers, postal footer.
  const out = await sendNonTransactional(tenant.env, mailer, {
    from: { name: 'Ready Set Mail', email: tenant.settings.fromEmail! },
    to: email,
    subject,
    text: body,
    html,
  });
  if (!out.ok) console.error(`[digest] digest not sent (${out.kind}): ${out.error}`);
}

// ── Main ──────────────────────────────────────────────────────

export async function sendWeeklyDigests(tenant: TenantContext, now = Date.now()): Promise<void> {
  // The hosted service has no digest: its address (rua@<reports domain>), its sender and its "fix it" link are the self-host forms, and none of them
  // exists per workspace there. Account holders get the weekly summary instead (src/lifecycle/email/run.ts, under this same cron, `0 9 * * 1`).
  if (hostedEnabled(tenant.env)) {
    console.log('[digest] hosted: skipped, the weekly summary replaces the digest');
    return;
  }
  const since = Math.floor(now / 1000) - 7 * 24 * 60 * 60; // 7 days ago in Unix seconds
  const weekLabel = new Date(since * 1000).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
  const rd = tenant.settings.reportsDomain;
  if (!rd) {
    console.log('[digest] reports domain not configured — skipping weekly digest');
    return;
  }
  const ruaAddress = `rua@${rd}`;

  // Single-tenant: get admin user email for digest delivery
  const q = tenant.scope;
  const admin = await q.team.firstAdmin();
  if (!admin) {
    console.log('[digest] no admin user found — skipping weekly digest');
    return;
  }

  try {
    const stats = await q.reports.weeklyDomainStats(since);
    if (stats.length === 0) {
      console.log('[digest] no domains — skipping weekly digest');
      return;
    }

    // Fetch top failing sources for domains that had failures
    const sourcesByDomain = new Map<number, FailingSource[]>();
    for (const stat of stats) {
      if (stat.fail_messages > 0) {
        const sources = await q.reports.topFailingSources(stat.domain_id, since);
        sourcesByDomain.set(stat.domain_id, sources);
      }
    }

    // Only for a digest that is sent. Off in MODE=saas and with UPDATE_CHECK=off; cached in OAUTH_KV, so a run over
    // many workspaces makes one GitHub call.
    const check = await checkForUpdate(tenant.env);
    const update: DigestUpdate | null = check.status === 'newer' ? check : null;
    if (update) console.log(`[digest] update available: v${update.latest} (running v${update.current})`);

    const body = buildDigestBody(admin.name ?? 'there', stats, sourcesByDomain, weekLabel, ruaAddress, rd, update);
    const html = buildWeeklyDigestHtml({
      recipientName: admin.name ?? 'there',
      stats,
      sourcesByDomain,
      weekLabel,
      ruaAddress,
      reportsDomain: rd,
      update,
      brand: tenant.brand,
    });
    const hasIssues = stats.some(s => s.fail_messages > 0 || !s.dmarc_policy || s.dmarc_policy === 'none');
    const subject = hasIssues
      ? `⚠️ DMARC Weekly Digest — action needed`
      : `✅ DMARC Weekly Digest — all clear`;

    await sendDigest(admin.email, subject, body, html, tenant);
    console.log(`[digest] sent to ${admin.email} (${stats.length} domain(s))`);
  } catch (e) {
    console.error('[digest] error:', e);
  }
}
