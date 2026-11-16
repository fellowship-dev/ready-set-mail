// Mail that fails authentication never counts toward a customer's limits (docs/adr/0016), and a report is never refused whole for its size.
//   - the free plan's daily volume counts only rows that PASS DMARC for the customer's own domain
//   - a spoofing run (many reports, many source addresses, all failing) leaves the customer's own reports recorded and the plan counter untouched
//   - a report over the row limit is accepted: every passing row kept, the biggest failing rows kept, the rest summarised with exact totals
//   - the operator hears of a heavy legitimate free workspace and of a likely spoofing run, once per workspace per day each
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.setConfig({ testTimeout: 120_000 });
vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
import { resetSchemaReadyCache } from '@ready-set-mail/db';
import { handleHostedEmail } from '../../src/hosted/intake';
import { fakeMessage, gzipReportMime } from '../helpers/mail';
import { nxdomain, quiet, twoWorkspaces } from '../hosted/world';
import { freePlanDayNotice } from '../../src/reports/visibility';
import { shapeRecords, networkOf } from '../../src/dmarc/summarise';

const RUA = 'rua.readysetmail.com';
const GOOGLE = { headers: { 'authentication-results': 'mx.cloudflare.net; dkim=pass header.d=google.com header.s=s1' } };
const BIG = { INTAKE_MAX_DECOMPRESSED_BYTES: String(20 * 1024 * 1024), INTAKE_MAX_RAW_BYTES: String(20 * 1024 * 1024) };
beforeEach(() => { quiet(); nxdomain(); resetSchemaReadyCache(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

type W = Awaited<ReturnType<typeof twoWorkspaces>>;
const world = async (extra: Record<string, string> = {}): Promise<W> => {
  const w = await twoWorkspaces({ HOSTED_PLAN: 'free_one_domain', OWNER_EMAIL: 'operator@example.com', ...BIG, ...extra });
  const send = vi.fn(async () => {});
  (w.env as any).SEND_EMAIL = { send };
  w.db.sqlite.prepare("INSERT OR REPLACE INTO settings (workspace_id, key, value) VALUES ('ws_default', 'from_email', 'noreply@reports.example.com')").run();
  return w;
};
const mails = (w: W) => ((w.env as any).SEND_EMAIL.send.mock.calls as any[]).map((c) => c[0] as { to: string[]; subject: string });

/** One aggregate report for a-corp.com: `pass` rows that pass (one source address each, 1 message), `fail` rows that fail (distinct addresses, `count` messages each). */
function report(id: string, pass: number, fail: number, o: { failCount?: (i: number) => number; ipBase?: number } = {}): string {
  const rec = (ip: string, count: number, ok: boolean) => `<record><row><source_ip>${ip}</source_ip><count>${count}</count><policy_evaluated><disposition>${ok ? 'none' : 'reject'}</disposition><dkim>${ok ? 'pass' : 'fail'}</dkim><spf>${ok ? 'pass' : 'fail'}</spf></policy_evaluated></row><identifiers><header_from>a-corp.com</header_from></identifiers></record>`;
  const rows: string[] = [];
  for (let i = 0; i < pass; i++) rows.push(rec(`198.51.${(i >> 8) & 255}.${(i & 255) + 1}`, 1, true));
  const base = o.ipBase ?? 0;
  for (let i = 0; i < fail; i++) { const n = base + i; rows.push(rec(`${100 + ((n >> 16) & 100)}.${(n >> 8) & 255}.${n & 255}.${(n % 250) + 1}`, o.failCount?.(i) ?? 1, false)); }
  return `<?xml version="1.0"?><feedback><report_metadata><org_name>google.com</org_name><email>noreply-dmarc-support@google.com</email><report_id>${id}</report_id><date_range><begin>1529366400</begin><end>1529452799</end></date_range></report_metadata><policy_published><domain>a-corp.com</domain><adkim>r</adkim><aspf>r</aspf><p>none</p><pct>100</pct></policy_published>${rows.join('')}</feedback>`;
}
const deliver = async (w: W, xml: string) => {
  const m = fakeMessage(`rua+${w.tokenA}@${RUA}`, gzipReportMime(xml), GOOGLE);
  await handleHostedEmail(m, w.env);
  return m;
};
const quota = (w: W, scope: string) => (w.rows('SELECT records FROM intake_quota WHERE scope = ?', scope)[0]?.records ?? 0) as number;
const failures = (w: W) => w.rows('SELECT reason, messages FROM intake_failures ORDER BY reason');

describe('the spoofing run', () => {
  it('100,000 failing rows (many reports, many source addresses) leave the passing reports recorded and the plan limit untouched', async () => {
    const w = await world();
    let sent = 0;
    for (let r = 0; r < 10; r++) { // 10 reports x 10,000 failing rows, every row its own source address
      expect((await deliver(w, report(`spoof-${r}`, 0, 10_000, { ipBase: r * 10_000 }))).setReject).not.toHaveBeenCalled();
      sent += 10_000;
    }
    expect(sent).toBe(100_000);
    // the customer's own mail arrives after the run: recorded
    const own = await deliver(w, report('own-1', 40, 0));
    expect(own.setReject).not.toHaveBeenCalled();
    expect(w.rows("SELECT COUNT(*) AS n FROM aggregate_reports WHERE report_id = 'google|own-1'")[0].n).toBe(1);
    expect(w.rows("SELECT COUNT(*) AS n FROM report_records r JOIN aggregate_reports a ON a.id = r.report_id WHERE a.report_id = 'google|own-1'")[0].n).toBe(40);
    // the plan counter holds only the customer's own passing rows; no failing row was counted, nothing was refused for the plan
    expect(quota(w, 'p:ws_a')).toBe(40);
    expect(quota(w, 'f:ws_a')).toBe(100_000);
    expect(failures(w)).toEqual([]);
    // failing evidence was kept (summarised), and every message is still counted exactly
    expect(w.rows('SELECT SUM(fail_count) AS n FROM aggregate_reports')[0].n).toBe(100_000);
    expect(w.rows('SELECT COUNT(*) AS n FROM aggregate_reports WHERE summarised_rows IS NOT NULL')[0].n).toBe(10);
    // the storage safety bound held: failing rows never used more than half of the address's daily room
    expect(w.rows('SELECT COUNT(*) AS n FROM report_records')[0].n).toBeLessThan(100_000);
  });

  it('the operator is told once a day that the customer may be under a spoofing run, and nothing else', async () => {
    const w = await world({ INTAKE_ALERT_FAILING_ROWS_PER_DAY: '500' });
    await deliver(w, report('s1', 0, 400));
    expect(mails(w)).toEqual([]);
    await deliver(w, report('s2', 0, 400, { ipBase: 5_000 }));
    await deliver(w, report('s3', 0, 400, { ipBase: 9_000 }));
    const alerts = mails(w).filter((m) => /spoofing run/.test(m.subject));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.to).toEqual(['operator@example.com']);
  });
});

describe('a report over the row limit', () => {
  it('5,000 rows with 50 passing: accepted, all 50 passing rows kept, the failing remainder summarised, message totals exact', async () => {
    const w = await world();
    const failCount = (i: number) => 1 + (i % 9);
    const xml = report('big-1', 50, 4_950, { failCount });
    const totalFail = Array.from({ length: 4_950 }, (_, i) => failCount(i)).reduce((a, b) => a + b, 0);
    const m = await deliver(w, xml);
    expect(m.setReject).not.toHaveBeenCalled();
    const rep = w.rows('SELECT * FROM aggregate_reports')[0];
    expect(rep.pass_count).toBe(50);
    expect(rep.fail_count).toBe(totalFail); // exact
    expect(rep.total_count).toBe(50 + totalFail);
    expect(rep.summarised_rows).toBe(3_000); // 4,950 failing - 1,950 kept (2,000 per report - 50 passing)
    expect(rep.summarised_sources).toBe(3_000);
    const stored = w.rows('SELECT * FROM report_records WHERE report_id = ?', rep.id);
    expect(stored.filter((r) => r.disposition === 'none')).toHaveLength(50); // every passing row
    expect(stored.filter((r) => r.summarised_sources === null && r.disposition === 'reject')).toHaveLength(1_950);
    const summary = stored.filter((r) => r.summarised_sources !== null);
    expect(summary.length).toBeGreaterThan(0);
    expect(summary.length).toBeLessThanOrEqual(200);
    expect(summary.reduce((n, r) => n + r.summarised_sources, 0)).toBe(3_000);
    expect(stored.reduce((n, r) => n + r.count, 0)).toBe(50 + totalFail); // every message is still counted
    expect(stored.length).toBeLessThanOrEqual(2_000 + 200);
    // the kept failing rows are the biggest ones
    const keptMin = Math.min(...stored.filter((r) => r.summarised_sources === null && r.disposition === 'reject').map((r) => r.count));
    const foldedMax = Math.max(...Array.from({ length: 4_950 }, (_, i) => failCount(i)));
    expect(keptMin).toBeGreaterThanOrEqual(1);
    expect(foldedMax).toBe(9);
    // the owner is told, in numbers
    expect(w.rows('SELECT COUNT(*) AS n FROM intake_failures')[0].n).toBe(0);
  });

  it('a report that does not fit is never refused for its size, whatever mix it holds', async () => {
    const w = await world();
    expect((await deliver(w, report('x1', 0, 2_500))).setReject).not.toHaveBeenCalled();
    expect((await deliver(w, report('x2', 2_500, 0))).setReject).not.toHaveBeenCalled(); // all passing: all kept
    expect(w.rows("SELECT COUNT(*) AS n FROM report_records r JOIN aggregate_reports a ON a.id = r.report_id WHERE a.report_id = 'google|x2'")[0].n).toBe(2_500);
  });
});

describe('the free plan counts the customer\'s own passing mail only', () => {
  it('over the daily limit of passing rows: refused for the plan (accepted and not stored for a registry reporter), told in the customer\'s own terms', async () => {
    const w = await world({ INTAKE_FREE_PASSING_ROWS_PER_DAY: '100' });
    await deliver(w, report('p1', 60, 0));
    await deliver(w, report('p2', 60, 0)); // 120 > 100
    expect(w.rows("SELECT report_id FROM aggregate_reports ORDER BY id").map((r) => r.report_id)).toEqual(['google|p1']);
    expect(failures(w)).toEqual([{ reason: 'cap_free_plan_day', messages: 1 }]);
    expect(quota(w, 'p:ws_a')).toBe(60);
    expect(freePlanDayNotice(1, 20_000)).toBe("Today your domain sent more of its own mail than the free plan's 20,000 report rows a day, so 1 report was not saved. Mail that fails authentication never counts toward this. Everything already here stays.");
  });

  it('failing rows never reach it: a flood of failing rows, then passing mail up to the limit', async () => {
    const w = await world({ INTAKE_FREE_PASSING_ROWS_PER_DAY: '100' });
    for (let i = 0; i < 4; i++) await deliver(w, report(`f${i}`, 0, 1_000, { ipBase: i * 1_000 }));
    await deliver(w, report('p1', 100, 0));
    expect(failures(w)).toEqual([]);
    expect(quota(w, 'p:ws_a')).toBe(100);
  });

  it('a pay-as-you-go workspace and the operator\'s workspace have no daily limit of the free plan', async () => {
    const w = await world({ INTAKE_FREE_PASSING_ROWS_PER_DAY: '100' });
    w.db.sqlite.prepare("UPDATE workspaces SET plan = 'payg' WHERE id = 'ws_a'").run();
    await deliver(w, report('p1', 90, 0));
    await deliver(w, report('p2', 90, 0));
    expect(failures(w)).toEqual([]);
    expect(w.rows('SELECT COUNT(*) AS n FROM aggregate_reports')[0].n).toBe(2);
  });

  it('with the plan off nothing of this applies: not the limit, not the summarising (a report over 2,000 rows is refused as before), not the pause', async () => {
    const w = await world({ INTAKE_FREE_PASSING_ROWS_PER_DAY: '10', HOSTED_PLAN: 'off' });
    await deliver(w, report('p1', 60, 0));
    await deliver(w, report('p2', 60, 0));
    expect(failures(w)).toEqual([]);
    const big = await deliver(w, report('big', 2_001, 0));
    expect(big.setReject).toHaveBeenCalledOnce(); // today's rule: a report over 2,000 rows is refused whole
    expect(failures(w)).toEqual([{ reason: 'too_many_records', messages: 1 }]);
    w.db.sqlite.prepare('UPDATE domains SET paused_at = 1 WHERE id = 1').run();
    expect((await deliver(w, report('after-pause', 5, 0))).setReject).not.toHaveBeenCalled();
    expect(w.rows("SELECT COUNT(*) AS n FROM aggregate_reports WHERE report_id = 'google|after-pause'")[0].n).toBe(1);
  });

  it('the operator hears once a day of a heavy legitimate free workspace', async () => {
    const w = await world({ INTAKE_ALERT_PASSING_ROWS_PER_DAY: '50' });
    await deliver(w, report('p1', 60, 0));
    await deliver(w, report('p2', 60, 0));
    const alerts = mails(w).filter((m) => /Heavy legitimate use/.test(m.subject));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.to).toEqual(['operator@example.com']);
  });
});

describe('the free plan\'s 200 report emails a day', () => {
  it('counts a report only if it holds a passing row: 25 failing-only reports use none of it, the passing ones then fill it, the next is refused for the plan', async () => {
    const w = await world({ INTAKE_FREE_REPORTS_PER_DAY: '3' });
    for (let i = 0; i < 25; i++) expect((await deliver(w, report(`spoof-${i}`, 0, 20, { ipBase: i * 100 }))).setReject).not.toHaveBeenCalled();
    expect(w.rows("SELECT messages FROM intake_quota WHERE scope = 'fe:ws_a'")).toEqual([]);
    for (let i = 0; i < 3; i++) await deliver(w, report(`own-${i}`, 2 + i, 5 + i, { ipBase: 50_000 + i * 100 }));
    expect(w.rows("SELECT messages FROM intake_quota WHERE scope = 'fe:ws_a'")[0].messages).toBe(3);
    const over = await deliver(w, report('own-3', 1, 0));
    expect(failures(w)).toEqual([{ reason: 'cap_free_plan_reports', messages: 1 }]);
    expect(over.setReject).not.toHaveBeenCalled(); // a registry reporter is accepted and dropped, never answered with a 5xx
    expect(w.rows("SELECT COUNT(*) AS n FROM aggregate_reports WHERE report_id = 'google|own-3'")[0].n).toBe(0);
    // failing mail still goes on being stored (summarised) and still never refused for the plan
    expect((await deliver(w, report('spoof-after', 0, 50, { ipBase: 90_000 }))).setReject).not.toHaveBeenCalled();
    expect(failures(w)).toEqual([{ reason: 'cap_free_plan_reports', messages: 1 }]);
  });
  it('a pay-as-you-go workspace is not held to it', async () => {
    const w = await world({ INTAKE_FREE_REPORTS_PER_DAY: '1' });
    w.db.sqlite.prepare("UPDATE workspaces SET plan = 'payg' WHERE id = 'ws_a'").run();
    await deliver(w, report('a', 3, 0)); await deliver(w, report('b', 3, 0));
    expect(failures(w)).toEqual([]);
  });
});

describe('a paused domain', () => {
  it('keeps its history, its new reports are not processed and the owner is told how many', async () => {
    const w = await world();
    await deliver(w, report('before', 5, 0));
    w.db.sqlite.prepare('UPDATE domains SET paused_at = 1 WHERE id = 1').run();
    const m = await deliver(w, report('after', 5, 0));
    expect(m.setReject).not.toHaveBeenCalled(); // a registry reporter is accepted and dropped, never answered with a 5xx
    expect(w.rows('SELECT report_id FROM aggregate_reports').map((r) => r.report_id)).toEqual(['google|before']);
    expect(failures(w)).toEqual([{ reason: 'domain_paused', messages: 1 }]);
  });
});

describe('summarising', () => {
  const rec = (ip: string, count: number, ok: boolean) => ({ source: { ip, reverse_dns: null, base_domain: null, country_code: null, country_name: null, subdivision: null, city: null, org: null, asn: null }, count, alignment: { spf: ok, dkim: ok, dmarc: ok }, policy_evaluated: { disposition: ok ? 'none' : 'reject', dkim: ok ? 'pass' : 'fail', spf: ok ? 'pass' : 'fail', policy_override_reasons: [] }, identifiers: { header_from: 'a.com', envelope_from: null, envelope_to: null }, auth_results: { dkim: [], spf: [] } }) as any;
  it('the network of an address: an IPv4 /24, an IPv6 /48, coarser when asked', () => {
    expect(networkOf('203.0.113.77', 0)).toBe('203.0.113.0/24');
    expect(networkOf('203.0.113.77', 1)).toBe('203.0.0.0/16');
    expect(networkOf('2001:db8:abcd:1::5', 0)).toBe('2001:db8:abcd::/48');
    expect(networkOf('::ffff:192.0.2.1', 0)).toBe('0:0:0::/48');
    expect(networkOf('203.0.113.77', 2)).toBe('*');
  });
  it('keeps every passing row, the biggest failing rows, folds the rest by network with exact totals', () => {
    const rows = [rec('10.0.0.1', 5, true), rec('10.0.0.2', 1, true), ...Array.from({ length: 10 }, (_, i) => rec(`203.0.113.${i + 1}`, i + 1, false)), rec('198.51.100.9', 100, false)];
    const out = shapeRecords(rows, { keepFailing: 2 });
    expect(out.records.filter((r) => r.alignment.dmarc)).toHaveLength(2);
    const kept = out.records.filter((r) => !r.alignment.dmarc && r.summarised_sources === undefined);
    expect(kept.map((r) => r.count).sort((a, b) => b - a)).toEqual([100, 10]);
    const summary = out.records.filter((r) => r.summarised_sources !== undefined);
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({ count: 1 + 2 + 3 + 4 + 5 + 6 + 7 + 8 + 9, summarised_sources: 9 });
    expect(out.summarisedRows).toBe(9);
    expect(out.records.reduce((n, r) => n + r.count, 0)).toBe(rows.reduce((n, r) => n + r.count, 0));
  });
  it('nothing is folded when everything fits', () => {
    const rows = [rec('10.0.0.1', 1, true), rec('10.0.0.2', 1, false)];
    expect(shapeRecords(rows, { keepFailing: 5 })).toEqual({ records: rows, summarisedRows: 0, summarisedSources: 0 });
  });
});
