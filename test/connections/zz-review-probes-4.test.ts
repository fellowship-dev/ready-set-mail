// Round-3 review probes for PR 173 at ba43ea3.
import { describe, it, vi, beforeEach, afterEach } from 'vitest';
import { call, signupVerified, inviteAndAccept } from '../auth/helpers';
import { world } from './world';
import { recheckZoneProofs } from '../../src/domains/proof-recheck';
import { attributeReport, fixedReportAddress } from '../../src/hosted/fixed-address';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));
beforeEach(() => { for (const m of ['warn', 'log', 'error', 'info'] as const) vi.spyOn(console, m).mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const out = (label: string, v: unknown) => process.stdout.write(`PROBE ${label}: ${JSON.stringify(v)}\n`);
const json = async (r: Response) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const zid = (n: string) => Buffer.from(n).toString('hex').padEnd(32, '0').slice(0, 32);
const INTAKE = 'rua.intake.example.net';
const CF = ['a.ns.cloudflare.com', 'b.ns.cloudflare.com'];

async function base(extra: Record<string, unknown> = {}) {
  const w = await world({ INTAKE_DOMAIN: INTAKE, HOSTED_CONNECT_REPORTS: 'all', ...extra });
  for (const k of Object.keys(w.cf.zones)) delete w.cf.zones[k];
  const rows = (name: string) => w.rows("SELECT id, workspace_id = ? AS is_a, verified_via, evicted_at IS NOT NULL AS ev, proof_lost_at IS NOT NULL AS lost, proof_suspected_at FROM domains WHERE domain = ? OR evicted_name = ?", w.A.ws, name, name);
  /** B claims `name` and publishes the TXT record, then presses Verify. */
  const txtProve = async (token: string, name: string) => {
    const r = await json(await call(w.env, 'POST', '/api/domains', { key: token, body: { domain: name } }));
    const claim = r.claim ?? r;
    if (!claim?.txt_value) return { add: r };
    w.cf.doh[`_readysetmail.${name}`] = [claim.txt_value];
    const v = await call(w.env, 'POST', `/api/domains/claims/${claim.id}/verify`, { key: token });
    return { add: 202, verify: v.status, body: JSON.stringify(await json(v)).slice(0, 160) };
  };
  return { w, rows, txtProve };
}
const oldRow = (w: any, ws: string, name: string) => w.db.sqlite.prepare("INSERT INTO domains (workspace_id, domain, rua_address, verified_via) VALUES (?, ?, ?, 'cloudflare')").run(ws, name, fixedReportAddress(INTAKE)).lastInsertRowid as number;

describe('2.0.0 rows (cloudflare, no servers)', () => {
  it('T1 claim alone vs TXT proof vs parent proof vs a stale 2.0.0 parent', async () => {
    const s = await base();
    oldRow(s.w, s.w.A.ws, 'legit.com');
    const claimOnly = await call(s.w.env, 'POST', '/api/domains', { key: s.w.B.token, body: { domain: 'legit.com' } });
    out('T1 claim only', [claimOnly.status, s.rows('legit.com')]);
    out('T1 intake before', !!(await attributeReport(s.w.env, INTAKE, 'legit.com')));
    out('T1 TXT proof by B', [await s.txtProve(s.w.B.token, 'legit.com'), s.rows('legit.com')]);
    // parent: B has a stale 2.0.0 row for parent.com; A holds a 2.0.0 row for mail.parent.com
    const s2 = await base();
    oldRow(s2.w, s2.w.B.ws, 'parent.com');
    oldRow(s2.w, s2.w.A.ws, 'mail.parent.com');
    const viaStaleParent = await call(s2.w.env, 'POST', '/api/domains', { key: s2.w.B.token, body: { domain: 'mail.parent.com' } });
    out('T1 B via its own stale 2.0.0 parent', [viaStaleParent.status, s2.rows('mail.parent.com')]);
  });
});

describe('prove again', () => {
  it('T2 role, cross-workspace, proven row, TXT-only row, evicted row', async () => {
    const s = await base();
    const id = oldRow(s.w, s.w.A.ws, 'p.com');
    s.w.db.sqlite.prepare("UPDATE domains SET verified_via = 'legacy', proof_lost_at = 1 WHERE id = ?").run(id);
    const member = s.w.member;
    out('T2 member', (await call(s.w.env, 'POST', `/api/domains/${id}/prove`, { key: member })).status);
    out('T2 other workspace', (await call(s.w.env, 'POST', `/api/domains/${id}/prove`, { key: s.w.B.token })).status);
    const first = await call(s.w.env, 'POST', `/api/domains/${id}/prove`, { key: s.w.A.token });
    const fb = await json(first);
    out('T2 owner, no proof', [first.status, JSON.stringify(fb).slice(0, 200)]);
    const tv = fb.claim?.txt_value ?? fb.txt_value;
    if (tv) s.w.cf.doh['_readysetmail.p.com'] = [tv];
    const again = await call(s.w.env, 'POST', `/api/domains/${id}/prove`, { key: s.w.A.token });
    out('T2 owner, TXT published', [again.status, JSON.stringify(await json(again)).slice(0, 200), s.rows('p.com')]);
    // spam: 20 prove calls in a row
    const t0 = Date.now(); const st: number[] = [];
    for (let i = 0; i < 20; i++) st.push((await call(s.w.env, 'POST', `/api/domains/${id}/prove`, { key: s.w.A.token })).status);
    out('T2 20 repeated', [st.join(','), Date.now() - t0]);
    // evicted
    const s3 = await base();
    const lid = oldRow(s3.w, s3.w.A.ws, 'gone.com');
    s3.w.db.sqlite.prepare("INSERT INTO aggregate_reports (domain_id, org_name, report_id, date_begin, date_end, total_count, pass_count, fail_count) VALUES (?, 'g', 'old-r', 1, 2, 5, 5, 0)").run(lid);
    await s3.txtProve(s3.w.B.token, 'gone.com');
    const ev = await call(s3.w.env, 'POST', `/api/domains/${lid}/prove`, { key: s3.w.A.token });
    out('T2 evicted prove', [ev.status, JSON.stringify(await json(ev)).slice(0, 220)]);
    // history readability and leakage
    const newId = s3.w.rows("SELECT id FROM domains WHERE domain = 'gone.com' AND evicted_at IS NULL")[0]?.id;
    if (newId) s3.w.db.sqlite.prepare("INSERT INTO aggregate_reports (domain_id, org_name, report_id, date_begin, date_end, total_count, pass_count, fail_count) VALUES (?, 'g', 'new-r', 3, 4, 7, 7, 0)").run(newId);
    const target = await attributeReport(s3.w.env, INTAKE, 'gone.com');
    out('T2 intake after eviction goes to', target ? (target.workspace_id === s3.w.A.ws ? 'A(old)' : 'B(new)') : null);
    for (const [who, tok] of [['A', s3.w.A.token], ['B', s3.w.B.token]] as const) {
      for (const p of [`/api/domains/${lid}/reports`, `/api/domains/${lid}`, '/api/reports', '/api/export']) {
        const r = await call(s3.w.env, 'GET', p, { key: tok });
        const body = JSON.stringify(await json(r));
        out(`T2 ${who} GET ${p.replace(String(lid), 'OLD')}`, [r.status, body.includes('old-r'), body.includes('new-r'), body.length]);
      }
    }
  });
});

describe('daily job', () => {
  function seed(w: any, n: number, prefix: string, ws: string) {
    const ins = w.db.sqlite.prepare("INSERT INTO domains (workspace_id, domain, rua_address, verified_via, cf_zone_id, cf_zone_name, cf_name_servers) VALUES (?, ?, '', 'cloudflare', ?, ?, ?)");
    for (let i = 0; i < n; i++) { const d = `${prefix}${i}.com`; ins.run(ws, d, zid(d), d, JSON.stringify(CF)); }
  }
  const res = (fn: (n: string) => string[] | 'fail') => ({ resolve: async (name: string) => { const a = fn(name); return a === 'fail' ? { status: 'error', answers: [], error: 'SERVFAIL' } : { status: 'ok', answers: a.map(d => ({ name, type: 2, ttl: 1, data: d })) }; }, txt: async () => ({ status: 'error', records: [] }), fetch: globalThis.fetch } as any);
  it('T3 stalled rows (200 SERVFAIL + 200 old no-server rows) and a moved domain: days to downgrade', async () => {
    const w = await world({ INTAKE_DOMAIN: INTAKE });
    seed(w, 200, 'stall', w.B.ws);
    for (let i = 0; i < 200; i++) oldRow(w, w.B.ws, `old${i}.com`);
    w.db.sqlite.prepare("INSERT INTO domains (workspace_id, domain, rua_address, verified_via, cf_zone_id, cf_zone_name, cf_name_servers) VALUES (?, 'moved.com', '', 'cloudflare', 'zz', 'moved.com', ?)").run(w.A.ws, JSON.stringify(CF));
    const r = res(n => n.startsWith('stall') ? 'fail' : n === 'moved.com' ? ['other.net'] : CF);
    let t = 1_800_000_000_000;
    for (let day = 1; day <= 5; day++) {
      const o = await recheckZoneProofs(w.env, { resolver: r, now: () => (t += 86_400_000) });
      out(`T3 day${day}`, { ...o, moved: w.rows("SELECT verified_via, proof_suspected_at IS NOT NULL AS sus FROM domains WHERE domain = 'moved.com'")[0] });
    }
  });
  it('T4 suspicion: differ, match, differ (24h+ apart) and what a single differing read changes', async () => {
    const w = await world({ INTAKE_DOMAIN: INTAKE, HOSTED_CONNECT_REPORTS: 'all' });
    w.db.sqlite.prepare("INSERT INTO domains (workspace_id, domain, rua_address, verified_via, cf_zone_id, cf_zone_name, cf_name_servers) VALUES (?, 'flip.com', ?, 'cloudflare', 'zz', 'flip.com', ?)").run(w.A.ws, fixedReportAddress(INTAKE), JSON.stringify(CF));
    const seq = [['x.net'], CF, ['x.net'], ['x.net'], ['x.net']];
    let i = 0, t = 1_800_000_000_000;
    for (const ans of seq) {
      const o = await recheckZoneProofs(w.env, { resolver: res(() => ans as string[]), now: () => (t += 86_400_000) });
      const st = await json(await call(w.env, 'GET', '/api/domains', { key: w.A.token }));
      const d = (st.domains ?? []).find((x: any) => x.domain === 'flip.com');
      out(`T4 read${++i} ${ans[0]}`, { o, row: w.rows("SELECT verified_via, proof_suspected_at IS NOT NULL AS sus FROM domains WHERE domain = 'flip.com'")[0], intake: !!(await attributeReport(w.env, INTAKE, 'flip.com')), apiKeys: d ? Object.keys(d).filter(k => /proof|suspect/.test(k)).map(k => `${k}=${d[k]}`) : null, mails: w.send.mock.calls.length });
    }
  });
});
