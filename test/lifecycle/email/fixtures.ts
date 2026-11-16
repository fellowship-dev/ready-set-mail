// Every lifecycle email, every variant, with the example data of the spec: Brightwave Studio, owner Dana Reyes, brightwave-mail.com, reporter
// Google, RFC 5737 addresses only, a fixed clock. Shared by copy.test.ts and the no-remote-resources block of test/email/html-templates.test.ts.

import { dmarcSteps, policyInForce, type InForce, type Policy } from '@ready-set-mail/dns-checks/dmarc-next-step';
import {
  firstReport, noReports, recordsLive, tipDone, tipFix, tipNext, weeklySummary,
  type Footer, type Mail, type SummaryRow, type Who,
} from '../../../src/lifecycle/email/copy';
import { summarise, type SourceStat, type SummaryDomain, type Totals } from '../../../src/lifecycle/email/analysis';

export const DOMAIN = 'brightwave-mail.com';
export const SUB = 'news.brightwave-mail.com';
export const BASE = 'https://app.example.test';
export const DOMAIN_URL = `${BASE}/#/w/ws_brightwave/domains/7`;
export const SETTINGS_URL = `${BASE}/#/w/ws_brightwave/settings`;
export const OFF_URL = `${BASE}/api/email-preferences/off?t=TOKEN`;
export const RUA = 'rua@rua.readysetmail.com';
export const ORDER_URL = `${DOMAIN_URL}?order=1`;

/** Mon 16 Nov 2026 11:00 UTC */
export const NOW = 1794826800;
const DAY = 86400;
/** Mon 9 Nov 2026 00:00 UTC; the week reported on Mon 16 Nov is [WEEK_START, WEEK_START + 7 days). */
export const WEEK_START = 1794182400;
export const WEEK = { start: WEEK_START, end: WEEK_START + 7 * DAY };
/** Sun 15 Nov 2026 00:00 UTC */
export const SUN_15 = WEEK_START + 6 * DAY;

const milestoneFooter: Footer = { why: `You get this because you added ${DOMAIN} to Brightwave Studio on Ready Set Mail.`, settingsUrl: SETTINGS_URL };
export const milestoneWho: Who = { name: 'Dana Reyes', footer: milestoneFooter };
export const severalWho: Who = { name: 'Dana Reyes', footer: { why: 'You get this because you added these domains to Brightwave Studio on Ready Set Mail.', settingsUrl: SETTINGS_URL } };
export const nameless: Who = { name: 'dana@brightwave-mail.com', footer: milestoneFooter };
const ownerSummary: Who = { name: 'Dana Reyes', footer: { why: 'Why am I getting this? You are the owner of Brightwave Studio on Ready Set Mail, and the weekly summary is on for you.', settingsUrl: SETTINGS_URL, off: { label: 'Turn off the weekly summary', url: OFF_URL } } };
const adminSummary: Who = { name: 'Dana Reyes', footer: { why: 'Why am I getting this? You are an admin of Brightwave Studio on Ready Set Mail, and you turned the weekly summary on.', settingsUrl: SETTINGS_URL, off: { label: 'Turn off the weekly summary', url: OFF_URL } } };
const tipWho: Who = { name: 'Dana Reyes', footer: { why: 'Why am I getting this? You are the owner of Brightwave Studio on Ready Set Mail, and tips about your domains are on for you.', settingsUrl: SETTINGS_URL, off: { label: 'Turn off tips about your domains', url: OFF_URL } } };

export const src = (p: Partial<SourceStat> & { key: string }): SourceStat => ({ name: null, ips: [], messages: 0, failing: 0, other: null, ...p });

const google = (p: Partial<SourceStat> = {}): SourceStat => src({ key: 'google workspace', name: 'Google Workspace', ips: ['192.0.2.10'], messages: 1000, failing: 0, ...p });
const sendgrid = (p: Partial<SourceStat> = {}): SourceStat => src({ key: 'sendgrid', name: 'o1.email.sendgrid.net', ips: ['198.51.100.7', '198.51.100.8', '198.51.100.9'], messages: 40, failing: 11, other: { by: 'DKIM', domain: 'sendgrid.net' }, ...p });

const totals = (total: number, passed: number, reports = 1): Totals => ({ total, passed, reports });
const first = (o: { total?: number; passed?: number; sources?: number; failing?: SourceStat | null; policy?: string | null; begin?: number; end?: number } = {}) => ({
  reporter: 'Google', begin: SUN_15, end: SUN_15 + DAY, total: 14, passed: 14, sources: 2, failing: null as SourceStat | null, policy: 'none' as string | null, ...o,
});

const domainRow = (p: Partial<SummaryDomain> & { domain: string }): SummaryDomain => ({
  id: 7, policy: 'none', this: totals(0, 0, 0), last: totals(0, 0, 0), sources: [], lastSources: [], earlierKeys: new Set(), ...p,
});

export interface Variant { name: string; mail: Mail }

export function policyStep(policy: Policy, messages = 1240, domain = DOMAIN): { inForce: InForce; step: ReturnType<typeof dmarcSteps>[number]; target: Policy } {
  const f = policyInForce(domain, { dmarc_policy: policy, dmarc_p: policy, dmarc_pct: 100, dmarc_sp: null, dmarc_rua: 1 });
  if (f.kind !== 'own') throw new Error(`expected own, got ${f.kind}`);
  const step = dmarcSteps(domain, f, { reportsAddress: true, ruaAddress: RUA, reports: { total: messages, passed: messages, days: 14 } })[0];
  const target: Policy = policy === 'none' ? 'quarantine' : 'reject';
  return { inForce: f, step, target };
}


/** Every lifecycle email and variant. */
export function allVariants(): Variant[] {
  const out: Variant[] = [];
  const add = (name: string, mail: Mail) => out.push({ name, mail });

  // b. records live
  add('records live: one domain', recordsLive({ ...milestoneWho, items: [{ domain: DOMAIN, seenAt: NOW }], domainUrl: DOMAIN_URL }));
  add('records live: several domains', recordsLive({ ...severalWho, items: [{ domain: DOMAIN, seenAt: NOW }, { domain: 'brightwave-news.example', seenAt: NOW - 3600 }], domainUrl: BASE }));

  // c. first report
  add('first report: all passed', firstReport({ ...milestoneWho, items: [{ domain: DOMAIN, data: first() }], domainUrl: DOMAIN_URL }));
  const failingOther = (o: Partial<SourceStat>) => sendgrid(o);
  add('first report: failing, passed DKIM for another domain', firstReport({ ...milestoneWho, items: [{ domain: DOMAIN, data: first({ passed: 3, failing: failingOther({ messages: 11, failing: 11, ips: ['198.51.100.7'] }) }) }], domainUrl: DOMAIN_URL }));
  add('first report: failing, passed SPF for another domain', firstReport({ ...milestoneWho, items: [{ domain: DOMAIN, data: first({ passed: 3, failing: failingOther({ messages: 11, failing: 11, ips: ['198.51.100.7'], other: { by: 'SPF', domain: 'mailer.example' } }) }) }], domainUrl: DOMAIN_URL }));
  const nobody = src({ key: '203.0.113.5', name: null, ips: ['203.0.113.5'], messages: 11, failing: 11 });
  add('first report: failing, no other pass, policy none', firstReport({ ...milestoneWho, items: [{ domain: DOMAIN, data: first({ passed: 3, failing: nobody, policy: 'none' }) }], domainUrl: DOMAIN_URL }));
  add('first report: failing, no other pass, policy quarantine', firstReport({ ...milestoneWho, items: [{ domain: DOMAIN, data: first({ passed: 3, failing: nobody, policy: 'quarantine' }) }], domainUrl: DOMAIN_URL }));
  add('first report: failing, no nameable source', firstReport({ ...milestoneWho, items: [{ domain: DOMAIN, data: first({ passed: 13, failing: null }) }], domainUrl: DOMAIN_URL }));
  add('first report: one message did not pass, one source', firstReport({ ...milestoneWho, items: [{ domain: DOMAIN, data: first({ total: 1, passed: 0, sources: 1, failing: src({ key: 'x', name: 'Example Mailer', ips: ['203.0.113.9'], messages: 1, failing: 1 }) }) }], domainUrl: DOMAIN_URL }));
  add('first report: report spanning two days', firstReport({ ...milestoneWho, items: [{ domain: DOMAIN, data: first({ begin: SUN_15 - DAY, end: SUN_15 + DAY }) }], domainUrl: DOMAIN_URL }));
  add('first report: several domains', firstReport({ ...severalWho, items: [{ domain: DOMAIN, data: first() }, { domain: SUB, data: first({ total: 1240, passed: 1200, reporter: 'Microsoft' }) }], domainUrl: BASE }));

  // d. no reports
  const nr = (check: Parameters<typeof noReports>[0]['items'][number]['check'], emailCheck: boolean) => noReports({ ...milestoneWho, items: [{ domain: DOMAIN, liveAt: NOW - 3 * DAY, check }], domainUrl: DOMAIN_URL, emailCheck });
  add('no reports: still names us', nr({ outcome: 'names_us' }, false));
  add('no reports: still names us, email check', nr({ outcome: 'names_us' }, true));
  add('no reports: no longer names us, with record', nr({ outcome: 'does_not', record: 'v=DMARC1; p=none; rua=mailto:dmarc@brightwave-mail.com', address: RUA }, false));
  add('no reports: no longer names us, no record', nr({ outcome: 'does_not', record: null, address: RUA }, false));
  add('no reports: read failed', nr({ outcome: 'failed' }, false));
  add('no reports: read failed, email check', nr({ outcome: 'failed' }, true));
  add('no reports: several domains, email check', noReports({
    ...severalWho, domainUrl: BASE, emailCheck: true,
    items: [
      { domain: DOMAIN, liveAt: NOW - 3 * DAY, check: { outcome: 'names_us' } },
      { domain: 'brightwave-news.example', liveAt: NOW - 4 * DAY, check: { outcome: 'does_not', record: 'v=DMARC1; p=none', address: RUA } },
      { domain: 'brightwave.example', liveAt: NOW - 5 * DAY, check: { outcome: 'failed' } },
    ],
  }));

  // e. weekly summary
  const oneDomain = [domainRow({ domain: DOMAIN, this: totals(1240, 1203, 9), last: totals(1100, 1100, 7), sources: [google({ messages: 1229 }), sendgrid({ messages: 11, failing: 11 })], lastSources: [google({ messages: 1100 })] })];
  const oneRows: SummaryRow[] = [{ domain: DOMAIN, indent: false, messages: 1240, passed: 1203, policy: 'none' }];
  add('summary: one domain, owner, started failing', weeklySummary({ ...ownerSummary, week: WEEK, facts: summarise([domainRow({ domain: DOMAIN, this: totals(1240, 1203, 9), last: totals(1100, 1100, 7), sources: [google({ messages: 1229 }), sendgrid({ messages: 11, failing: 11 })], lastSources: [google({ messages: 1100 }), sendgrid({ messages: 12, failing: 0 })] })]), rows: oneRows, uncounted: 0, domainUrl: DOMAIN_URL, domainName: DOMAIN }));
  add('summary: one domain, admin, new source failing, uncounted reports', weeklySummary({ ...adminSummary, week: WEEK, facts: summarise(oneDomain), rows: oneRows, uncounted: 3, domainUrl: DOMAIN_URL, domainName: DOMAIN }));
  add('summary: one domain, nothing changed', weeklySummary({
    ...ownerSummary, week: WEEK, domainUrl: DOMAIN_URL, domainName: DOMAIN, uncounted: 1, rows: [{ domain: DOMAIN, indent: false, messages: 1100, passed: 1100, policy: 'reject' }],
    facts: summarise([domainRow({ domain: DOMAIN, policy: 'reject', this: totals(1100, 1100, 7), last: totals(1000, 1000, 7), sources: [google({ messages: 1100 })], lastSources: [google({ messages: 1000 })] })]),
  }));
  const sub = domainRow({ id: 8, domain: SUB, policy: 'quarantine', this: totals(2880, 2820, 4), last: totals(2900, 2900, 4), sources: [google({ messages: 2880 })], lastSources: [google({ messages: 2900 })] });
  const mainD = domainRow({ domain: DOMAIN, policy: 'none', this: totals(1240, 1203, 9), last: totals(1100, 1100, 7), sources: [google({ messages: 1229 }), src({ key: '203.0.113.5', ips: ['203.0.113.5'], messages: 11, failing: 11 })], lastSources: [google({ messages: 1100 })] });
  const other = domainRow({ id: 9, domain: 'brightwave-news.example', policy: null, this: totals(0, 0, 0), last: totals(0, 0, 0) });
  add('summary: several domains, subdomain nested, new failing source', weeklySummary({
    ...ownerSummary, week: WEEK, domainUrl: BASE, domainName: null, uncounted: 0,
    rows: [
      { domain: DOMAIN, indent: false, messages: 1240, passed: 1203, policy: 'none' },
      { domain: SUB, indent: true, messages: 2880, passed: 2820, policy: 'quarantine' },
      { domain: 'brightwave-news.example', indent: false, messages: 0, passed: 0, policy: null },
    ],
    facts: summarise([mainD, sub, other]),
  }));
  add('summary: one domain, no reports this week but a change', weeklySummary({
    ...ownerSummary, week: WEEK, domainUrl: DOMAIN_URL, domainName: DOMAIN, uncounted: 0, rows: [{ domain: DOMAIN, indent: false, messages: 0, passed: 0, policy: 'none' }],
    facts: summarise([domainRow({ domain: DOMAIN, this: totals(0, 0, 0), last: totals(1100, 1100, 7), sources: [], lastSources: [google({ messages: 1100 })] })]),
  }));
  add('summary: new source, all passed, nothing to do', weeklySummary({
    ...ownerSummary, week: WEEK, domainUrl: DOMAIN_URL, domainName: DOMAIN, uncounted: 0, rows: [{ domain: DOMAIN, indent: false, messages: 1105, passed: 1105, policy: 'reject' }],
    facts: summarise([domainRow({ domain: DOMAIN, policy: 'reject', this: totals(1105, 1105, 7), last: totals(1000, 1000, 7), sources: [google({ messages: 1100 }), src({ key: 'mailchimp', name: 'Mailchimp', ips: ['203.0.113.40'], messages: 5 })], lastSources: [google({ messages: 1000 })] })]),
  }));
  add('summary: one new source with one failing message, nine changes', weeklySummary({
    ...ownerSummary, week: WEEK, domainUrl: DOMAIN_URL, domainName: DOMAIN, uncounted: 0, rows: [{ domain: DOMAIN, indent: false, messages: 1, passed: 0, policy: 'none' }],
    facts: summarise([domainRow({ domain: DOMAIN, this: totals(1, 0, 1), last: totals(1000, 1000, 7), sources: Array.from({ length: 10 }, (_, i) => src({ key: `s${i}`, name: `Service ${i}`, ips: [`203.0.113.${i + 1}`], messages: 1, failing: i === 0 ? 1 : 0 })), lastSources: [google({ messages: 1000 })] })]),
  }));

  // f. tips
  const fixSrc = sendgrid({ messages: 40, failing: 38 });
  add('tip fix: without offer', tipFix({ ...tipWho, domain: DOMAIN, domainUrl: DOMAIN_URL, source: fixSrc, offer: null }));
  add('tip fix: with offer', tipFix({ ...tipWho, domain: DOMAIN, domainUrl: DOMAIN_URL, source: fixSrc, offer: { price: '$149', orderUrl: ORDER_URL } }));
  add('tip fix: SPF, one address', tipFix({ ...tipWho, domain: DOMAIN, domainUrl: DOMAIN_URL, source: src({ key: 'x', name: null, ips: ['198.51.100.20'], messages: 12, failing: 12, other: { by: 'SPF', domain: 'mailer.example' } }), offer: null }));
  for (const p of ['none', 'quarantine'] as const) {
    const { inForce, step, target } = policyStep(p);
    add(`tip next: ${p} to ${target}`, tipNext({ ...tipWho, domain: DOMAIN, domainUrl: DOMAIN_URL, weeks: { start: WEEK_START - 7 * DAY, end: WEEK.end }, messages: 2480, sources: 3, inForce, step, target, ruaAddress: RUA }));
  }
  add('tip done', tipDone({ ...tipWho, domain: DOMAIN, domainUrl: DOMAIN_URL, messages: 2480, sources: 3 }));
  add('tip done: one message, one source', tipDone({ ...tipWho, domain: DOMAIN, domainUrl: DOMAIN_URL, messages: 1, sources: 1 }));
  add('records live: nameless recipient', recordsLive({ ...nameless, items: [{ domain: DOMAIN, seenAt: NOW }], domainUrl: DOMAIN_URL }));
  return out;
}
