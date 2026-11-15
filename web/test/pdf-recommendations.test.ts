import { describe, it, expect } from 'vitest';
import { getRecommendations, getAllRecommendations, pdfVerdict, type PdfDomainContext } from '../src/lib/pdf/recommendations';
import { domainVerdict, totalsFromSummary } from '../src/lib/verdict';
import type { DomainCheckSummary } from '../src/lib/types';

const now = Math.floor(Date.now() / 1000);

function makeSummary(overrides: Partial<DomainCheckSummary> & Record<string, unknown> = {}): DomainCheckSummary {
  return {
    domain_id: 1,
    domain: 'example.com',
    dmarc_policy: 'reject',
    dns_checked_at: now, dns_check_attempted_at: now, dns_check_status: 'ok', dmarc_issue: null, dmarc_inherited_from: null, dns_last_good_status: 'ok',
    spf_record: 'v=spf1 include:_spf.example.com ~all',
    spf_lookup_count: 3, dmarc_pct: 100, dmarc_p: 'reject', dmarc_sp: null, dmarc_rua: 1,
    total_messages: 1000,
    pass_messages: 980,
    fail_messages: 20,
    dkim_total: 1000,
    dkim_pass: 970,
    spf_total: 1000,
    spf_pass: 960,
    mta_sts_enabled: 1,
    mta_sts_mode: 'enforce',
    ...overrides,
  } as DomainCheckSummary;
}

const ctx = (over: Partial<PdfDomainContext> = {}): PdfDomainContext => ({ domain: { id: 1, domain: 'example.com', rua_address: 'r@reports.test' }, hosted: null, ...over });
const dmarcLine = (s: DomainCheckSummary, c = ctx()) => getRecommendations(s, c).find((r) => !/^(SPF|DKIM|MTA-STS) /.test(r.message));

describe('getRecommendations: DMARC lines are the overview verdict', () => {
  it('returns no recommendations for a fully healthy domain', () => {
    expect(getRecommendations(makeSummary(), ctx())).toHaveLength(0);
  });

  it('says what the overview says, word for word', () => {
    for (const s of [makeSummary({ dmarc_policy: 'none', dmarc_p: 'none' }), makeSummary({ dmarc_policy: 'quarantine', dmarc_p: 'quarantine' }), makeSummary({ pass_messages: 600 })]) {
      const v = domainVerdict(ctx().domain, s, totalsFromSummary(s), null);
      const line = dmarcLine(s)!;
      expect(line.message).toBe([v.sentence, v.evidence, `Next: ${v.next.label}.`].filter(Boolean).join(' '));
      expect(pdfVerdict(s, ctx()).status).toBe(v.status);
    }
  });

  it('checked and missing is not "not checked yet"', () => {
    const line = dmarcLine(makeSummary({ dmarc_policy: null, dmarc_p: null, dmarc_pct: null, dmarc_rua: null }))!;
    expect(line.message).toContain('no DMARC record');
    expect(line.message).not.toMatch(/not been checked/);
    expect(line.severity).toBe('critical');
  });

  it('checked and invalid says invalid', () => {
    expect(dmarcLine(makeSummary({ dmarc_policy: null, dmarc_issue: 'invalid', dmarc_p: null, dmarc_pct: null, dmarc_rua: null }))!.message).toContain('has no valid p= policy');
  });

  it('p=reject at pct=25 is not called done, and the line names pct', () => {
    const line = dmarcLine(makeSummary({ dmarc_pct: 25 }))!;
    expect(line.message).toMatch(/pct=25/);
  });

  it('an inherited policy is named with where it comes from', () => {
    const line = dmarcLine(makeSummary({ domain: 'mail.example.com', dmarc_policy: 'quarantine', dmarc_p: 'quarantine', dmarc_inherited_from: 'example.com' }), ctx({ domain: { id: 1, domain: 'mail.example.com', rua_address: 'r@reports.test' } }))!;
    expect(line.message).toMatch(/example\.com/);
    expect(line.message).toMatch(/no DMARC record of its own/);
  });

  it('a domain without report intake is never told to verify the RUA address', () => {
    const recs = getRecommendations(makeSummary({ dmarc_policy: 'none', dmarc_p: 'none', total_messages: 0, pass_messages: 0, fail_messages: 0 }), ctx({ domain: { id: 1, domain: 'example.com', rua_address: '' }, hostedMode: true }));
    expect(recs.some((r) => /RUA address/i.test(r.message))).toBe(false);
    expect(recs.some((r) => /Reports are not connected/.test(r.message))).toBe(true);
  });

  it('reports received but not counted are not "no reports"', () => {
    const s = makeSummary({ dmarc_policy: 'none', dmarc_p: 'none', total_messages: 0, pass_messages: 0, fail_messages: 0, uncounted: { reports: 3, messages: 40, latest_at: now, unknown: 3, unauthenticated: 0, by_reporter: [] } });
    const line = dmarcLine(s)!;
    expect(line.message).toContain('3 reports from senders we do not recognise are not counted.');
    expect(line.message).not.toMatch(/No DMARC reports in the last/);
  });
});

describe('getRecommendations: SPF, DKIM and MTA-STS', () => {
  it('returns info when MTA-STS is disabled', () => {
    expect(getRecommendations(makeSummary({ mta_sts_enabled: 0 }), ctx()).find((r) => r.severity === 'info' && r.message.includes('MTA-STS'))).toBeDefined();
  });
  it('returns warning for low SPF pass rate', () => {
    expect(getRecommendations(makeSummary({ spf_pass: 800, spf_total: 1000 }), ctx()).find((r) => r.severity === 'warning' && r.message.startsWith('SPF'))).toBeDefined();
  });
  it('returns warning for low DKIM pass rate', () => {
    expect(getRecommendations(makeSummary({ dkim_pass: 800, dkim_total: 1000 }), ctx()).find((r) => r.severity === 'warning' && r.message.startsWith('DKIM'))).toBeDefined();
  });
  it('all recommendations include domain name', () => {
    for (const r of getRecommendations(makeSummary({ dmarc_policy: 'none', dmarc_p: 'none', mta_sts_enabled: 0 }), ctx())) expect(r.domain).toBe('example.com');
  });
});

describe('getAllRecommendations', () => {
  it('flattens recommendations from multiple domains, each with its own context', () => {
    const summaries = [makeSummary({ domain: 'a.com', dmarc_policy: 'none', dmarc_p: 'none' }), makeSummary({ domain_id: 2, domain: 'b.com', mta_sts_enabled: 0 })];
    const recs = getAllRecommendations(summaries, [ctx({ domain: { id: 1, domain: 'a.com', rua_address: 'r@reports.test' } }), ctx({ domain: { id: 2, domain: 'b.com', rua_address: 'r@reports.test' } })]);
    expect(recs.some((r) => r.domain === 'a.com')).toBe(true);
    expect(recs.some((r) => r.domain === 'b.com')).toBe(true);
  });
  it('returns empty array for all-healthy domains', () => {
    expect(getAllRecommendations([makeSummary(), makeSummary({ domain_id: 2, domain: 'b.com' })], [ctx(), ctx({ domain: { id: 2, domain: 'b.com', rua_address: 'r@reports.test' } })])).toHaveLength(0);
  });
});
