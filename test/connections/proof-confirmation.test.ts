// Security review round 4 of the Cloudflare zone proofs: the daily queue rotates, a zone proof always has its name servers (and the 2.0.0 ones that do
// not are unproven against a rival), the way back after a lost proof keeps the row and its history, and a lapse is confirmed before a proof is withdrawn.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProofIncompleteError } from '@ready-set-mail/db';
import { call, signupVerified } from '../auth/helpers';
import { CF_NS } from '../helpers/cf-fake';
import { world } from './world';
import { ANSWERED_WINDOW_SECONDS, CONFIRM_AFTER_SECONDS, checkDelegation, confirmDelayMs, recheckZoneProofs } from '../../src/domains/proof-recheck';
import { commitVerifiedDomain, DomainServiceError } from '../../src/domains/service';
import { loadTenant } from '../../src/tenancy/load';
import { intakeLookups } from '@ready-set-mail/db';
import { fixedReportAddress } from '../../src/hosted/fixed-address';
import { createResolver } from '@ready-set-mail/dns-checks';
import { claimLookups } from '@ready-set-mail/db';
import { confirmResolverFor, dohEndpoint } from '../../src/dns/resolver';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

beforeEach(() => { for (const m of ['warn', 'log', 'error', 'info'] as const) vi.spyOn(console, m).mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const json = async (r: Response) => await r.json() as any;
const zid = (n: string) => Buffer.from(n).toString('hex').padEnd(32, '0').slice(0, 32);
const CONNECTIONS = '/api/cloudflare/connections';
const INTAKE = 'rua.intake.example.net';
const TOKEN_C = 'secret-token-aaaaaaaaaaaa-1';
const TOKEN_C2 = 'secret-token-cccccccccccc-2';
const TOKEN_B = 'secret-token-bbbbbbbbbbbb-1';
const MOVED_NS = ['n1.ns.cloudflare.com', 'n2.ns.cloudflare.com'];
const DAY_MS = 86_400_000;
const nsBody = (name: string, hosts: string[]) => ({ Status: 0, Answer: hosts.map(h => ({ name: `${name}.`, type: 2, data: `${h}.` })) });

async function setup(zones: Record<string, { account?: string; nameServers?: string[] }>, extraEnv: Record<string, unknown> = {}) {
  const w = await world({ INTAKE_DOMAIN: INTAKE, ...extraEnv });
  const token = await signupVerified(w.env, 'c@example.com');
  const ws = w.rows('SELECT m.workspace_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ?', 'c@example.com')[0].workspace_id as string;
  for (const k of Object.keys(w.cf.zones)) delete w.cf.zones[k];
  for (const [name, z] of Object.entries(zones)) w.cf.zones[name] = { id: zid(name), cfAccountId: z.account ?? 'acct-1', cfAccountName: 'Example Co', nameServers: z.nameServers };
  w.cf.accounts = [{ id: 'acct-1', name: 'Example Co' }, { id: 'acct-2', name: 'Second' }, { id: 'acct-b', name: 'New owner' }];
  const C = { token, ws };
  const connect = async (as = C.token, secret = TOKEN_C) => (await w.addToken(as, secret)).id;
  const imp = (id: string, body?: unknown, as = C.token) => w.api(as, 'POST', `${CONNECTIONS}/${id}/import`, body);
  const rows = (wsId: string) => w.rows('SELECT id, domain, verified_via, evicted_at, cf_zone_id, cf_zone_name, cf_name_servers, cf_account_id, proof_lost_at, proof_attempted_at, proof_suspected_at, proof_checked_at FROM domains WHERE workspace_id = ? ORDER BY id', wsId);
  const mailed = () => w.send.mock.calls.map((c: any[]) => c[0] as { to: string[]; subject: string; text: string });
  const claim = (as: string, domain: string) => call(w.env, 'POST', '/api/domains', { key: as, body: { domain } });
  const addReport = (domainId: number) => w.db.sqlite.prepare("INSERT INTO aggregate_reports (domain_id, org_name, report_id, date_begin, date_end, total_count, pass_count, fail_count) VALUES (?, 'g', ?, 1, 2, 5, 5, 0)").run(domainId, `r${domainId}-${Math.random()}`);
  const reports = (domainId: number) => w.rows('SELECT COUNT(*) AS n FROM aggregate_reports WHERE domain_id = ?', domainId)[0].n as number;
  const connectReports = (wsId: string, domain: string) => w.db.sqlite.prepare('UPDATE domains SET rua_address = ? WHERE workspace_id = ? AND domain = ?').run(fixedReportAddress(INTAKE), wsId, domain);
  const reportTarget = (domain: string) => intakeLookups(w.env.DB).connectedForReport([domain], fixedReportAddress(INTAKE));
  return { w, C, connect, imp, rows, mailed, claim, addReport, reports, connectReports, reportTarget };
}
type S = Awaited<ReturnType<typeof setup>>;

/** NS answers by name: a body, or a function of how many times that name was asked (so a glitch can be one read only). */
function ns(answers: Record<string, unknown | ((n: number) => unknown)>) {
  const prev = globalThis.fetch;
  const asked: Record<string, number> = {};
  vi.stubGlobal('fetch', async (input: any, init?: any) => {
    const u = new URL(String(input.url ?? input));
    const name = (u.searchParams.get('name') ?? '').toLowerCase();
    if (u.searchParams.get('type') === 'NS') {
      asked[name] = (asked[name] ?? 0) + 1;
      const a = answers[name];
      if (a !== undefined) return new Response(JSON.stringify(typeof a === 'function' ? (a as (n: number) => unknown)(asked[name]) : a), { status: 200 });
    }
    return prev(input, init);
  });
  return asked;
}

/** C holds sold.com through its zone (imported), token still valid. */
async function held(extra: Record<string, unknown> = {}) {
  const s = await setup({ 'sold.com': {} }, extra);
  const id = await s.connect();
  expect((await json(await s.imp(id))).imported.map((i: any) => i.domain)).toEqual(['sold.com']);
  s.w.send.mockClear();
  return { s, connection: id };
}
/** The shape release 2.0.0 wrote: verified through Cloudflare, and nothing else about it. */
const asRelease2 = (s: S) => s.w.db.sqlite.prepare('UPDATE domains SET cf_zone_id = NULL, cf_zone_name = NULL, cf_name_servers = NULL, cf_account_id = NULL, verified_at = NULL WHERE workspace_id = ?').run(s.C.ws);
const resolverOf = (fn: (name: string) => { status: string; answers: unknown[]; error?: string; truncated?: boolean }) => ({ resolve: async (name: string) => fn(name), txt: async () => ({ status: 'error', records: [] }), fetch: globalThis.fetch }) as any;
const seedZone = (s: S, name: string, ws: string, id = name) => s.w.db.sqlite.prepare("INSERT INTO domains (workspace_id, domain, rua_address, verified_via, cf_zone_id, cf_zone_name, cf_name_servers) VALUES (?, ?, '', 'cloudflare', ?, ?, ?)").run(ws, name, zid(id), name, JSON.stringify(CF_NS));

describe('finding 1: the daily queue rotates whatever the lookups answer', () => {
  it('a moved-away domain behind 200 rows whose lookups fail is looked at on the second day, and withdrawn once confirmed', async () => {
    const s = await setup({});
    for (let i = 0; i < 200; i++) seedZone(s, `stall${i}.com`, s.w.B.ws);
    seedZone(s, 'moved.com', s.w.A.ws);
    const asked: string[] = [];
    const resolver = resolverOf(name => { asked.push(name); return name.startsWith('stall') ? { status: 'error', answers: [], error: 'SERVFAIL' } : { status: 'ok', answers: [{ name, type: 2, ttl: 1, data: 'other.provider.net' }] }; });
    const t0 = 1_800_000_000_000;
    const verdicts: string[] = [];
    for (let day = 1; day <= 4; day++) {
      await recheckZoneProofs(s.w.env, { resolver, now: () => t0 + day * DAY_MS });
      verdicts.push(s.w.rows("SELECT verified_via FROM domains WHERE domain = 'moved.com'")[0].verified_via);
      if (day === 1) expect(asked).not.toContain('moved.com'); // 200 never-attempted rows come first, in id order
      if (day === 2) expect(asked).toContain('moved.com'); // ... and are then behind everything that was attempted since
    }
    // day 2: first answer (suspected), and from then on it is in the answered queue, read every day: confirmed on day 3
    expect(verdicts).toEqual(['cloudflare', 'cloudflare', 'legacy', 'legacy']);
  });

  it('proofs with no name servers and no working token do not hold the head of the queue either', async () => {
    const s = await setup({});
    const ins = s.w.db.sqlite.prepare("INSERT INTO domains (workspace_id, domain, rua_address, verified_via) VALUES (?, ?, '', 'cloudflare')");
    for (let i = 0; i < 200; i++) ins.run(s.w.B.ws, `old${i}.com`);
    seedZone(s, 'moved.com', s.w.A.ws);
    const asked: string[] = [];
    const resolver = resolverOf(name => { asked.push(name); return { status: 'ok', answers: [{ name, type: 2, ttl: 1, data: 'other.provider.net' }] }; });
    const t0 = 1_800_000_000_000;
    await recheckZoneProofs(s.w.env, { resolver, now: () => t0 + DAY_MS });
    expect(asked).not.toContain('moved.com');
    await recheckZoneProofs(s.w.env, { resolver, now: () => t0 + 2 * DAY_MS });
    expect(asked).toContain('moved.com');
  });

  it('every row the job takes is marked attempted: a verdict, no verdict, and nothing to compare with', async () => {
    const s = await setup({});
    seedZone(s, 'ok.com', s.w.B.ws);
    seedZone(s, 'glitch.com', s.w.B.ws);
    s.w.db.sqlite.prepare("INSERT INTO domains (workspace_id, domain, rua_address, verified_via) VALUES (?, 'old.com', '', 'cloudflare')").run(s.w.B.ws);
    const resolver = resolverOf(name => (name === 'glitch.com' ? { status: 'error', answers: [], error: 'SERVFAIL' } : { status: 'ok', answers: CF_NS.map(d => ({ name, type: 2, ttl: 1, data: d })) }));
    const now = 1_800_000_000_000;
    await recheckZoneProofs(s.w.env, { resolver, now: () => now });
    expect(s.rows(s.w.B.ws).filter(r => r.verified_via === 'cloudflare').map(r => [r.domain, r.proof_attempted_at])).toEqual([['ok.com', now / 1000], ['glitch.com', now / 1000], ['old.com', now / 1000]]);
  });
});

describe('finding 2: a zone proof always has its name servers', () => {
  it('no code path writes a zone-verified row without them: the insert, the add and the bulk import refuse', async () => {
    const s = await setup({});
    const tenant = await loadTenant(s.w.env, { workspaceId: s.C.ws });
    await expect(tenant.scope.domains.insert({ domain: 'bare.com', rua_address: '', verified_via: 'cloudflare' })).rejects.toBeInstanceOf(ProofIncompleteError);
    await expect(tenant.scope.domains.insert({ domain: 'bare.com', rua_address: '', verified_via: 'cloudflare', proof: { cf_account_id: 'a', cf_zone_id: 'z', verified_at: 1, cf_zone_name: 'bare.com', cf_name_servers: [] } })).rejects.toBeInstanceOf(ProofIncompleteError);
    await expect(commitVerifiedDomain(tenant, 'bare.com', 'cloudflare')).rejects.toMatchObject({ status: 409, body: { code: 'proof_incomplete' } });
    await expect(commitVerifiedDomain(tenant, 'bare.com', 'cloudflare')).rejects.toBeInstanceOf(DomainServiceError);
    expect(s.rows(s.C.ws)).toEqual([]);
  });

  it('a zone that reports no name servers proves nothing: the name is a claim, not a zone-verified row', async () => {
    const s = await setup({ 'bare.com': { nameServers: [] } });
    await s.connect();
    const added = await s.claim(s.C.token, 'bare.com');
    expect(added.status).toBe(202);
    expect(s.rows(s.C.ws)).toEqual([]);
  });

  it('a row verified by Cloudflare without recorded servers (what 2.0.0 stored) is unproven against a rival: a claim alone moves nothing, a completed proof takes the name', async () => {
    const { s } = await held();
    asRelease2(s);
    const old = s.rows(s.C.ws)[0];
    s.addReport(old.id);
    // the connection is gone, so nothing can be read about the holder
    s.w.cf.validTokens!.delete(TOKEN_C);
    const claimed = await s.claim(s.w.B.token, 'sold.com');
    expect(claimed.status).toBe(202); // a pending claim, not 409
    expect(s.rows(s.C.ws)[0]).toMatchObject({ verified_via: 'cloudflare', evicted_at: null });
    expect(s.mailed()).toEqual([]);
    const c = (await json(claimed)).claim;
    s.w.cf.doh[c.txt_name] = [c.txt_value];
    const verified = await call(s.w.env, 'POST', `/api/domains/claims/${c.id}/verify`, { key: s.w.B.token });
    expect(verified.status).toBe(201);
    expect(s.rows(s.w.B.ws).find(r => r.domain === 'sold.com')?.verified_via).toBe('txt');
    expect(s.rows(s.C.ws)[0].evicted_at).not.toBeNull();
    expect(s.reports(old.id)).toBe(1); // its history is kept, read-only, for the retention window
    expect(s.mailed().some(m => m.to.includes('c@example.com'))).toBe(true);
  });

  it('a server-less row whose holder still has a working connection that agrees with public DNS is recorded at the rival claim and then keeps the name', async () => {
    const { s } = await held();
    asRelease2(s);
    expect((await s.claim(s.w.B.token, 'sold.com')).status).toBe(409);
    expect(s.rows(s.C.ws)[0]).toMatchObject({ verified_via: 'cloudflare', cf_zone_name: 'sold.com', cf_name_servers: JSON.stringify(CF_NS), cf_zone_id: zid('sold.com'), cf_account_id: 'acct-1' });
  });

  it('the daily job records zone, account and servers for such a row when Cloudflare and public DNS agree, and only then', async () => {
    const { s } = await held();
    const asRel2 = () => asRelease2(s);
    const now = () => 1_800_000_000_000;
    asRel2();
    expect(await recheckZoneProofs(s.w.env, { now })).toMatchObject({ recorded: 1, downgraded: 0 });
    expect(s.rows(s.C.ws)[0]).toMatchObject({ cf_zone_name: 'sold.com', cf_name_servers: JSON.stringify(CF_NS), cf_zone_id: zid('sold.com'), cf_account_id: 'acct-1' });
    // public DNS elsewhere: nothing recorded, nothing downgraded
    asRel2();
    s.w.cf.ns['sold.com'] = ['ns1.elsewhere.test'];
    expect(await recheckZoneProofs(s.w.env, { now })).toMatchObject({ recorded: 0, downgraded: 0 });
    expect(s.rows(s.C.ws)[0]).toMatchObject({ verified_via: 'cloudflare', cf_name_servers: null });
    // no working token: today's DNS could be the new owner's, so it is not pinned
    delete s.w.cf.ns['sold.com'];
    s.w.cf.validTokens!.delete(TOKEN_C);
    expect(await recheckZoneProofs(s.w.env, { now })).toMatchObject({ recorded: 0, downgraded: 0 });
    expect(s.rows(s.C.ws)[0]).toMatchObject({ verified_via: 'cloudflare', cf_name_servers: null });
  });
});

describe('finding 3: the way back after a lost proof keeps the row and its history', () => {
  /** C moved sold.com's zone to its own second account; a rival claim downgraded it (the old connection cannot find the zone any more). */
  async function lost() {
    const { s } = await held();
    const old = s.rows(s.C.ws)[0];
    s.addReport(old.id);
    s.connectReports(s.C.ws, 'sold.com');
    expect((await s.reportTarget('sold.com'))?.workspace_id).toBe(s.C.ws);
    s.w.cf.zones['sold.com'] = { id: zid('sold-acct2'), cfAccountId: 'acct-2', cfAccountName: 'Second', nameServers: MOVED_NS };
    expect((await s.claim(s.w.B.token, 'sold.com')).status).toBe(202); // the rival's claim: the holder shows it no longer holds it
    expect(s.rows(s.C.ws)[0]).toMatchObject({ verified_via: 'legacy', evicted_at: null });
    expect(await s.reportTarget('sold.com')).toBeNull(); // reports are refused while unproven
    s.w.send.mockClear();
    return { s, old };
  }

  it('Prove again through another connection of the workspace restores the SAME row: id, reports and report address intact, reports accepted again', async () => {
    const { s, old } = await lost();
    const second = await s.connect(s.C.token, TOKEN_C2);
    await s.imp(second); // allows the zones of the second account
    const proved = await call(s.w.env, 'POST', `/api/domains/${old.id}/prove`, { key: s.C.token });
    expect(proved.status).toBe(200);
    expect(await json(proved)).toMatchObject({ restored: true, domain: { id: old.id, domain: 'sold.com' } });
    expect(s.rows(s.C.ws)).toEqual([expect.objectContaining({ id: old.id, verified_via: 'cloudflare', proof_lost_at: null, proof_suspected_at: null, cf_zone_id: zid('sold-acct2'), cf_account_id: 'acct-2', cf_name_servers: JSON.stringify(MOVED_NS) })]);
    expect(s.reports(old.id)).toBe(1);
    expect((await s.reportTarget('sold.com'))?.workspace_id).toBe(s.C.ws);
  });

  it('adding the same name again runs the same re-prove (it is not "already added" while unproven)', async () => {
    const { s, old } = await lost();
    const second = await s.connect(s.C.token, TOKEN_C2);
    await s.imp(second);
    const again = await s.claim(s.C.token, 'sold.com');
    expect(again.status).toBe(200);
    expect(await json(again)).toMatchObject({ restored: true });
    expect(s.rows(s.C.ws)).toEqual([expect.objectContaining({ id: old.id, verified_via: 'cloudflare', proof_lost_at: null })]);
  });

  it('when the zone cannot prove it, Prove again opens the TXT claim and Verify restores the same row with its history', async () => {
    const { s, old } = await lost();
    const first = await call(s.w.env, 'POST', `/api/domains/${old.id}/prove`, { key: s.C.token });
    expect(first.status).toBe(202);
    const claim = (await json(first)).claim;
    expect(s.rows(s.C.ws)[0].verified_via).toBe('legacy');
    s.w.cf.doh[claim.txt_name] = [claim.txt_value];
    const verified = await call(s.w.env, 'POST', `/api/domains/claims/${claim.id}/verify`, { key: s.C.token });
    expect(verified.status).toBe(200);
    expect(await json(verified)).toMatchObject({ restored: true, domain: { id: old.id } });
    expect(s.rows(s.C.ws)).toEqual([expect.objectContaining({ id: old.id, verified_via: 'txt', proof_lost_at: null })]);
    expect(s.reports(old.id)).toBe(1);
  });

  it('the domain list says which domain lost its proof, so the overview and the domain page can show "Proof lost: prove it is still yours"', async () => {
    const { s, old } = await lost();
    const list = (await json(await call(s.w.env, 'GET', '/api/domains', { key: s.C.token }))).domains;
    expect(list.find((d: any) => d.id === old.id)).toMatchObject({ verified_via: 'legacy', proof_lost_at: expect.any(Number) });
  });

  it('the email points to Prove again, does not advise removing, and says what happens if a rival proves it first', async () => {
    const { s } = await held();
    s.w.cf.zones['sold.com'] = { id: zid('sold-acct2'), cfAccountId: 'acct-2', cfAccountName: 'Second', nameServers: MOVED_NS };
    await s.claim(s.w.B.token, 'sold.com');
    const text = s.mailed().find(m => m.to.includes('c@example.com'))!.text;
    expect(text).toMatch(/Prove again/);
    expect(text).toMatch(/Proof lost: prove it is still yours/);
    expect(text).not.toMatch(/remove it and add it again/i);
    expect(text).toMatch(/keeps it|moves to that workspace and it keeps it/);
    expect(text).toMatch(/read-only/);
  });

  it('a rival that proved the name keeps it: the old row answers Prove again with that, keeps its history read-only, and is not a live domain', async () => {
    const { s, old } = await lost();
    s.addReport(old.id);
    const c = (await json(await s.claim(s.w.B.token, 'sold.com'))).claim;
    s.w.cf.doh[c.txt_name] = [c.txt_value];
    expect((await call(s.w.env, 'POST', `/api/domains/claims/${c.id}/verify`, { key: s.w.B.token })).status).toBe(201);
    const proved = await call(s.w.env, 'POST', `/api/domains/${old.id}/prove`, { key: s.C.token });
    expect(proved.status).toBe(409);
    const body = await json(proved);
    expect(body).toMatchObject({ code: 'domain_taken' });
    expect(body.error).toMatch(/keeps it/);
    expect(body.error).toMatch(/read-only/);
    expect(s.rows(s.w.B.ws).find(r => r.domain === 'sold.com')?.verified_via).toBe('txt'); // the rival keeps it
    expect(s.rows(s.C.ws)[0].evicted_at).not.toBeNull();
    expect(s.reports(old.id)).toBe(2); // the history stays
    const list = (await json(await call(s.w.env, 'GET', '/api/domains', { key: s.C.token }))).domains;
    expect(list.find((d: any) => d.id === old.id)).toBeUndefined();
    expect((await s.claim(s.C.token, 'sold.com')).status).toBe(409); // adding it again does not take it back
  });
});

describe('finding 4: a lapse is confirmed before a proof is withdrawn', () => {
  it('a truncated answer is unknown, never a different set of servers', async () => {
    const resolver = createResolver({ fetch: async () => ({ ok: true, status: 200, json: async () => ({ Status: 0, TC: true, Answer: [{ name: 'z.com.', type: 2, data: 'a.ns.cloudflare.com.' }] }) }) as any });
    expect(await checkDelegation(resolver, 'z.com', CF_NS)).toBe('unknown');
    const whole = createResolver({ fetch: async () => ({ ok: true, status: 200, json: async () => nsBody('z.com', CF_NS) }) as any });
    expect(await checkDelegation(whole, 'z.com', CF_NS)).toBe('match');
  });

  it('rival claim: one empty answer (a glitch) does not downgrade a holder whose token was revoked', async () => {
    const { s } = await held();
    s.w.cf.validTokens!.delete(TOKEN_C);
    ns({ 'sold.com': (n: number) => (n === 1 ? { Status: 0 } : nsBody('sold.com', CF_NS)) });
    expect((await s.claim(s.w.B.token, 'sold.com')).status).toBe(409);
    expect(s.rows(s.C.ws)[0]).toMatchObject({ verified_via: 'cloudflare', proof_lost_at: null });
    expect(s.mailed()).toEqual([]);
  });

  it('rival claim: a truncated subset of the servers does not downgrade', async () => {
    const { s } = await held();
    s.w.cf.validTokens!.delete(TOKEN_C);
    ns({ 'sold.com': { Status: 0, TC: true, Answer: [{ name: 'sold.com.', type: 2, data: 'a.ns.cloudflare.com.' }] } });
    expect((await s.claim(s.w.B.token, 'sold.com')).status).toBe(409);
    expect(s.rows(s.C.ws)[0].verified_via).toBe('cloudflare');
  });

  it('rival claim: the same answer on two reads a short interval apart is a lapse (the interval is waited, in the same request)', async () => {
    const { s } = await held({ PROOF_CONFIRM_DELAY_MS: '300' });
    s.w.cf.validTokens!.delete(TOKEN_C);
    const at: number[] = [];
    ns({ 'sold.com': () => { at.push(Date.now()); return { Status: 3 }; } });
    expect((await s.claim(s.w.B.token, 'sold.com')).status).toBe(202);
    expect(at).toHaveLength(2);
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(290);
    expect(s.rows(s.C.ws)[0]).toMatchObject({ verified_via: 'legacy' });
  });

  it('rival claim: where the holder\'s token still works, public DNS alone differing while Cloudflare still serves the zone does not withdraw the proof', async () => {
    const { s } = await held();
    ns({ 'sold.com': nsBody('sold.com', ['ns1.elsewhere.test']) });
    expect((await s.claim(s.w.B.token, 'sold.com')).status).toBe(409);
    expect(s.rows(s.C.ws)[0]).toMatchObject({ verified_via: 'cloudflare', proof_lost_at: null });
  });

  it('daily job: the first differing read is only a suspicion; a day later it is a lapse; a read that matches in between clears it', async () => {
    const s = await setup({});
    seedZone(s, 'moved.com', s.w.A.ws);
    const answer = { current: 'differs' as 'differs' | 'match' };
    const resolver = resolverOf(name => ({ status: 'ok', answers: (answer.current === 'match' ? CF_NS : ['other.net']).map(d => ({ name, type: 2, ttl: 1, data: d })) }));
    const t0 = 1_800_000_000_000;
    const run = (hours: number) => recheckZoneProofs(s.w.env, { resolver, now: () => t0 + hours * 3_600_000 });
    const row = () => s.w.rows("SELECT verified_via, proof_suspected_at FROM domains WHERE domain = 'moved.com'")[0];

    expect(await run(0)).toMatchObject({ suspected: 1, downgraded: 0 });
    expect(row()).toEqual({ verified_via: 'cloudflare', proof_suspected_at: t0 / 1000 });
    expect(await run(10)).toMatchObject({ suspected: 1, downgraded: 0 }); // a second read the same day is not a confirmation
    expect(row().verified_via).toBe('cloudflare');

    answer.current = 'match';
    expect(await run(20)).toMatchObject({ downgraded: 0 });
    expect(row()).toEqual({ verified_via: 'cloudflare', proof_suspected_at: null }); // cleared

    answer.current = 'differs';
    expect(await run(30)).toMatchObject({ suspected: 1 });
    expect(await run(30 + CONFIRM_AFTER_SECONDS / 3600)).toMatchObject({ downgraded: 1 });
    expect(row().verified_via).toBe('legacy');
  });

  it('daily job: NXDOMAIN for the zone name twice, a day apart, is a real lapse; a failed lookup in between neither confirms nor clears', async () => {
    const s = await setup({});
    seedZone(s, 'gone.com', s.w.A.ws);
    let mode: 'nx' | 'fail' = 'nx';
    const resolver = resolverOf(() => (mode === 'nx' ? { status: 'nxdomain', answers: [] } : { status: 'error', answers: [], error: 'SERVFAIL' }));
    const t0 = 1_800_000_000_000;
    expect(await recheckZoneProofs(s.w.env, { resolver, now: () => t0 })).toMatchObject({ suspected: 1, downgraded: 0 });
    mode = 'fail';
    expect(await recheckZoneProofs(s.w.env, { resolver, now: () => t0 + DAY_MS / 2 })).toMatchObject({ inconclusive: 1 });
    expect(s.rows(s.w.A.ws).find(r => r.domain === 'gone.com')).toMatchObject({ verified_via: 'cloudflare', proof_suspected_at: t0 / 1000 });
    mode = 'nx';
    expect(await recheckZoneProofs(s.w.env, { resolver, now: () => t0 + DAY_MS })).toMatchObject({ downgraded: 1 });
    expect(s.rows(s.w.A.ws).find(r => r.domain === 'gone.com')?.verified_via).toBe('legacy');
  });

  it('daily job: a truncated answer is inconclusive and starts no suspicion', async () => {
    const s = await setup({});
    seedZone(s, 'big.com', s.w.A.ws);
    const resolver = resolverOf(name => ({ status: 'ok', truncated: true, answers: [{ name, type: 2, ttl: 1, data: 'a.ns.cloudflare.com' }] }));
    expect(await recheckZoneProofs(s.w.env, { resolver })).toMatchObject({ inconclusive: 1, downgraded: 0, suspected: 0 });
    expect(s.rows(s.w.A.ws).find(r => r.domain === 'big.com')).toMatchObject({ verified_via: 'cloudflare', proof_suspected_at: null });
  });
});

describe('round 5, finding 1: one rule decides what counts as proof against another workspace', () => {
  const release2Row = (s: S, ws: string, name: string) => s.w.db.sqlite.prepare("INSERT INTO domains (workspace_id, domain, rua_address, verified_via) VALUES (?, ?, '', 'cloudflare')").run(ws, name).lastInsertRowid;
  const live = (s: S, name: string) => s.w.rows('SELECT workspace_id, verified_via, evicted_at FROM domains WHERE domain = ?', name);

  it('a stale 2.0.0 parent does not prove a subdomain that another workspace holds: no 201 via parent, no eviction', async () => {
    const s = await setup({});
    release2Row(s, s.w.B.ws, 'parent.com');
    release2Row(s, s.w.A.ws, 'mail.parent.com');
    s.w.send.mockClear();
    const r = await s.claim(s.w.B.token, 'mail.parent.com');
    expect(r.status).toBe(202); // a claim to prove by TXT, not an admission
    expect(s.w.rows("SELECT workspace_id, evicted_at FROM domains WHERE domain = 'mail.parent.com' OR evicted_name = 'mail.parent.com'")).toEqual([{ workspace_id: s.w.A.ws, evicted_at: null }]);
    expect(s.mailed()).toEqual([]);
  });

  it('with no rival, a stale 2.0.0 parent still lets its own workspace add a subdomain (nothing evicted, no conflict)', async () => {
    const s = await setup({});
    release2Row(s, s.w.B.ws, 'parent.com');
    const r = await s.claim(s.w.B.token, 'mail.parent.com');
    expect(r.status).toBe(201);
    expect(live(s, 'mail.parent.com')).toEqual([{ workspace_id: s.w.B.ws, verified_via: 'parent', evicted_at: null }]);
  });

  it('a proven parent (TXT) in the workspace still proves a subdomain another workspace holds unproven', async () => {
    const s = await setup({});
    s.w.db.sqlite.prepare("INSERT INTO domains (workspace_id, domain, rua_address, verified_via) VALUES (?, 'parent.com', '', 'txt')").run(s.w.B.ws);
    release2Row(s, s.w.A.ws, 'mail.parent.com');
    expect((await s.claim(s.w.B.token, 'mail.parent.com')).status).toBe(201);
    expect(s.w.rows("SELECT workspace_id = ? AS b, verified_via, evicted_at IS NOT NULL AS ev FROM domains WHERE domain = 'mail.parent.com' OR evicted_name = 'mail.parent.com'", s.w.B.ws).map(r => [!!r.b, r.verified_via, !!r.ev]).sort()).toEqual([[false, 'cloudflare', true], [true, 'parent', false]].sort());
  });

  it('relatedOwnedByOther uses the same rule: a 2.0.0 or legacy row in another workspace is no related owner, a proven one is', async () => {
    const s = await setup({});
    const related = (name: string) => claimLookups(s.w.env.DB).relatedOwnedByOther(name, s.w.B.ws);
    release2Row(s, s.w.A.ws, 'parent.com');
    expect(await related('mail.parent.com')).toBe(false);
    s.w.db.sqlite.prepare("UPDATE domains SET verified_via = 'txt' WHERE domain = 'parent.com'").run();
    expect(await related('mail.parent.com')).toBe(true);
    expect(await related('parent.com.evil.net')).toBe(false);
  });
});

describe('round 5, finding 3: the confirming second read', () => {
  it('PROOF_CONFIRM_DELAY_MS is clamped to 1000 ms outside tests (0 included), honoured under test, default 2000', () => {
    expect(confirmDelayMs({ PROOF_CONFIRM_DELAY_MS: '0' }, false)).toBe(1000);
    expect(confirmDelayMs({ PROOF_CONFIRM_DELAY_MS: '10' }, false)).toBe(1000);
    expect(confirmDelayMs({ PROOF_CONFIRM_DELAY_MS: '5000' }, false)).toBe(5000);
    expect(confirmDelayMs({}, false)).toBe(2000);
    expect(confirmDelayMs({ PROOF_CONFIRM_DELAY_MS: 'abc' }, false)).toBe(2000);
    expect(confirmDelayMs({ PROOF_CONFIRM_DELAY_MS: '0' }, true)).toBe(0);
  });

  it('the two reads of a rival claim go to different resolvers (cloudflare-dns.com, then dns.google)', async () => {
    const { s } = await held();
    s.w.cf.validTokens!.delete(TOKEN_C);
    const hosts: string[] = [];
    const prev = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: any, init?: any) => {
      const u = new URL(String(input.url ?? input));
      if (u.searchParams.get('type') === 'NS' && u.searchParams.get('name') === 'sold.com') { hosts.push(u.hostname); return new Response(JSON.stringify({ Status: 3 }), { status: 200 }); }
      return prev(input, init);
    });
    expect((await s.claim(s.w.B.token, 'sold.com')).status).toBe(202);
    expect(hosts).toEqual(['cloudflare-dns.com', 'dns.google']);
  });

  it('a local DOH_BASE_URL (testing) stays in force for both reads', () => {
    expect(confirmResolverFor({ DOH_BASE_URL: 'http://127.0.0.1:8787' })).toBeDefined();
    expect(dohEndpoint('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787/dns-query');
  });
});

describe('round 5, finding 4: junk rows cannot delay healthy ones', () => {
  const DAY = 86_400_000;
  it('2,000 never-answering rows and one moved-away healthy row: the healthy one is withdrawn on day 2 (first read, then the confirming read a day later)', async () => {
    const s = await setup({});
    const ins = s.w.db.sqlite.prepare("INSERT INTO domains (workspace_id, domain, rua_address, verified_via, cf_zone_id, cf_zone_name, cf_name_servers) VALUES (?, ?, '', 'cloudflare', ?, ?, ?)");
    for (let i = 0; i < 2000; i++) ins.run(s.w.B.ws, `stall${i}.com`, zid(`stall${i}`), `stall${i}.com`, JSON.stringify(CF_NS));
    ins.run(s.w.A.ws, 'moved.com', zid('moved'), 'moved.com', JSON.stringify(CF_NS));
    s.w.db.sqlite.prepare("UPDATE domains SET proof_answered_at = ? WHERE domain = 'moved.com'").run(1_800_000_000 - 3600); // it has answered before: a healthy row
    const resolver = resolverOf(name => (name.startsWith('stall') ? { status: 'error', answers: [], error: 'SERVFAIL' } : { status: 'ok', answers: [{ name, type: 2, ttl: 1, data: 'other.provider.net' }] }));
    const t0 = 1_800_000_000_000;
    const asked: string[][] = [];
    const wrapped = { ...resolver, resolve: async (n: string, t: string) => { (asked.at(-1) ?? []).push(n); return resolver.resolve(n); } };
    const verdicts: string[] = [];
    for (let day = 1; day <= 4; day++) {
      asked.push([]);
      await recheckZoneProofs(s.w.env, { resolver: wrapped, now: () => t0 + day * DAY });
      verdicts.push(s.w.rows("SELECT verified_via FROM domains WHERE domain = 'moved.com'")[0].verified_via);
    }
    // It is in the answered queue: read on day 1 (suspected) and day 2 (confirmed a day later), whatever the 2,000 junk rows do (they take the 40 reserved slots).
    expect(verdicts).toEqual(['cloudflare', 'legacy', 'legacy', 'legacy']);
    expect(asked[0]).toContain('moved.com');
    expect(asked[0].filter(n => n.startsWith('stall'))).toHaveLength(199); // 200 slots: the healthy row, and the rest shared by the junk (which is lent the answered queue's unused slots)
  });

  it('answering rows are served first; never-answering rows keep a reserved share (40 of 200) and rotate through it', async () => {
    const s = await setup({});
    const ins = s.w.db.sqlite.prepare("INSERT INTO domains (workspace_id, domain, rua_address, verified_via, cf_zone_id, cf_zone_name, cf_name_servers, proof_answered_at) VALUES (?, ?, '', 'cloudflare', ?, ?, ?, ?)");
    const t0 = 1_800_000_000_000;
    for (let i = 0; i < 400; i++) ins.run(s.w.B.ws, `good${i}.com`, zid(`good${i}`), `good${i}.com`, JSON.stringify(CF_NS), t0 / 1000 - 3600);
    for (let i = 0; i < 400; i++) ins.run(s.w.B.ws, `junk${i}.com`, zid(`junk${i}`), `junk${i}.com`, JSON.stringify(CF_NS), null);
    const seen = { good: new Set<string>(), junk: new Set<string>() };
    const perDay: Array<[number, number]> = [];
    const resolver = resolverOf(name => ({ status: name.startsWith('junk') ? 'error' : 'ok', answers: name.startsWith('junk') ? [] : CF_NS.map(d => ({ name, type: 2, ttl: 1, data: d })) }));
    const day = { n: 0, good: 0, junk: 0 };
    const counting = { ...resolver, resolve: async (n: string) => { if (n.startsWith('good')) { day.good++; seen.good.add(n); } else { day.junk++; seen.junk.add(n); } return resolver.resolve(n); } };
    for (let d = 1; d <= 10; d++) {
      day.good = 0; day.junk = 0;
      await recheckZoneProofs(s.w.env, { resolver: counting, now: () => t0 + d * DAY });
      perDay.push([day.good, day.junk]);
    }
    expect(perDay.slice(0, 2)).toEqual([[160, 40], [160, 40]]);
    expect(seen.good.size).toBe(400); // 400 / 160 = 3 days to cover every healthy row
    expect(seen.junk.size).toBe(400); // 400 / 40 = 10 days for the never-answered ones
  });

  it('a row that answered long ago and went silent falls back to the shared queue', async () => {
    const s = await setup({});
    const t0 = 1_800_000_000_000;
    s.w.db.sqlite.prepare("INSERT INTO domains (workspace_id, domain, rua_address, verified_via, cf_zone_id, cf_zone_name, cf_name_servers, proof_answered_at) VALUES (?, 'old.com', '', 'cloudflare', ?, 'old.com', ?, ?)").run(s.w.B.ws, zid('old'), JSON.stringify(CF_NS), t0 / 1000 - ANSWERED_WINDOW_SECONDS - 10);
    const due = await claimLookups(s.w.env.DB).zoneVerifiedDue(200, t0 / 1000, { reserved: 40, answeredWithinSeconds: ANSWERED_WINDOW_SECONDS });
    expect(due.map(r => r.domain)).toEqual(['old.com']);
    const ins = s.w.db.sqlite.prepare("INSERT INTO domains (workspace_id, domain, rua_address, verified_via, cf_zone_id, cf_zone_name, cf_name_servers, proof_answered_at) VALUES (?, ?, '', 'cloudflare', ?, ?, ?, ?)");
    for (let i = 0; i < 200; i++) ins.run(s.w.B.ws, `good${i}.com`, zid(`good${i}`), `good${i}.com`, JSON.stringify(CF_NS), t0 / 1000 - 5);
    const full = await claimLookups(s.w.env.DB).zoneVerifiedDue(200, t0 / 1000, { reserved: 40, answeredWithinSeconds: ANSWERED_WINDOW_SECONDS });
    expect(full).toHaveLength(200);
    expect(full.filter(r => r.domain === 'old.com')).toHaveLength(1); // got one of the 40 reserved slots
    expect(full.filter(r => r.domain.startsWith('good'))).toHaveLength(199); // the reserved slots nobody else wants go to answering rows
  });
});
