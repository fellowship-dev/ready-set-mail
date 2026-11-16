import { describe, it, expect, vi } from 'vitest';

import {
  buildWeeklyDigestHtml,
  buildFreeCheckHtml,
  buildDnsAlertHtml,
  buildLetterHtml,
} from '../../src/email/html-templates';
import { stepCopy, SEQUENCE_DAYS } from '../../src/funnel/copy';
import type { DomainWeeklyStat, FailingSource } from '@ready-set-mail/db';
import type { CheckSummary } from '../../src/email/report-formatter';
import type { DomainChange } from '../../src/monitor/check';
import type { DnsCheckResult } from '../../src/email/dns-check';
import type { AuthResultsHeader } from '../../src/email/parse-headers';
import { DEFAULT_BRAND_COLOR } from '../../src/tenancy/context';
import { render } from '../../src/lifecycle/email/copy';
import { allVariants } from '../lifecycle/email/fixtures';

// ── Fixtures ──────────────────────────────────────────────────

const STAT_REJECT: DomainWeeklyStat = {
  domain_id: 1, domain: 'acme.com', dmarc_policy: 'reject',
  total_messages: 1000, pass_messages: 980, fail_messages: 20, report_count: 5,
};

const STAT_NONE: DomainWeeklyStat = {
  domain_id: 2, domain: 'acme.net', dmarc_policy: 'none',
  total_messages: 50, pass_messages: 30, fail_messages: 20, report_count: 1,
};

const STAT_NO_REPORTS: DomainWeeklyStat = {
  domain_id: 3, domain: 'acme.org', dmarc_policy: null,
  total_messages: 0, pass_messages: 0, fail_messages: 0, report_count: 0,
};

const SOURCE: FailingSource = { source_ip: '1.2.3.4', total: 15, header_from: 'mail.sender.com' };

const DNS_FULL: DnsCheckResult = {
  spf:  { raw: 'v=spf1 include:_spf.google.com ~all', verdict: 'softfail', lookup_count: 2 },
  dkim: { present: true },
  dmarc: { raw: 'v=DMARC1; p=reject', policy: 'reject', pct: 100 },
};

const AUTH_PASS: AuthResultsHeader = {
  spf:   { result: 'pass',    domain: 'acme.com' },
  dkim:  { result: 'pass',    domain: 'acme.com', selector: 'google' },
  dmarc: { result: 'pass',    domain: 'acme.com', policy: 'reject', disposition: 'none' },
  raw: '',
};

// ── Weekly digest ─────────────────────────────────────────────

describe('buildWeeklyDigestHtml', () => {
  function makeParams(overrides: Partial<Parameters<typeof buildWeeklyDigestHtml>[0]> = {}) {
    const sourcesByDomain = new Map<number, FailingSource[]>();
    sourcesByDomain.set(1, [SOURCE]);
    return {
      recipientName: 'Alice',
      stats: [STAT_REJECT, STAT_NONE],
      sourcesByDomain,
      weekLabel: 'Mar 24, 2025',
      ruaAddress: 'rua@reports.acme.com',
      reportsDomain: 'reports.acme.com',
      update: null,
      ...overrides,
    };
  }

  it('includes recipient name and week label', () => {
    const html = buildWeeklyDigestHtml(makeParams());
    expect(html).toContain('Alice');
    expect(html).toContain('Mar 24, 2025');
  });

  it('renders reject badge for reject policy', () => {
    const html = buildWeeklyDigestHtml(makeParams());
    expect(html).toContain('reject');
    expect(html).toContain('#147a3a'); // success token: reject badge
  });

  it('renders none badge for none policy', () => {
    const html = buildWeeklyDigestHtml(makeParams());
    expect(html).toContain('none');
    expect(html).toContain('#b91c1c'); // danger token: none badge
  });

  it('shows pass/fail counts with percentages', () => {
    const html = buildWeeklyDigestHtml(makeParams());
    expect(html).toContain('1,000');
    expect(html).toContain('980');
    expect(html).toContain('98%');
    expect(html).toContain('20');
    expect(html).toContain('2%');
  });

  it('shows top failing sources table', () => {
    const html = buildWeeklyDigestHtml(makeParams());
    expect(html).toContain('1.2.3.4');
    expect(html).toContain('mail.sender.com');
  });

  it('shows CTA for weak domains', () => {
    const html = buildWeeklyDigestHtml(makeParams());
    expect(html).toContain('acme.net');
    expect(html).toContain('not enforcing DMARC');
  });

  it('shows no reports message when total_messages is 0', () => {
    const html = buildWeeklyDigestHtml(makeParams({ stats: [STAT_NO_REPORTS] }));
    expect(html).toContain('No reports received this week');
    expect(html).toContain('rua@reports.acme.com');
  });

  it('shows update notice when a newer release is passed in', () => {
    const html = buildWeeklyDigestHtml(makeParams({ update: { current: '1.0.0', latest: '2.0.0', release_url: 'https://github.com/fellowship-dev/ready-set-mail/releases/tag/v2.0.0', upgrade_url: 'https://github.com/fellowship-dev/ready-set-mail/blob/v2.0.0/packages/db/UPGRADING.md' } }));
    expect(html).toContain('v2.0.0');
    expect(html).toContain('v1.0.0');
  });

  it('omits update notice without an update', () => {
    const html = buildWeeklyDigestHtml(makeParams({ update: null }));
    expect(html).not.toContain('is available');
  });

  it('is valid HTML with doctype', () => {
    const html = buildWeeklyDigestHtml(makeParams());
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain('</html>');
  });
});

// ── Free-check report ─────────────────────────────────────────

describe('buildFreeCheckHtml', () => {
  function makeSummary(status: CheckSummary['status'], overrides: Partial<CheckSummary> = {}): CheckSummary {
    return {
      status,
      domain: 'acme.com',
      spfPass: status === 'protected',
      dkimPass: status === 'protected',
      dmarcPass: status === 'protected',
      dmarcPolicy: status === 'exposed' ? null : 'reject',
      dkimPresent: true,
      ...overrides,
    };
  }

  it('shows green banner for protected status', () => {
    const html = buildFreeCheckHtml({ fromEmail: 'user@acme.com', summary: makeSummary('protected'), auth: AUTH_PASS, dns: DNS_FULL });
    expect(html).toContain('Protected');
    expect(html).toContain('#147a3a');
  });

  it('shows orange banner for at_risk status', () => {
    const html = buildFreeCheckHtml({ fromEmail: 'user@acme.com', summary: makeSummary('at_risk'), auth: AUTH_PASS, dns: DNS_FULL });
    expect(html).toContain('At risk');
    expect(html).toContain('#aa4f08');
  });

  it('shows red banner for exposed status', () => {
    const html = buildFreeCheckHtml({ fromEmail: 'user@acme.com', summary: makeSummary('exposed'), auth: null, dns: DNS_FULL });
    expect(html).toContain('Exposed');
    expect(html).toContain('#b91c1c');
  });

  it('shows PASS badges for all checks when protected', () => {
    const html = buildFreeCheckHtml({ fromEmail: 'user@acme.com', summary: makeSummary('protected'), auth: AUTH_PASS, dns: DNS_FULL });
    expect(html.match(/PASS/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('shows FAIL badges for failed checks', () => {
    const html = buildFreeCheckHtml({ fromEmail: 'user@acme.com', summary: makeSummary('exposed'), auth: null, dns: DNS_FULL });
    expect(html).toContain('FAIL');
  });

  it('shows SPF and DMARC DNS records', () => {
    const html = buildFreeCheckHtml({ fromEmail: 'user@acme.com', summary: makeSummary('protected'), auth: AUTH_PASS, dns: DNS_FULL });
    expect(html).toContain('v=spf1');
    expect(html).toContain('v=DMARC1');
  });

  it('shows CTA for non-protected status, linking the configured site', () => {
    const html = buildFreeCheckHtml({ fromEmail: 'user@acme.com', summary: makeSummary('exposed'), auth: null, dns: DNS_FULL, siteUrl: 'https://readysetmail.com' });
    expect(html).toContain('href="https://readysetmail.com"');
  });

  it('no site URL: no marketing link and never readysetmail.com', () => {
    const html = buildFreeCheckHtml({ fromEmail: 'user@acme.com', summary: makeSummary('exposed'), auth: null, dns: DNS_FULL });
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('readysetmail.com');
    expect(html).not.toContain('No data about your domain is stored');
  });

  const bodyText = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  const LAYOUT_FOOTER = 'Ready Set Mail — automated email security monitoring';

  it('the body ends with the help line, after the disclosure', () => {
    for (const status of ['protected', 'at_risk', 'exposed'] as const) {
      const html = buildFreeCheckHtml({ fromEmail: 'user@acme.com', summary: makeSummary(status), auth: null, dns: DNS_FULL, disclosure: { text: 'We will send you 5 short emails.', unsubscribeUrl: 'https://w.example/u' } });
      expect(bodyText(html).endsWith(`Need help? Any doubts? Reply. ${LAYOUT_FOOTER}`)).toBe(true);
      expect(html.indexOf('Need help?')).toBeGreaterThan(html.indexOf('We will send you 5 short emails.'));
    }
  });

  it('states retention truthfully for each enrolment outcome', () => {
    const plain = buildFreeCheckHtml({ fromEmail: 'user@acme.com', summary: makeSummary('exposed'), auth: null, dns: DNS_FULL, retentionDays: 14 });
    expect(bodyText(plain)).toContain('We keep your address and this result for 14 days, then delete them.');
    const enrolled = buildFreeCheckHtml({ fromEmail: 'user@acme.com', summary: makeSummary('exposed'), auth: null, dns: DNS_FULL, disclosure: { text: 'x', unsubscribeUrl: 'https://w.example/u' } });
    expect(bodyText(enrolled)).toContain('after you unsubscribe we keep only your address, on a do-not-contact list. The full result is deleted after');
    const suppressed = buildFreeCheckHtml({ fromEmail: 'user@acme.com', summary: makeSummary('exposed'), auth: null, dns: DNS_FULL, retentionDays: 14, lead: 'suppressed' });
    expect(bodyText(suppressed)).toContain('Your address is on our do-not-contact list and stays there');
  });

  it('omits CTA for protected status', () => {
    const html = buildFreeCheckHtml({ fromEmail: 'user@acme.com', summary: makeSummary('protected'), auth: AUTH_PASS, dns: DNS_FULL });
    expect(html).not.toContain('Start free monitoring');
  });

  const NO_DMARC: DnsCheckResult = { ...DNS_FULL, dmarc: null };

  it('no DMARC: shows the exact _dmarc record and the "mailbox you read" note', () => {
    const html = buildFreeCheckHtml({ fromEmail: 'user@acme.com', summary: makeSummary('exposed'), auth: null, dns: NO_DMARC });
    expect(html).toContain('_dmarc.acme.com');
    expect(html).toContain('v=DMARC1; p=none; rua=mailto:dmarc@acme.com');
    expect(html).toContain('change the address to one you read');
  });

  it('p=reject and all passing: no fix block and no "or we do it" line', () => {
    const html = buildFreeCheckHtml({ fromEmail: 'user@acme.com', summary: makeSummary('protected'), auth: AUTH_PASS, dns: DNS_FULL, bookingUrl: 'https://cal.example/max' });
    expect(html).not.toContain('What to do next');
    expect(html).not.toMatch(/or we do it/i);
  });

  it('"or we do it for you" links BOOKING_URL, else SITE_URL/pricing, else is plain text', () => {
    const p = { fromEmail: 'user@acme.com', summary: makeSummary('exposed'), auth: null, dns: NO_DMARC };
    expect(buildFreeCheckHtml({ ...p, bookingUrl: 'https://cal.example/max', siteUrl: 'https://readysetmail.com' })).toMatch(/Or we do it for you[^<]*<a href="https:\/\/cal\.example\/max"/);
    expect(buildFreeCheckHtml({ ...p, siteUrl: 'https://readysetmail.com' })).toMatch(/Or we do it for you[^<]*<a href="https:\/\/readysetmail\.com\/pricing"/);
    const plain = buildFreeCheckHtml(p);
    expect(plain).toContain('Or we do it for you');
    expect(plain).not.toContain('<a ');
  });

  it('protected: X and LinkedIn share links, URL-encoded and HTML-escaped, before the help line', () => {
    const html = buildFreeCheckHtml({ fromEmail: 'user@acme.com', summary: makeSummary('protected'), auth: AUTH_PASS, dns: DNS_FULL });
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map(m => m[1].replace(/&amp;/g, '&'));
    const x = hrefs.find(h => h.startsWith('https://x.com/intent/tweet?text='))!;
    const li = hrefs.find(h => h.startsWith('https://www.linkedin.com/feed/?shareActive=true&text='))!;
    for (const u of [x, li]) {
      expect(u).toBeDefined();
      expect(u).not.toMatch(/ /);
      expect(new URL(u).searchParams.get('text')).toContain('acme.com');
    }
    expect(html).toContain('shareActive=true&amp;text=');
    expect(html.indexOf('x.com/intent')).toBeLessThan(html.indexOf('Need help?'));
  });

  it('at risk and exposed: no share links', () => {
    for (const status of ['at_risk', 'exposed'] as const) {
      const html = buildFreeCheckHtml({ fromEmail: 'user@acme.com', summary: makeSummary(status), auth: AUTH_PASS, dns: DNS_FULL });
      expect(html).not.toContain('x.com/intent');
      expect(html).not.toContain('linkedin.com');
    }
  });

  it('Google MX and no SPF: the SPF record is the catalog\'s Google include', () => {
    const dns: DnsCheckResult = { domain: 'acme.com', spf: null, dkim: null, dmarc: null, mx: { status: 'found', hosts: [{ priority: 1, host: 'aspmx.l.google.com' }] } };
    const html = buildFreeCheckHtml({ fromEmail: 'user@acme.com', summary: makeSummary('exposed', { spfPass: false }), auth: null, dns });
    expect(html).toContain('v=spf1 include:_spf.google.com ~all');
    expect(html).not.toMatch(/resolver|cross-check|consensus|confirmed/i);
  });

  it('is valid HTML with doctype', () => {
    const html = buildFreeCheckHtml({ fromEmail: 'user@acme.com', summary: makeSummary('protected'), auth: AUTH_PASS, dns: DNS_FULL });
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain('</html>');
  });
});

// ── DNS change alert ──────────────────────────────────────────

describe('buildDnsAlertHtml', () => {
  const degraded: DomainChange = { field: 'DMARC policy', was: 'reject', now: 'none', severity: 'degraded' };
  const improved: DomainChange = { field: 'DMARC policy', was: 'none', now: 'reject', severity: 'improved' };
  const changed:  DomainChange = { field: 'SPF record', was: 'v=spf1 ~all', now: 'v=spf1 -all', severity: 'changed' };

  it('shows domain name in heading', () => {
    const html = buildDnsAlertHtml({ domain: 'acme.com', changes: [degraded], reportsDomain: 'reports.acme.com' });
    expect(html).toContain('acme.com');
  });

  it('shows degraded badge in red', () => {
    const html = buildDnsAlertHtml({ domain: 'acme.com', changes: [degraded], reportsDomain: 'reports.acme.com' });
    expect(html).toContain('degraded');
    expect(html).toContain('#b91c1c');
  });

  it('shows improved badge in green', () => {
    const html = buildDnsAlertHtml({ domain: 'acme.com', changes: [improved], reportsDomain: 'reports.acme.com' });
    expect(html).toContain('improved');
    expect(html).toContain('#147a3a');
  });

  it('shows changed badge in orange', () => {
    const html = buildDnsAlertHtml({ domain: 'acme.com', changes: [changed], reportsDomain: 'reports.acme.com' });
    expect(html).toContain('changed');
    expect(html).toContain('#aa4f08');
  });

  it('shows old and new values in change table', () => {
    const html = buildDnsAlertHtml({ domain: 'acme.com', changes: [degraded], reportsDomain: 'reports.acme.com' });
    expect(html).toContain('reject');
    expect(html).toContain('none');
    expect(html).toContain('DMARC policy');
  });

  it('shows warning CTA when changes include degraded', () => {
    const html = buildDnsAlertHtml({ domain: 'acme.com', changes: [degraded], reportsDomain: 'reports.acme.com' });
    expect(html).toContain('exposed to spoofing');
    expect(html).toContain('acme.com'); // strip reports. prefix
  });

  it('shows no-action message when no degraded changes', () => {
    const html = buildDnsAlertHtml({ domain: 'acme.com', changes: [improved], reportsDomain: 'reports.acme.com' });
    expect(html).toContain('No action required');
  });

  it('is valid HTML with doctype', () => {
    const html = buildDnsAlertHtml({ domain: 'acme.com', changes: [degraded], reportsDomain: 'reports.acme.com' });
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain('</html>');
  });
});

// ── Shared layout: the logo ───────────────────────────────────

describe('email header', () => {
  const params = { fromEmail: 'user@acme.com', summary: { status: 'protected', domain: 'acme.com', spfPass: true, dkimPass: true, dmarcPass: true, dmarcPolicy: 'reject', dkimPresent: true } as CheckSummary, auth: AUTH_PASS, dns: DNS_FULL };

  it('sets the name as navy text on a light cell, with the brand rule under it, and no image', () => {
    const html = buildFreeCheckHtml(params);
    expect(html).not.toContain('<img');
    expect(html).toContain('background:#ffffff;padding:16px 24px;border-bottom:3px solid #0647FF;');
    expect(html).toMatch(/color:#06194b;font-family:Arial,Helvetica,sans-serif;font-size:20px;font-weight:700;letter-spacing:-0\.01em;">readysetmail<\/span>/i);
    expect(html).not.toMatch(/<svg|data:image/);
  });

  it("keeps a workspace's own logo on its coloured band", () => {
    const html = buildFreeCheckHtml({ ...params, brand: { color: '#ff0000', logoUrl: 'https://logo.example.test/x.png' } });
    expect(html).toContain('background:#ff0000;padding:16px 24px;');
    expect(html).toContain('src="https://logo.example.test/x.png"');
    expect(html).not.toContain('https://app.example.test/l.png');
  });

  it('the default brand colour is the brand blue', () => {
    expect(DEFAULT_BRAND_COLOR).toBe('#0647FF');
  });
});

// ── No remote resources in any default-brand email ────────────

describe('default-brand HTML emails load nothing remote', () => {
  const dns = DNS_FULL;
  const summary = { status: 'protected', domain: 'acme.com', spfPass: true, dkimPass: true, dmarcPass: true, dmarcPolicy: 'reject', dkimPresent: true } as CheckSummary;
  const changes: DomainChange[] = [{ field: 'dmarc', was: 'p=none', now: 'p=reject', severity: 'improved' } as DomainChange];
  const sequence = SEQUENCE_DAYS.map((_, i) => {
    const copy = stepCopy(i, { domain: 'acme.com', summary, bookingUrl: 'https://cal.example.test/x', prices: {} });
    return [`funnel step ${i}`, buildLetterHtml({ title: copy.subject, blocks: copy.blocks, brand: { color: DEFAULT_BRAND_COLOR } })] as const;
  });
  const emails: (readonly [string, string])[] = [
    ['weekly digest', buildWeeklyDigestHtml({ recipientName: 'Ada', weekLabel: 'Jan 1', stats: [STAT_REJECT], sourcesByDomain: new Map(), ruaAddress: 'rua@r.example.test', reportsDomain: 'reports.example.test' })],
    ['free check', buildFreeCheckHtml({ fromEmail: 'user@acme.com', summary, auth: AUTH_PASS, dns })],
    ['dns alert', buildDnsAlertHtml({ domain: 'acme.com', changes, reportsDomain: 'reports.example.test' })],
    ['letter', buildLetterHtml({ title: 'Hi', blocks: ['Hello', { cta: { label: 'Go', url: 'https://example.test/' } }] })],
    ...sequence,
  ];

  it.each(emails)('%s', (_name, html) => {
    expect(html).not.toMatch(/<img[^>]*\ssrc\s*=\s*["']?https?:/i);
    expect(html).not.toMatch(/url\(\s*["']?https?:/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/<svg|data:image/i);
    expect(html).toMatch(/font-weight:700;letter-spacing:-0\.01em;">readysetmail<\/span>/);
  });
});

// ── Lifecycle emails: nothing remote, no emoji, no scare words ──
// Every variant of every lifecycle email (test/lifecycle/email/fixtures.ts), HTML and text.

describe('lifecycle emails load nothing remote', () => {
  const lifecycle = allVariants().map((v) => [v.name, render(v.mail)] as const);

  it('renders every kind of lifecycle email', () => {
    expect(new Set(allVariants().map((v) => v.mail.kind))).toEqual(new Set(['records_live', 'first_report', 'no_reports', 'summary', 'tip_fix', 'tip_next', 'tip_done']));
  });

  it.each(lifecycle)('%s', (_name, { html }) => {
    expect(html).not.toContain('<img');
    expect(html).not.toContain('url(');
    expect(html).not.toMatch(/\ssrc\s*=/i);
    expect(html).not.toMatch(/<link\b|@import|<svg|data:image|<script|<iframe/i);
    expect(html).toMatch(/font-weight:700;letter-spacing:-0\.01em;">readysetmail<\/span>/);
  });
});

describe('lifecycle emails have no emoji and none of the scare words', () => {
  const lifecycle = allVariants().map((v) => [v.name, render(v.mail)] as const);
  const banned = ['could not be authenticated', 'claims to be', 'spoof', 'attack', 'at risk', 'exposed', 'action needed'];

  it.each(lifecycle)('%s', (_name, { subject, html, text }) => {
    for (const [part, s] of [['subject', subject], ['html', html], ['text', text]] as const) {
      expect(s, `${part} has an emoji`).not.toMatch(/\p{Extended_Pictographic}/u);
      for (const phrase of banned) expect(s.toLowerCase(), `${part} says "${phrase}"`).not.toContain(phrase);
    }
  });
});
