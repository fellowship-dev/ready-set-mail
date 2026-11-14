import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { Z, world, type World } from '../connections/world';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

beforeEach(() => { for (const m of ['warn', 'log', 'error', 'info'] as const) vi.spyOn(console, m).mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const json = async (r: Response) => await r.json() as any;

async function connected(w: World) {
  const { res } = await w.connectOAuth(w.A.token);
  const id = w.connectionId(res);
  await w.api(w.A.token, 'PUT', `/api/cloudflare/connections/${id}/zones`, { zone_ids: [Z.a1, Z.a2] });
  for (const d of [1, 2]) await w.api(w.A.token, 'PUT', `/api/domains/${d}/connection`, { connection_id: id });
  return id;
}
const plan = async (w: World, ids = [1, 2]) => json(await w.api(w.A.token, 'POST', '/api/onboarding/dns-plan', { domain_ids: ids }));

describe('onboarding routes', () => {
  it('members are refused, and only owners/admins reach the module', async () => {
    const w = await world();
    expect((await w.api(w.member, 'POST', '/api/onboarding/dns-plan', { domain_ids: [1] })).status).toBe(403);
    expect((await w.api(w.admin, 'POST', '/api/onboarding/dns-plan', { domain_ids: [1] })).status).toBe(200);
  });

  it('dns-state reports SPF, DMARC and MX per name, and lookup failure is not "missing"', async () => {
    const w = await world();
    w.cf.doh['a-corp.com'] = ['v=spf1 -all'];
    w.cf.doh['_dmarc.a-corp.com'] = ['v=DMARC1; p=reject'];
    const r = await json(await w.api(w.A.token, 'GET', '/api/onboarding/dns-state?names=a-corp.com,a-two.org'));
    expect(r.states[0]).toMatchObject({ name: 'a-corp.com', spf: 'found', dmarc: { state: 'found', policy: 'reject' } });
    expect(r.states[1]).toMatchObject({ name: 'a-two.org', spf: 'missing', dmarc: { state: 'missing' } });
    const many = Array.from({ length: 51 }, (_, i) => `d${i}.com`).join(',');
    expect((await w.api(w.A.token, 'GET', `/api/onboarding/dns-state?names=${many}`)).status).toBe(400);
    vi.stubGlobal('fetch', async () => { throw new Error('offline'); });
    const down = await json(await w.api(w.A.token, 'GET', '/api/onboarding/dns-state?names=a-corp.com'));
    expect(down.states[0]).toMatchObject({ spf: 'error', dmarc: { state: 'error' }, mx: null });
  });

  it('plans a DMARC create, applies it, and is satisfied afterwards', async () => {
    const w = await world();
    await connected(w);
    const p = await plan(w);
    const dmarc = p.steps.find((s: any) => s.key === 'dmarc');
    expect(dmarc.satisfied).toBe(false);
    expect(dmarc.writes.map((x: any) => [x.name, x.action, x.content])).toEqual([
      ['_dmarc.a-corp.com', 'create', 'v=DMARC1; p=none'],
      ['_dmarc.a-two.org', 'create', 'v=DMARC1; p=none'],
    ]);
    expect(p.not_written.find((n: any) => /SPF and DKIM/.test(n.what))).toMatchObject({ step: null, link: '/domains/1/setup' });

    const res = await w.api(w.A.token, 'POST', '/api/onboarding/dns-apply', { domain_ids: [1, 2], step: 'dmarc', plan_id: p.plan_id });
    expect((await json(res)).results).toEqual([{ id: 'dmarc:1', ok: true, verified: true }, { id: 'dmarc:2', ok: true, verified: true }]);
    expect(w.cf.records.get(Z.a1)!.some(r => r.name === '_dmarc.a-corp.com' && r.content === 'v=DMARC1; p=none')).toBe(true);
    expect(w.rows(`SELECT action FROM audit_log WHERE action = 'dns.create'`).length).toBeGreaterThanOrEqual(2);

    const after = await plan(w);
    expect(after.steps.find((s: any) => s.key === 'dmarc').satisfied).toBe(true);
    // retrying the applied plan is a plan change, nothing is written twice
    const again = await w.api(w.A.token, 'POST', '/api/onboarding/dns-apply', { domain_ids: [1, 2], step: 'dmarc', plan_id: p.plan_id });
    expect(again.status).toBe(409);
    expect((await json(again)).code).toBe('plan_changed');
    expect(w.cf.records.get(Z.a1)!.filter(r => r.name === '_dmarc.a-corp.com')).toHaveLength(1);
  });

  it('a write that Cloudflare does not show on read-back is ok but not verified', async () => {
    const w = await world();
    await connected(w);
    const p = await plan(w, [1]);
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const res = await real(input, init);
      if (init?.method === 'POST' && String(input).includes('/dns_records')) w.cf.records.set(Z.a1, []);
      return res;
    });
    const res = await w.api(w.A.token, 'POST', '/api/onboarding/dns-apply', { domain_ids: [1], step: 'dmarc', plan_id: p.plan_id });
    expect((await json(res)).results).toEqual([{ id: 'dmarc:1', ok: true, verified: false }]);
  });

  it('a stale plan_id writes nothing', async () => {
    const w = await world();
    await connected(w);
    const res = await w.api(w.A.token, 'POST', '/api/onboarding/dns-apply', { domain_ids: [1], step: 'dmarc', plan_id: 'stale' });
    expect(res.status).toBe(409);
    expect((await json(res)).plan.steps[0].writes[0].action).toBe('create');
    expect(w.cf.calls.some(c => c.method === 'POST')).toBe(false);
  });

  it('an existing record is only extended, and several records are not written', async () => {
    const w = await world();
    await connected(w);
    w.cf.seed(Z.a2, { type: 'TXT', name: '_dmarc.a-two.org', content: 'v=DMARC1; p=none' });
    w.cf.seed(Z.a2, { type: 'TXT', name: '_dmarc.a-two.org', content: 'v=DMARC1; p=reject' });
    w.cf.seed(Z.a1, { type: 'TXT', name: '_dmarc.a-corp.com', content: '"v=DMARC1; p=quarantine; pct=50"' });
    const p = await plan(w);
    const writes = p.steps.find((s: any) => s.key === 'dmarc').writes;
    expect(writes).toHaveLength(1); // hosted: no rua, so the existing record needs nothing
    expect(writes[0]).toMatchObject({ domain: 'a-corp.com', action: 'none' });
    expect(p.not_written.find((n: any) => n.domain === 'a-two.org')).toMatchObject({ link: '/domains/2/setup', step: 'dmarc' });
  });

  it("another workspace's domain id plans nothing", async () => {
    const w = await world();
    await connected(w);
    const p = await plan(w, [3]);
    expect(p.steps[0].writes).toEqual([]);
  });

  it('a zone the owner did not allow is explained, not thrown', async () => {
    const w = await world();
    const { res } = await w.connectOAuth(w.A.token);
    const id = w.connectionId(res);
    await w.api(w.A.token, 'PUT', `/api/cloudflare/connections/${id}/zones`, { zone_ids: [Z.a1, Z.a2] });
    await w.api(w.A.token, 'PUT', '/api/domains/2/connection', { connection_id: id });
    await w.api(w.A.token, 'PUT', `/api/cloudflare/connections/${id}/zones`, { zone_ids: [Z.a1] });
    const p = await plan(w, [2]);
    expect(p.not_written.find((n: any) => n.domain === 'a-two.org').reason).toMatch(/not one of the zones/);
  });

  it('first-check answers per domain', async () => {
    const w = await world();
    const r = await json(await w.api(w.A.token, 'POST', '/api/onboarding/first-check', { domain_ids: [1] }));
    expect(r.results).toHaveLength(1);
    expect(r.results[0].domain_id).toBe(1);
  });

  describe('hosted: only verified domains of the workspace get writes', () => {
    const none = (p: any) => p.steps.flatMap((s: any) => s.writes);

    it('a pending claim id yields no plan, no writes and no first check', async () => {
      const w = await world();
      await connected(w);
      let claimId = 0;
      for (const d of ['pend-one.org', 'pend-two.org', 'pend-three.org', 'pend-four.org', 'pend-five.org']) {
        const r = await json(await w.api(w.A.token, 'POST', '/api/domains', { domain: d }));
        expect(r.pending).toBe(true);
        claimId = r.claim.id;
      }
      expect(claimId).toBeGreaterThan(3); // beyond every domain id, so it names no domain
      expect(w.rows('SELECT id FROM domains WHERE workspace_id = ?', w.A.ws).map(r => r.id)).not.toContain(claimId);
      const before = JSON.stringify([...w.cf.records.entries()]);

      const p = await plan(w, [claimId]);
      expect(none(p)).toEqual([]);
      const res = await w.api(w.A.token, 'POST', '/api/onboarding/dns-apply', { domain_ids: [claimId], step: 'dmarc', plan_id: p.plan_id });
      expect(res.status).toBe(200);
      expect((await json(res)).results).toEqual([]);
      expect((await json(await w.api(w.A.token, 'POST', '/api/onboarding/first-check', { domain_ids: [claimId] }))).results).toEqual([]);
      expect(JSON.stringify([...w.cf.records.entries()])).toBe(before);
      expect(w.rows(`SELECT 1 FROM audit_log WHERE action LIKE 'dns.%'`)).toEqual([]);
    });

    it('a subdomain admitted through a parent that left the workspace is refused; a proven one is planned', async () => {
      const w = await world();
      await connected(w);
      w.db.sqlite.prepare(`INSERT INTO domains (id, workspace_id, domain, rua_address, verified_via) VALUES (4, ?, 'x.a-corp.com', 'rua@x', 'parent')`).run(w.A.ws);
      expect(none(await plan(w, [4]))).toEqual([]);
      w.db.sqlite.prepare(`UPDATE domains SET verified_via = 'cloudflare' WHERE id = 1`).run();
      w.db.sqlite.prepare('UPDATE domains SET cf_connection_id = (SELECT cf_connection_id FROM domains WHERE id = 1) WHERE id = 4').run();
      const ok = await plan(w, [4]);
      expect(none(await plan(w, [4])).map((x: any) => x.name)).toEqual(['_dmarc.x.a-corp.com']);
    });

    it('mixed ids: only the verified domain of the caller is written', async () => {
      const w = await world();
      await connected(w);
      const p = await plan(w, [1, 3, 999]);
      expect(none(p).map((x: any) => x.name)).toEqual(['_dmarc.a-corp.com']);
      const fc = await json(await w.api(w.A.token, 'POST', '/api/onboarding/first-check', { domain_ids: [1, 3, 999] }));
      expect(fc.results.map((x: any) => x.domain_id)).toEqual([1]);
    });
  });
});
