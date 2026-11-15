// A domain proven through a Cloudflare zone is linked to the connection whose zone proved it, on every path (claim Verify, Prove again, Add
// domain, bulk add, the import), so Apply via Cloudflare works; and a pending claim that a connection the workspace already has can prove is
// verified without a click when the domain list loads, when its zone is on a saved allow-list: at most one live check per claim per hour and
// five per request (src/connections/import.ts autoVerifyClaims).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { call, inviteAndAccept, signupVerified } from '../auth/helpers';
import { world } from './world';
import { CLAIM_AUTOCHECK_SECONDS, CLAIM_AUTOCHECKS_PER_REQUEST } from '../../src/connections/import';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

beforeEach(() => { for (const m of ['warn', 'log', 'error', 'info'] as const) vi.spyOn(console, m).mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const json = async (r: Response) => await r.json() as any;
const zid = (n: string) => Buffer.from(n).toString('hex').padEnd(32, '0').slice(0, 32);

/** Workspace C (its owner signed up, nothing in it) and a Cloudflare account that holds exactly `zones`. */
async function setup(zones: string[]) {
  const w = await world();
  const token = await signupVerified(w.env, 'c@example.com');
  const ws = w.rows('SELECT m.workspace_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ?', 'c@example.com')[0].workspace_id as string;
  for (const k of Object.keys(w.cf.zones)) delete w.cf.zones[k];
  for (const name of zones) w.cf.zones[name] = { id: zid(name), cfAccountId: 'acct-1', cfAccountName: 'Example Co' };
  w.cf.accounts = [{ id: 'acct-1', name: 'Example Co' }];
  const C = { token, ws };
  /** A pasted-token connection, made the way it was before this release: no import, nothing allowed. */
  const connect = async () => (await w.addToken(C.token, 'secret-token-aaaaaaaaaaaa-1')).id;
  /** A zone on the connection's stored allow-list (cloudflare_connection_zones), as an earlier allow-list save left it. */
  const allow = (connectionId: string, name: string) =>
    w.db.sqlite.prepare('INSERT INTO cloudflare_connection_zones (connection_id, workspace_id, zone_id, zone_name, cf_account_id, cf_account_name) VALUES (?, ?, ?, ?, ?, ?)').run(connectionId, ws, zid(name), name, 'acct-1', 'Example Co');
  /** A claim as sign-up or Add domain left it, days before this release. */
  const seedClaim = (domain: string) => {
    w.db.sqlite.prepare('INSERT INTO domain_claims (workspace_id, domain, token, created_at) VALUES (?, ?, ?, unixepoch() - 3 * 86400)').run(ws, domain, 'a'.repeat(32));
    return w.rows('SELECT id FROM domain_claims WHERE workspace_id = ? AND domain = ?', ws, domain)[0].id as number;
  };
  const row = (domain: string) => w.rows('SELECT id, verified_via, cf_zone_id, cf_connection_id FROM domains WHERE workspace_id = ? AND domain = ?', ws, domain)[0] as { id: number; verified_via: string; cf_zone_id: string | null; cf_connection_id: string | null } | undefined;
  const openClaims = () => w.rows('SELECT domain FROM domain_claims WHERE workspace_id = ? AND settled_at IS NULL ORDER BY domain', ws).map(r => r.domain);
  /** Live checks of a zone: Cloudflare's GET /zones/:id, the read the proof makes. */
  const liveChecks = (name: string) => w.cf.calls.filter(c => c.method === 'GET' && new URL(c.url).pathname.endsWith(`/zones/${zid(name)}`)).length;
  const allowList = () => w.rows('SELECT zone_name FROM cloudflare_connection_zones WHERE workspace_id = ? ORDER BY zone_name', ws).map(r => r.zone_name);
  const apply = (id: number) => w.dmarc(C.token, id);
  return { w, C, connect, allow, seedClaim, row, openClaims, liveChecks, allowList, apply };
}

describe('every path links a zone-proven domain to the connection that proved it', () => {
  it('claim Verify: linked, and Apply via Cloudflare works', async () => {
    const s = await setup(['one.com']);
    const claimId = s.seedClaim('one.com');
    const id = await s.connect();
    s.allow(id, 'one.com');
    const res = await call(s.w.env, 'POST', `/api/domains/claims/${claimId}/verify`, { key: s.C.token });
    expect(res.status).toBe(201);
    expect(s.row('one.com')).toMatchObject({ verified_via: 'cloudflare', cf_zone_id: zid('one.com'), cf_connection_id: id });
    expect((await s.apply(s.row('one.com')!.id)).status).toBe(200);
  });

  it('Prove again: the restored row is linked, and Apply via Cloudflare works', async () => {
    const s = await setup(['one.com']);
    s.w.db.sqlite.prepare("INSERT INTO domains (workspace_id, domain, rua_address, verified_via) VALUES (?, 'one.com', '', 'legacy')").run(s.C.ws);
    const before = s.row('one.com')!;
    expect(before.cf_connection_id).toBeNull();
    const id = await s.connect();
    s.allow(id, 'one.com');
    const res = await call(s.w.env, 'POST', `/api/domains/${before.id}/prove`, { key: s.C.token });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ restored: true });
    expect(s.row('one.com')).toMatchObject({ id: before.id, verified_via: 'cloudflare', cf_connection_id: id });
    expect((await s.apply(before.id)).status).toBe(200);
  });

  it('Add domain and bulk add: linked', async () => {
    const s = await setup(['one.com', 'two.org']);
    const id = await s.connect();
    s.allow(id, 'one.com');
    s.allow(id, 'two.org');
    expect((await call(s.w.env, 'POST', '/api/domains', { key: s.C.token, body: { domain: 'one.com' } })).status).toBe(201);
    expect((await call(s.w.env, 'POST', '/api/domains/bulk-import', { key: s.C.token, body: { domains: 'two.org' } })).status).toBe(201);
    expect(s.row('one.com')).toMatchObject({ verified_via: 'cloudflare', cf_connection_id: id });
    expect(s.row('two.org')).toMatchObject({ verified_via: 'cloudflare', cf_connection_id: id });
    expect((await s.apply(s.row('two.org')!.id)).status).toBe(200);
  });

  it('a TXT proof links nothing', async () => {
    const s = await setup([]);
    const claimId = s.seedClaim('txt-only.com');
    s.w.cf.doh['_readysetmail.txt-only.com'] = [`readysetmail-verify=${'a'.repeat(32)}`];
    expect((await call(s.w.env, 'POST', `/api/domains/claims/${claimId}/verify`, { key: s.C.token })).status).toBe(201);
    expect(s.row('txt-only.com')).toMatchObject({ verified_via: 'txt', cf_connection_id: null });
  });
});

describe('a pending claim a connection can prove is verified without a click', () => {
  it('after connecting: the import verifies and links it, and Apply via Cloudflare works', async () => {
    const s = await setup(['one.com']);
    expect((await call(s.w.env, 'POST', '/api/domains', { key: s.C.token, body: { domain: 'shop.one.com' } })).status).toBe(202);
    const id = await s.connect();
    const res = await json(await s.w.api(s.C.token, 'POST', `/api/cloudflare/connections/${id}/import`));
    expect(res.verified_claims).toEqual(['shop.one.com']);
    expect(s.row('shop.one.com')).toMatchObject({ verified_via: 'cloudflare', cf_connection_id: id });
    expect((await s.apply(s.row('shop.one.com')!.id)).status).toBe(200);
  });

  it('the owner\'s state before this release (claim from sign-up, connection with the zone allowed): verified and linked on the next overview load, with exactly one live check, and none on later loads', async () => {
    const s = await setup(['readysetmail.com']);
    s.seedClaim('readysetmail.com');
    const id = await s.connect();
    s.allow(id, 'readysetmail.com');
    s.w.cf.calls.length = 0;

    const first = await json(await call(s.w.env, 'GET', '/api/domains', { key: s.C.token }));
    expect(first.pending_claims).toEqual([]);
    expect(first.domains.map((d: any) => [d.domain, d.verified_via, d.cf_connection_id])).toEqual([['readysetmail.com', 'cloudflare', id]]);
    expect(s.liveChecks('readysetmail.com')).toBe(1);
    expect(s.openClaims()).toEqual([]);

    s.w.cf.calls.length = 0;
    await call(s.w.env, 'GET', '/api/domains', { key: s.C.token });
    await call(s.w.env, 'GET', '/api/domains', { key: s.C.token });
    expect(s.w.cf.calls).toEqual([]); // nothing pending: later loads cost Cloudflare nothing
    expect((await s.apply(s.row('readysetmail.com')!.id)).status).toBe(200);
  });

  it('a claim whose zone is granted in Cloudflare but not on the saved list stays pending, is offered under "new domains", and Add verifies and links it', async () => {
    const s = await setup(['readysetmail.com']);
    s.seedClaim('readysetmail.com');
    const id = await s.connect();
    s.w.cf.calls.length = 0;
    expect((await json(await call(s.w.env, 'GET', '/api/domains', { key: s.C.token }))).pending_claims.map((c: any) => c.domain)).toEqual(['readysetmail.com']);
    expect(s.w.cf.calls).toEqual([]); // nothing saved to go on: no Cloudflare read
    const sug = await json(await s.w.api(s.C.token, 'GET', '/api/cloudflare/suggestions'));
    expect(sug.suggestions.map((x: any) => x.name)).toEqual(['readysetmail.com']);
    expect(s.liveChecks('readysetmail.com')).toBe(0);
    expect(s.allowList()).toEqual([]); // nothing writes the saved list on a load
    expect(s.openClaims()).toEqual(['readysetmail.com']);

    const add = await json(await s.w.api(s.C.token, 'POST', `/api/cloudflare/connections/${id}/import`, { zone_ids: [zid('readysetmail.com')] }));
    expect(add.imported.map((i: any) => i.domain)).toEqual(['readysetmail.com']);
    expect(s.row('readysetmail.com')).toMatchObject({ verified_via: 'cloudflare', cf_connection_id: id });
    expect(s.openClaims()).toEqual([]);
    expect((await s.apply(s.row('readysetmail.com')!.id)).status).toBe(200);
  });

  it('a claim whose zone is on the saved list is not offered as new', async () => {
    const s = await setup(['readysetmail.com', 'other.net']);
    s.seedClaim('readysetmail.com');
    const id = await s.connect();
    s.allow(id, 'readysetmail.com');
    const sug = await json(await s.w.api(s.C.token, 'GET', '/api/cloudflare/suggestions'));
    expect(sug.suggestions.map((x: any) => x.name)).toEqual(['other.net']);
    expect(s.liveChecks('readysetmail.com')).toBe(0); // the suggestions read verifies nothing; the domain list does
  });

  it('a claim whose zone is not in the account stays pending with the TXT route, and costs no live check', async () => {
    const s = await setup(['one.com']);
    s.seedClaim('elsewhere.org');
    const id = await s.connect();
    s.allow(id, 'one.com');
    s.w.cf.calls.length = 0;
    const list = await json(await call(s.w.env, 'GET', '/api/domains', { key: s.C.token }));
    expect(list.pending_claims).toEqual([expect.objectContaining({ domain: 'elsewhere.org', status: 'pending', txt_name: '_readysetmail.elsewhere.org' })]);
    expect(s.w.cf.calls).toEqual([]);
    expect(s.openClaims()).toEqual(['elsewhere.org']);
  });

  it('a zone that does not prove the claim: it stays pending and is checked at most once an hour', async () => {
    const s = await setup(['moving.com']);
    s.w.cf.ns['moving.com'] = ['ns1.registrar.test']; // public DNS still delegates elsewhere
    s.seedClaim('moving.com');
    const id = await s.connect();
    s.allow(id, 'moving.com');
    vi.useFakeTimers({ toFake: ['Date'] });

    await call(s.w.env, 'GET', '/api/domains', { key: s.C.token });
    expect(s.liveChecks('moving.com')).toBe(1);
    expect(s.openClaims()).toEqual(['moving.com']);
    expect(s.allowList()).toEqual(['moving.com']); // the saved list is left as it was
    await call(s.w.env, 'GET', '/api/domains', { key: s.C.token });
    expect(s.liveChecks('moving.com')).toBe(1); // within the hour: no second check

    vi.setSystemTime(Date.now() + (CLAIM_AUTOCHECK_SECONDS + 1) * 1000);
    delete s.w.cf.ns['moving.com']; // the delegation finished moving
    await call(s.w.env, 'GET', '/api/domains', { key: s.C.token });
    expect(s.liveChecks('moving.com')).toBe(2);
    expect(s.row('moving.com')).toMatchObject({ verified_via: 'cloudflare', cf_connection_id: id });
  });

  it(`checks at most ${CLAIM_AUTOCHECKS_PER_REQUEST} claims per load, the longest unchecked first`, async () => {
    const names = ['c1.com', 'c2.com', 'c3.com', 'c4.com', 'c5.com', 'c6.com', 'c7.com'];
    const s = await setup(names);
    for (const n of names) s.w.cf.ns[n] = ['ns1.registrar.test']; // none proves yet
    for (const n of names) s.seedClaim(n);
    const id = await s.connect();
    for (const n of names) s.allow(id, n);
    vi.useFakeTimers({ toFake: ['Date'] });
    const checked = () => names.filter(n => s.liveChecks(n) > 0);

    await call(s.w.env, 'GET', '/api/domains', { key: s.C.token });
    expect(checked()).toEqual(names.slice(0, 5));
    s.w.cf.calls.length = 0;
    vi.setSystemTime(Date.now() + 60_000);
    await call(s.w.env, 'GET', '/api/domains', { key: s.C.token });
    expect(checked()).toEqual(['c6.com', 'c7.com']);
    s.w.cf.calls.length = 0;
    await call(s.w.env, 'GET', '/api/domains', { key: s.C.token });
    expect(s.w.cf.calls).toEqual([]); // all seven within their hour

    vi.setSystemTime(Date.now() + (CLAIM_AUTOCHECK_SECONDS + 1) * 1000);
    s.w.cf.calls.length = 0;
    await call(s.w.env, 'GET', '/api/domains', { key: s.C.token });
    expect(checked()).toEqual(names.slice(0, 5)); // the oldest checks come round first
  });

  it('a member\'s page load triggers nothing a member could not do: no live check, no verification; the owner\'s next load does it', async () => {
    const s = await setup(['readysetmail.com']);
    s.seedClaim('readysetmail.com');
    const id = await s.connect();
    s.allow(id, 'readysetmail.com');
    const member = await inviteAndAccept(s.w.env, s.C.token, 'm@example.com', 'member');
    s.w.cf.calls.length = 0;

    const seen = await json(await call(s.w.env, 'GET', '/api/domains', { key: member }));
    expect(seen.pending_claims.map((c: any) => c.domain)).toEqual(['readysetmail.com']);
    expect((await call(s.w.env, 'GET', '/api/cloudflare/suggestions', { key: member })).status).toBe(403);
    expect(s.w.cf.calls).toEqual([]);
    expect(s.openClaims()).toEqual(['readysetmail.com']);
    expect(s.w.rows("SELECT key FROM settings WHERE workspace_id = ? AND key LIKE 'cf_claim_autocheck:%'", s.C.ws)).toEqual([]);

    await call(s.w.env, 'GET', '/api/domains', { key: s.C.token });
    expect(s.row('readysetmail.com')).toMatchObject({ verified_via: 'cloudflare', cf_connection_id: id });
  });
});
