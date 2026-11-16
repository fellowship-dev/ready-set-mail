// The queries that judge a record all use the one verdict (`verdictSql`): a source is failing only when the receiver said neither identifier aligned,
// passing on one check is listed apart, and a record stored without the verdict is never failed and never passing (RFC 9989 section 5.3.5, RFC 9990 section 3.1.1.9).
import { describe, expect, it } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { forWorkspace, IMPLICIT_WORKSPACE_ID } from '@ready-set-mail/db';

const NOW = Math.floor(Date.now() / 1000);

type Rec = { ip: string; n: number; spf?: 'pass' | 'fail'; dkim?: 'pass' | 'fail'; spfDomain?: string | null; dkimDomain?: string | null; spfAligned: number | null; dkimAligned: number | null; from?: string };

async function seed(records: Rec[]) {
  const db = createMigratedD1();
  const q = forWorkspace(db, IMPLICIT_WORKSPACE_ID);
  const id = Number((await q.domains.insert({ domain: 'example.com', rua_address: 'rua@r.test' })).meta.last_row_id);
  const total = records.reduce((n, r) => n + r.n, 0);
  const rep = await q.reports.insertAggregate({ domain_id: id, org_name: 'google', report_id: 'r1', date_begin: NOW - 86400, date_end: NOW, total_count: total, pass_count: 0, fail_count: total, raw_xml: null, reporter_auth: 'pass', reporter_tier: 'counted' });
  const report_id = Number(rep.meta.last_row_id);
  await q.reports.insertRecords(records.map((r) => ({
    report_id, source_ip: r.ip, count: r.n, disposition: 'none', spf_result: r.spf ?? 'pass', dkim_result: r.dkim ?? 'pass', spf_domain: r.spfDomain ?? null, dkim_domain: r.dkimDomain ?? null,
    header_from: r.from ?? 'example.com', spf_aligned: r.spfAligned, dkim_aligned: r.dkimAligned,
  })));
  return { q, id };
}

const MIX: Rec[] = [
  { ip: '1.1.1.1', n: 8, spf: 'fail', dkim: 'fail', spfAligned: 0, dkimAligned: 0 }, // failed, nobody's: nothing authenticated
  { ip: '2.2.2.2', n: 5, spfDomain: 'bounces.esp.example', dkimDomain: 'esp.example', spfAligned: 0, dkimAligned: 0 }, // failed although both passed raw
  { ip: '3.3.3.3', n: 20, spf: 'fail', spfAligned: 0, dkimAligned: 1, dkimDomain: 'example.com' }, // passed on DKIM alone
  { ip: '4.4.4.4', n: 6, spf: 'fail', dkim: 'fail', spfAligned: null, dkimAligned: null }, // stored before 0017: raw failures, no verdict
  { ip: '5.5.5.5', n: 3, spfAligned: -1, dkimAligned: -1 }, // not recoverable
  { ip: '6.6.6.6', n: 40, spfDomain: 'example.com', dkimDomain: 'example.com', spfAligned: 1, dkimAligned: 1 }, // passed
];

describe('queries judge a record by its verdict only', () => {
  it('topFailingSources lists only failed sources, counting their failed messages, with what was authenticated', async () => {
    const { q, id } = await seed(MIX);
    const top = await q.reports.topFailingSources(id, 0);
    expect(top.map((s) => [s.source_ip, s.total])).toEqual([['1.1.1.1', 8], ['2.2.2.2', 5]]);
    expect(top[1]).toMatchObject({ spf_domain: 'bounces.esp.example', dkim_domain: 'esp.example', spf_pass: 1, dkim_pass: 1, header_from: 'example.com' });
  });

  it('likely_not_yours: only a source that is no known service and passed for no name of the domain', async () => {
    const { q, id } = await seed([
      { ip: '1.1.1.1', n: 8, spf: 'fail', dkim: 'fail', spfAligned: 0, dkimAligned: 0 },
      { ip: '2.2.2.2', n: 5, spfDomain: 'example.com', dkimDomain: 'esp.example', spfAligned: 0, dkimAligned: 0, from: 'other.example.org' }, // SPF passed for its own name: not "not yours"
    ]);
    const top = await q.reports.topFailingSources(id, 0);
    expect(Object.fromEntries(top.map((s) => [s.source_ip, s.likely_not_yours]))).toEqual({ '1.1.1.1': true, '2.2.2.2': false });
  });

  it('the verdict tally counts sources and messages per verdict', async () => {
    const { q, id } = await seed(MIX);
    expect(await q.reports.verdictTally(id, 0)).toEqual({
      failed: { sources: 2, messages: 13 }, passed: { sources: 1, messages: 40 }, 'passed-one': { sources: 1, messages: 20 }, 'not-recorded': { sources: 2, messages: 9 },
    });
  });

  it('anomalies: every row that is not a plain pass, one verdict per row; all sources keeps the passing one', async () => {
    const { q, id } = await seed(MIX);
    const an = await q.reports.anomalySources(id, 0);
    expect(Object.fromEntries(an.map((s) => [s.source_ip, s.verdict]))).toEqual({ '3.3.3.3': 'passed-one', '1.1.1.1': 'failed', '2.2.2.2': 'failed', '4.4.4.4': 'not-recorded', '5.5.5.5': 'not-recorded' });
    expect(an.filter((s) => s.dmarc_fail === 1).map((s) => s.source_ip).sort()).toEqual(['1.1.1.1', '2.2.2.2']);
    expect((await q.reports.allSources(id, 0)).map((s) => s.verdict).sort()).toEqual(['failed', 'failed', 'not-recorded', 'not-recorded', 'passed', 'passed-one']);
  });

  it('one source with two verdicts is two rows, never one MAX of both', async () => {
    const { q, id } = await seed([
      { ip: '7.7.7.7', n: 4, spfAligned: 0, dkimAligned: 0 },
      { ip: '7.7.7.7', n: 9, spfAligned: 1, dkimAligned: 0 },
    ]);
    const rows = await q.reports.anomalySources(id, 0);
    expect(rows.map((s) => [s.verdict, s.total, s.spf_aligned, s.dkim_aligned]).sort()).toEqual([['failed', 4, 0, 0], ['passed-one', 9, 1, 0]]);
    const day = new Date((NOW - 86400) * 1000).toISOString().slice(0, 10);
    const byDate = await q.reports.sourcesByDate(id, day);
    expect(byDate.map((s) => [s.verdict, s.count, s.dmarc_fail]).sort()).toEqual([['failed', 4, 1], ['passed-one', 9, 0]]);
  });

  it('failed_not_yours on the check summary: failed messages from sources that are likely not the domain\'s', async () => {
    const { q, id } = await seed([
      { ip: '1.1.1.1', n: 8, spf: 'fail', dkim: 'fail', spfAligned: 0, dkimAligned: 0 },
      { ip: '2.2.2.2', n: 5, spfDomain: 'example.com', dkimDomain: 'example.com', spfAligned: 0, dkimAligned: 0, from: 'example.com' }, // passed for its own name: yours
      { ip: '3.3.3.3', n: 4, spf: 'fail', dkim: 'fail', spfAligned: null, dkimAligned: null }, // no verdict: never failed
    ]);
    expect((await q.reports.checkSummary(id, 0))?.failed_not_yours).toBe(8);
    expect((await q.reports.checkSummaries(0, { limit: 10 }))[0]?.failed_not_yours).toBe(8);
  });
});
