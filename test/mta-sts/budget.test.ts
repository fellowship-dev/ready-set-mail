// The daily job and the owner's reconcile endpoint stay under the Workers subrequest limit. developers.cloudflare.com/workers/platform/limits/ (read 2026-11-16):
// "Subrequests per invocation": Workers Free 50, Workers Paid 10,000 (up to 10M); a subrequest is "any request a Worker makes using the Fetch API or to Cloudflare
// services like R2, KV, or D1". One run uses at most half of the limit; rows are visited oldest check first, so every row is visited at least every ceil(R / P) days.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetSchemaReadyCache } from '@ready-set-mail/db';
import { DEFAULT_SUBREQUEST_LIMIT, maintenancePerRun, refreshIntervalDays, refreshRowsPerRun, SUBREQUEST_MARGIN, SUBREQUEST_RESERVE, SUBREQUESTS_PER_ROW } from '../../src/mta-sts/config';
import { refreshMtaStsHosted } from '../../src/mta-sts/refresh';
import { INTAKE, OP, mtaWorld, quietLogs, type MtaWorld } from './world';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
beforeEach(() => { quietLogs(); resetSchemaReadyCache(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('rows per run', () => {
  it('the default is the Workers Paid limit and 100 rows (the default ceiling of policy hosts), well under half of it', () => {
    expect(DEFAULT_SUBREQUEST_LIMIT).toBe(10_000);
    expect(refreshRowsPerRun({})).toBe(100);
    expect(100 * SUBREQUESTS_PER_ROW + SUBREQUEST_RESERVE).toBeLessThanOrEqual(DEFAULT_SUBREQUEST_LIMIT * SUBREQUEST_MARGIN);
    expect(maintenancePerRun({})).toBe(20);
  });
  it('shrinks with the limit: never more than half of it is planned, and a Workers Free install (50) still moves one row a run', () => {
    for (const limit of [50, 500, 1000, 2000, 4000, 10_000, 100_000]) {
      const rows = refreshRowsPerRun({ SUBREQUEST_LIMIT: String(limit) });
      expect(rows, String(limit)).toBeGreaterThanOrEqual(1);
      if (rows > 1) expect(rows * SUBREQUESTS_PER_ROW + SUBREQUEST_RESERVE, String(limit)).toBeLessThanOrEqual(limit * SUBREQUEST_MARGIN);
    }
    expect(refreshRowsPerRun({ SUBREQUEST_LIMIT: '50' })).toBe(1);
    expect(refreshRowsPerRun({ SUBREQUEST_LIMIT: '2000' })).toBe(16);
    expect(maintenancePerRun({ SUBREQUEST_LIMIT: '50' })).toBe(1);
    for (const bad of ['', '0', '-5', 'abc', '1.5']) expect(refreshRowsPerRun({ SUBREQUEST_LIMIT: bad }), bad).toBe(100);
  });
  it('every row is visited at least every N days: N = ceil(rows / rows per run)', () => {
    expect(refreshIntervalDays(100, {})).toBe(1);
    expect(refreshIntervalDays(250, {})).toBe(3);
    expect(refreshIntervalDays(10, { SUBREQUEST_LIMIT: '50' })).toBe(10);
  });
});

describe('what one row really costs', () => {
  /** Subrequests of one run: every fetch (DNS, Cloudflare, the policy URL) and every D1 statement. */
  async function count(w: MtaWorld, run: () => Promise<unknown>) {
    const fetched = w.cf.fetch.mock.calls.length;
    let statements = 0;
    const prepare = w.db.prepare.bind(w.db);
    (w.db as any).prepare = (sql: string) => { statements++; return prepare(sql); };
    await run();
    (w.db as any).prepare = prepare;
    return (w.cf.fetch.mock.calls.length - fetched) + statements;
  }

  it('an active row costs at most SUBREQUESTS_PER_ROW more than an empty run', async () => {
    const w = await mtaWorld();
    await w.mta(w.A.token, 'POST', 1);
    w.cf.cname['mta-sts.a-corp.com'] = OP.target;
    w.cf.doh['_smtp._tls.a-corp.com'] = [`v=TLSRPTv1; rua=mailto:tls-rpt@${INTAKE}`];
    w.cf.activateHostname('mta-sts.a-corp.com');
    await w.mta(w.A.token, 'POST', 1, undefined, '/verify');
    expect(w.row(1).state).toBe('active');
    await refreshMtaStsHosted(w.env as any); // warm: zone lookups cached per run only, so this just proves it works
    const withRow = await count(w, () => refreshMtaStsHosted(w.env as any));
    w.db.sqlite.prepare('UPDATE mta_sts_config SET enabled = 0').run();
    const empty = await count(w, () => refreshMtaStsHosted(w.env as any));
    expect(withRow - empty).toBeGreaterThan(5);
    expect(withRow - empty).toBeLessThanOrEqual(SUBREQUESTS_PER_ROW);
  });
});

describe('the owner endpoint is bounded the same way', () => {
  it('with SUBREQUEST_LIMIT=50 one call visits one row, the next call the oldest of the rest', async () => {
    const w = await mtaWorld({ SUBREQUEST_LIMIT: '50' });
    await w.mta(w.A.token, 'POST', 1);
    await w.mta(w.A.token, 'POST', 2);
    w.db.sqlite.prepare('UPDATE mta_sts_config SET last_checked_at = 100 WHERE domain_id = 1').run();
    w.db.sqlite.prepare('UPDATE mta_sts_config SET last_checked_at = 50 WHERE domain_id = 2').run();
    const first = await (await w.api(w.A.token, 'POST', '/api/instance/mta-sts/reconcile')).json() as any;
    expect(first.visited).toBe(1);
    expect(w.row(2).last_checked_at).toBeGreaterThan(100); // the oldest went first
    expect(w.row(1).last_checked_at).toBe(100);
    const second = await (await w.api(w.A.token, 'POST', '/api/instance/mta-sts/reconcile')).json() as any;
    expect(second.visited).toBe(1);
    expect(w.row(1).last_checked_at).toBeGreaterThan(100);
  });
  it('at the default limit it visits every row', async () => {
    const w = await mtaWorld();
    await w.mta(w.A.token, 'POST', 1);
    await w.mta(w.A.token, 'POST', 2);
    expect(((await (await w.api(w.A.token, 'POST', '/api/instance/mta-sts/reconcile')).json()) as any).visited).toBe(2);
  });
});
