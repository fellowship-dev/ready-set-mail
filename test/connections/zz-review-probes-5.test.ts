import { describe, it, vi, beforeEach } from 'vitest';
import { call } from '../auth/helpers';
import { world } from './world';
import { fixedReportAddress } from '../../src/hosted/fixed-address';
vi.mock('cloudflare:email', () => ({ EmailMessage: class {} }));
vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));
beforeEach(() => { for (const m of ['warn', 'log', 'error', 'info'] as const) vi.spyOn(console, m).mockImplementation(() => {}); });
const out = (l: string, v: unknown) => process.stdout.write(`PROBE ${l}: ${JSON.stringify(v)}\n`);
const body = async (r: Response) => await r.text();
const INTAKE = 'rua.intake.example.net';
describe('x', () => {
  it('T5 prove again by TXT through the claim Verify; T6 displaced history', async () => {
    const w = await world({ INTAKE_DOMAIN: INTAKE, HOSTED_CONNECT_REPORTS: 'all' });
    const id = w.db.sqlite.prepare("INSERT INTO domains (workspace_id, domain, rua_address, verified_via, proof_lost_at) VALUES (?, 'p.com', ?, 'legacy', 1)").run(w.A.ws, fixedReportAddress(INTAKE)).lastInsertRowid;
    w.db.sqlite.prepare("INSERT INTO aggregate_reports (domain_id, org_name, report_id, date_begin, date_end, total_count, pass_count, fail_count) VALUES (?, 'g', 'keep-r', 1, 2, 5, 5, 0)").run(id);
    const p = JSON.parse(await body(await call(w.env, 'POST', `/api/domains/${id}/prove`, { key: w.A.token })));
    w.cf.doh['_readysetmail.p.com'] = [p.claim.txt_value];
    const v = await call(w.env, 'POST', `/api/domains/claims/${p.claim.id}/verify`, { key: w.A.token });
    out('T5 verify', [v.status, (await body(v)).slice(0, 150), w.rows("SELECT id, verified_via, proof_lost_at FROM domains WHERE domain = 'p.com'"), w.rows('SELECT COUNT(*) n FROM aggregate_reports WHERE domain_id = ?', id)]);
    // displaced
    const lid = w.db.sqlite.prepare("INSERT INTO domains (workspace_id, domain, rua_address, verified_via) VALUES (?, 'gone.com', '', 'cloudflare')").run(w.A.ws).lastInsertRowid;
    w.db.sqlite.prepare("INSERT INTO aggregate_reports (domain_id, org_name, report_id, date_begin, date_end, total_count, pass_count, fail_count) VALUES (?, 'g', 'old-r', 1, 2, 5, 5, 0)").run(lid);
    const c = JSON.parse(await body(await call(w.env, 'POST', '/api/domains', { key: w.B.token, body: { domain: 'gone.com' } })));
    w.cf.doh['_readysetmail.gone.com'] = [c.claim?.txt_value ?? c.txt_value];
    await call(w.env, 'POST', `/api/domains/claims/${(c.claim ?? c).id}/verify`, { key: w.B.token });
    const nid = w.rows("SELECT id FROM domains WHERE domain = 'gone.com' AND evicted_at IS NULL")[0]?.id;
    w.db.sqlite.prepare("INSERT INTO aggregate_reports (domain_id, org_name, report_id, date_begin, date_end, total_count, pass_count, fail_count) VALUES (?, 'g', 'new-r', 3, 4, 7, 7, 0)").run(nid);
    for (const [who, tok] of [['A', w.A.token], ['B', w.B.token]] as const) {
      for (const path of [`/api/domains/${lid}/export`, `/api/workspaces/${who === 'A' ? w.A.ws : w.B.ws}/export`, `/api/domains/${nid}/export`]) {
        const r = await call(w.env, 'GET', path, { key: tok }); const t = await body(r);
        out(`T6 ${who} ${path.replace(String(lid), 'OLD').replace(String(nid), 'NEW').replace(/ws_[^/]+/, 'WS')}`, [r.status, t.includes('old-r'), t.includes('new-r')]);
      }
    }
  });
});
