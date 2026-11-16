// ADR 0020: ONE function writes our report address into a DMARC record (src/hosted/report-address.ts: reviewReportRecord, applyReportRecord).
// Both entry points use it: the domain page (POST /api/domains/:id/report-address/apply) and the first-run review (dns-plan + dns-apply).
// These tests run the real routes against the fake Cloudflare.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { Z, world, type World } from '../connections/world';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));

beforeEach(() => { for (const m of ['warn', 'log', 'error', 'info'] as const) vi.spyOn(console, m).mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const json = async (r: Response) => await r.json() as any;
const INTAKE = 'rua.intake.example.net';
const OURS = `mailto:rua@${INTAKE}`;
const THIRD = 'mailto:dmarc@thirdparty.example';

async function setup(extraEnv: Record<string, unknown> = {}) {
  const w = await world({ INTAKE_DOMAIN: INTAKE, HOSTED_CONNECT_REPORTS: 'all', ...extraEnv });
  w.db.sqlite.prepare("UPDATE domains SET verified_via = 'cloudflare', rua_address = ''").run();
  const { res } = await w.connectOAuth(w.A.token);
  const id = w.connectionId(res);
  await w.api(w.A.token, 'PUT', `/api/cloudflare/connections/${id}/zones`, { zone_ids: [Z.a1, Z.a2] });
  for (const d of [1, 2]) await w.api(w.A.token, 'PUT', `/api/domains/${d}/connection`, { connection_id: id });
  // A subdomain of a-corp.com, proven through the zone, in the same zone and connection.
  w.db.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address, verified_via, cf_connection_id) VALUES (4, ?, 'mail.a-corp.com', '', 'cloudflare', ?)").run(w.A.ws, id);
  return w;
}
const nameOf = (id: number) => (id === 4 ? '_dmarc.mail.a-corp.com' : '_dmarc.a-corp.com');
const seed = (w: World, content: string, id = 1) => w.cf.seed(Z.a1, { id: `${id}`.repeat(32).slice(0, 32), type: 'TXT', name: nameOf(id), content });
const setLive = (w: World, content: string, id = 1) => { w.cf.records.get(Z.a1)!.find((r) => r.name === nameOf(id))!.content = content; };
const live = (w: World, id = 1) => w.cf.records.get(Z.a1)?.find((r) => r.name === nameOf(id))?.content;
const row = (w: World, id = 1) => w.rows('SELECT rua_address, reports_connected_at FROM domains WHERE id = ?', id)[0];
const status = async (w: World, id = 1, token = w.A.token) => json(await w.api(token, 'GET', `/api/domains/${id}/report-address`));
const page = async (w: World, id: number, choice: unknown, hash?: string, token = w.A.token) =>
  w.api(token, 'POST', `/api/domains/${id}/report-address/apply`, { reviewed: hash ?? (await status(w, id)).review.hash, choice });
const plan = async (w: World, ids: number[]) => json(await w.api(w.A.token, 'POST', '/api/onboarding/dns-plan', { domain_ids: ids }));
const firstRun = async (w: World, ids: number[]) => {
  const p = await plan(w, ids);
  return json(await w.api(w.A.token, 'POST', '/api/onboarding/dns-apply', { domain_ids: ids, step: 'dmarc', plan_id: p.plan_id }));
};

describe('the record changed between the review and the Apply (the reviewer\'s S11)', () => {
  it('a stale hash is refused with 409 record_changed and the fresh review; nothing is connected or written; the fresh hash keeps the policy and the third party', async () => {
    const w = await setup();
    seed(w, 'v=DMARC1; p=reject;');
    const reviewed = (await status(w)).review;
    expect(reviewed.now).toBe('v=DMARC1; p=reject;');

    setLive(w, `v=DMARC1; p=quarantine; rua=${THIRD}`); // changed by hand after the review opened

    const stale = await page(w, 1, { kind: 'add' }, reviewed.hash);
    expect(stale.status).toBe(409);
    const body = await json(stale);
    expect(body.code).toBe('record_changed');
    expect(body.review.now).toBe(`v=DMARC1; p=quarantine; rua=${THIRD}`);
    expect(body.review.hash).not.toBe(reviewed.hash);
    expect(body.review.outcome).toMatchObject({ kind: 'write', after: `v=DMARC1; p=quarantine; rua=${THIRD},${OURS}` });
    expect(live(w)).toBe(`v=DMARC1; p=quarantine; rua=${THIRD}`); // nothing written
    expect(row(w)).toMatchObject({ rua_address: '', reports_connected_at: null }); // nothing connected
    expect(w.rows("SELECT action FROM audit_log WHERE action = 'reports.connect'")).toEqual([]);

    const ok = await page(w, 1, { kind: 'add' }, body.review.hash);
    expect(ok.status).toBe(200);
    expect(live(w)).toBe(`v=DMARC1; p=quarantine; rua=${THIRD},${OURS}`); // policy and third party kept
    expect(row(w).rua_address).toBe(`rua@${INTAKE}`);
  });

  it('the browser cannot send a record: a record in the body changes nothing', async () => {
    const w = await setup();
    seed(w, 'v=DMARC1; p=reject;');
    const hash = (await status(w)).review.hash;
    const res = await w.api(w.A.token, 'POST', '/api/domains/1/report-address/apply', { reviewed: hash, choice: { kind: 'add' }, record: 'v=DMARC1; p=none; rua=mailto:evil@x.example' });
    expect(res.status).toBe(200);
    expect(live(w)).toBe(`v=DMARC1; p=reject; rua=${OURS}`);
  });

  it('first-run Apply: the same refusal when the record moves after the plan', async () => {
    const w = await setup();
    seed(w, 'v=DMARC1; p=reject;');
    const p = await plan(w, [1]);
    setLive(w, `v=DMARC1; p=quarantine; rua=${THIRD}`);
    const res = await w.api(w.A.token, 'POST', '/api/onboarding/dns-apply', { domain_ids: [1], step: 'dmarc', plan_id: p.plan_id });
    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe('plan_changed');
    expect(live(w)).toBe(`v=DMARC1; p=quarantine; rua=${THIRD}`);
    expect(row(w).rua_address).toBe('');
  });
});

describe('one address-count rule: ours is only the first or second address', () => {
  it('two addresses: the choice is the first or the second, every other address and tag stays; "add" and the third are refused', async () => {
    const w = await setup();
    const two = 'v=DMARC1; p=quarantine; pct=50; rua=mailto:a@x.example,mailto:b@y.example; fo=1';
    seed(w, two);
    const s = await status(w);
    expect(s.review.outcome.kind).toBe('choose');
    expect(s.review.outcome.options.map((o: any) => o.replaces)).toEqual(['mailto:a@x.example', 'mailto:b@y.example']);

    expect((await page(w, 1, { kind: 'add' })).status).toBe(400);
    expect((await page(w, 1, { kind: 'replace', address: 'mailto:zzz@x.example' })).status).toBe(400);
    expect(live(w)).toBe(two);
    expect(row(w).rua_address).toBe('');

    expect((await page(w, 1, { kind: 'replace', address: 'mailto:a@x.example' })).status).toBe(200);
    expect(live(w)).toBe(`v=DMARC1; p=quarantine; pct=50; rua=${OURS},mailto:b@y.example; fo=1`);
  });

  it('replace the second', async () => {
    const w = await setup();
    seed(w, 'v=DMARC1; p=quarantine; rua=mailto:a@x.example,mailto:b@y.example');
    expect((await page(w, 1, { kind: 'replace', address: 'mailto:b@y.example' })).status).toBe(200);
    expect(live(w)).toBe(`v=DMARC1; p=quarantine; rua=mailto:a@x.example,${OURS}`);
  });

  it('three addresses: only the first two are offered; replacing one keeps the other two in order, the third is untouched, and the third cannot be replaced', async () => {
    const w = await setup();
    const three = 'v=DMARC1; p=none; rua=mailto:a@x.example,mailto:b@y.example,mailto:c@z.example';
    seed(w, three);
    const o = (await status(w)).review.outcome;
    expect(o.kind).toBe('choose');
    expect(o.existing).toHaveLength(3);
    expect(o.options).toHaveLength(2);
    expect((await page(w, 1, { kind: 'replace', address: 'mailto:c@z.example' })).status).toBe(400);
    expect((await page(w, 1, { kind: 'replace', address: 'mailto:b@y.example' })).status).toBe(200);
    expect(live(w)).toBe(`v=DMARC1; p=none; rua=mailto:a@x.example,${OURS},mailto:c@z.example`);
  });

  it('leaving the record as it is: nothing is written and reports are not connected; the first-run plan says the same and writes nothing', async () => {
    const w = await setup();
    const two = 'v=DMARC1; p=quarantine; rua=mailto:a@x.example,mailto:b@y.example';
    seed(w, two);
    const p = await plan(w, [1]);
    const write = p.steps[0].writes.find((x: any) => x.name === '_dmarc.a-corp.com');
    expect(write).toMatchObject({ action: 'none', content: two });
    expect(write.reason).toBe((await status(w)).review.outcome.reason.length ? write.reason : '');
    expect(write.reason).toMatch(/first two/);
    await firstRun(w, [1]);
    expect(live(w)).toBe(two);
    expect(await status(w)).toMatchObject({ state: 'not_connected', address: null });
  });
});

describe('Cloudflare is the live record; public DNS may lag', () => {
  it('the review uses Cloudflare\'s record, not the one public DNS still shows; after the write the state is "written", not "not_published"', async () => {
    const w = await setup();
    seed(w, `v=DMARC1; p=reject; rua=${THIRD}`);
    w.cf.doh['_dmarc.a-corp.com'] = ['v=DMARC1; p=none']; // public DNS is behind
    const s = await status(w);
    expect(s.review.now).toBe(`v=DMARC1; p=reject; rua=${THIRD}`);
    expect(s.review.source).toBe('cloudflare');
    expect((await page(w, 1, { kind: 'add' })).status).toBe(200);
    expect(live(w)).toBe(`v=DMARC1; p=reject; rua=${THIRD},${OURS}`);
    const after = await status(w);
    expect(after.state).toBe('written');
    expect(after.review.outcome.kind).toBe('present');
    // The apply answers with the same true state.
    w.cf.doh['_dmarc.a-corp.com'] = []; // public DNS shows no record at all
    expect((await status(w)).state).toBe('written');
    // Once public DNS shows it: waiting for the first report.
    w.cf.doh['_dmarc.a-corp.com'] = [live(w)!];
    expect((await status(w)).state).toBe('waiting');
  });

  it('the apply response carries the true resulting state', async () => {
    const w = await setup();
    seed(w, 'v=DMARC1; p=reject;');
    const out = await json(await page(w, 1, { kind: 'add' }));
    expect(out).toMatchObject({ ok: true, wrote: true, status: { state: 'written', address: `rua@${INTAKE}` } });
  });

  it('without a Cloudflare connection the review is read from public DNS, and nothing can be written', async () => {
    const w = await setup();
    w.db.sqlite.prepare('UPDATE domains SET cf_connection_id = NULL WHERE id = 1').run();
    w.cf.doh['_dmarc.a-corp.com'] = ['v=DMARC1; p=reject;'];
    const review = await json(await w.api(w.A.token, 'GET', '/api/domains/1/report-address/review'));
    expect(review).toMatchObject({ source: 'public_dns', now: 'v=DMARC1; p=reject;' });
    const res = await page(w, 1, { kind: 'add' }, review.hash);
    expect(res.status).toBe(409);
    expect((await json(res)).error).toMatch(/No Cloudflare connection/);
    expect(row(w).rua_address).toBe('');
  });

  it('a record with several DMARC records, or an invalid p=, is not written: a true reason, nothing connected', async () => {
    for (const [records, reason] of [[['v=DMARC1; p=none', 'v=DMARC1; p=reject'], /more than one DMARC record/], [['v=DMARC1; p=bogus'], /no valid p=/]] as const) {
      const w = await setup();
      for (const r of records) seed(w, r);
      const o = (await status(w)).review.outcome;
      expect(o).toMatchObject({ kind: 'blocked' });
      expect(o.reason).toMatch(reason);
      const res = await page(w, 1, { kind: 'add' });
      expect(res.status).toBe(409);
      expect(row(w).rua_address).toBe('');
    }
  });
});

describe('parity: the domain page and the first-run review write byte-identical records', () => {
  const CASES: { name: string; id: number; zone?: string; parent?: string; expected: (live: string) => string }[] = [
    { name: 'no record', id: 1, expected: () => `v=DMARC1; p=none; rua=${OURS}` },
    { name: 'p=none', id: 1, zone: 'v=DMARC1; p=none', expected: () => `v=DMARC1; p=none; rua=${OURS}` },
    { name: 'p=reject;', id: 1, zone: 'v=DMARC1; p=reject;', expected: () => `v=DMARC1; p=reject; rua=${OURS}` },
    { name: 'one third-party address', id: 1, zone: `v=DMARC1; p=reject; rua=${THIRD}`, expected: () => `v=DMARC1; p=reject; rua=${THIRD},${OURS}` },
    { name: 'ours already', id: 1, zone: `v=DMARC1; p=reject; rua=${OURS}`, expected: (l) => l },
    { name: 'every other tag', id: 1, zone: `v=DMARC1; p=none; sp=reject; pct=50; rua=${THIRD}; ruf=mailto:f@x.example; fo=1`, expected: () => `v=DMARC1; p=none; sp=reject; pct=50; rua=${THIRD},${OURS}; ruf=mailto:f@x.example; fo=1` },
    { name: 'subdomain without a record of its own', id: 4, parent: 'v=DMARC1; p=reject', expected: () => `v=DMARC1; p=reject; rua=${OURS}` },
    { name: 'no spaces, upper-case tag and address', id: 1, zone: 'v=DMARC1;p=reject;RUA=mailto:Dmarc@ThirdParty.example', expected: () => `v=DMARC1;p=reject;rua=mailto:Dmarc@ThirdParty.example,${OURS}` },
  ];
  for (const c of CASES) {
    it(c.name, async () => {
      const runs: string[] = [];
      for (const entry of ['page', 'first-run'] as const) {
        const w = await setup();
        if (c.zone) seed(w, c.zone, c.id);
        if (c.parent) w.cf.doh['_dmarc.a-corp.com'] = [c.parent];
        if (entry === 'page') expect((await page(w, c.id, { kind: 'add' })).status).toBe(200);
        else expect((await firstRun(w, [c.id])).results[0]).toMatchObject({ ok: true, reports: 'connected' });
        const after = live(w, c.id)!;
        expect(after).toBe(c.expected(c.zone ?? ''));
        expect(row(w, c.id).rua_address).toBe(`rua@${INTAKE}`);
        runs.push(after);
      }
      expect(runs[0]).toBe(runs[1]);
    });
  }

  it('two addresses: the first-run review writes nothing, and offers exactly the options the domain page does', async () => {
    const w = await setup();
    const two = `v=DMARC1; p=quarantine; rua=mailto:a@x.example,mailto:b@y.example`;
    seed(w, two);
    const p = await plan(w, [1]);
    expect(p.steps[0].writes[0]).toMatchObject({ action: 'none', content: two });
    expect(p.steps[0].writes[0].reason).toBe((await status(w)).review.outcome.reason + ' Choose under Connect reports on the domain page.');
    await firstRun(w, [1]);
    expect(live(w)).toBe(two);
  });
});

describe('who may have our address written', () => {
  const seedPlain = (w: World) => seed(w, 'v=DMARC1; p=reject;');

  it('an unproven (legacy) domain: the page route is refused with 403 and the connect panel\'s words; the first-run plan writes the record without our address', async () => {
    const w = await setup();
    seedPlain(w);
    w.db.sqlite.prepare("UPDATE domains SET verified_via = 'legacy' WHERE id = 1").run();
    const res = await page(w, 1, { kind: 'add' }, 'whatever');
    expect(res.status).toBe(403);
    expect((await json(res)).error).toMatch(/Ownership of a-corp\.com is not proven/);
    expect(live(w)).toBe('v=DMARC1; p=reject;');
    expect((await status(w)).review).toBeNull();
    const p = await plan(w, [1]);
    expect(JSON.stringify(p)).not.toContain(`rua@${INTAKE}`);
    await firstRun(w, [1]);
    expect(live(w)).not.toContain(INTAKE);
    expect(row(w).rua_address).toBe('');
  });

  it('proof lost: refused, nothing written', async () => {
    const w = await setup();
    seedPlain(w);
    w.db.sqlite.prepare("UPDATE domains SET verified_via = 'legacy', proof_lost_at = 1 WHERE id = 1").run();
    expect((await page(w, 1, { kind: 'add' }, 'x')).status).toBe(403);
    expect(live(w)).toBe('v=DMARC1; p=reject;');
  });

  it('a workspace HOSTED_CONNECT_REPORTS does not admit: refused on the page route, no address on the first-run route', async () => {
    const w = await setup({ HOSTED_CONNECT_REPORTS: 'owner', OWNER_EMAIL: 'someone-else@example.com' });
    seedPlain(w);
    const res = await page(w, 1, { kind: 'add' }, 'x', w.admin);
    expect(res.status).toBe(403);
    expect((await json(res)).error).toMatch(/only the operator/);
    await w.api(w.admin, 'POST', '/api/onboarding/dns-apply', { domain_ids: [1], step: 'dmarc', plan_id: (await json(await w.api(w.admin, 'POST', '/api/onboarding/dns-plan', { domain_ids: [1] }))).plan_id });
    expect(live(w)).not.toContain(INTAKE);
    expect(row(w).rua_address).toBe('');
  });

  it('a read-only member is refused by the router before the function runs', async () => {
    const w = await setup();
    seedPlain(w);
    const res = await w.api(w.member, 'POST', '/api/domains/1/report-address/apply', { reviewed: 'x', choice: { kind: 'add' } });
    expect(res.status).toBe(403);
    expect(live(w)).toBe('v=DMARC1; p=reject;');
  });

  it('a domain whose reports come through hosted records is left alone', async () => {
    const w = await setup();
    seedPlain(w);
    w.db.sqlite.prepare("INSERT INTO hosted_domains (domain_id, workspace_id, hosted_id, zone_key) VALUES (1, ?, 'h1', 'z')").run(w.A.ws);
    const res = await page(w, 1, { kind: 'add' }, 'x');
    expect(res.status).toBe(409);
  });
});
