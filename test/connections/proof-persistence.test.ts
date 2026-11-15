// A Cloudflare zone proof is not permanent: another workspace that proves the name makes the holder show it still holds it, and a daily job
// compares public DNS with the name servers stored at the proof (src/domains/ownership.ts, src/domains/proof-recheck.ts). Also: the NS check
// follows no CNAME and wants the zone's exact set; a full plan evicts nobody; the import says why a zone was refused.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { intakeLookups } from '@ready-set-mail/db';
import { call, signupVerified } from '../auth/helpers';
import { CF_NS } from '../helpers/cf-fake';
import { world } from './world';
import { recheckZoneProofs, RECHECK_PER_RUN } from '../../src/domains/proof-recheck';
import { importZones } from '../../src/connections/import';
import { loadTenant } from '../../src/tenancy/load';
import { admitByZone } from '../../src/domains/ownership';
import { commitVerifiedDomain } from '../../src/domains/service';
import { hashToken } from '../../src/hosted/tokens';
import { fixedReportAddress } from '../../src/hosted/fixed-address';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

beforeEach(() => { for (const m of ['warn', 'log', 'error', 'info'] as const) vi.spyOn(console, m).mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const json = async (r: Response) => await r.json() as any;
const zid = (n: string) => Buffer.from(n).toString('hex').padEnd(32, '0').slice(0, 32);
const CONNECTIONS = '/api/cloudflare/connections';
const INTAKE = 'rua.intake.example.net';
const TOKEN_C = 'secret-token-aaaaaaaaaaaa-1';
const TOKEN_B = 'secret-token-bbbbbbbbbbbb-1';
const MOVED_NS = ['n1.ns.cloudflare.com', 'n2.ns.cloudflare.com'];

/** Workspace C (nothing in it) and a Cloudflare that holds exactly `zones`. B is the world's second workspace. */
async function setup(zones: Record<string, { account?: string; status?: string; type?: string; nameServers?: string[] }>, extraEnv: Record<string, unknown> = {}) {
  const w = await world({ INTAKE_DOMAIN: INTAKE, ...extraEnv });
  const token = await signupVerified(w.env, 'c@example.com');
  const ws = w.rows('SELECT m.workspace_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ?', 'c@example.com')[0].workspace_id as string;
  for (const k of Object.keys(w.cf.zones)) delete w.cf.zones[k];
  for (const [name, z] of Object.entries(zones)) w.cf.zones[name] = { id: zid(name), cfAccountId: z.account ?? 'acct-1', cfAccountName: 'Example Co', status: z.status, type: z.type, nameServers: z.nameServers };
  w.cf.accounts = [{ id: 'acct-1', name: 'Example Co' }, { id: 'acct-b', name: 'New owner' }];
  const C = { token, ws };
  const connect = async (as = C.token, secret = TOKEN_C) => (await w.addToken(as, secret)).id;
  const imp = (id: string, body?: unknown, as = C.token) => w.api(as, 'POST', `${CONNECTIONS}/${id}/import`, body);
  const domainsOf = (wsId: string) => w.rows('SELECT id, domain, verified_via, evicted_at, cf_name_servers, cf_zone_name, proof_lost_at FROM domains WHERE workspace_id = ? ORDER BY id', wsId);
  const audit = (action: string) => w.rows('SELECT workspace_id, resource_name FROM audit_log WHERE action = ? ORDER BY id', action);
  const mailed = () => w.send.mock.calls.map((c: any[]) => c[0] as { to: string[]; subject: string; text: string });
  const tenantOf = (workspaceId: string) => loadTenant(w.env, { workspaceId });
  return { w, C, connect, imp, domainsOf, audit, mailed, tenantOf };
}
type S = Awaited<ReturnType<typeof setup>>;

/** C imports sold.com (delegated to Cloudflare's CF_NS), then the domain is sold: C revokes its token and the zone now lives in another account. */
async function soldDomain(s: S) {
  const idC = await s.connect();
  expect((await json(await s.imp(idC))).imported.map((i: any) => i.domain)).toEqual(['sold.com']);
  s.w.send.mockClear();
  return idC;
}
const moveZone = (s: S, name: string) => { s.w.cf.zones[name] = { id: zid(`${name}-new`), cfAccountId: 'acct-b', cfAccountName: 'New owner', nameServers: MOVED_NS }; };
const revoke = (s: S, secret = TOKEN_C) => s.w.cf.validTokens!.delete(secret);
const fixedAddress = fixedReportAddress(INTAKE);
const connectReports = (s: S, workspaceId: string, domain: string) => s.w.db.sqlite.prepare('UPDATE domains SET rua_address = ? WHERE workspace_id = ? AND domain = ?').run(fixedAddress, workspaceId, domain);
const reportTarget = (s: S, domain: string) => intakeLookups(s.w.env.DB).connectedForReport([domain], fixedAddress);

describe('finding 1: a zone proof is re-checked when another workspace proves the name', () => {
  it('the new owner imports a name whose zone moved away (previous owner revoked the token), and reports follow the new owner', async () => {
    const s = await setup({ 'sold.com': {} });
    await soldDomain(s);
    connectReports(s, s.C.ws, 'sold.com');
    expect((await reportTarget(s, 'sold.com'))?.workspace_id).toBe(s.C.ws);
    revoke(s);
    moveZone(s, 'sold.com');
    const idB = await s.connect(s.w.B.token, TOKEN_B);
    const res = await json(await s.imp(idB, undefined, s.w.B.token));
    expect(res.skipped).toEqual([]);
    expect(res.imported.map((i: any) => i.domain)).toEqual(['sold.com']);
    expect(s.domainsOf(s.w.B.ws).find(d => d.domain === 'sold.com')?.verified_via).toBe('cloudflare');
    const old = s.domainsOf(s.C.ws)[0];
    expect(old.evicted_at).not.toBeNull();
    expect(old.proof_lost_at).not.toBeNull();
    expect(s.audit('domain.evicted')).toEqual([{ workspace_id: s.C.ws, resource_name: 'sold.com' }]);
    expect(s.mailed().some(m => m.to.includes('c@example.com'))).toBe(true);
    // intake files the shared address's reports into the workspace that holds the name now
    connectReports(s, s.w.B.ws, 'sold.com');
    expect((await reportTarget(s, 'sold.com'))?.workspace_id).toBe(s.w.B.ws);
  });

  it('the new owner is not locked out of the TXT proof either', async () => {
    const s = await setup({ 'sold.com': {} });
    await soldDomain(s);
    revoke(s);
    moveZone(s, 'sold.com');
    const added = await call(s.w.env, 'POST', '/api/domains', { key: s.w.B.token, body: { domain: 'sold.com' } });
    expect(added.status).toBe(202);
    const claim = (await json(added)).claim;
    s.w.cf.doh[claim.txt_name] = [claim.txt_value];
    const verified = await call(s.w.env, 'POST', `/api/domains/claims/${claim.id}/verify`, { key: s.w.B.token });
    expect(verified.status).toBe(201);
    expect(s.domainsOf(s.w.B.ws).find(d => d.domain === 'sold.com')?.verified_via).toBe('txt');
    expect(s.domainsOf(s.C.ws)[0].evicted_at).not.toBeNull();
  });

  it('a holder whose zone is still delegated to the stored servers keeps the name, whatever the token does', async () => {
    const s = await setup({ 'sold.com': {} });
    await soldDomain(s);
    revoke(s); // a revoked token alone is no reason to doubt the proof
    const added = await call(s.w.env, 'POST', '/api/domains', { key: s.w.B.token, body: { domain: 'sold.com' } });
    expect(added.status).toBe(409);
    expect(s.domainsOf(s.C.ws)[0]).toMatchObject({ verified_via: 'cloudflare', evicted_at: null, proof_lost_at: null });
    expect(s.mailed()).toEqual([]);
  });

  it('a holder whose token still works but whose zone is no longer active in its account loses the name even if the delegation is unchanged', async () => {
    const s = await setup({ 'sold.com': {} });
    await soldDomain(s);
    s.w.cf.zones['sold.com'].status = 'pending'; // same servers in public DNS, but Cloudflare no longer serves the zone
    const added = await call(s.w.env, 'POST', '/api/domains', { key: s.w.B.token, body: { domain: 'sold.com' } });
    expect(added.status).toBe(202);
    expect(s.domainsOf(s.C.ws)[0]).toMatchObject({ verified_via: 'legacy' });
    expect(s.domainsOf(s.C.ws)[0].proof_lost_at).toBeGreaterThan(0);
  });

  it('a holder that has just shown it holds the name is not asked again, so repeated claims cannot make us hammer its account', async () => {
    const s = await setup({ 'sold.com': {} });
    await soldDomain(s);
    revoke(s);
    const asked: string[] = [];
    const prev = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: any, init?: any) => { const u = new URL(String(input.url ?? input)); if (u.searchParams.get('type') === 'NS') asked.push(u.searchParams.get('name')!); return prev(input, init); });
    for (let i = 0; i < 3; i++) expect((await call(s.w.env, 'POST', '/api/domains', { key: s.w.B.token, body: { domain: 'sold.com' } })).status).toBe(409);
    expect(asked).toEqual(['sold.com']);
    expect(s.w.rows('SELECT proof_checked_at FROM domains WHERE workspace_id = ?', s.C.ws)[0].proof_checked_at).toBeGreaterThan(0);
  });

  it('records the zone name and the name servers with the proof', async () => {
    const s = await setup({ 'sold.com': { nameServers: ['B.NS.cloudflare.com', 'a.ns.cloudflare.com'] } });
    s.w.cf.ns['sold.com'] = ['a.ns.cloudflare.com', 'b.ns.cloudflare.com'];
    await s.imp(await s.connect());
    expect(s.domainsOf(s.C.ws)[0]).toMatchObject({ cf_zone_name: 'sold.com', cf_name_servers: JSON.stringify(['a.ns.cloudflare.com', 'b.ns.cloudflare.com']) });
  });
});

const DAY_MS = 86_400_000;
const NOW = () => Math.floor(Date.now() / 1000);

describe('finding 1: the daily re-check of zone-verified domains', () => {

  it('a delegation that no longer matches downgrades the domain: intake refuses it, the workspace is told, the audit says so', async () => {
    const s = await setup({ 'sold.com': {} });
    await soldDomain(s);
    connectReports(s, s.C.ws, 'sold.com');
    // a hosted-records token for the domain, as hosted records create
    const tokenHash = await hashToken('a'.repeat(32));
    s.w.db.sqlite.prepare('INSERT INTO intake_tokens (workspace_id, domain_id, token_hash) VALUES (?, ?, ?)').run(s.C.ws, s.domainsOf(s.C.ws)[0].id, tokenHash);
    expect(await intakeLookups(s.w.env.DB).resolveToken(tokenHash, NOW())).not.toBeNull();
    expect(await reportTarget(s, 'sold.com')).not.toBeNull();

    s.w.cf.ns['sold.com'] = ['ns1.elsewhere.test']; // the domain was delegated somewhere else
    expect(await recheckZoneProofs(s.w.env)).toMatchObject({ checked: 1, downgraded: 0, suspected: 1 }); // one read is a suspicion, not a lapse
    expect(s.domainsOf(s.C.ws)[0].verified_via).toBe('cloudflare');
    const out = await recheckZoneProofs(s.w.env, { now: () => Date.now() + DAY_MS }); // the same answer a day later is
    expect(out).toMatchObject({ checked: 1, downgraded: 1 });

    expect(s.domainsOf(s.C.ws)[0]).toMatchObject({ verified_via: 'legacy', evicted_at: null });
    expect(s.domainsOf(s.C.ws)[0].proof_lost_at).toBeGreaterThan(0);
    expect(await reportTarget(s, 'sold.com')).toBeNull(); // the fixed address
    expect(await intakeLookups(s.w.env.DB).resolveToken(tokenHash, NOW())).toBeNull(); // a hosted token address
    const note = s.mailed().find(m => m.to.includes('c@example.com'));
    expect(note?.text).toMatch(/sold\.com/);
    expect(note?.text).toMatch(/no longer points to the Cloudflare name servers/i);
    expect(s.audit('domain.proof_lost')).toEqual([{ workspace_id: s.C.ws, resource_name: 'sold.com' }]);
    // told once: the next run has nothing to say
    s.w.send.mockClear();
    expect(await recheckZoneProofs(s.w.env)).toMatchObject({ downgraded: 0 });
    expect(s.mailed()).toEqual([]);
  });

  it('a delegation that still matches changes nothing; a revoked token alone does not downgrade', async () => {
    const s = await setup({ 'sold.com': {} });
    await soldDomain(s);
    revoke(s);
    const out = await recheckZoneProofs(s.w.env);
    expect(out).toMatchObject({ checked: 1, downgraded: 0 });
    expect(s.domainsOf(s.C.ws)[0]).toMatchObject({ verified_via: 'cloudflare', proof_lost_at: null });
    expect(s.w.rows('SELECT proof_checked_at FROM domains WHERE workspace_id = ?', s.C.ws)[0].proof_checked_at).toBeGreaterThan(0);
    expect(s.mailed()).toEqual([]);
  });

  it('a lookup that fails (SERVFAIL) is not a verdict: nothing changes and the domain is tried again next run', async () => {
    const s = await setup({ 'sold.com': {} });
    await soldDomain(s);
    const prev = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: any, init?: any) => (String(input.url ?? input).includes('type=NS') ? new Response(JSON.stringify({ Status: 2 }), { status: 200 }) : prev(input, init)));
    expect(await recheckZoneProofs(s.w.env)).toMatchObject({ downgraded: 0, inconclusive: 1 });
    expect(s.domainsOf(s.C.ws)[0].verified_via).toBe('cloudflare');
    expect(s.w.rows('SELECT proof_checked_at FROM domains WHERE workspace_id = ?', s.C.ws)[0].proof_checked_at).toBeNull();
  });

  it('only zone-verified domains are asked about, one NS query per zone, oldest check first, at most RECHECK_PER_RUN per run', async () => {
    const s = await setup({ 'one.com': {}, 'two.org': {}, 'three.net': {} });
    await s.imp(await s.connect());
    s.w.db.sqlite.prepare("UPDATE domains SET proof_attempted_at = 100 WHERE domain = 'two.org'").run();
    s.w.db.sqlite.prepare("UPDATE domains SET proof_attempted_at = 50 WHERE domain = 'three.net'").run();
    s.w.db.sqlite.prepare("INSERT INTO domains (workspace_id, domain, rua_address, verified_via) VALUES (?, 'txt-only.com', '', 'txt')").run(s.C.ws);
    const asked: string[] = [];
    const prev = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: any, init?: any) => { const u = new URL(String(input.url ?? input)); if (u.searchParams.get('type') === 'NS') asked.push(u.searchParams.get('name')!); return prev(input, init); });
    const out = await recheckZoneProofs(s.w.env, { limit: 2 });
    expect(out.checked).toBe(2);
    expect(asked.sort()).toEqual(['one.com', 'three.net']); // never attempted first, then the oldest attempt; the TXT domain is not one of them
    expect(RECHECK_PER_RUN).toBeGreaterThanOrEqual(100);
  });

  it('domains of one zone cost one query between them', async () => {
    const s = await setup({ 'one.com': {} });
    await s.imp(await s.connect());
    s.w.db.sqlite.prepare("INSERT INTO domains (workspace_id, domain, rua_address, verified_via, cf_zone_id, cf_zone_name, cf_name_servers) VALUES (?, 'mail.one.com', '', 'cloudflare', ?, 'one.com', ?)").run(s.C.ws, zid('one.com'), JSON.stringify(CF_NS));
    const asked: string[] = [];
    const prev = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: any, init?: any) => { const u = new URL(String(input.url ?? input)); if (u.searchParams.get('type') === 'NS') asked.push(u.searchParams.get('name')!); return prev(input, init); });
    expect(await recheckZoneProofs(s.w.env)).toMatchObject({ checked: 2, downgraded: 0 });
    expect(asked).toEqual(['one.com']);
    s.w.cf.ns['one.com'] = ['ns1.elsewhere.test'];
    expect(await recheckZoneProofs(s.w.env)).toMatchObject({ downgraded: 0, suspected: 2 });
    expect(await recheckZoneProofs(s.w.env, { now: () => Date.now() + DAY_MS })).toMatchObject({ downgraded: 2 });
  });

  it('a domain verified through Cloudflare before the servers were kept is never downgraded for the missing record', async () => {
    const s = await setup({ 'one.com': {} });
    await s.imp(await s.connect());
    s.w.db.sqlite.prepare('UPDATE domains SET cf_name_servers = NULL, cf_zone_name = NULL').run();
    s.w.cf.ns['one.com'] = ['ns1.elsewhere.test'];
    expect(await recheckZoneProofs(s.w.env)).toMatchObject({ downgraded: 0 });
    expect(s.domainsOf(s.C.ws)[0].verified_via).toBe('cloudflare');
  });

  it('runs from the daily hosted cron', async () => {
    const s = await setup({ 'sold.com': {} });
    await soldDomain(s);
    s.w.cf.ns['sold.com'] = ['ns1.elsewhere.test'];
    s.w.db.sqlite.prepare('UPDATE domains SET proof_suspected_at = ? WHERE workspace_id = ?').run(NOW() - 2 * 86400, s.C.ws); // first seen two days ago
    const { runHostedCron, HOSTED_CRON } = await import('../../src/hosted/cron');
    await runHostedCron({ cron: HOSTED_CRON } as ScheduledController, s.w.env, { waitUntil() {} } as unknown as ExecutionContext);
    expect(s.domainsOf(s.C.ws)[0].verified_via).toBe('legacy');
  });
});

describe('finding 2: the NS check follows no CNAME and wants the zone\'s exact set', () => {
  it('a name that is a CNAME to another domain is not proven by that domain\'s name servers', async () => {
    const s = await setup({ 'shop.victim.com': { nameServers: ['x.ns.cloudflare.com', 'y.ns.cloudflare.com'] }, 'attacker.com': { nameServers: ['x.ns.cloudflare.com', 'y.ns.cloudflare.com'] } });
    s.w.cf.nsViaCname['shop.victim.com'] = 'attacker.com'; // victim.com's zone: `shop CNAME attacker.com`
    const res = await json(await s.imp(await s.connect(), { zone_ids: [zid('shop.victim.com')] }));
    expect(res.imported).toEqual([]);
    expect(res.skipped.map((k: any) => k.domain)).toEqual(['shop.victim.com']);
    expect(s.domainsOf(s.C.ws)).toEqual([]);
  });

  it('only some of the zone\'s servers answering is not a delegation to it', async () => {
    const s = await setup({ 'half.com': {}, 'full.com': {} });
    s.w.cf.ns['half.com'] = ['a.ns.cloudflare.com'];
    const res = await json(await s.imp(await s.connect()));
    expect(res.imported.map((i: any) => i.domain)).toEqual(['full.com']);
    expect(res.skipped.map((k: any) => k.domain)).toEqual(['half.com']);
  });

  it('answers that name no owner are not trusted', async () => {
    const s = await setup({ 'bare.com': {} });
    const prev = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: any, init?: any) => (String(input.url ?? input).includes('type=NS')
      ? new Response(JSON.stringify({ Status: 0, Answer: CF_NS.map(h => ({ type: 2, data: `${h}.` })) }), { status: 200 }) : prev(input, init)));
    expect((await json(await s.imp(await s.connect()))).imported).toEqual([]);
  });
});

describe('finding 3: nobody loses a domain to a claim that cannot be added', () => {
  /** C holds two domains under a cap of 2 and has a pending claim on a-corp.com, which workspace A holds without proof. */
  async function fullPlan() {
    const s = await setup({ 'f1.com': {}, 'f2.com': {}, 'a-corp.com': {} }, { MAX_DOMAINS_PER_WORKSPACE: '2' });
    expect((await call(s.w.env, 'POST', '/api/domains', { key: s.C.token, body: { domain: 'a-corp.com' } })).status).toBe(202);
    const id = await s.connect();
    expect((await json(await s.imp(id, { zone_ids: [zid('f1.com'), zid('f2.com')] }))).imported).toHaveLength(2);
    s.w.send.mockClear();
    return { s, id };
  }

  it('saving the allow-list with a full plan leaves the unproven holder, its records, its email and its audit trail alone', async () => {
    const { s, id } = await fullPlan();
    const before = s.domainsOf(s.w.A.ws);
    const put = await s.w.api(s.C.token, 'PUT', `${CONNECTIONS}/${id}/zones`, { zone_ids: [zid('f1.com'), zid('f2.com'), zid('a-corp.com')] });
    expect(put.status).toBe(200);
    expect((await json(put)).verified_claims).toEqual([]);
    expect(s.domainsOf(s.w.A.ws)).toEqual(before);
    expect(s.mailed()).toEqual([]);
    expect(s.audit('domain.evicted')).toEqual([]);
    expect(s.domainsOf(s.C.ws).map(d => d.domain)).toEqual(['f1.com', 'f2.com']);
  });

  it('a plan that fills up between the admission and the insert still evicts nobody', async () => {
    const s = await setup({ 'a-corp.com': {}, 'filler.org': {} }, { MAX_DOMAINS_PER_WORKSPACE: '1' });
    const id = await s.connect();
    await s.w.api(s.C.token, 'PUT', `${CONNECTIONS}/${id}/zones`, { zone_ids: [zid('a-corp.com')] });
    s.w.send.mockClear();
    const tenant = await s.tenantOf(s.C.ws);
    expect(await admitByZone(tenant, 'a-corp.com')).toEqual({ kind: 'verified', via: 'cloudflare' });
    s.w.db.sqlite.prepare("INSERT INTO domains (workspace_id, domain, rua_address, verified_via) VALUES (?, 'filler.org', '', 'txt')").run(s.C.ws); // someone else's request takes the last place
    await expect(commitVerifiedDomain(tenant, 'a-corp.com', 'cloudflare')).rejects.toThrow();
    expect(s.domainsOf(s.w.A.ws).find(d => d.domain === 'a-corp.com')).toMatchObject({ evicted_at: null });
    expect(s.mailed()).toEqual([]);
    expect(s.audit('domain.evicted')).toEqual([]);
  });

  it('with room, the holder is evicted once the new row is in: emailed, audit-logged, its row detached', async () => {
    const s = await setup({ 'a-corp.com': {} });
    const id = await s.connect();
    const res = await json(await s.w.api(s.C.token, 'PUT', `${CONNECTIONS}/${id}/zones`, { zone_ids: [zid('a-corp.com')] }));
    expect(res.status ?? 200).toBe(200);
    await s.imp(id);
    expect(s.domainsOf(s.C.ws).map(d => d.domain)).toEqual(['a-corp.com']);
    expect(s.domainsOf(s.w.A.ws).find(d => d.id === 1)?.evicted_at).not.toBeNull();
    expect(s.audit('domain.evicted')).toEqual([{ workspace_id: s.w.A.ws, resource_name: 'a-corp.com' }]);
    expect(s.mailed().length).toBeGreaterThan(0);
  });
});

describe('finding 5: a zone refused because of a verified neighbour says so', () => {
  it('says that a parent or subdomain is verified elsewhere, not that Cloudflare does not answer, and not who has it', async () => {
    const s = await setup({ 'victim.com': {}, 'target.org': {} });
    const ins = s.w.db.sqlite.prepare("INSERT INTO domains (workspace_id, domain, rua_address, verified_via) VALUES (?, ?, '', 'txt')");
    ins.run(s.w.B.ws, 'mail.victim.com'); ins.run(s.w.B.ws, 'sub.target.org');
    const res = await json(await s.imp(await s.connect()));
    expect(res.skipped.map((k: any) => k.domain).sort()).toEqual(['target.org', 'victim.com']);
    for (const k of res.skipped) {
      expect(k.reason).not.toMatch(/Cloudflare does not answer/);
      expect(k.reason).toMatch(/parent or a subdomain/i);
      expect(k.reason).toMatch(/TXT|DNS record/i);
      expect(k.reason).not.toMatch(/b-corp|b@example|mail\.victim|sub\.target/i);
    }
  });
});
