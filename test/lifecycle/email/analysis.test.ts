import { describe, expect, it } from 'vitest';
import type { WeekSourceRow } from '@ready-set-mail/db';
import {
  allPassed, failingSources, noTotals, passRate, quietWeek, sourceKey, sourceLabel, sourceName, sourceStats, summarise, tipFixSources, clean, rowFailsDmarc, ownerEvidence, MAX_WORD,
  type SourceStat, type SummaryDomain, type Totals,
} from '../../../src/lifecycle/email/analysis';

const D = 'brightwave-mail.com';
const row = (p: Partial<WeekSourceRow> = {}): WeekSourceRow => ({
  domain_id: 7, domain: D, wk: 0, source_ip: '192.0.2.10', header_from: D,
  spf_domain: null, spf_result: null, dkim_domain: null, dkim_result: null,
  messages: 1, reverse_dns: null, base_domain: null, org: null, ...p,
});
/** A message that passes DMARC through aligned DKIM. */
const pass = (p: Partial<WeekSourceRow> = {}) => row({ dkim_result: 'pass', dkim_domain: D, ...p });
/** A message that fails DMARC and passed nothing. */
const fail = (p: Partial<WeekSourceRow> = {}) => row({ dkim_result: 'fail', dkim_domain: D, spf_result: 'fail', spf_domain: D, ...p });

describe('sourceKey', () => {
  it('is the org, else the base domain, else the IP, lower-cased', () => {
    expect(sourceKey({ org: 'Google Workspace', base_domain: 'google.com', source_ip: '192.0.2.10' })).toBe('google workspace');
    expect(sourceKey({ org: null, base_domain: 'SendGrid.NET', source_ip: '192.0.2.10' })).toBe('sendgrid.net');
    expect(sourceKey({ org: null, base_domain: null, source_ip: '2001:DB8::1' })).toBe('2001:db8::1');
    expect(sourceKey({ org: '', base_domain: '', source_ip: '198.51.100.7' })).toBe('198.51.100.7');
  });
  it('trims, and the org wins over the base domain', () => {
    expect(sourceKey({ org: '  Mailchimp ', base_domain: 'mcsv.net', source_ip: '203.0.113.1' })).toBe('mailchimp');
  });
  it('is the same for two addresses of one organisation', () => {
    expect(sourceKey({ org: 'Google', base_domain: null, source_ip: '192.0.2.1' })).toBe(sourceKey({ org: 'GOOGLE', base_domain: 'x', source_ip: '192.0.2.2' }));
  });
});

describe('sourceLabel and sourceName', () => {
  it('name and address, with "and N more" for several', () => {
    expect(sourceLabel({ name: 'Google Workspace', ips: ['192.0.2.10'] })).toBe('Google Workspace (192.0.2.10)');
    expect(sourceLabel({ name: 'o1.email.sendgrid.net', ips: ['192.0.2.7', '192.0.2.8', '192.0.2.9'] })).toBe('o1.email.sendgrid.net (192.0.2.7 and 2 more)');
    expect(sourceLabel({ name: null, ips: ['203.0.113.5'] })).toBe('203.0.113.5');
    expect(sourceLabel({ name: null, ips: ['203.0.113.5', '203.0.113.6'] })).toBe('203.0.113.5 and 1 more');
    expect(sourceLabel({ name: null, ips: [] })).toBe('unknown');
  });
  it('the short name is the name, else the first address', () => {
    expect(sourceName({ name: 'Mailchimp', ips: ['203.0.113.40'] })).toBe('Mailchimp');
    expect(sourceName({ name: null, ips: ['203.0.113.40'] })).toBe('203.0.113.40');
    expect(sourceName({ name: null, ips: [] })).toBe('an unknown source');
  });
});

describe('sourceStats', () => {
  it('rolls rows up per source key: messages, addresses (busiest first), name (the most-used)', () => {
    const s = sourceStats([
      pass({ source_ip: '192.0.2.10', org: 'Google', messages: 30 }),
      pass({ source_ip: '192.0.2.11', org: 'google', messages: 70, reverse_dns: 'mail-a.google.com' }),
      pass({ source_ip: '198.51.100.7', org: null, base_domain: 'sendgrid.net', messages: 5 }),
    ]);
    expect(s.map((x) => x.key)).toEqual(['google', 'sendgrid.net']);
    expect(s[0]).toMatchObject({ messages: 100, failing: 0, other: null, ips: ['192.0.2.11', '192.0.2.10'] });
    expect(s[1]).toMatchObject({ name: 'sendgrid.net', messages: 5, ips: ['198.51.100.7'] });
  });
  it('names a source by org, else reverse DNS, else base domain; null when only the address is known', () => {
    const s = sourceStats([
      pass({ source_ip: '192.0.2.1', org: 'Acme Mail', reverse_dns: 'x.acme.example', base_domain: 'acme.example' }),
      pass({ source_ip: '192.0.2.2', org: null, reverse_dns: 'o1.sender.example', base_domain: 'sender.example' }),
      pass({ source_ip: '192.0.2.3', org: null, reverse_dns: null, base_domain: 'plain.example' }),
      pass({ source_ip: '192.0.2.4' }),
    ]);
    const by = Object.fromEntries(s.map((x) => [x.key, x.name]));
    expect(by).toEqual({ 'acme mail': 'Acme Mail', 'sender.example': 'o1.sender.example', 'plain.example': 'plain.example', '192.0.2.4': null });
  });
  it('sorts the busiest source first, ties by key', () => {
    const s = sourceStats([pass({ source_ip: '192.0.2.2', messages: 5 }), pass({ source_ip: '192.0.2.1', messages: 5 }), pass({ source_ip: '192.0.2.3', messages: 9 })]);
    expect(s.map((x) => x.key)).toEqual(['192.0.2.3', '192.0.2.1', '192.0.2.2']);
  });

  describe('aligned pass vs fail, by relaxed alignment', () => {
    it('aligned DKIM passes, aligned SPF passes', () => {
      expect(sourceStats([pass({ messages: 4 })])[0].failing).toBe(0);
      expect(sourceStats([row({ spf_result: 'pass', spf_domain: D, messages: 4 })])[0].failing).toBe(0);
    });
    it('a subdomain of the From domain aligns under relaxed alignment, in either direction', () => {
      expect(sourceStats([row({ dkim_result: 'pass', dkim_domain: `mail.${D}`, messages: 3 })])[0].failing).toBe(0);
      expect(sourceStats([row({ header_from: `news.${D}`, spf_result: 'pass', spf_domain: D, messages: 3 })])[0].failing).toBe(0);
    });
    it('a pass for an unrelated domain does not align: the messages are failing', () => {
      const [s] = sourceStats([row({ dkim_result: 'pass', dkim_domain: 'sendgrid.net', messages: 12 })]);
      expect(s.failing).toBe(12);
    });
    it('a failing result on an aligned domain is failing', () => {
      expect(sourceStats([fail({ messages: 6 })])[0].failing).toBe(6);
    });
    it('the From domain defaults to the domain row when the header is empty', () => {
      expect(sourceStats([row({ header_from: null, dkim_result: 'pass', dkim_domain: D, messages: 2 })])[0].failing).toBe(0);
    });
    it('counts passing and failing rows of one source separately', () => {
      const [s] = sourceStats([pass({ org: 'Mixed', messages: 60 }), fail({ org: 'Mixed', messages: 40 })]);
      expect(s).toMatchObject({ messages: 100, failing: 40 });
    });
  });

  describe('"passed for another domain"', () => {
    it('is the DKIM domain that passed', () => {
      const [s] = sourceStats([row({ dkim_result: 'pass', dkim_domain: 'sendgrid.net', messages: 12 })]);
      expect(s.other).toEqual({ by: 'DKIM', domain: 'sendgrid.net' });
    });
    it('is the SPF domain when only SPF passed', () => {
      const [s] = sourceStats([row({ spf_result: 'pass', spf_domain: 'mailer.example', dkim_result: 'fail', dkim_domain: D, messages: 12 })]);
      expect(s.other).toEqual({ by: 'SPF', domain: 'mailer.example' });
    });
    it('prefers DKIM over SPF on the same record', () => {
      const [s] = sourceStats([row({ spf_result: 'pass', spf_domain: 'mailer.example', dkim_result: 'pass', dkim_domain: 'sendgrid.net', messages: 12 })]);
      expect(s.other).toEqual({ by: 'DKIM', domain: 'sendgrid.net' });
    });
    it('is null when the failing messages passed nothing', () => {
      expect(sourceStats([fail({ messages: 12 })])[0].other).toBeNull();
    });
    it('is null when the result passed but names no domain', () => {
      expect(sourceStats([row({ dkim_result: 'pass', dkim_domain: null, messages: 12 })])[0].other).toBeNull();
    });
    it('is never taken from messages that passed DMARC', () => {
      expect(sourceStats([pass({ messages: 12, spf_result: 'pass', spf_domain: 'mailer.example' })])[0].other).toBeNull();
    });
    it('is the domain with most failing messages, lower-cased', () => {
      const [s] = sourceStats([
        row({ dkim_result: 'pass', dkim_domain: 'A.example', messages: 3 }),
        row({ dkim_result: 'pass', dkim_domain: 'b.EXAMPLE', messages: 5 }),
        row({ dkim_result: 'pass', dkim_domain: 'B.example', messages: 4 }),
      ]);
      expect(s.other).toEqual({ by: 'DKIM', domain: 'b.example' });
    });
  });

  describe('failing is capped by the exact failing total', () => {
    const rows = [row({ dkim_result: 'pass', dkim_domain: 'sendgrid.net', org: 'SendGrid', messages: 30 }), pass({ org: 'Google', messages: 100 })];
    it('without an exact count, the estimate stands', () => {
      expect(sourceStats(rows).find((x) => x.key === 'sendgrid')!.failing).toBe(30);
      expect(sourceStats(rows, null).find((x) => x.key === 'sendgrid')!.failing).toBe(30);
    });
    it('never exceeds the exact total', () => {
      expect(sourceStats(rows, 12).find((x) => x.key === 'sendgrid')!.failing).toBe(12);
      expect(sourceStats(rows, 30).find((x) => x.key === 'sendgrid')!.failing).toBe(30);
      expect(sourceStats(rows, 500).find((x) => x.key === 'sendgrid')!.failing).toBe(30);
    });
    it('an exact 0 means no source failed, and there is no failing source', () => {
      const s = sourceStats(rows, 0);
      expect(s.every((x) => x.failing === 0)).toBe(true);
      expect(failingSources(s)).toEqual([]);
      expect(tipFixSources(s)).toEqual([]);
    });
    it('a negative exact count is treated as 0', () => {
      expect(sourceStats(rows, -4).every((x) => x.failing === 0)).toBe(true);
    });
    it('a source that did not fail stays at 0 whatever the exact total', () => {
      expect(sourceStats(rows, 12).find((x) => x.key === 'google')!.failing).toBe(0);
    });
    it('keeps what the failing source passed even when the count is capped', () => {
      expect(sourceStats(rows, 0).find((x) => x.key === 'sendgrid')!.other).toEqual({ by: 'DKIM', domain: 'sendgrid.net' });
    });
  });

  it('gives an empty list for no rows', () => {
    expect(sourceStats([])).toEqual([]);
    expect(sourceStats([], 0)).toEqual([]);
  });
});

const stat = (p: Partial<SourceStat> & { key: string }): SourceStat => ({ name: null, ips: ['192.0.2.1'], messages: 0, failing: 0, other: null, mine: null, ...p });
const DKIM = { by: 'DKIM', domain: 'sendgrid.net' } as const;
const MINE = { mine: 'SendGrid' } as const;

describe('failingSources', () => {
  it('keeps the failing ones, the most failing first, ties by key', () => {
    const f = failingSources([stat({ key: 'b', messages: 10, failing: 3 }), stat({ key: 'ok', messages: 99 }), stat({ key: 'a', messages: 10, failing: 3 }), stat({ key: 'c', messages: 50, failing: 9 })]);
    expect(f.map((x) => x.key)).toEqual(['c', 'a', 'b']);
  });
});

describe('tipFixSources', () => {
  it('needs at least 10 failing messages', () => {
    expect(tipFixSources([stat({ key: 'a', messages: 20, failing: 9, other: DKIM, ...MINE })])).toEqual([]);
    expect(tipFixSources([stat({ key: 'a', messages: 20, failing: 10, other: DKIM, ...MINE })]).map((x) => x.key)).toEqual(['a']);
  });
  it('needs most of its messages to fail (half counts)', () => {
    expect(tipFixSources([stat({ key: 'a', messages: 100, failing: 49, other: DKIM, ...MINE })])).toEqual([]);
    expect(tipFixSources([stat({ key: 'a', messages: 100, failing: 50, other: DKIM, ...MINE })])).toHaveLength(1);
    expect(tipFixSources([stat({ key: 'a', messages: 100, failing: 100, other: DKIM, ...MINE })])).toHaveLength(1);
  });
  it('needs a pass for another domain', () => {
    expect(tipFixSources([stat({ key: 'a', messages: 20, failing: 20, other: null })])).toEqual([]);
  });
  it('needs evidence that the owner uses the service', () => {
    expect(tipFixSources([stat({ key: 'a', messages: 20, failing: 20, other: DKIM, mine: null })])).toEqual([]);
  });
  it('lists the most failing first', () => {
    const t = tipFixSources([stat({ key: 'a', messages: 20, failing: 12, other: DKIM, ...MINE }), stat({ key: 'b', messages: 90, failing: 80, other: { by: 'SPF', domain: 'mailer.example' }, ...MINE })]);
    expect(t.map((x) => x.key)).toEqual(['b', 'a']);
  });
  it('is empty for no sources', () => {
    expect(tipFixSources([])).toEqual([]);
  });
});

describe('totals', () => {
  it('pass rate is a whole number, 0 for nothing', () => {
    expect(passRate({ total: 1240, passed: 1203 })).toBe(97);
    expect(passRate({ total: 3, passed: 2 })).toBe(67);
    expect(passRate({ total: 0, passed: 0 })).toBe(0);
    expect(passRate({ total: 1, passed: 0 })).toBe(0);
  });
  it('pass rate rounds up at .5, so 199 of 200 is 100% only when exact', () => {
    expect(passRate({ total: 200, passed: 199 })).toBe(100);
  });
  it('allPassed needs at least one message and every one passing', () => {
    expect(allPassed({ total: 0, passed: 0, reports: 0 })).toBe(false);
    expect(allPassed({ total: 5, passed: 5, reports: 1 })).toBe(true);
    expect(allPassed({ total: 5, passed: 4, reports: 1 })).toBe(false);
  });
  it('noTotals is zero and fresh each time', () => {
    expect(noTotals()).toEqual({ total: 0, passed: 0, reports: 0 });
    expect(noTotals()).not.toBe(noTotals());
  });
});

const totals = (total: number, passed: number, reports = 1): Totals => ({ total, passed, reports });
const dom = (p: Partial<SummaryDomain> & { domain: string }): SummaryDomain => ({
  id: 1, policy: 'none', this: totals(0, 0, 0), last: totals(0, 0, 0), sources: [], lastSources: [], earlierKeys: new Set(), hadHistory: true, ...p,
});
const google = (p: Partial<SourceStat> = {}) => stat({ key: 'google', name: 'Google', messages: 100, ...p });

describe('summarise', () => {
  it('sums the exact totals of every domain', () => {
    const f = summarise([dom({ domain: D, this: totals(1240, 1203, 9) }), dom({ id: 2, domain: 'news.brightwave-mail.com', this: totals(10, 10, 2) })]);
    expect(f.totals).toEqual({ total: 1250, passed: 1213, reports: 11 });
    expect(f.domains.map((d) => d.domain)).toEqual([D, 'news.brightwave-mail.com']);
  });

  describe('new source', () => {
    it('a source with messages this week and none last week or the four weeks before', () => {
      const f = summarise([dom({ domain: D, this: totals(110, 110), sources: [google(), stat({ key: 'mailchimp', name: 'Mailchimp', messages: 10 })], lastSources: [google()] })]);
      expect(f.changes).toEqual([{ kind: 'new_source', domain: D, source: expect.objectContaining({ key: 'mailchimp' }) }]);
    });
    it('not new when it was seen in the four weeks before', () => {
      const f = summarise([dom({ domain: D, this: totals(110, 110), sources: [google(), stat({ key: 'mailchimp', messages: 10 })], lastSources: [google()], earlierKeys: new Set(['mailchimp']) })]);
      expect(f.changes).toEqual([]);
    });
    it('a source without messages is not a source', () => {
      const f = summarise([dom({ domain: D, this: totals(100, 100), sources: [google(), stat({ key: 'ghost', messages: 0 })], lastSources: [google()] })]);
      expect(f.changes).toEqual([]);
    });
    it('a domain with no earlier history is a silent baseline: no source is new', () => {
      const f = summarise([dom({ domain: D, hadHistory: false, this: totals(100, 100), sources: [google(), stat({ key: 'bulk', messages: 30, failing: 30 })] })]);
      expect(f.changes).toEqual([]);
      expect(f.todo).toBeNull();
      expect(quietWeek(f)).toBe(false); // it still has counted messages
    });
    it('a silent baseline with no messages is a quiet week', () => {
      expect(quietWeek(summarise([dom({ domain: D, hadHistory: false })]))).toBe(true);
    });
    it('with history, a source absent before is new (and a failing one is the thing to do)', () => {
      const f = summarise([dom({ domain: D, hadHistory: true, this: totals(130, 100), sources: [google(), stat({ key: 'bulk', messages: 30, failing: 30 })], lastSources: [google()] })]);
      expect(f.changes).toEqual([{ kind: 'new_source', domain: D, source: expect.objectContaining({ key: 'bulk' }) }]);
      expect(f.todo).toMatchObject({ kind: 'new_source' });
    });
    it('a started-failing source is reported even without earlier history beyond last week', () => {
      const f = summarise([dom({ domain: D, hadHistory: false, this: totals(100, 80), sources: [google({ failing: 20 })], lastSources: [google()] })]);
      expect(f.changes.map((c) => c.kind)).toEqual(['started_failing']);
    });
  });

  describe('started failing', () => {
    it('last week it passed, this week it fails', () => {
      const f = summarise([dom({ domain: D, this: totals(100, 80), sources: [google({ failing: 20 })], lastSources: [google({ failing: 0 })] })]);
      expect(f.changes).toEqual([{ kind: 'started_failing', domain: D, source: expect.objectContaining({ key: 'google', failing: 20 }) }]);
    });
    it('not when it was already failing last week', () => {
      const f = summarise([dom({ domain: D, this: totals(100, 80), sources: [google({ failing: 20 })], lastSources: [google({ failing: 5 })] })]);
      expect(f.changes).toEqual([]);
    });
    it('not when it passes this week', () => {
      const f = summarise([dom({ domain: D, this: totals(100, 100), sources: [google()], lastSources: [google({ failing: 7 })] })]);
      expect(f.changes).toEqual([]);
    });
    it('not when last week it sent nothing (that is a new source or a return, not a change of result)', () => {
      const f = summarise([dom({ domain: D, this: totals(100, 80), sources: [google({ failing: 20 })], lastSources: [google({ messages: 0 })], earlierKeys: new Set(['google']) })]);
      expect(f.changes).toEqual([]);
    });
  });

  describe('stopped getting reports', () => {
    it('had messages last week and none this week', () => {
      const f = summarise([dom({ domain: D, this: totals(0, 0, 0), last: totals(100, 100) })]);
      expect(f.changes).toEqual([{ kind: 'no_reports', domain: D }]);
    });
    it('not when it had none last week either, nor when it still has some', () => {
      expect(summarise([dom({ domain: D })]).changes).toEqual([]);
      expect(summarise([dom({ domain: D, this: totals(1, 1), last: totals(100, 100) })]).changes).toEqual([]);
    });
  });

  describe('the one thing to do', () => {
    const failing = { id: 1, domain: 'a.example', this: totals(100, 80), sources: [google({ failing: 20 })], lastSources: [google()] };
    it('is null when nothing changed', () => {
      expect(summarise([dom({ domain: D, this: totals(100, 100), sources: [google()], lastSources: [google()] })]).todo).toBeNull();
    });
    it('is null when the only news is a new source that passes', () => {
      expect(summarise([dom({ domain: D, this: totals(110, 110), sources: [google(), stat({ key: 'new', messages: 10 })], lastSources: [google()] })]).todo).toBeNull();
    });
    it('a source that started failing comes first, before a failing new source and a domain with no reports', () => {
      const f = summarise([
        dom({ id: 2, domain: 'b.example', last: totals(5, 5) }),
        dom({ id: 3, domain: 'c.example', this: totals(50, 40), sources: [stat({ key: 'new', messages: 50, failing: 40 })], lastSources: [google()], earlierKeys: new Set() }),
        dom(failing),
      ]);
      expect(f.changes).toHaveLength(3);
      expect(f.todo).toMatchObject({ kind: 'started_failing', domain: 'a.example' });
    });
    it('a failing new source comes before a domain with no reports', () => {
      const f = summarise([
        dom({ id: 2, domain: 'a.example', last: totals(5, 5) }),
        dom({ id: 3, domain: 'c.example', this: totals(50, 40), sources: [stat({ key: 'new', messages: 50, failing: 40 })], lastSources: [google()] }),
      ]);
      expect(f.todo).toMatchObject({ kind: 'new_source', domain: 'c.example' });
    });
    it('a domain with no reports is the thing to do when it is all there is', () => {
      expect(summarise([dom({ domain: D, last: totals(5, 5) })]).todo).toEqual({ kind: 'no_reports', domain: D });
    });
    it('among equals the most failing messages wins, then the domain name', () => {
      const mk = (id: number, domain: string, n: number) => dom({ id, domain, this: totals(100, 100 - n), sources: [google({ failing: n })], lastSources: [google()] });
      expect(summarise([mk(1, 'a.example', 5), mk(2, 'b.example', 9)]).todo).toMatchObject({ domain: 'b.example' });
      expect(summarise([mk(1, 'b.example', 5), mk(2, 'a.example', 5)]).todo).toMatchObject({ domain: 'a.example' });
    });
    it('keeps every change in the list, in domain order', () => {
      const f = summarise([dom({ domain: 'z.example', last: totals(5, 5) }), dom({ id: 2, ...failing })]);
      expect(f.changes.map((c) => c.domain)).toEqual(['z.example', 'a.example']);
    });
  });

  describe('quietWeek', () => {
    it('is no counted messages and no change', () => {
      expect(quietWeek(summarise([dom({ domain: D })]))).toBe(true);
      expect(quietWeek(summarise([]))).toBe(true);
    });
    it('is not quiet with messages, nor with only a change', () => {
      expect(quietWeek(summarise([dom({ domain: D, this: totals(1, 1), sources: [], lastSources: [] })]))).toBe(false);
      expect(quietWeek(summarise([dom({ domain: D, last: totals(5, 5) })]))).toBe(false);
    });
  });

  it('works with no domains', () => {
    expect(summarise([])).toEqual({ domains: [], totals: { total: 0, passed: 0, reports: 0 }, changes: [], todo: null });
  });
});

// ── Who the failing source is (ownerEvidence), and what is safe to print ──

describe('rowFailsDmarc', () => {
  it('is the one decision: aligned DKIM or SPF passes, anything else fails', () => {
    expect(rowFailsDmarc(pass())).toBe(false);
    expect(rowFailsDmarc(row({ spf_result: 'pass', spf_domain: D }))).toBe(false);
    expect(rowFailsDmarc(fail())).toBe(true);
    expect(rowFailsDmarc(row({ spf_result: 'pass', spf_domain: 'bulkmailer.example' }))).toBe(true);
  });
});

describe('mine: evidence that the owner uses the service', () => {
  const bulk = '203.0.113.60';
  it('review scenario: an SPF pass for an unrelated domain alone is not evidence, so no tip and no offer', () => {
    const s = sourceStats([row({ source_ip: bulk, spf_result: 'pass', spf_domain: 'bulkmailer.example', dkim_result: null, messages: 30 })]);
    expect(s[0]).toMatchObject({ failing: 30, other: { by: 'SPF', domain: 'bulkmailer.example' }, mine: null });
    expect(tipFixSources(s)).toEqual([]);
  });
  it('with no authentication at all there is no evidence either', () => {
    const s = sourceStats([row({ source_ip: bulk, messages: 30 })]);
    expect(s[0]).toMatchObject({ failing: 30, other: null, mine: null });
    expect(tipFixSources(s)).toEqual([]);
  });
  it('a DKIM pass for an unknown domain is not evidence', () => {
    const s = sourceStats([row({ source_ip: bulk, dkim_result: 'pass', dkim_domain: 'bulkmailer.example', messages: 30 })]);
    expect(s[0]).toMatchObject({ other: { by: 'DKIM' }, mine: null });
    expect(tipFixSources(s)).toEqual([]);
  });
  it('a failing source that passed DKIM for sendgrid.net qualifies for the tip', () => {
    const s = sourceStats([row({ source_ip: bulk, dkim_result: 'pass', dkim_domain: 'sendgrid.net', messages: 30 })]);
    expect(s[0].mine).toBe('SendGrid');
    expect(tipFixSources(s)).toHaveLength(1);
  });
  it('an SPF pass for sendgrid.net alone, with an unknown reverse DNS, does not', () => {
    const s = sourceStats([row({ source_ip: bulk, spf_result: 'pass', spf_domain: 'sendgrid.net', reverse_dns: 'host.unknown.example', messages: 30 })]);
    expect(s[0]).toMatchObject({ other: { by: 'SPF', domain: 'sendgrid.net' }, mine: null });
    expect(tipFixSources(s)).toEqual([]);
  });
  it('the inventory recognising the reverse DNS does', () => {
    const s = sourceStats([row({ source_ip: bulk, spf_result: 'pass', spf_domain: 'sendgrid.net', reverse_dns: 'o1.email.sendgrid.net', messages: 30 })]);
    expect(s[0].mine).toBe('SendGrid');
    expect(tipFixSources(s)).toHaveLength(1);
    expect(ownerEvidence(row({ reverse_dns: 'o1.email.sendgrid.net' }))).toBe('SendGrid');
  });
  it('a DKIM pass is only evidence when it passed', () => {
    expect(ownerEvidence(row({ dkim_result: 'fail', dkim_domain: 'sendgrid.net' }))).toBeNull();
  });
  it('evidence comes only from failing rows', () => {
    const s = sourceStats([pass({ source_ip: bulk, reverse_dns: 'o1.email.sendgrid.net', messages: 30 })]);
    expect(s[0]).toMatchObject({ failing: 0, mine: null });
  });
});

describe('clean and report-derived text', () => {
  const evilOrg = `Evil <b>Corp</b> "x"\r\nBcc: victim@example.com${'A'.repeat(3000)}`;
  const evilName = '<script>alert(1)</script>\r\nX';
  const evilDomain = 'x.example\r\nSubject: hi';
  const controls = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

  it('turns every control and format character into a space, collapses spaces, and caps with an ellipsis', () => {
    expect(clean('a\r\nb\tc\u2028d\u202ee\u200bf   g')).toBe('a b c d e f g');
    expect(clean(null)).toBe('');
    expect(clean('x'.repeat(200))).toHaveLength(MAX_WORD);
    expect(clean('x'.repeat(200)).endsWith('…')).toBe(true);
    expect(clean('x'.repeat(80))).toBe('x'.repeat(80));
    expect(clean('abcdef', 4)).toBe('abc…');
  });
  it('sourceStats cleans the name, addresses and authenticated domains', () => {
    const [s] = sourceStats([row({ source_ip: '203.0.113.9', org: evilOrg, reverse_dns: evilName, base_domain: evilName, dkim_result: 'pass', dkim_domain: evilDomain, messages: 20 })]);
    expect(s.key).not.toMatch(controls); // an identity, not printed (it is not capped: it is part of a claim's period `src:<key>`)
    for (const v of [s.name ?? '', ...s.ips, s.other?.domain ?? '']) {
      expect(v).not.toMatch(controls);
      expect(v.length).toBeLessThanOrEqual(MAX_WORD);
    }
    expect(s.name).toMatch(/^Evil <b>Corp<\/b> "x" Bcc: victim@example\.com/);
    expect(s.name!.endsWith('…')).toBe(true);
    expect(s.other).toEqual({ by: 'DKIM', domain: 'x.example subject: hi' });
    const [t] = sourceStats([row({ source_ip: '203.0.113.9', org: null, reverse_dns: null, base_domain: evilName, spf_result: 'pass', spf_domain: evilDomain, messages: 20 })]);
    expect(t.name).toBe('<script>alert(1)</script> X');
    expect(t.key).not.toMatch(controls);
    expect(t.other).toEqual({ by: 'SPF', domain: 'x.example subject: hi' });
  });
});
