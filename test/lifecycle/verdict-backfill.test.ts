// The daily backfill of alignment verdicts for rows stored before 0022: bounded, idempotent, exact or -1.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { backfillVerdicts } from '../../src/lifecycle/verdict-backfill';

beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => vi.restoreAllMocks());

const rec = (ip: string, count: number, spf: string, dkim: string) => `<record><row><source_ip>${ip}</source_ip><count>${count}</count><policy_evaluated><disposition>none</disposition><dkim>${dkim}</dkim><spf>${spf}</spf></policy_evaluated></row><identifiers><header_from>example.com</header_from></identifiers><auth_results><spf><domain>example.com</domain><result>pass</result></spf></auth_results></record>`;
const xml = (...records: string[]) => `<?xml version="1.0"?><feedback><report_metadata><org_name>g</org_name><email>a@b.c</email><report_id>r</report_id><date_range><begin>1700000000</begin><end>1700086400</end></date_range></report_metadata><policy_published><domain>example.com</domain><p>none</p></policy_published>${records.join('')}</feedback>`;

function seed() {
  const db = createMigratedD1();
  const s = db.sqlite;
  s.prepare("INSERT INTO domains (id, domain, rua_address) VALUES (1, 'example.com', 'rua@x')").run();
  const rep = s.prepare('INSERT INTO aggregate_reports (id, domain_id, org_name, report_id, date_begin, date_end, raw_xml, total_count, pass_count) VALUES (?, 1, ?, ?, 1, 2, ?, ?, ?)');
  const rc = s.prepare("INSERT INTO report_records (report_id, source_ip, count, disposition) VALUES (?, ?, ?, 'none')");
  const verdicts = (id: number) => (s.prepare('SELECT spf_aligned a, dkim_aligned d FROM report_records WHERE report_id = ? ORDER BY id').all(id) as Array<{ a: number | null; d: number | null }>).map((r) => [r.a, r.d]);
  return { db, s, rep, rc, verdicts };
}

describe('backfillVerdicts', () => {
  it('sets all-failed reports (pass_count 0) to 0/0 without their XML', async () => {
    const { db, rep, rc, verdicts } = seed();
    rep.run(1, 'g', 'a', null, 5, 0); rc.run(1, '1.1.1.1', 3); rc.run(1, '2.2.2.2', 2);
    rep.run(2, 'g', 'b', null, 5, 5); rc.run(2, '1.1.1.1', 5); // passing, no XML: stays unrecorded
    await backfillVerdicts({ DB: db as any });
    expect(verdicts(1)).toEqual([[0, 0], [0, 0]]);
    expect(verdicts(2)).toEqual([[null, null]]);
  });
  it('reads the verdict from the kept XML when the records match by position', async () => {
    const { db, rep, rc, verdicts } = seed();
    rep.run(1, 'g', 'a', xml(rec('1.1.1.1', 3, 'pass', 'fail'), rec('2.2.2.2', 2, 'fail', 'pass')), 5, 5);
    rc.run(1, '1.1.1.1', 3); rc.run(1, '2.2.2.2', 2);
    await backfillVerdicts({ DB: db as any });
    expect(verdicts(1)).toEqual([[1, 0], [0, 1]]);
  });
  it('marks a report -1/-1 when the XML does not match its rows or does not parse', async () => {
    const { db, rep, rc, verdicts } = seed();
    rep.run(1, 'g', 'a', xml(rec('1.1.1.1', 3, 'pass', 'pass')), 3, 3); rc.run(1, '9.9.9.9', 3); // other ip
    rep.run(2, 'g', 'b', xml(rec('1.1.1.1', 3, 'pass', 'pass')), 6, 6); rc.run(2, '1.1.1.1', 3); rc.run(2, '1.1.1.1', 3); // other count of records
    rep.run(3, 'g', 'c', 'not xml', 1, 1); rc.run(3, '1.1.1.1', 1);
    await backfillVerdicts({ DB: db as any });
    expect(verdicts(1)).toEqual([[-1, -1]]);
    expect(verdicts(2)).toEqual([[-1, -1], [-1, -1]]);
    expect(verdicts(3)).toEqual([[-1, -1]]);
  });
  it('is idempotent: a second run changes nothing', async () => {
    const { db, s, rep, rc } = seed();
    rep.run(1, 'g', 'a', xml(rec('1.1.1.1', 3, 'pass', 'fail')), 3, 3); rc.run(1, '1.1.1.1', 3);
    rep.run(2, 'g', 'b', null, 2, 0); rc.run(2, '1.1.1.1', 2);
    rep.run(3, 'g', 'c', 'bad', 1, 1); rc.run(3, '1.1.1.1', 1);
    await backfillVerdicts({ DB: db as any });
    const snap = JSON.stringify(s.prepare('SELECT id, spf_aligned, dkim_aligned FROM report_records ORDER BY id').all());
    const second = await backfillVerdicts({ DB: db as any });
    expect(second).toMatchObject({ allFailed: 0, reports: 0, records: 0 });
    expect(JSON.stringify(s.prepare('SELECT id, spf_aligned, dkim_aligned FROM report_records ORDER BY id').all())).toBe(snap);
  });
  it('is bounded: 20 reports per run, newest first', async () => {
    const { db, s, rep, rc } = seed();
    for (let i = 1; i <= 25; i++) { rep.run(i, 'g', `r${i}`, xml(rec('1.1.1.1', 1, 'pass', 'pass')), 1, 1); rc.run(i, '1.1.1.1', 1); }
    const first = await backfillVerdicts({ DB: db as any });
    expect(first.reports).toBe(20);
    expect((s.prepare('SELECT COUNT(*) n FROM report_records WHERE spf_aligned IS NULL').get() as { n: number }).n).toBe(5);
    expect((s.prepare('SELECT MAX(id) m FROM report_records WHERE spf_aligned IS NULL').get() as { m: number }).m).toBe(5);
    await backfillVerdicts({ DB: db as any });
    expect((s.prepare('SELECT COUNT(*) n FROM report_records WHERE spf_aligned IS NULL').get() as { n: number }).n).toBe(0);
  });
});
