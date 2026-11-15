// Round-2 review probes for PR 173 at 851654f. Prints what it measured.
import { describe, it, vi, beforeEach, afterEach } from 'vitest';
import { createResolver } from '@ready-set-mail/dns-checks';
import { call, signupVerified } from '../auth/helpers';
import { world } from './world';
import { checkDelegation, recheckZoneProofs } from '../../src/domains/proof-recheck';
import { attributeReport, fixedReportAddress } from '../../src/hosted/fixed-address';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));
beforeEach(() => { for (const m of ['warn', 'log', 'error', 'info'] as const) vi.spyOn(console, m).mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const out = (label: string, v: unknown) => process.stdout.write(`PROBE ${label}: ${JSON.stringify(v)}\n`);
const json = async (r: Response) => await r.json() as any;
const zid = (n: string) => Buffer.from(n).toString('hex').padEnd(32, '0').slice(0, 32);
const CONNECTIONS = '/api/cloudflare/connections';
const INTAKE = 'rua.intake.example.net';
const CF = ['a.ns.cloudflare.com', 'b.ns.cloudflare.com'];

async function setup(zones: Record<string, { account?: string; nameServers?: string[] }>, extraEnv: Record<string, unknown> = {}) {
  const w = await world({ INTAKE_DOMAIN: INTAKE, HOSTED_CONNECT_REPORTS: 'all', ...extraEnv });
  const token = await signupVerified(w.env, 'c@example.com');
  const ws = w.rows('SELECT m.workspace_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ?', 'c@example.com')[0].workspace_id as string;
  for (const k of Object.keys(w.cf.zones)) delete w.cf.zones[k];
  for (const [name, z] of Object.entries(zones)) w.cf.zones[name] = { id: zid(name), cfAccountId: z.account ?? 'acct-1', cfAccountName: 'Example Co', nameServers: z.nameServers };
  w.cf.accounts = [{ id: 'acct-1', name: 'Example Co' }];
  const C = { token, ws };
  const connect = async (as = C.token, secret = 'secret-token-aaaaaaaaaaaa-1') => (await w.addToken(as, secret)).id;
  const imp = (id: string, body?: unknown, as = C.token) => w.api(as, 'POST', `${CONNECTIONS}/${id}/import`, body);
  const rows = (wsId: string) => w.rows('SELECT domain, verified_via, evicted_at IS NOT NULL AS evicted, proof_lost_at IS NOT NULL AS lost FROM domains WHERE workspace_id = ? ORDER BY domain', wsId);
  return { w, C, connect, imp, rows };
}
function overrideNs(answers: Record<string, unknown>) {
  const prev = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: any, init?: any) => {
    const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (u.pathname.endsWith('/dns-query') || u.pathname.endsWith('/resolve')) {
      const name = (u.searchParams.get('name') ?? '').toLowerCase();
      if ((u.searchParams.get('type') ?? '').toUpperCase() === 'NS' && answers[name]) return new Response(JSON.stringify(answers[name]), { status: 200 });
    }
    return prev(input, init);
  });
}

describe('round-1 probes, re-run', () => {
  it('R1 CNAME at the zone name; partial NS set; misleading skip reason; full-plan eviction', async () => {
    const s = await setup({ 'shop.victim.com': { nameServers: ['x.ns.cloudflare.com', 'y.ns.cloudflare.com'] }, 'half.com': {}, 'victim2.com': {} });
    overrideNs({
      'shop.victim.com': { Status: 0, Answer: [{ name: 'shop.victim.com.', type: 5, data: 'attacker.com.' }, { name: 'attacker.com.', type: 2, data: 'x.ns.cloudflare.com.' }, { name: 'attacker.com.', type: 2, data: 'y.ns.cloudflare.com.' }] },
      'half.com': { Status: 0, Answer: [{ name: 'half.com.', type: 2, data: 'a.ns.cloudflare.com.' }] },
    });
    s.w.db.sqlite.prepare("INSERT INTO domains (workspace_id, domain, rua_address, verified_via) VALUES (?, 'mail.victim2.com', '', 'txt')").run(s.w.B.ws);
    const id = await s.connect();
    const res = await json(await s.imp(id));
    out('R1 imported', res.imported.map((i: any) => i.domain));
    out('R1 skipped', res.skipped);
  });
  it('R2 full plan + pending claim on a legacy holder: nobody evicted', async () => {
    const s = await setup({ 'f1.com': {}, 'f2.com': {}, 'a-corp.com': {} }, { MAX_DOMAINS_PER_WORKSPACE: '2' });
    await call(s.w.env, 'POST', '/api/domains', { key: s.C.token, body: { domain: 'a-corp.com' } });
    const id = await s.connect();
    await s.imp(id, { zone_ids: [zid('f1.com'), zid('f2.com')] });
    await s.w.api(s.C.token, 'PUT', `${CONNECTIONS}/${id}/zones`, { zone_ids: [zid('f1.com'), zid('f2.com'), zid('a-corp.com')] });
    out('R2 A rows', s.rows(s.w.A.ws));
    out('R2 emails', s.w.send.mock.calls.length);
  });
  it('R3 onboarding-status without and with Cloudflare, owner vs all', async () => {
    for (const mode of ['all', 'owner']) {
      const w = await world({ INTAKE_DOMAIN: INTAKE, HOSTED_CONNECT_REPORTS: mode });
      w.db.sqlite.prepare("UPDATE domains SET verified_via = 'txt', rua_address = ''").run();
      const st = await json(await w.api(w.B.token, 'GET', '/api/domains/3/onboarding-status'));
      out(`R3 ${mode} B no-CF`, { rua: st.rua_address, offered: st.offered_rua_address, cf: st.cf_available });
      await w.addToken(w.A.token, 'secret-token-aaaaaaaaaaaa-9');
      const sa = await json(await w.api(w.A.token, 'GET', '/api/domains/1/onboarding-status'));
      out(`R3 ${mode} A with-CF`, { rua: sa.rua_address, offered: sa.offered_rua_address, cf: sa.cf_available });
    }
  });
});

describe('rival-claim re-check', () => {
  async function owned() {
    const s = await setup({ 'sold.com': {} });
    const idC = await s.connect();
    await s.imp(idC);
    s.w.send.mockClear();
    return s;
  }
  it('N1 the domain moves away (new account, new NS); rival imports', async () => {
    for (const revoked of [false, true]) {
      const s = await owned();
      if (revoked) s.w.cf.validTokens!.delete('secret-token-aaaaaaaaaaaa-1');
      s.w.cf.zones['sold.com'] = { id: zid('sold-new'), cfAccountId: 'acct-b', cfAccountName: 'New', nameServers: ['n1.ns.cloudflare.com', 'n2.ns.cloudflare.com'] };
      const idB = await s.connect(s.w.B.token, 'secret-token-bbbbbbbbbbbb-1');
      const r = await json(await s.imp(idB, undefined, s.w.B.token));
      out(`N1 revoked=${revoked} B`, [r.imported.map((i: any) => i.domain), r.skipped.map((k: any) => k.reason.slice(0, 40))]);
      out(`N1 revoked=${revoked} C`, s.rows(s.C.ws));
      out(`N1 revoked=${revoked} mails`, s.w.send.mock.calls.map((c: any[]) => c[0].subject));
    }
  });
  it('N2 rival triggers the re-check while the holder\'s NS lookup fails (SERVFAIL / timeout-like / NODATA / NXDOMAIN / truncated subset)', async () => {
    for (const [label, body] of [['servfail', { Status: 2 }], ['nodata', { Status: 0 }], ['nxdomain', { Status: 3 }], ['tc-subset', { Status: 0, TC: true, Answer: [{ name: 'sold.com.', type: 2, data: 'a.ns.cloudflare.com.' }] }], ['mixedcase-dot', { Status: 0, Answer: [{ name: 'SOLD.Com.', type: 2, data: 'A.NS.CLOUDFLARE.COM.' }, { name: 'sold.com', type: 2, data: 'b.ns.cloudflare.com' }] }]] as const) {
      const s = await owned();
      s.w.cf.validTokens!.delete('secret-token-aaaaaaaaaaaa-1'); // holder token revoked: DNS is the only evidence
      overrideNs({ 'sold.com': body });
      const r = await call(s.w.env, 'POST', '/api/domains', { key: s.w.B.token, body: { domain: 'sold.com' } });
      out(`N2 ${label}`, { rival: r.status, holder: s.rows(s.C.ws), mails: s.w.send.mock.calls.length });
    }
  });
  it('N3 holder moved the zone between its OWN Cloudflare accounts (old token still valid), then tries to re-prove', async () => {
    const s = await owned();
    s.w.cf.zones['sold.com'] = { id: zid('sold-acct2'), cfAccountId: 'acct-2', cfAccountName: 'Own second', nameServers: ['m1.ns.cloudflare.com', 'm2.ns.cloudflare.com'] };
    const rival = await call(s.w.env, 'POST', '/api/domains', { key: s.w.B.token, body: { domain: 'sold.com' } });
    out('N3 rival status', rival.status);
    out('N3 holder', s.rows(s.C.ws));
    out('N3 mail', s.w.send.mock.calls.map((c: any[]) => c[0].text.slice(0, 600)));
    const again = await call(s.w.env, 'POST', '/api/domains', { key: s.C.token, body: { domain: 'sold.com' } });
    out('N3 holder re-add status', [again.status, (await again.text()).slice(0, 160)]);
    const did = s.w.rows("SELECT id FROM domains WHERE domain = 'sold.com'")[0].id;
    s.w.db.sqlite.prepare("INSERT INTO aggregate_reports (domain_id, org_name, report_id, date_begin, date_end, total_count, pass_count, fail_count) VALUES (?, 'g', 'r1', 1, 2, 5, 5, 0)").run(did);
    await call(s.w.env, 'DELETE', `/api/domains/${did}`, { key: s.C.token });
    out('N3 reports left after remove (mail says history stays)', s.w.rows('SELECT COUNT(*) AS n FROM aggregate_reports WHERE domain_id = ?', did));
  });
});

describe('daily job', () => {
  function seed(w: any, n: number, prefix: string, ws: string) {
    const ins = w.db.sqlite.prepare("INSERT INTO domains (workspace_id, domain, rua_address, verified_via, cf_zone_id, cf_zone_name, cf_name_servers) VALUES (?, ?, '', 'cloudflare', ?, ?, ?)");
    for (let i = 0; i < n; i++) { const d = `${prefix}${i}.com`; ins.run(ws, d, zid(d), d, JSON.stringify(CF)); }
  }
  it('N4 200 attacker rows whose lookups SERVFAIL starve a moved-away domain', async () => {
    const w = await world({ INTAKE_DOMAIN: INTAKE });
    seed(w, 200, 'stall', w.B.ws);
    w.db.sqlite.prepare("INSERT INTO domains (workspace_id, domain, rua_address, verified_via, cf_zone_id, cf_zone_name, cf_name_servers, proof_checked_at) VALUES (?, 'moved.com', '', 'cloudflare', 'zz', 'moved.com', ?, 1)").run(w.A.ws, JSON.stringify(CF));
    const resolver = { resolve: async (name: string) => name.startsWith('stall') ? { status: 'error', answers: [], error: 'SERVFAIL' } : { status: 'ok', answers: [{ name, type: 2, ttl: 1, data: 'other.provider.net' }] }, txt: async () => ({ status: 'error', records: [] }), fetch: globalThis.fetch } as any;
    for (let day = 1; day <= 3; day++) {
      const r = await recheckZoneProofs(w.env, { resolver });
      out(`N4 day${day}`, { ...r, moved: w.rows("SELECT verified_via FROM domains WHERE domain = 'moved.com'")[0] });
    }
  });
  it('N5 250 healthy rows + one moved: covered across days?', async () => {
    const w = await world({ INTAKE_DOMAIN: INTAKE });
    seed(w, 250, 'ok', w.B.ws);
    w.db.sqlite.prepare("INSERT INTO domains (workspace_id, domain, rua_address, verified_via, cf_zone_id, cf_zone_name, cf_name_servers) VALUES (?, 'zmoved.com', '', 'cloudflare', 'zz', 'zmoved.com', ?)").run(w.A.ws, JSON.stringify(CF));
    const resolver = { resolve: async (name: string) => ({ status: 'ok', answers: (name === 'zmoved.com' ? ['other.net'] : CF).map(d => ({ name, type: 2, ttl: 1, data: d })) }), txt: async () => ({ status: 'error', records: [] }), fetch: globalThis.fetch } as any;
    let t = 1_800_000_000_000;
    for (let day = 1; day <= 2; day++) {
      const r = await recheckZoneProofs(w.env, { resolver, now: () => (t += 86_400_000) });
      out(`N5 day${day}`, { ...r, moved: w.rows("SELECT verified_via FROM domains WHERE domain = 'zmoved.com'")[0] });
    }
  });
  it('N6 pre-PR zone proofs (no stored servers) whose token is gone: never re-checkable; and they sit at the head of the queue', async () => {
    const w = await world({ INTAKE_DOMAIN: INTAKE });
    const ins = w.db.sqlite.prepare("INSERT INTO domains (workspace_id, domain, rua_address, verified_via, cf_zone_id) VALUES (?, ?, '', 'cloudflare', ?)");
    for (let i = 0; i < 200; i++) ins.run(w.B.ws, `old${i}.com`, zid(`old${i}`));
    w.db.sqlite.prepare("INSERT INTO domains (workspace_id, domain, rua_address, verified_via, cf_zone_id, cf_zone_name, cf_name_servers, proof_checked_at) VALUES (?, 'moved.com', '', 'cloudflare', 'zz', 'moved.com', ?, 1)").run(w.A.ws, JSON.stringify(CF));
    const resolver = { resolve: async (name: string) => ({ status: 'ok', answers: [{ name, type: 2, ttl: 1, data: 'other.net' }] }), txt: async () => ({ status: 'error', records: [] }), fetch: globalThis.fetch } as any;
    for (let day = 1; day <= 2; day++) { const r = await recheckZoneProofs(w.env, { resolver }); out(`N6 day${day}`, { ...r, moved: w.rows("SELECT verified_via FROM domains WHERE domain = 'moved.com'")[0] }); }
    // and a rival claim on a pre-PR, token-less proof
    const rival = await call(w.env, 'POST', '/api/domains', { key: w.A.token, body: { domain: 'old0.com' } });
    out('N6 rival on old0.com', rival.status);
  });
});

describe('intake after downgrade', () => {
  it('N7 fixed-address attribution before/after the proof is lost', async () => {
    const s = await setup({ 'sold.com': {} });
    const id = await s.connect();
    await s.imp(id);
    s.w.db.sqlite.prepare('UPDATE domains SET rua_address = ? WHERE domain = ?').run(fixedReportAddress(INTAKE), 'sold.com');
    const before = await attributeReport(s.w.env, INTAKE, 'sold.com');
    const sub = await attributeReport(s.w.env, INTAKE, 'mail.sold.com');
    s.w.cf.zones['sold.com'] = { id: zid('sold-new'), cfAccountId: 'acct-b', cfAccountName: 'New', nameServers: ['n1.ns.cloudflare.com', 'n2.ns.cloudflare.com'] };
    await call(s.w.env, 'POST', '/api/domains', { key: s.w.B.token, body: { domain: 'sold.com' } });
    const after = await attributeReport(s.w.env, INTAKE, 'sold.com');
    const afterSub = await attributeReport(s.w.env, INTAKE, 'mail.sold.com');
    out('N7', { before: !!before, sub: !!sub, after, afterSub, rows: s.w.rows("SELECT workspace_id = ? AS is_c, verified_via, evicted_at IS NOT NULL AS ev FROM domains WHERE domain = 'sold.com' OR evicted_name = 'sold.com'", s.C.ws) });
  });
});

describe('resolver tricks against checkDelegation', () => {
  it('N8', async () => {
    const mk = (body: unknown) => createResolver({ fetch: async () => ({ ok: true, status: 200, json: async () => body }) as any });
    const cases: Record<string, unknown> = {
      exact: { Status: 0, Answer: CF.map(d => ({ name: 'z.com.', type: 2, data: `${d}.` })) },
      dname: { Status: 0, Answer: [{ name: 'z.com.', type: 39, data: 'evil.net.' }, ...CF.map(d => ({ name: 'evil.net.', type: 2, data: d }))] },
      mixedCaseNoDot: { Status: 0, Answer: CF.map(d => ({ name: 'Z.COM', type: 2, data: d.toUpperCase() })) },
      extraForeignOwner: { Status: 0, Answer: [...CF.map(d => ({ name: 'z.com.', type: 2, data: d })), { name: 'x.z.com.', type: 2, data: 'ns.other.' }] },
      duplicateOne: { Status: 0, Answer: [{ name: 'z.com.', type: 2, data: CF[0] }, { name: 'z.com.', type: 2, data: CF[0] }] },
      superset: { Status: 0, Answer: [...CF, 'ns3.other.net'].map(d => ({ name: 'z.com.', type: 2, data: d })) },
      noName: { Status: 0, Answer: CF.map(d => ({ type: 2, data: d })) },
      servfailAD: { Status: 2, AD: false },
    };
    const res: Record<string, string> = {};
    for (const [k, b] of Object.entries(cases)) res[k] = await checkDelegation(mk(b), 'z.com', CF);
    out('N8', res);
  });
});
