// Hosted: a DMARC record the product writes itself carries the workspace's report address, built by the existing report-address
// rules (src/hosted/report-address.ts), and writing it connects the domain's reports. HOSTED_CONNECT_REPORTS keeps its meaning:
// where it does not admit the workspace, the record is written without the address and the plan says so.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { intakeLookups } from '@ready-set-mail/db';
import { fixedReportAddress } from '../../src/hosted/fixed-address';
import { Z, world, type World } from '../connections/world';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

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

describe('the apply-dmarc route (the per-domain Apply) on hosted', () => {
  const apply1 = (w: World, record: string, token = w.A.token) => w.api(token, 'POST', '/api/domains/1/apply-dmarc', { record });

  it('adds the address to the record it is given and connects the domain', async () => {
    const w = await setup();
    const res = await json(await apply1(w, 'v=DMARC1; p=none'));
    expect(res).toMatchObject({ ok: true, record: `v=DMARC1; p=none; rua=mailto:${ADDRESS}`, reports: { state: 'connected', address: ADDRESS } });
    expect(live(w)).toBe(`v=DMARC1; p=none; rua=mailto:${ADDRESS}`);
    expect(row(w)).toMatchObject({ rua_address: ADDRESS });
  });

  it('keeps a foreign address and the policy, and never weakens a p=reject', async () => {
    const w = await setup();
    w.cf.seed(Z.a1, { id: 'c'.repeat(32), type: 'TXT', name: '_dmarc.a-corp.com', content: 'v=DMARC1; p=reject; rua=mailto:dmarc@vendor.example' });
    const res = await json(await apply1(w, 'v=DMARC1; p=reject; rua=mailto:dmarc@vendor.example'));
    expect(res.record).toBe(`v=DMARC1; p=reject; rua=mailto:dmarc@vendor.example,mailto:${ADDRESS}`);
  });

  it('two foreign addresses: written as given, no third, not connected, and it says so', async () => {
    const w = await setup();
    const two = 'v=DMARC1; p=none; rua=mailto:a@one.example,mailto:b@two.example';
    const res = await json(await apply1(w, two));
    expect(res.record).toBe(two);
    expect(res.reports.state).toBe('limit');
    expect(row(w)).toMatchObject({ rua_address: '' });
  });

  it('a third address the caller appended is cut back to what was there, ours left out', async () => {
    const w = await setup();
    w.cf.seed(Z.a1, { id: 'c'.repeat(32), type: 'TXT', name: '_dmarc.a-corp.com', content: 'v=DMARC1; p=none; rua=mailto:a@one.example,mailto:b@two.example' });
    const res = await json(await apply1(w, `v=DMARC1; p=none; rua=mailto:a@one.example,mailto:b@two.example,mailto:${ADDRESS}`));
    expect(res.record).toBe('v=DMARC1; p=none; rua=mailto:a@one.example,mailto:b@two.example');
    expect(res.reports.state).toBe('limit');
  });

  it('where reports are not admitted: written without the address, with the reason', async () => {
    const w = await setup({ HOSTED_CONNECT_REPORTS: 'owner', OWNER_EMAIL: 'someone-else@example.com' });
    const res = await json(await apply1(w, 'v=DMARC1; p=none', w.admin));
    expect(res.record).toBe('v=DMARC1; p=none');
    expect(res.reports).toMatchObject({ state: 'refused' });
    expect(res.reports.reason).toMatch(/only the operator/);
    expect(row(w)).toMatchObject({ rua_address: '' });
  });

  it('the setup status leaves the stored address alone and offers the connectable one apart, for Apply via Cloudflare only; refused workspaces are offered none', async () => {
    const w = await setup();
    const s = await json(await w.api(w.A.token, 'GET', '/api/domains/1/onboarding-status'));
    expect(s.rua_address).toBe(''); // not connected: no hand-made record with it would be accepted at intake
    expect(s.offered_rua_address).toBe(ADDRESS);
    const blocked = await setup({ HOSTED_CONNECT_REPORTS: 'owner', OWNER_EMAIL: 'someone-else@example.com' });
    const b = await json(await blocked.api(blocked.A.token, 'GET', '/api/domains/1/onboarding-status'));
    expect(b.rua_address).toBe('');
    expect(b.offered_rua_address).toBeNull();
  });

  it('with Cloudflare connected but the domain\'s zone not in it, no report address is offered: that Apply cannot write the record or connect the reports', async () => {
    const w = await setup();
    w.db.sqlite.prepare('UPDATE domains SET cf_connection_id = NULL WHERE id = 1').run(); // a connection exists, for other zones; this domain is not linked to it
    w.cf.doh['_dmarc.a-corp.com'] = ['v=DMARC1; p=none; rua=mailto:someone-else@example.net'];
    const s = await json(await w.api(w.A.token, 'GET', '/api/domains/1/onboarding-status'));
    expect(s).toMatchObject({ cf_available: true, rua_address: '', offered_rua_address: null });
    expect(JSON.stringify(s)).not.toContain(ADDRESS);
    const linked = await json(await w.api(w.A.token, 'GET', '/api/domains/2/onboarding-status')); // the linked one still offers it
    expect(linked.offered_rua_address).toBe(ADDRESS);
  });

  it('without Cloudflare nothing is offered, even when the record already lists our address: the domain was never connected', async () => {
    const w = await world({ INTAKE_DOMAIN: INTAKE, HOSTED_CONNECT_REPORTS: 'all' });
    w.db.sqlite.prepare("UPDATE domains SET verified_via = 'txt', rua_address = '' WHERE id = 3").run(); // B's domain: proven, no Cloudflare, not connected
    w.cf.doh['_dmarc.b-corp.org'] = [`v=DMARC1; p=none; rua=mailto:${ADDRESS}`];
    const s = await json(await w.api(w.B.token, 'GET', '/api/domains/3/onboarding-status'));
    expect(s).toMatchObject({ rua_address: '', offered_rua_address: null, cf_available: false });
    expect(s.dmarc.has_our_rua).toBe(false);
    expect(await intakeLookups(w.env.DB).connectedForReport(['b-corp.org'], fixedReportAddress(INTAKE))).toBeNull(); // so a pasted record's reports would be refused
  });

  it('invariant: an address the status offers is accepted at intake once the Apply it is offered for has run, and is connected before the record carrying it is written', async () => {
    const w = await setup();
    const s = await json(await w.api(w.A.token, 'GET', '/api/domains/1/onboarding-status'));
    expect(s.offered_rua_address).toBe(ADDRESS);
    expect(await intakeLookups(w.env.DB).connectedForReport(['a-corp.com'], fixedReportAddress(INTAKE))).toBeNull(); // before: refused
    const connectedAtWrite: string[] = [];
    const prev = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: any, init?: any) => {
      if (/dns_records/.test(String(input.url ?? input)) && ['POST', 'PUT', 'PATCH'].includes((init?.method ?? 'GET').toUpperCase()) && /_dmarc/.test(String(init?.body))) connectedAtWrite.push(row(w).rua_address);
      return prev(input, init);
    });
    const res = await json(await w.api(w.A.token, 'POST', '/api/domains/1/apply-dmarc', { record: `v=DMARC1; p=none; rua=mailto:${s.offered_rua_address}` }));
    expect(res.reports).toMatchObject({ state: 'connected' });
    expect(connectedAtWrite).toEqual([ADDRESS]);
    expect((await intakeLookups(w.env.DB).connectedForReport(['a-corp.com'], fixedReportAddress(INTAKE)))?.workspace_id).toBe(w.A.ws);
  });

  it('invariant, the plan apply: the domain is connected before the record is written', async () => {
    const w = await setup();
    const p = await plan(w);
    const connectedAtWrite: string[] = [];
    const prev = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: any, init?: any) => {
      if (/dns_records/.test(String(input.url ?? input)) && ['POST', 'PUT', 'PATCH'].includes((init?.method ?? 'GET').toUpperCase()) && /_dmarc/.test(String(init?.body))) connectedAtWrite.push(row(w).rua_address);
      return prev(input, init);
    });
    expect((await apply(w, p)).results).toEqual([{ id: 'dmarc:1', ok: true, verified: true, reports: 'connected' }]);
    expect(connectedAtWrite).toEqual([ADDRESS]);
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

  it('linked to a working Cloudflare connection and not connected: Apply reaches the zone, and the preview is the live record now and after, policy kept', async () => {
    const w = await setup();
    w.cf.doh['_dmarc.a-corp.com'] = ['v=DMARC1; p=reject; rua=mailto:dmarc@vendor.example'];
    const s = await status(w);
    expect(s).toMatchObject({ state: 'not_connected', address: null, can_connect: true, apply_via_cloudflare: true });
    expect(s.preview.plan).toMatchObject({
      kind: 'add',
      name: '_dmarc.a-corp.com',
      current: 'v=DMARC1; p=reject; rua=mailto:dmarc@vendor.example',
      record: `v=DMARC1; p=reject; rua=mailto:dmarc@vendor.example,mailto:${ADDRESS}`,
    });
    expect(row(w)).toMatchObject({ rua_address: '' }); // reading the preview connects nothing
  });

  it('p=reject with no rua= (the owner\'s case): the after-record is the same record with only our rua= added', async () => {
    const w = await setup();
    w.cf.doh['_dmarc.a-corp.com'] = ['v=DMARC1; p=reject;'];
    const s = await status(w);
    expect(s.preview.plan).toMatchObject({ kind: 'add', current: 'v=DMARC1; p=reject;' });
    expect(s.preview.plan.record).toMatch(/^v=DMARC1; p=reject;/);
    expect(s.preview.plan.record).toContain(`rua=mailto:${ADDRESS}`);
  });

  it('two addresses already: the preview is the choose plan, never a third address', async () => {
    const w = await setup();
    w.cf.doh['_dmarc.a-corp.com'] = ['v=DMARC1; p=quarantine; rua=mailto:a@one.example,mailto:b@two.example'];
    const s = await status(w);
    expect(s.preview.plan.kind).toBe('choose');
    expect(s.preview.plan.options.some((o: any) => o.replaces === null)).toBe(true);
    for (const o of s.preview.plan.options.filter((o: any) => o.replaces !== null)) expect(o.record.match(/mailto:/g)).toHaveLength(2);
  });

  it('a domain not linked to the connection: no Apply, and no record with the address is offered before the domain is connected', async () => {
    const w = await setup();
    w.db.sqlite.prepare('UPDATE domains SET cf_connection_id = NULL WHERE id = 1').run();
    w.cf.doh['_dmarc.a-corp.com'] = ['v=DMARC1; p=reject;'];
    const s = await status(w);
    expect(s).toMatchObject({ can_connect: true, apply_via_cloudflare: false, preview: null });
    expect(JSON.stringify(s)).not.toContain(ADDRESS);
  });

  it('connected: no preview (the live check is the plan), Apply still reaches the zone', async () => {
    const w = await setup();
    w.cf.doh['_dmarc.a-corp.com'] = ['v=DMARC1; p=reject;'];
    expect((await w.api(w.A.token, 'POST', '/api/domains/1/report-address', {})).status).toBe(201);
    const s = await status(w);
    expect(s).toMatchObject({ state: 'not_published', address: ADDRESS, apply_via_cloudflare: true, preview: null });
    expect(s.dns.plan.kind).toBe('add');
  });

  it('where reports cannot be connected: no Apply, no preview', async () => {
    const w = await setup({ HOSTED_CONNECT_REPORTS: 'owner', OWNER_EMAIL: 'someone-else@example.com' });
    w.cf.doh['_dmarc.a-corp.com'] = ['v=DMARC1; p=reject;'];
    expect(await status(w)).toMatchObject({ can_connect: false, apply_via_cloudflare: false, preview: null });
  });
});

describe('Apply: connect first, then write', () => {
  const apply1 = (w: World, record: string, token = w.A.token) => w.api(token, 'POST', '/api/domains/1/apply-dmarc', { record });

  it('a write that fails after the domain was connected leaves it connected, and the status says so: not published, Apply offered again', async () => {
    const w = await setup();
    w.cf.doh['_dmarc.a-corp.com'] = ['v=DMARC1; p=reject;'];
    w.cf.seed(Z.a1, { id: 'c'.repeat(32), type: 'TXT', name: '_dmarc.a-corp.com', content: 'v=DMARC1; p=reject;' });
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      if (/\/dns_records/.test(u.pathname) && ['POST', 'PATCH', 'PUT'].includes((init?.method ?? 'GET').toUpperCase())) return Response.json({ success: false, errors: [{ message: 'write refused' }] }, { status: 500 });
      return real(input, init);
    });
    const res = await apply1(w, 'v=DMARC1; p=reject;');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(live(w)).toBe('v=DMARC1; p=reject;'); // nothing written
    expect(row(w)).toMatchObject({ rua_address: ADDRESS }); // but connected, before the write
    const s = await json(await w.api(w.A.token, 'GET', '/api/domains/1/report-address'));
    expect(s).toMatchObject({ state: 'not_published', address: ADDRESS, apply_via_cloudflare: true });
    expect(s.dns.plan.kind).toBe('add');
    // The retry: the connection stays, the record is written, and the domain waits for its first report.
    vi.stubGlobal('fetch', real);
    const again = await json(await apply1(w, 'v=DMARC1; p=reject;'));
    expect(again.reports).toMatchObject({ state: 'connected', address: ADDRESS });
    expect(live(w)).toBe(`v=DMARC1; p=reject; rua=mailto:${ADDRESS}`);
    w.cf.doh['_dmarc.a-corp.com'] = [live(w)!];
    expect((await json(await w.api(w.A.token, 'GET', '/api/domains/1/report-address'))).state).toBe('waiting');
    expect(w.rows("SELECT action FROM audit_log WHERE action = 'reports.connect'")).toHaveLength(1);
  });

  it('read-only members cannot connect or apply: 403, nothing changes', async () => {
    const w = await setup();
    w.cf.seed(Z.a1, { id: 'c'.repeat(32), type: 'TXT', name: '_dmarc.a-corp.com', content: 'v=DMARC1; p=reject;' });
    expect((await w.api(w.member, 'POST', '/api/domains/1/report-address', {})).status).toBe(403);
    expect((await apply1(w, 'v=DMARC1; p=reject;', w.member)).status).toBe(403);
    expect(live(w)).toBe('v=DMARC1; p=reject;');
    expect(row(w)).toMatchObject({ rua_address: '' });
    // They can read the status (the panel shows the review but no enabled Apply).
    expect((await w.api(w.member, 'GET', '/api/domains/1/report-address')).status).toBe(200);
  });
});
