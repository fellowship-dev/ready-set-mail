// Branded HTML email templates for all outbound report types.
// All templates use inline CSS (no <style> blocks) for email-client compatibility. Colours are the design-system tokens
// (light values: mail clients have no reliable dark mode), statuses keep their meaning: success, warning, danger.
// Plain-text versions are generated separately and passed alongside HTML in multipart/alternative.

import type { DomainWeeklyStat, FailingSource } from '@ready-set-mail/db';
import { uncountedNotice } from '../reports/visibility';
import { CheckSummary, DO_IT_FOR_YOU, doItForYouUrl, fixSteps, HELP_LINE, OverallStatus, retentionSentence, SHARE_IT, shareLinks } from './report-formatter';
import { DomainChange } from '../monitor/check';
import { DnsCheckResult } from './dns-check';
import { AuthResultsHeader } from './parse-headers';
import { DEFAULT_BRAND_COLOR, type Brand } from '../tenancy/context';
import { lightColors as c } from '../../packages/ui/src/tokens/tokens';

const DEFAULT_BRAND: Readonly<Brand> = { color: DEFAULT_BRAND_COLOR };

// ── Primitives ────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function badge(label: string, color: string): string {
  return `<span style="display:inline-block;padding:2px 8px;border-radius:3px;font-size:12px;font-weight:600;background:${color};color:#fff;">${esc(label)}</span>`;
}

function passBadge(pass: boolean): string {
  return pass ? badge('PASS', c.success) : badge('FAIL', c.danger);
}

function policyBadge(policy: string | null): string {
  if (policy === 'reject')     return badge('reject', c.success);
  if (policy === 'quarantine') return badge('quarantine', c.warning);
  if (policy === 'none')       return badge('none', c.danger);
  return badge('not set', c.danger);
}

function severityBadge(s: DomainChange['severity']): string {
  if (s === 'improved') return badge('improved', c.success);
  if (s === 'degraded') return badge('degraded', c.danger);
  return badge('changed', c.warning);
}

function pct(n: number, total: number): string {
  if (total === 0) return '0%';
  return `${Math.round((n / total) * 100)}%`;
}

// ── Shared layout ─────────────────────────────────────────────

function htmlLayout(title: string, bodyHtml: string, brand: Brand, footer = 'Ready Set Mail — automated email security monitoring'): string {
  const accent = esc(brand.color);
  const logo = brand.logoUrl;
  // A workspace's own logo keeps its coloured band. Otherwise the header is the wordmark as plain text: no remote
  // images (many clients block them and every open would hit the instance), no SVG or web font. The light background and
  // the navy text are set as a pair, so a client that forces dark mode inverts both and the contrast holds, and the name
  // still reads with images blocked. The brand colour stays as the rule under the header.
  const header = logo
    ? `<tr><td style="background:${accent};padding:16px 24px;">
    <span style="color:#fff;font-size:16px;font-weight:700;"><img src="${esc(logo)}" alt="Ready Set Mail" style="height:32px;vertical-align:middle;margin-right:8px;">Ready Set Mail</span>
  </td></tr>`
    : `<tr><td style="background:${c['surface-1']};padding:16px 24px;border-bottom:3px solid ${accent};">
    <span style="color:${c['ink-1']};font-family:Arial,Helvetica,sans-serif;font-size:20px;font-weight:700;letter-spacing:-0.01em;">readysetmail</span>
  </td></tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:${c['surface-2']};font-family:Arial,sans-serif;font-size:14px;color:${c['ink-1']};">
<table width="100%" cellpadding="0" cellspacing="0" style="background:${c['surface-2']};">
<tr><td align="center" style="padding:24px 8px;">
<table width="600" cellpadding="0" cellspacing="0" style="background:${c['surface-1']};border-radius:6px;overflow:hidden;max-width:600px;">
  ${header}
  <tr><td style="padding:24px;">
    ${bodyHtml}
  </td></tr>
  <tr><td style="padding:12px 24px;background:${c['surface-0']};border-top:1px solid ${c.line};font-size:11px;color:${c['ink-2']};text-align:center;">
    ${esc(footer)}
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

// ── Plain letter (onboarding sequence) ────────────────────────

export type LetterBlock = string | { heading: string } | { list: string[] } | { cta: { label: string; url: string } };

/** A plain, text-first letter in the shared brand layout: paragraphs, headings, lists and one call-to-action button. */
export function buildLetterHtml(p: { title: string; blocks: LetterBlock[]; brand?: Brand }): string {
  const brand = p.brand ?? DEFAULT_BRAND;
  const body = p.blocks.map((b) => {
    if (typeof b === 'string') return `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;">${esc(b)}</p>`;
    if ('heading' in b) return `<h2 style="margin:20px 0 8px;font-size:16px;">${esc(b.heading)}</h2>`;
    if ('list' in b) return `<ul style="margin:0 0 14px;padding-left:20px;font-size:15px;line-height:1.6;">${b.list.map((i) => `<li style="margin-bottom:6px;">${esc(i)}</li>`).join('')}</ul>`;
    return `<p style="margin:20px 0;"><a href="${esc(b.cta.url)}" style="display:inline-block;padding:10px 18px;border-radius:4px;background:${esc(brand.color)};color:#fff;font-size:15px;font-weight:600;text-decoration:none;">${esc(b.cta.label)}</a></p>`;
  }).join('\n');
  return htmlLayout(p.title, body, brand);
}

/** The same letter as plain text. */
export function buildLetterText(blocks: LetterBlock[]): string {
  return blocks.map((b) => {
    if (typeof b === 'string') return b;
    if ('heading' in b) return b.heading.toUpperCase();
    if ('list' in b) return b.list.map((i) => `- ${i}`).join('\n');
    return `${b.cta.label}: ${b.cta.url}`;
  }).join('\n\n');
}

// ── Sign-in code ──────────────────────────────────────────────

export interface CodeEmailHtmlParams {
  code: string;
  /** The one sentence: what entering the code does. */
  sentence: string;
  /** "It works for 10 minutes, once, …": the lifetime and where to enter it. */
  validity: string;
  /** "If you didn't ask for this, you can ignore this email." and the lines that follow it, each its own paragraph. */
  notes: string[];
  /** Small print under the notes (where it was asked for, advice after a sign-in). */
  fine: string[];
  /** The operator line (who runs the service, privacy link), or empty. */
  footer: string;
}

/**
 * The code email: the wordmark as text (no images, like every default-brand email), one sentence, the code alone in very large
 * selectable monospace digits in a light panel, how long it works, and what to do if it was not asked for. Nothing in it is a
 * link, so nothing in it can be mistaken for the way to enter the code.
 */
export function buildCodeEmailHtml(p: CodeEmailHtmlParams): string {
  const body = `<p style="margin:0 0 16px;font-size:16px;line-height:1.5;">${esc(p.sentence)}</p>
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin:0 0 16px;"><tr><td align="center" style="background:${c['surface-2']};border:1px solid ${c.line};border-radius:6px;padding:20px 8px;">
      <span style="display:block;font-family:'Courier New',Courier,monospace;font-size:40px;line-height:1.2;font-weight:700;letter-spacing:0.25em;color:${c['ink-1']};user-select:all;-webkit-user-select:all;">${esc(p.code)}</span>
    </td></tr></table>
    <p style="margin:0 0 16px;font-size:14px;line-height:1.5;">${esc(p.validity)}</p>
    ${p.notes.map((n) => `<p style="margin:0 0 12px;font-size:14px;line-height:1.5;color:${c['ink-2']};">${esc(n)}</p>`).join('\n    ')}
    ${p.fine.map((n) => `<p style="margin:12px 0 0;font-size:12px;line-height:1.5;color:${c['ink-2']};">${esc(n)}</p>`).join('\n    ')}`;
  return htmlLayout(`${p.code} is your Ready Set Mail code`, body, { color: DEFAULT_BRAND_COLOR }, p.footer || 'Ready Set Mail');
}

// ── Weekly digest ─────────────────────────────────────────────

function domainSection(
  stat: DomainWeeklyStat,
  sources: FailingSource[],
  ruaAddress: string,
): string {
  let html = `<h3 style="margin:20px 0 8px;font-size:15px;color:${c['ink-1']};">${esc(stat.domain)}</h3>`;
  html += `<p style="margin:0 0 8px;">DMARC policy: ${policyBadge(stat.dmarc_policy)}</p>`;

  if (stat.total_messages === 0 && stat.uncounted_reports > 0) {
    return html + `<p style="color:${c['ink-2']};">No counted reports this week. ${esc(uncountedNotice(stat.uncounted_reports))}</p>`;
  }
  if (stat.total_messages === 0) {
    html += `<p style="color:${c['ink-2']};">No reports received this week. Verify <code>rua=mailto:${esc(ruaAddress)}</code> is in your DMARC record.</p>`;
    return html;
  }

  html += `<table cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%;margin-bottom:8px;">
<tr style="background:${c['surface-0']};font-weight:600;"><td>Messages</td><td>Passed</td><td>Failed</td></tr>
<tr><td>${stat.total_messages.toLocaleString()}</td>
<td style="color:${c.success};">${stat.pass_messages.toLocaleString()} (${pct(stat.pass_messages, stat.total_messages)})</td>
<td style="color:${c.danger};">${stat.fail_messages.toLocaleString()} (${pct(stat.fail_messages, stat.total_messages)})</td></tr>
</table>`;
  if (stat.uncounted_reports > 0) html += `<p style="color:${c['ink-2']};margin:0 0 8px;">${esc(uncountedNotice(stat.uncounted_reports))}</p>`;

  if (sources.length > 0) {
    html += `<p style="font-weight:600;margin:8px 0 4px;">Top failing sources:</p>
<table cellpadding="4" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:13px;">
<tr style="background:${c['surface-0']};font-weight:600;"><td>IP</td><td>From</td><td>Failures</td></tr>`;
    for (const s of sources) {
      html += `<tr><td>${esc(s.source_ip)}</td><td>${esc(s.header_from ?? '—')}</td><td>${s.total.toLocaleString()}</td></tr>`;
    }
    html += '</table>';
  }

  return html;
}

export interface WeeklyDigestHtmlParams {
  recipientName: string;
  stats: DomainWeeklyStat[];
  sourcesByDomain: Map<number, FailingSource[]>;
  weekLabel: string;
  ruaAddress: string;
  reportsDomain: string;
  /** Only when a newer published release exists (src/update-check.ts). */
  update?: { current: string; latest: string | null; release_url: string; upgrade_url: string } | null;
  brand?: Brand;
}

export function buildWeeklyDigestHtml(p: WeeklyDigestHtmlParams): string {
  let body = `<h2 style="margin:0 0 16px;font-size:18px;">DMARC Weekly Digest</h2>
<p style="margin:0 0 16px;">Hi ${esc(p.recipientName)}, here&rsquo;s your summary for the week of <strong>${esc(p.weekLabel)}</strong>.</p>
<hr style="border:none;border-top:1px solid ${c.line};margin:16px 0;">`;

  for (const stat of p.stats) {
    body += domainSection(stat, p.sourcesByDomain.get(stat.domain_id) ?? [], p.ruaAddress);
    body += `<hr style="border:none;border-top:1px solid ${c.line};margin:12px 0;">`;
  }

  const weak = p.stats.filter(s => s.dmarc_policy === 'none' || !s.dmarc_policy);
  if (weak.length > 0) {
    body += `<p style="background:${c['warning-subtle']};border:1px solid ${c.warning};border-radius:4px;padding:12px;margin:16px 0;">
<strong>${esc(weak.map(s => s.domain).join(', '))}</strong> ${weak.length === 1 ? 'is' : 'are'} not enforcing DMARC.
<br>Want us to fix it? <a href="https://${esc(p.reportsDomain.replace(/^reports\./, ''))}">Sign up for Ready Set Mail</a>.
</p>`;
  }

  if (p.update?.latest) {
    const u = p.update;
    body += `<p style="font-size:12px;color:${c['ink-2']};">Ready Set Mail v${esc(u.latest!)} is available (you&rsquo;re on v${esc(u.current)}): <a href="${esc(u.release_url)}">release notes</a> &middot; <a href="${esc(u.upgrade_url)}">how to upgrade</a></p>`;
  }

  return htmlLayout(`DMARC Weekly Digest — ${p.weekLabel}`, body, p.brand ?? DEFAULT_BRAND);
}

// ── Free-check report ─────────────────────────────────────────

const STATUS_COLOR: Readonly<Record<OverallStatus, string>> = {
  protected: c.success,
  at_risk:   c.warning,
  exposed:   c.danger,
};

const STATUS_LABEL: Readonly<Record<OverallStatus, string>> = {
  protected: 'Protected',
  at_risk:   'At risk',
  exposed:   'Exposed',
};

const STATUS_DESC: Readonly<Record<OverallStatus, string>> = {
  protected: 'This email passed all security checks.',
  at_risk:   'Your domain has partial protection — gaps remain.',
  exposed:   'Anyone can send email pretending to be you.',
};

export interface FreeCheckHtmlParams {
  fromEmail: string;
  summary: CheckSummary;
  auth: AuthResultsHeader | null;
  dns: DnsCheckResult;
  brand?: Brand;
  /** The line telling the sender about the follow-up emails, with its unsubscribe link. */
  disclosure?: { text: string; unsubscribeUrl: string };
  /** The marketing site (SITE_URL); no marketing link when unset. */
  siteUrl?: string | null;
  /** Days check results are kept, for the retention line when the sender is not enrolled. */
  retentionDays?: number;
  /** Not enrolled but already known (see CheckReportOptions.lead), for the retention line. */
  lead?: 'inactive' | 'suppressed';
  /** BOOKING_URL: where "or we do it for you" points first. */
  bookingUrl?: string | null;
}

export function buildFreeCheckHtml(p: FreeCheckHtmlParams): string {
  const { summary, auth, dns } = p;
  const color = STATUS_COLOR[summary.status];

  let body = `<div style="background:${color};color:#fff;border-radius:4px;padding:16px;margin-bottom:16px;">
<span style="font-size:18px;font-weight:700;">${esc(STATUS_LABEL[summary.status])}</span>
<span style="margin-left:12px;">${esc(STATUS_DESC[summary.status])}</span>
</div>
<p style="margin:0 0 12px;">Security check for <strong>${esc(summary.domain)}</strong></p>
<table cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%;margin-bottom:16px;">
<tr style="background:${c['surface-0']};font-weight:600;"><td>Check</td><td>Result</td><td>Detail</td></tr>
<tr style="border-top:1px solid ${c.line};">
  <td><strong>SPF</strong></td>
  <td>${passBadge(summary.spfPass)}</td>
  <td style="font-size:13px;color:${c['ink-2']};">${summary.spfPass ? 'Authorized sender' : 'Unauthorized or no record'}</td>
</tr>
<tr style="border-top:1px solid ${c.line};">
  <td><strong>DKIM</strong></td>
  <td>${passBadge(summary.dkimPass)}</td>
  <td style="font-size:13px;color:${c['ink-2']};">${summary.dkimPass ? 'Valid signature' : summary.dkimPresent ? 'Key found but email unsigned' : 'No signing key configured'}</td>
</tr>
<tr style="border-top:1px solid ${c.line};">
  <td><strong>DMARC</strong></td>
  <td>${passBadge(summary.dmarcPass)}</td>
  <td style="font-size:13px;color:${c['ink-2']};">Policy: ${policyBadge(summary.dmarcPolicy)}</td>
</tr>
</table>`;

  // DNS records detail
  body += `<h3 style="margin:16px 0 8px;font-size:13px;font-weight:600;color:${c['ink-2']};text-transform:uppercase;">DNS Records</h3>
<table cellpadding="4" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:12px;font-family:monospace;">`;
  if (dns.spf) {
    body += `<tr><td style="padding-right:12px;color:${c['ink-2']};">SPF</td><td>${esc(dns.spf.raw)}</td></tr>`;
  }
  if (dns.dmarc) {
    body += `<tr><td style="padding-right:12px;color:${c['ink-2']};">DMARC</td><td>${esc(dns.dmarc.raw)}</td></tr>`;
  }
  for (const [label, msg] of [['SPF', dns.errors?.spf], ['DMARC', dns.errors?.dmarc], ['DKIM', dns.errors?.dkim]] as const) {
    if (msg) body += `<tr><td style="padding-right:12px;color:${c['ink-2']};">${label}</td><td>could not be checked (DNS lookup failed)</td></tr>`;
  }
  if (dns.dkim) {
    body += `<tr><td style="padding-right:12px;color:${c['ink-2']};">DKIM</td><td>selector: ${esc(auth?.dkim?.selector ?? 'found')}</td></tr>`;
  }
  body += '</table>';

  const steps = fixSteps(summary, auth, dns);
  if (steps.length > 0) {
    const accent = esc((p.brand ?? DEFAULT_BRAND).color);
    body += `<h3 style="margin:16px 0 8px;font-size:15px;">What to do next</h3>
<ol style="margin:0 0 12px;padding-left:20px;font-size:14px;line-height:1.5;">`;
    for (const st of steps) {
      body += `<li style="margin-bottom:8px;">${esc(st.text)}`;
      if (st.record) {
        body += `<div style="margin:6px 0;font-family:monospace;font-size:12px;background:${c['surface-2']};padding:8px;border-radius:4px;">${esc(st.record.name)} &nbsp;${st.record.type}&nbsp; ${esc(st.record.value)}</div>`;
      }
      if (st.note) body += `<div style="font-size:13px;color:${c['ink-2']};">${esc(st.note)}</div>`;
      body += '</li>';
    }
    body += '</ol>';
    const url = doItForYouUrl(p);
    body += url
      ? `<p style="margin:0;font-size:14px;">${DO_IT_FOR_YOU}: <a href="${esc(url)}" style="color:${accent};">${esc(url)}</a></p>`
      : `<p style="margin:0;font-size:14px;">${DO_IT_FOR_YOU}: reply to this email.</p>`;
  }

  const share = shareLinks(summary, p.siteUrl);
  if (share.length) {
    const accent = esc((p.brand ?? DEFAULT_BRAND).color);
    const links = share.map(l => `<a href="${esc(l.url)}" style="color:${accent};">${esc(l.label)}</a>`).join(' · ');
    body += `<p style="margin:16px 0 0;font-size:14px;">${SHARE_IT} (optional, nothing is posted unless you post it): ${links}</p>`;
  }

  if (p.disclosure) {
    body += `<p style="margin:16px 0 0;font-size:13px;color:${c['ink-2']};">${esc(p.disclosure.text)} <a href="${esc(p.disclosure.unsubscribeUrl)}" style="color:${c['ink-2']};">Unsubscribe</a></p>`;
  }

  const site = p.siteUrl ? ` <a href="${esc(p.siteUrl)}" style="color:${c['ink-2']};">${esc(p.siteUrl.replace(/^https:\/\//, ''))}</a>` : '';
  body += `<p style="margin:16px 0 0;font-size:12px;color:${c['ink-2']};">${esc(retentionSentence({ retentionDays: p.retentionDays, enrolled: p.disclosure, lead: p.lead }))}${site}</p>
<p style="margin:16px 0 0;font-size:15px;font-weight:600;">${esc(HELP_LINE)}</p>`;

  return htmlLayout(`Email Security Check — ${summary.domain}`, body, p.brand ?? DEFAULT_BRAND);
}

// ── DNS change alert ──────────────────────────────────────────

export interface DnsAlertHtmlParams {
  domain: string;
  changes: DomainChange[];
  reportsDomain: string;
  brand?: Brand;
}

export function buildDnsAlertHtml(p: DnsAlertHtmlParams): string {
  const hasDegraded = p.changes.some(c => c.severity === 'degraded');
  const accent = (p.brand ?? DEFAULT_BRAND).color;

  let body = `<h2 style="margin:0 0 12px;font-size:18px;">Email security configuration changed</h2>
<p style="margin:0 0 16px;">We detected changes to the email security configuration of <strong>${esc(p.domain)}</strong>.</p>
<table cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%;margin-bottom:16px;">
<tr style="background:${c['surface-0']};font-weight:600;"><td>Field</td><td>Was</td><td>Now</td><td>Status</td></tr>`;

  for (const ch of p.changes) {
    body += `<tr style="border-top:1px solid ${c.line};">
<td><strong>${esc(ch.field)}</strong></td>
<td style="font-size:13px;color:${c['ink-2']};">${esc(ch.was || '(not set)')}</td>
<td style="font-size:13px;">${esc(ch.now || '(removed)')}</td>
<td>${severityBadge(ch.severity)}</td>
</tr>`;
  }

  body += '</table>';

  if (hasDegraded) {
    body += `<p style="background:${c['danger-subtle']};border:1px solid ${c.danger};border-radius:4px;padding:12px;margin:0 0 12px;">
Some changes may leave your domain exposed to spoofing.
<a href="https://${esc(p.reportsDomain.replace(/^reports\./, ''))}" style="color:${esc(accent)};">Fix it with Ready Set Mail →</a>
</p>`;
  } else {
    body += `<p style="color:${c['ink-2']};font-size:13px;">No action required — these look like improvements or routine updates.</p>`;
  }

  return htmlLayout(`${p.domain} email security updated`, body, p.brand ?? DEFAULT_BRAND);
}
