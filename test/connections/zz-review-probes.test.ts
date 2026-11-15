// Independent review probes for PR 173. Each test PRINTS what it measured (console.info is muted by world tests, so use process.stdout).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { call, signupVerified, inviteAndAccept } from '../auth/helpers';
import { world } from './world';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

beforeEach(() => { for (const m of ['warn', 'log', 'error', 'info'] as const) vi.spyOn(console, m).mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const out = (label: string, v: unknown) => process.stdout.write(`PROBE ${label}: ${JSON.stringify(v)}\n`);
const json = async (r: Response) => await r.json() as any;
const zid = (n: string) => Buffer.from(n).toString('hex').padEnd(32, '0').slice(0, 32);
const CONNECTIONS = '/api/cloudflare/connections';

async function setup(zones: Record<string, { account?: string; status?: string; type?: string; nameServers?: string[] }>, extraEnv: Record<string, unknown> = {}) {
  const w = await world(extraEnv);
  const token = await signupVerified(w.env, 'c@example.com');
  const ws = w.rows('SELECT m.workspace_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ?', 'c@example.com')[0].workspace_id as string;
  for (const k of Object.keys(w.cf.zones)) delete w.cf.zones[k];
  for (const [name, z] of Object.entries(zones)) w.cf.zones[name] = { id: zid(name), cfAccountId: z.account ?? 'acct-1', cfAccountName: 'Example Co', status: z.status, type: z.type, nameServers: z.nameServers };
  w.cf.accounts = [{ id: 'acct-1', name: 'Example Co' }];
  const C = { token, ws };
  const connect = async (as = C.token, secret = 'secret-token-aaaaaaaaaaaa-1') => (await w.addToken(as, secret)).id;
  const imp = (id: string, body?: unknown, as = C.token) => w.api(as, 'POST', `${CONNECTIONS}/${id}/import`, body);
  const domainsOf = (wsId: string) => w.rows('SELECT domain, verified_via, evicted_at FROM domains WHERE workspace_id = ? ORDER BY domain', wsId);
  return { w, C, connect, imp, domainsOf };
}

/** Wrap the stubbed global fetch so specific DoH NS questions get a hand-written answer (owner names included, as real DoH gives). */
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

describe('item 1: zone states and delegation', () => {
  it('P1a CNAME at the zone name: NS answers of the CNAME target are accepted as the zone delegation', async () => {
    // Attacker C holds a (sub)zone shop.victim.com in their own Cloudflare account, same NS pair as their other zone attacker.com.
    const s = await setup({ 'shop.victim.com': { nameServers: ['x.ns.cloudflare.com', 'y.ns.cloudflare.com'] } });
    // Public DNS: the victim's victim.com zone has `shop CNAME attacker.com`; a recursive NS query follows it.
    overrideNs({ 'shop.victim.com': { Status: 0, Answer: [
      { name: 'shop.victim.com.', type: 5, TTL: 300, data: 'attacker.com.' },
      { name: 'attacker.com.', type: 2, TTL: 300, data: 'x.ns.cloudflare.com.' },
      { name: 'attacker.com.', type: 2, TTL: 300, data: 'y.ns.cloudflare.com.' },
    ] } });
    const id = await s.connect();
    const res = await json(await s.imp(id));
    out('P1a imported', res.imported?.map((i: any) => i.domain));
    out('P1a skipped', res.skipped);
    out('P1a C domains', s.domainsOf(s.C.ws));
  });

  it('P1b partial public NS (one of the two) still proves; empty/NXDOMAIN/SERVFAIL do not', async () => {
    const s = await setup({ 'half.com': {}, 'nx.com': {}, 'fail.com': {} });
    overrideNs({
      'half.com': { Status: 0, Answer: [{ name: 'half.com.', type: 2, data: 'a.ns.cloudflare.com.' }] },
      'nx.com': { Status: 3 },
      'fail.com': { Status: 2 },
    });
    const id = await s.connect();
    const res = await json(await s.imp(id));
    out('P1b imported', res.imported?.map((i: any) => i.domain));
    out('P1b skipped', res.skipped?.map((k: any) => k.domain));
  });

  it('P1c a subdomain delegated elsewhere is still proven by the parent zone', async () => {
    const s = await setup({ 'example.com': {} });
    overrideNs({ 'sub.example.com': { Status: 0, Answer: [{ name: 'sub.example.com.', type: 2, data: 'ns1.other-provider.test.' }] } });
    const id = await s.connect();
    await s.imp(id);
    const r = await call(s.w.env, 'POST', '/api/domains', { key: s.C.token, body: { domain: 'sub.example.com' } });
    out('P1c status', r.status);
    out('P1c C domains', s.domainsOf(s.C.ws));
  });

  it('P1d pending / moved zones are not listed; a zone in another account than the connection records is refused', async () => {
    const s = await setup({ 'p.com': { status: 'pending' }, 'm.com': { status: 'moved' }, 'ok.com': {}, 'other.com': { account: 'acct-evil' } });
    const id = await s.connect();
    const res = await json(await s.imp(id));
    out('P1d imported', res.imported?.map((i: any) => i.domain));
    out('P1d skipped', res.skipped?.map((k: any) => k.domain));
  });
});

describe('item 2: trust boundaries', () => {
  it('P2a IDOR: another workspace imports through C\'s connection id; a member of C calls import', async () => {
    const s = await setup({ 'one.com': {} });
    const id = await s.connect();
    const asB = await s.imp(id, undefined, s.w.B.token);
    out('P2a B->C import status', asB.status);
    const member = await inviteAndAccept(s.w.env, s.C.token, 'mem-c@example.com', 'member');
    const asMember = await s.imp(id, undefined, member);
    out('P2a member import status', asMember.status);
    const memberSug = await s.w.api(member, 'GET', '/api/cloudflare/suggestions');
    out('P2a member suggestions status', memberSug.status);
    out('P2a C domains', s.domainsOf(s.C.ws));
  });

  it('P2b names from the browser: casing, trailing dot, punycode vs unicode, a wildcard, an over-long name', async () => {
    const s = await setup({ 'one.com': {}, 'xn--bcher-kva.example': {} });
    const id = await s.connect();
    await s.w.api(s.C.token, 'PUT', `${CONNECTIONS}/${id}/zones`, { zone_ids: [zid('one.com'), zid('xn--bcher-kva.example')] });
    for (const d of ['SHOP.One.COM.', 'mail.one.com.', 'bücher.example', '*.one.com', `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(50)}.one.com`]) {
      const r = await call(s.w.env, 'POST', '/api/domains', { key: s.C.token, body: { domain: d } });
      out(`P2b ${d.slice(0, 30)} status`, [r.status, (await r.text()).slice(0, 160)]);
    }
    out('P2b C domains', s.domainsOf(s.C.ws));
    const bad = await s.imp(id, { zone_ids: [zid('one.com').toUpperCase()] });
    out('P2b uppercase zone id status', bad.status);
  });
});

describe('item 3: public suffix, label boundary, conflicts, races', () => {
  it('P3a zones named like public suffixes (ICANN and private) are not imported and prove nothing under them', async () => {
    const s = await setup({ 'co.uk': {}, 'pages.dev': {}, 'github.io': {}, 'workers.dev': {}, 'example.co.uk': {} });
    const id = await s.connect();
    const res = await json(await s.imp(id));
    out('P3a imported', res.imported?.map((i: any) => i.domain));
    out('P3a skipped', res.skipped?.map((k: any) => k.domain));
    const sug = await json(await s.w.api(s.C.token, 'GET', '/api/cloudflare/suggestions'));
    out('P3a suggestions', sug.suggestions?.map((x: any) => x.name));
    for (const d of ['victim.pages.dev', 'notexample.co.uk', 'x.example.co.uk']) {
      const r = await call(s.w.env, 'POST', '/api/domains', { key: s.C.token, body: { domain: d } });
      out(`P3a add ${d}`, r.status);
    }
    out('P3a C domains', s.domainsOf(s.C.ws));
  });

  it('P3b conflicts both directions with another workspace\'s verified (txt) names', async () => {
    const s = await setup({ 'victim.com': {}, 'shop.target.org': {}, 'same.net': {} });
    const ins = s.w.db.sqlite.prepare("INSERT INTO domains (workspace_id, domain, rua_address, verified_via) VALUES (?, ?, '', 'txt')");
    ins.run(s.w.B.ws, 'mail.victim.com'); ins.run(s.w.B.ws, 'target.org'); ins.run(s.w.B.ws, 'same.net');
    const id = await s.connect();
    const res = await json(await s.imp(id));
    out('P3b imported', res.imported?.map((i: any) => i.domain));
    out('P3b skipped', res.skipped);
    out('P3b B domains', s.domainsOf(s.w.B.ws));
  });

  it('P3c race: two workspaces import the same zone name at once', async () => {
    const s = await setup({ 'race.com': {} });
    const idC = await s.connect();
    const idB = await s.connect(s.w.B.token, 'secret-token-bbbbbbbbbbbb-1');
    const [rc, rb] = await Promise.all([s.imp(idC), s.imp(idB, undefined, s.w.B.token)]);
    const jc = await json(rc), jb = await json(rb);
    out('P3c C', [rc.status, jc.imported?.map((i: any) => i.domain), jc.skipped]);
    out('P3c B', [rb.status, jb.imported?.map((i: any) => i.domain), jb.skipped]);
    out('P3c rows', s.w.rows("SELECT workspace_id = ? AS is_c, verified_via FROM domains WHERE domain = 'race.com'", s.C.ws));
  });
});

describe('item 4: persistence after the zone leaves', () => {
  it('P4 zone deleted from C\'s account and re-added by D: D is refused, C keeps the domain', async () => {
    const s = await setup({ 'sold.com': {} });
    const idC = await s.connect();
    await s.imp(idC);
    // C revokes, the domain is sold: the zone now lives in B's Cloudflare account, delegated to B.
    s.w.cf.validTokens!.delete('secret-token-aaaaaaaaaaaa-1');
    s.w.cf.zones['sold.com'] = { id: zid('sold.com-new'), cfAccountId: 'acct-b', cfAccountName: 'New owner', nameServers: ['n1.ns.cloudflare.com', 'n2.ns.cloudflare.com'] };
    const idB = await s.connect(s.w.B.token, 'secret-token-bbbbbbbbbbbb-1');
    const res = await json(await s.imp(idB, undefined, s.w.B.token));
    out('P4 B import', [res.imported?.map((i: any) => i.domain), res.skipped]);
    const txt = await call(s.w.env, 'POST', '/api/domains', { key: s.w.B.token, body: { domain: 'sold.com' } });
    out('P4 B add by TXT status', [txt.status, (await txt.text()).slice(0, 200)]);
    out('P4 C domains', s.domainsOf(s.C.ws));
  });
});

describe('item 5: side effects', () => {
  it('P5a parallel imports through two connections under a cap of 3', async () => {
    const s = await setup({ 'a1.com': {}, 'a2.com': {}, 'a3.com': {} }, { MAX_DOMAINS_PER_WORKSPACE: '3' });
    const one = await s.connect(s.C.token, 'secret-token-aaaaaaaaaaaa-1');
    const two = await s.connect(s.C.token, 'secret-token-aaaaaaaaaaaa-2');
    s.w.db.sqlite.prepare("INSERT INTO domains (workspace_id, domain, rua_address, verified_via) VALUES (?, 'held.org', '', 'txt')").run(s.C.ws);
    const rs = await Promise.all([s.imp(one), s.imp(two), s.imp(one, { zone_ids: [zid('a1.com'), zid('a2.com')] })]);
    out('P5a statuses', rs.map(r => r.status));
    out('P5a count', s.domainsOf(s.C.ws).length);
  });

  it('P5b a full plan: verifying a pending claim evicts another workspace\'s legacy holder although the insert then fails', async () => {
    const s = await setup({ 'f1.com': {}, 'f2.com': {}, 'a-corp.com': {} }, { MAX_DOMAINS_PER_WORKSPACE: '2' });
    // C claims a-corp.com first (A holds it as an unproven legacy row in the world).
    const claim = await call(s.w.env, 'POST', '/api/domains', { key: s.C.token, body: { domain: 'a-corp.com' } });
    out('P5b claim status', claim.status);
    const id = await s.connect();
    const r = await json(await s.imp(id, { zone_ids: [zid('f1.com'), zid('f2.com')] }));
    out('P5b first import', r.imported?.map((i: any) => i.domain));
    const before = s.domainsOf(s.w.A.ws);
    const put = await s.w.api(s.C.token, 'PUT', `${CONNECTIONS}/${id}/zones`, { zone_ids: [zid('f1.com'), zid('f2.com'), zid('a-corp.com')] });
    out('P5b PUT', [put.status, (await json(put)).verified_claims]);
    out('P5b A before', before);
    out('P5b A after', s.domainsOf(s.w.A.ws));
    out('P5b C after', s.domainsOf(s.C.ws));
    out('P5b eviction emails', s.w.send.mock.calls.length);
    out('P5b audit evicted', s.w.rows("SELECT resource_name FROM audit_log WHERE action = 'domain.evicted'"));
  });

  it('P5c cost of one import request of 10 zones (Cloudflare + DoH calls), and 60 zones in self-host', async () => {
    const zones: Record<string, {}> = {};
    for (let i = 0; i < 10; i++) zones[`z${i}.com`] = {};
    const s = await setup(zones);
    const id = await s.connect();
    let n = 0, cfN = 0, dohN = 0;
    const prev = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: any, init?: any) => { n++; const u = String(typeof input === 'string' ? input : input.url ?? input); if (/dns-query|resolve\?/.test(u)) dohN++; else cfN++; return prev(input, init); });
    const t0 = Date.now();
    const res = await json(await s.imp(id));
    out('P5c saas 10 zones', { imported: res.imported?.length, fetches: n, cf: cfN, doh: dohN, ms: Date.now() - t0 });
  });

  it('P5d removed-domain memory is per workspace; a removed name re-imported by explicit id', async () => {
    const s = await setup({ 'one.com': {} });
    const id = await s.connect();
    await s.imp(id);
    const did = s.w.rows("SELECT id FROM domains WHERE domain = 'one.com'")[0].id;
    await call(s.w.env, 'DELETE', `/api/domains/${did}`, { key: s.C.token });
    out('P5d removed rows', s.w.rows('SELECT workspace_id = ? AS is_c, domain FROM removed_domains', s.C.ws));
    const idB = await s.connect(s.w.B.token, 'secret-token-bbbbbbbbbbbb-1');
    const rb = await json(await s.imp(idB, undefined, s.w.B.token));
    out('P5d B auto-import of the name C removed', rb.imported?.map((i: any) => i.domain));
  });
});

describe('item 6: hosted report address offered before connecting', () => {
  it('P6 onboarding-status shows the fixed address for an unconnected TXT domain without Cloudflare', async () => {
    const w = await world({ INTAKE_DOMAIN: 'rua.intake.example.net', HOSTED_CONNECT_REPORTS: 'all' });
    w.db.sqlite.prepare("UPDATE domains SET verified_via = 'txt', rua_address = '' WHERE id = 3").run(); // B's b-corp.org, no connection
    w.cf.doh['_dmarc.b-corp.org'] = ['v=DMARC1; p=none; rua=mailto:rua@rua.intake.example.net'];
    const st = await json(await w.api(w.B.token, 'GET', '/api/domains/3/onboarding-status'));
    out('P6 status', { rua_address: st.rua_address, cf_available: st.cf_available, has_our_rua: st.dmarc?.has_our_rua, current: st.dmarc?.current_record });
    const ra = await json(await w.api(w.B.token, 'GET', '/api/domains/3/report-address'));
    out('P6 report-address', { state: ra.state, address: ra.address, can_connect: ra.can_connect });
    out('P6 stored', w.rows('SELECT rua_address FROM domains WHERE id = 3'));
  });
  it('P6b HOSTED_CONNECT_REPORTS=owner: an ordinary workspace is not shown the address', async () => {
    const w = await world({ INTAKE_DOMAIN: 'rua.intake.example.net', HOSTED_CONNECT_REPORTS: 'owner' });
    w.db.sqlite.prepare("UPDATE domains SET verified_via = 'txt', rua_address = '' WHERE id = 3").run();
    const st = await json(await w.api(w.B.token, 'GET', '/api/domains/3/onboarding-status'));
    out('P6b rua_address', st.rua_address);
  });
});
