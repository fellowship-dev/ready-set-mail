// Hosted: a DMARC record the product writes itself carries the workspace's report address, built by the existing report-address
// rules (src/hosted/report-address.ts), and writing it connects the domain's reports. HOSTED_CONNECT_REPORTS keeps its meaning:
// where it does not admit the workspace, the record is written without the address and the plan says so.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { intakeLookups } from '@ready-set-mail/db';
import { fixedReportAddress } from '../../src/hosted/fixed-address';
import { Z, world, type World } from '../connections/world';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));

beforeEach(() => { for (const m of ['warn', 'log', 'error', 'info'] as const) vi.spyOn(console, m).mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const json = async (r: Response) => await r.json() as any;
const INTAKE = 'rua.intake.example.net'; // from configuration: nothing in the product names it
const ADDRESS = `rua@${INTAKE}`;

async function setup(extraEnv: Record<string, unknown> = {}) {
  const w = await world({ INTAKE_DOMAIN: INTAKE, HOSTED_CONNECT_REPORTS: 'all', ...extraEnv });
  w.db.sqlite.prepare("UPDATE domains SET verified_via = 'cloudflare', rua_address = ''").run(); // proven, and no reports connected yet
  const { res } = await w.connectOAuth(w.A.token);
  const id = w.connectionId(res);
  await w.api(w.A.token, 'PUT', `/api/cloudflare/connections/${id}/zones`, { zone_ids: [Z.a1, Z.a2] });
  for (const d of [1, 2]) await w.api(w.A.token, 'PUT', `/api/domains/${d}/connection`, { connection_id: id });
  return w;
}
const plan = async (w: World, token = w.A.token, ids = [1]) => json(await w.api(token, 'POST', '/api/onboarding/dns-plan', { domain_ids: ids }));
const apply = async (w: World, p: any, token = w.A.token, ids = [1]) => json(await w.api(token, 'POST', '/api/onboarding/dns-apply', { domain_ids: ids, step: 'dmarc', plan_id: p.plan_id }));
const dmarcWrite = (p: any) => p.steps.find((s: any) => s.key === 'dmarc').writes.find((x: any) => x.name === '_dmarc.a-corp.com');
const live = (w: World) => w.cf.records.get(Z.a1)!.find(r => r.name === '_dmarc.a-corp.com')?.content;
const row = (w: World) => w.rows('SELECT rua_address, reports_connected_at FROM domains WHERE id = 1')[0];

describe('the plan on hosted', () => {
  it('a new record carries the report address; applying writes it, connects the domain and leaves nothing to connect', async () => {
    const w = await setup();
    const p = await plan(w);
    expect(dmarcWrite(p)).toMatchObject({ action: 'create', content: `v=DMARC1; p=none; rua=mailto:${ADDRESS}` });
    expect(p.not_written.some((n: any) => n.what === 'Report address')).toBe(false);

    const out = await apply(w, p);
    expect(out.results).toEqual([{ id: 'dmarc:1', ok: true, verified: true, reports: 'connected' }]);
    expect(live(w)).toBe(`v=DMARC1; p=none; rua=mailto:${ADDRESS}`);
    expect(row(w)).toMatchObject({ rua_address: ADDRESS });
    expect(row(w).reports_connected_at).toBeGreaterThan(0);
    expect(w.rows("SELECT action FROM audit_log WHERE action = 'reports.connect'")).toHaveLength(1);

    // Once public DNS shows the record, the domain is "waiting for the first report": nothing is left to connect.
    w.cf.doh['_dmarc.a-corp.com'] = [`v=DMARC1; p=none; rua=mailto:${ADDRESS}`];
    const status = await json(await w.api(w.A.token, 'GET', '/api/domains/1/report-address'));
    expect(status).toMatchObject({ state: 'waiting', address: ADDRESS, can_connect: true });
    // And a second plan has nothing to write for it.
    expect(dmarcWrite(await plan(w))).toMatchObject({ action: 'none' });
  });

  it('merges into an existing record: the foreign address stays, ours is added beside it, the policy is untouched, and the before is shown', async () => {
    const w = await setup();
    w.cf.seed(Z.a1, { id: 'c'.repeat(32), type: 'TXT', name: '_dmarc.a-corp.com', content: 'v=DMARC1; p=reject; pct=50; rua=mailto:dmarc@vendor.example' });
    const p = await plan(w);
    expect(dmarcWrite(p)).toMatchObject({
      action: 'update',
      before: 'v=DMARC1; p=reject; pct=50; rua=mailto:dmarc@vendor.example',
      content: `v=DMARC1; p=reject; pct=50; rua=mailto:dmarc@vendor.example,mailto:${ADDRESS}`,
    });
    await apply(w, p);
    expect(live(w)).toBe(`v=DMARC1; p=reject; pct=50; rua=mailto:dmarc@vendor.example,mailto:${ADDRESS}`);
    expect(row(w)).toMatchObject({ rua_address: ADDRESS });
  });

  it('a record that already lists two addresses never gets a third: nothing is written, nothing is dropped, and the plan says what to do', async () => {
    const w = await setup();
    const two = 'v=DMARC1; p=quarantine; rua=mailto:a@one.example,mailto:b@two.example';
    w.cf.seed(Z.a1, { id: 'c'.repeat(32), type: 'TXT', name: '_dmarc.a-corp.com', content: two });
    const p = await plan(w);
    expect(dmarcWrite(p)).toMatchObject({ action: 'none', content: two });
    expect(dmarcWrite(p).reason).toMatch(/two report addresses/);
    const out = await apply(w, p);
    expect(out.results.every((r: any) => r.reports === undefined)).toBe(true);
    expect(live(w)).toBe(two);
    expect(row(w)).toMatchObject({ rua_address: '' }); // not connected: its address is not in the record
  });

  it('an existing record that already carries our address is left as it is, and the domain is connected', async () => {
    const w = await setup();
    w.cf.seed(Z.a1, { id: 'c'.repeat(32), type: 'TXT', name: '_dmarc.a-corp.com', content: `v=DMARC1; p=none; rua=mailto:${ADDRESS}` });
    const p = await plan(w);
    expect(dmarcWrite(p)).toMatchObject({ action: 'none' });
    await apply(w, p);
    expect(row(w)).toMatchObject({ rua_address: ADDRESS });
  });
});

describe('HOSTED_CONNECT_REPORTS keeps its meaning', () => {
  it('owner (the default): an admin of a workspace the instance owner does not own gets the record without the address, and a plain sentence', async () => {
    const w = await setup({ HOSTED_CONNECT_REPORTS: 'owner', OWNER_EMAIL: 'someone-else@example.com' });
    const p = await plan(w, w.admin);
    expect(dmarcWrite(p)).toMatchObject({ action: 'create', content: 'v=DMARC1; p=none' });
    const note = p.not_written.find((n: any) => n.what === 'Report address');
    expect(note.reason).toMatch(/Reports are not connected for this workspace\. .*only the operator/);
    expect(note.reason).toMatch(/without a report address/);
    const out = await apply(w, p, w.admin);
    expect(out.results).toEqual([{ id: 'dmarc:1', ok: true, verified: true }]);
    expect(live(w)).toBe('v=DMARC1; p=none');
    expect(row(w)).toMatchObject({ rua_address: '', reports_connected_at: null });
    expect(w.rows("SELECT action FROM audit_log WHERE action = 'reports.connect'")).toEqual([]);
  });

  it('owner: a workspace the instance owner owns gets the address through the same path', async () => {
    const w = await setup({ HOSTED_CONNECT_REPORTS: 'owner', OWNER_EMAIL: 'a@example.com' });
    const p = await plan(w, w.admin);
    expect(dmarcWrite(p)).toMatchObject({ content: `v=DMARC1; p=none; rua=mailto:${ADDRESS}` });
  });

  it('a domain whose ownership is not proven is written without the address', async () => {
    const w = await setup();
    w.db.sqlite.prepare("UPDATE domains SET verified_via = 'legacy' WHERE id = 1").run();
    const p = await plan(w);
    expect(dmarcWrite(p)).toMatchObject({ content: 'v=DMARC1; p=none' });
    expect(p.not_written.find((n: any) => n.what === 'Report address').reason).toMatch(/Ownership of a-corp\.com is not proven/);
  });
});

describe('the apply-dmarc route on hosted never adds our address and never drops one that is published', () => {
  const apply1 = (w: World, record: string, token = w.A.token) => w.api(token, 'POST', '/api/domains/1/apply-dmarc', { record });
  const seedLive = (w: World, content: string) => w.cf.seed(Z.a1, { id: 'c'.repeat(32), type: 'TXT', name: '_dmarc.a-corp.com', content });

  it('a record that adds our address is refused with a pointer to Connect reports: nothing is written, nothing is connected', async () => {
    const w = await setup();
    seedLive(w, 'v=DMARC1; p=reject;');
    const res = await apply1(w, `v=DMARC1; p=reject; rua=mailto:${ADDRESS}`);
    expect(res.status).toBe(409);
    expect((await json(res)).error).toMatch(/Connect reports/);
    expect(live(w)).toBe('v=DMARC1; p=reject;');
    expect(row(w)).toMatchObject({ rua_address: '', reports_connected_at: null });
    expect((await apply1(w, `v=DMARC1; p=none; rua=mailto:${ADDRESS}`, w.admin)).status).toBe(409); // an admin of the same workspace, same rule
  });

  it('a record that drops a published address is refused: the address stays', async () => {
    const w = await setup();
    seedLive(w, 'v=DMARC1; p=reject; rua=mailto:dmarc@vendor.example');
    const res = await apply1(w, 'v=DMARC1; p=reject');
    expect(res.status).toBe(409);
    expect((await json(res)).error).toMatch(/dmarc@vendor\.example/);
    expect(live(w)).toBe('v=DMARC1; p=reject; rua=mailto:dmarc@vendor.example');
  });

  it('a policy record that keeps what is published is still written, and reports stay as they were', async () => {
    const w = await setup();
    seedLive(w, 'v=DMARC1; p=none; rua=mailto:dmarc@vendor.example');
    const res = await json(await apply1(w, 'v=DMARC1; p=quarantine; rua=mailto:dmarc@vendor.example'));
    expect(res).toMatchObject({ ok: true, record: 'v=DMARC1; p=quarantine; rua=mailto:dmarc@vendor.example' });
    expect(res.reports).toBeUndefined();
    expect(live(w)).toBe('v=DMARC1; p=quarantine; rua=mailto:dmarc@vendor.example');
    expect(row(w)).toMatchObject({ rua_address: '' });
  });

  it('a workspace that is not admitted, or a domain that is not proven, can never get our address through apply-dmarc or the policy PATCH', async () => {
    for (const [extra, prove] of [[{ HOSTED_CONNECT_REPORTS: 'owner', OWNER_EMAIL: 'someone-else@example.com' }, true], [{}, false]] as const) {
      const w = await setup(extra);
      if (!prove) w.db.sqlite.prepare("UPDATE domains SET verified_via = 'legacy' WHERE id = 1").run();
      seedLive(w, 'v=DMARC1; p=none');
      expect((await apply1(w, `v=DMARC1; p=none; rua=mailto:${ADDRESS}`)).status).toBe(409);
      // Even when its stored address is ours (connected before the workspace was refused), the policy PATCH adds nothing.
      w.db.sqlite.prepare('UPDATE domains SET rua_address = ? WHERE id = 1').run(ADDRESS);
      const patched = await json(await w.api(w.A.token, 'PATCH', '/api/domains/1/dmarc', { policy: 'quarantine' }));
      expect(patched.record).toBe('v=DMARC1; p=quarantine');
      expect(live(w)).toBe('v=DMARC1; p=quarantine');
    }
  });
});

describe('public DNS re-read', () => {
  it('dns-state carries the record public DNS shows, so a write is "live" only once it matches', async () => {
    const w = await setup();
    const before = await json(await w.api(w.A.token, 'GET', '/api/onboarding/dns-state?names=a-corp.com'));
    expect(before.states[0].dmarc).toEqual({ state: 'missing' });
    w.cf.doh['_dmarc.a-corp.com'] = [`v=DMARC1; p=none; rua=mailto:${ADDRESS}`];
    const after = await json(await w.api(w.A.token, 'GET', '/api/onboarding/dns-state?names=a-corp.com'));
    expect(after.states[0].dmarc).toMatchObject({ state: 'found', policy: 'none', record: `v=DMARC1; p=none; rua=mailto:${ADDRESS}` });
  });
});

describe('the reports status the dashboard panel reads (GET /api/domains/:id/report-address)', () => {
  const status = async (w: World, id = 1, token = w.A.token) => json(await w.api(token, 'GET', `/api/domains/${id}/report-address`));
  const seedLive = (w: World, content: string) => w.cf.seed(Z.a1, { id: 'c'.repeat(32), type: 'TXT', name: '_dmarc.a-corp.com', content });

  it('linked to a working Cloudflare connection and not connected: Apply reaches the zone, and the review is the record in the zone now and after, policy kept', async () => {
    const w = await setup();
    seedLive(w, 'v=DMARC1; p=reject; rua=mailto:dmarc@vendor.example');
    w.cf.doh['_dmarc.a-corp.com'] = ['v=DMARC1; p=none']; // public DNS lags behind: Cloudflare's record is the one reviewed
    const s = await status(w);
    expect(s).toMatchObject({ state: 'not_connected', address: null, can_connect: true, apply_via_cloudflare: true });
    expect(s.review).toMatchObject({
      source: 'cloudflare',
      name: '_dmarc.a-corp.com',
      now: 'v=DMARC1; p=reject; rua=mailto:dmarc@vendor.example',
      outcome: { kind: 'write', action: 'update', after: `v=DMARC1; p=reject; rua=mailto:dmarc@vendor.example,mailto:${ADDRESS}` },
    });
    expect(s.review.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row(w)).toMatchObject({ rua_address: '' }); // reading the review connects nothing
  });

  it('p=reject with no rua= (the owner\'s case): the after-record is the same record with only our rua= added', async () => {
    const w = await setup();
    seedLive(w, 'v=DMARC1; p=reject;');
    const s = await status(w);
    expect(s.review.now).toBe('v=DMARC1; p=reject;');
    expect(s.review.outcome.after).toMatch(/^v=DMARC1; p=reject;/);
    expect(s.review.outcome.after).toContain(`rua=mailto:${ADDRESS}`);
  });

  it('two addresses already: the review is a choice between the first two, never a third address', async () => {
    const w = await setup();
    seedLive(w, 'v=DMARC1; p=quarantine; rua=mailto:a@one.example,mailto:b@two.example');
    const o = (await status(w)).review.outcome;
    expect(o.kind).toBe('choose');
    expect(o.options.map((x: any) => x.replaces)).toEqual(['mailto:a@one.example', 'mailto:b@two.example']);
    for (const x of o.options) expect(x.after.match(/mailto:/g)).toHaveLength(2);
    expect(o.reason).toMatch(/first two/);
  });

  it('a domain not linked to the connection: no Apply, no review, and no record with the address is offered before the domain is connected', async () => {
    const w = await setup();
    w.db.sqlite.prepare('UPDATE domains SET cf_connection_id = NULL WHERE id = 1').run();
    w.cf.doh['_dmarc.a-corp.com'] = ['v=DMARC1; p=reject;'];
    const s = await status(w);
    expect(s).toMatchObject({ can_connect: true, apply_via_cloudflare: false, review: null });
    expect(JSON.stringify(s)).not.toContain(ADDRESS);
  });

  it('connected: the review stays, Apply still reaches the zone', async () => {
    const w = await setup();
    seedLive(w, 'v=DMARC1; p=reject;');
    w.cf.doh['_dmarc.a-corp.com'] = ['v=DMARC1; p=reject;'];
    expect((await w.api(w.A.token, 'POST', '/api/domains/1/report-address', {})).status).toBe(201);
    const s = await status(w);
    expect(s).toMatchObject({ state: 'not_published', address: ADDRESS, apply_via_cloudflare: true });
    expect(s.review.outcome.kind).toBe('write');
    expect(s.dns.plan.kind).toBe('add');
  });

  it('where reports cannot be connected: no Apply, no review', async () => {
    const w = await setup({ HOSTED_CONNECT_REPORTS: 'owner', OWNER_EMAIL: 'someone-else@example.com' });
    seedLive(w, 'v=DMARC1; p=reject;');
    expect(await status(w)).toMatchObject({ can_connect: false, apply_via_cloudflare: false, review: null });
  });

  it('the setup status no longer offers an address to write: the write goes through Connect reports', async () => {
    const w = await setup();
    const s = await json(await w.api(w.A.token, 'GET', '/api/domains/1/onboarding-status'));
    expect(s.rua_address).toBe('');
    expect(s).not.toHaveProperty('offered_rua_address');
    expect(JSON.stringify(s)).not.toContain(ADDRESS);
  });
});

describe('Apply: connect first, then write', () => {
  const seedLive = (w: World, content: string) => w.cf.seed(Z.a1, { id: 'c'.repeat(32), type: 'TXT', name: '_dmarc.a-corp.com', content });
  const apply1 = async (w: World, token = w.A.token, choice: unknown = { kind: 'add' }) => {
    const hash = (await json(await w.api(w.A.token, 'GET', '/api/domains/1/report-address'))).review.hash;
    return w.api(token, 'POST', '/api/domains/1/report-address/apply', { reviewed: hash, choice });
  };

  it('the domain is connected before the record carrying our address is written', async () => {
    const w = await setup();
    seedLive(w, 'v=DMARC1; p=none;');
    expect(await intakeLookups(w.env.DB).connectedForReport(['a-corp.com'], fixedReportAddress(INTAKE))).toBeNull(); // before: refused
    const connectedAtWrite: string[] = [];
    const prev = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: any, init?: any) => {
      if (/dns_records/.test(String(input.url ?? input)) && ['POST', 'PUT', 'PATCH'].includes((init?.method ?? 'GET').toUpperCase()) && /_dmarc/.test(String(init?.body))) connectedAtWrite.push(row(w).rua_address);
      return prev(input, init);
    });
    const res = await json(await apply1(w));
    expect(res).toMatchObject({ ok: true, wrote: true });
    expect(connectedAtWrite).toEqual([ADDRESS]);
    expect((await intakeLookups(w.env.DB).connectedForReport(['a-corp.com'], fixedReportAddress(INTAKE)))?.workspace_id).toBe(w.A.ws);
  });

  it('a write that fails after the domain was connected leaves it connected, says so, and a retry writes it', async () => {
    const w = await setup();
    seedLive(w, 'v=DMARC1; p=reject;');
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      if (/\/dns_records/.test(u.pathname) && ['POST', 'PATCH', 'PUT'].includes((init?.method ?? 'GET').toUpperCase())) return Response.json({ success: false, errors: [{ message: 'write refused' }] }, { status: 500 });
      return real(input, init);
    });
    const res = await apply1(w);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await json(res)).error).toMatch(/write refused/);
    expect(live(w)).toBe('v=DMARC1; p=reject;'); // nothing written
    expect(row(w)).toMatchObject({ rua_address: ADDRESS }); // but connected, before the write
    const s = await json(await w.api(w.A.token, 'GET', '/api/domains/1/report-address'));
    expect(s).toMatchObject({ state: 'not_published', address: ADDRESS, apply_via_cloudflare: true });
    expect(s.review.outcome.kind).toBe('write');
    // The retry: the connection stays, the record is written.
    vi.stubGlobal('fetch', real);
    expect(await json(await apply1(w))).toMatchObject({ ok: true, wrote: true });
    expect(live(w)).toBe(`v=DMARC1; p=reject; rua=mailto:${ADDRESS}`);
    w.cf.doh['_dmarc.a-corp.com'] = [live(w)!];
    expect((await json(await w.api(w.A.token, 'GET', '/api/domains/1/report-address'))).state).toBe('waiting');
    expect(w.rows("SELECT action FROM audit_log WHERE action = 'reports.connect'")).toHaveLength(1);
  });

  it('read-only members cannot connect or apply: 403, nothing changes; they can read the status', async () => {
    const w = await setup();
    seedLive(w, 'v=DMARC1; p=reject;');
    expect((await w.api(w.member, 'POST', '/api/domains/1/report-address', {})).status).toBe(403);
    expect((await apply1(w, w.member)).status).toBe(403);
    expect(live(w)).toBe('v=DMARC1; p=reject;');
    expect(row(w)).toMatchObject({ rua_address: '' });
    expect((await w.api(w.member, 'GET', '/api/domains/1/report-address')).status).toBe(200);
  });
});
