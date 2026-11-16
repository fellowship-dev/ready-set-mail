// First run: the zones a connection can see become verified domains without a click (src/connections/import.ts).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { call, signupVerified } from '../auth/helpers';
import { CF_NS } from '../helpers/cf-fake';
import { world, type World } from './world';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));

beforeEach(() => { for (const m of ['warn', 'log', 'error', 'info'] as const) vi.spyOn(console, m).mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const json = async (r: Response) => await r.json() as any;
const zid = (n: string) => Buffer.from(n).toString('hex').padEnd(32, '0').slice(0, 32);
const CONNECTIONS = '/api/cloudflare/connections';

/** A workspace of its own (C) with nothing in it, and a Cloudflare that holds exactly `zones`. */
async function setup(zones: Record<string, { account?: string; accountName?: string; status?: string; type?: string; nameServers?: string[] }>, extraEnv: Record<string, unknown> = {}) {
  const w = await world(extraEnv);
  const token = await signupVerified(w.env, 'c@example.com');
  const ws = w.rows('SELECT m.workspace_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ?', 'c@example.com')[0].workspace_id as string;
  for (const k of Object.keys(w.cf.zones)) delete w.cf.zones[k]; // A's and B's zones are not part of this story
  for (const [name, z] of Object.entries(zones)) w.cf.zones[name] = { id: zid(name), cfAccountId: z.account ?? 'acct-1', cfAccountName: z.accountName ?? 'Example Co', status: z.status, type: z.type, nameServers: z.nameServers };
  w.cf.accounts = [...new Map(Object.values(w.cf.zones).map(z => [z.cfAccountId!, { id: z.cfAccountId!, name: z.cfAccountName! }])).values()];
  const C = { token, ws };
  const connect = async (secret = 'secret-token-aaaaaaaaaaaa-1') => (await w.addToken(C.token, secret)).id;
  const imp = (id: string, body?: unknown) => w.api(C.token, 'POST', `${CONNECTIONS}/${id}/import`, body);
  const domains = () => w.rows('SELECT domain, verified_via, cf_account_id, cf_zone_id, cf_connection_id FROM domains WHERE workspace_id = ? ORDER BY domain', C.ws);
  const dnsWrites = () => w.cf.calls.filter(c => /\/dns_records|\/email\/routing/.test(c.url) && c.method !== 'GET');
  return { w, C, connect, imp, domains, dnsWrites };
}

describe('import after connecting', () => {
  it('adds every active zone, verified through the connection, and writes nothing to DNS', async () => {
    const s = await setup({ 'one.com': {}, 'two.org': {}, 'three.net': {} });
    const id = await s.connect();
    const res = await json(await s.imp(id));
    expect(res.imported.map((i: any) => i.domain).sort()).toEqual(['one.com', 'three.net', 'two.org']);
    expect(res.skipped).toEqual([]);
    expect(res.accounts).toEqual([{ id: 'acct-1', name: 'Example Co' }]);
    expect(s.domains()).toEqual([
      { domain: 'one.com', verified_via: 'cloudflare', cf_account_id: 'acct-1', cf_zone_id: zid('one.com'), cf_connection_id: id },
      { domain: 'three.net', verified_via: 'cloudflare', cf_account_id: 'acct-1', cf_zone_id: zid('three.net'), cf_connection_id: id },
      { domain: 'two.org', verified_via: 'cloudflare', cf_account_id: 'acct-1', cf_zone_id: zid('two.org'), cf_connection_id: id },
    ]);
    expect(s.dnsWrites()).toEqual([]);
    // the allow-list is what was imported
    expect(s.w.rows('SELECT zone_name FROM cloudflare_connection_zones WHERE workspace_id = ? ORDER BY zone_name', s.C.ws).map(r => r.zone_name)).toEqual(['one.com', 'three.net', 'two.org']);
    expect(s.w.rows("SELECT resource_name FROM audit_log WHERE workspace_id = ? AND action = 'domain.proof' ORDER BY resource_name", s.C.ws).map(r => r.resource_name)).toEqual(['one.com', 'three.net', 'two.org']);
  });

  it('skips a zone that is pending, moved, partial, secondary, or not delegated: no domain, no claim, not on the allow-list', async () => {
    const s = await setup({
      'good.com': {}, 'waiting.com': { status: 'pending' }, 'gone.com': { status: 'moved' },
      'cname.com': { type: 'partial' }, 'second.com': { type: 'secondary' }, 'elsewhere.com': { nameServers: ['ns1.elsewhere.test'] },
    });
    // elsewhere.com: Cloudflare names its own servers, but public DNS is delegated to someone else
    s.w.cf.ns['elsewhere.com'] = ['ns1.registrar.test'];
    const id = await s.connect();
    const res = await json(await s.imp(id));
    expect(res.imported.map((i: any) => i.domain)).toEqual(['good.com']);
    expect(res.skipped.map((k: any) => k.domain).sort()).toEqual(['cname.com', 'elsewhere.com', 'second.com']); // pending and moved zones are not even listed (active only)
    expect(s.domains().map(d => d.domain)).toEqual(['good.com']);
    expect(s.w.rows('SELECT * FROM domain_claims WHERE workspace_id = ?', s.C.ws)).toEqual([]);
    expect(s.w.rows('SELECT zone_name FROM cloudflare_connection_zones WHERE workspace_id = ?', s.C.ws).map(r => r.zone_name)).toEqual(['good.com']);
  });

  it('is idempotent: a second import and a second grant for the same account add nothing', async () => {
    const s = await setup({ 'one.com': {}, 'two.org': {} });
    const first = await s.connect('secret-token-aaaaaaaaaaaa-1');
    expect((await json(await s.imp(first))).imported).toHaveLength(2);
    const again = await json(await s.imp(first));
    expect(again.imported).toEqual([]);
    expect(again.already).toBe(2);
    const second = await s.connect('secret-token-aaaaaaaaaaaa-2');
    const viaSecond = await json(await s.imp(second));
    expect(viaSecond.imported).toEqual([]);
    expect(viaSecond.already).toBe(2);
    expect(s.domains()).toHaveLength(2);
    expect(s.domains().every(d => d.cf_connection_id === first)).toBe(true); // a working link is not taken away
  });

  it('settles pending claims for imported names, and for names inside an imported zone', async () => {
    const s = await setup({ 'one.com': {} });
    // claims first: one.com is not provable yet (no connection)
    expect((await call(s.w.env, 'POST', '/api/domains', { key: s.C.token, body: { domain: 'one.com' } })).status).toBe(202);
    expect((await call(s.w.env, 'POST', '/api/domains', { key: s.C.token, body: { domain: 'shop.one.com' } })).status).toBe(202);
    const id = await s.connect();
    const res = await json(await s.imp(id));
    expect(res.imported.map((i: any) => i.domain)).toEqual(['one.com']);
    expect(res.verified_claims).toEqual(['shop.one.com']);
    expect(s.domains().map(d => d.domain)).toEqual(['one.com', 'shop.one.com']);
    expect(s.w.rows('SELECT settled_at FROM domain_claims WHERE workspace_id = ? AND settled_at IS NULL', s.C.ws)).toEqual([]);
  });

  it('saving the allow-list verifies pending claims by itself, with no click', async () => {
    const s = await setup({ 'one.com': {}, 'two.org': {} });
    for (const d of ['one.com', 'two.org']) expect((await call(s.w.env, 'POST', '/api/domains', { key: s.C.token, body: { domain: d } })).status).toBe(202);
    const id = await s.connect();
    expect(s.domains()).toEqual([]); // connecting alone proves nothing: the zone list is the person's, and it is empty
    const put = await json(await s.w.api(s.C.token, 'PUT', `${CONNECTIONS}/${id}/zones`, { zone_ids: [zid('one.com')] }));
    expect(put.verified_claims).toEqual(['one.com']);
    expect(s.domains().map(d => [d.domain, d.verified_via])).toEqual([['one.com', 'cloudflare']]);
    expect(s.w.rows("SELECT domain FROM domain_claims WHERE workspace_id = ? AND settled_at IS NULL", s.C.ws).map(r => r.domain)).toEqual(['two.org']); // not in the list: still pending, TXT is the way
  });

  it('a zone id the connection cannot see is refused; names from the browser are never read', async () => {
    const s = await setup({ 'one.com': {} });
    const id = await s.connect();
    const bad = await s.imp(id, { zone_ids: ['f'.repeat(32)], zone_names: ['evil.com'] });
    expect(bad.status).toBe(400);
    expect(s.domains()).toEqual([]);
    expect((await s.imp('cfc_nope')).status).toBe(404);
  });

  it('a broken connection imports nothing', async () => {
    const s = await setup({ 'one.com': {} });
    const id = await s.connect();
    s.w.db.sqlite.prepare("UPDATE cloudflare_connections SET status = 'broken' WHERE id = ?").run(id);
    expect((await s.imp(id)).status).toBe(409);
  });
});

describe('the plan', () => {
  it('asks the person to choose when the zones do not fit, and imports nothing before they do', async () => {
    const s = await setup({ 'a1.com': {}, 'a2.com': {}, 'a3.com': {}, 'a4.com': {}, 'a5.com': {} }, { MAX_DOMAINS_PER_WORKSPACE: '3' });
    const id = await s.connect();
    const res = await json(await s.imp(id));
    expect(res.imported).toEqual([]);
    expect(res.needs_selection).toMatchObject({ room: 3, cap: 3 });
    expect(res.needs_selection.zones.map((z: any) => z.name)).toEqual(['a1.com', 'a2.com', 'a3.com', 'a4.com', 'a5.com']);
    expect(s.domains()).toEqual([]);
    expect(s.w.rows('SELECT * FROM cloudflare_connection_zones WHERE workspace_id = ?', s.C.ws)).toEqual([]);
  });

  it('refuses a choice larger than the room (server side), accepts one that fits, and counts the domains already held', async () => {
    const s = await setup({ 'a1.com': {}, 'a2.com': {}, 'a3.com': {}, 'a4.com': {}, 'a5.com': {} }, { MAX_DOMAINS_PER_WORKSPACE: '3' });
    const id = await s.connect();
    const all = Object.values(s.w.cf.zones).map(z => z.id);
    const tooMany = await s.imp(id, { zone_ids: all.slice(0, 4) });
    expect(tooMany.status).toBe(403);
    expect((await json(tooMany)).code).toBe('plan_limit');
    expect(s.domains()).toEqual([]);
    const ok = await json(await s.imp(id, { zone_ids: all.slice(0, 2) }));
    expect(ok.imported).toHaveLength(2);
    // one place is left: importing the rest automatically does not fit any more
    const next = await json(await s.imp(id));
    expect(next.needs_selection).toMatchObject({ room: 1, cap: 3 });
    expect(next.needs_selection.zones).toHaveLength(3);
    expect(s.domains()).toHaveLength(2);
  });
});

describe('removed domains', () => {
  it('stay removed on a later import, are suggested, and come back when the person asks for them', async () => {
    const s = await setup({ 'one.com': {}, 'two.org': {} });
    const id = await s.connect();
    await s.imp(id);
    const one = s.w.rows("SELECT id FROM domains WHERE domain = 'one.com'")[0].id;
    expect((await call(s.w.env, 'DELETE', `/api/domains/${one}`, { key: s.C.token })).status).toBe(200);
    expect(s.w.rows('SELECT domain FROM removed_domains WHERE workspace_id = ?', s.C.ws)).toEqual([{ domain: 'one.com' }]);

    const again = await json(await s.imp(id));
    expect(again.imported).toEqual([]);
    expect(again.removed).toBe(1);
    expect(s.domains().map(d => d.domain)).toEqual(['two.org']);

    const sug = (await json(await s.w.api(s.C.token, 'GET', '/api/cloudflare/suggestions'))).suggestions;
    expect(sug).toEqual([expect.objectContaining({ name: 'one.com', removed: true, zone_id: zid('one.com'), account_name: 'Example Co' })]);

    const back = await json(await s.imp(id, { zone_ids: [zid('one.com')] }));
    expect(back.imported.map((i: any) => i.domain)).toEqual(['one.com']);
    expect(s.w.rows('SELECT * FROM removed_domains WHERE workspace_id = ?', s.C.ws)).toEqual([]);
  });

  it('a zone that appears in Cloudflare later is suggested, not added', async () => {
    const s = await setup({ 'one.com': {} });
    const id = await s.connect();
    await s.imp(id);
    s.w.cf.zones['new.io'] = { id: zid('new.io'), cfAccountId: 'acct-1', cfAccountName: 'Example Co' };
    const sug = (await json(await s.w.api(s.C.token, 'GET', '/api/cloudflare/suggestions'))).suggestions;
    expect(sug.map((x: any) => [x.name, x.removed])).toEqual([['new.io', false]]);
    expect(s.domains().map(d => d.domain)).toEqual(['one.com']);
    expect((await json(await s.imp(id))).imported.map((i: any) => i.domain)).toEqual(['new.io']); // reconnecting is the person asking
  });
});

describe('several Cloudflare accounts', () => {
  it('one grant covering two accounts imports both, each domain records its own account, and the accounts are listed by name', async () => {
    const s = await setup({ 'one.com': { account: 'acct-1', accountName: 'Example Co' }, 'two.org': { account: 'acct-2', accountName: 'Side Project' } });
    const id = await s.connect();
    const res = await json(await s.imp(id));
    expect(res.imported).toHaveLength(2);
    expect(res.accounts.map((a: any) => a.name).sort()).toEqual(['Example Co', 'Side Project']);
    expect(s.domains().map(d => [d.domain, d.cf_account_id])).toEqual([['one.com', 'acct-1'], ['two.org', 'acct-2']]);
    const list = await json(await s.w.api(s.C.token, 'GET', CONNECTIONS));
    expect(list.accounts.map((a: any) => [a.id, a.name, a.domains, a.state])).toEqual([['acct-1', 'Example Co', 1, 'working'], ['acct-2', 'Side Project', 1, 'working']]);
    expect(list.accounts[0].connected_by).toBe('c@example.com');
    expect(list.connections[0].accounts.map((a: any) => a.name).sort()).toEqual(['Example Co', 'Side Project']);
  });

  it('the same account reached through two grants is listed once, with both connections, and no domain is added twice', async () => {
    const s = await setup({ 'one.com': {} });
    const a = await s.connect('secret-token-aaaaaaaaaaaa-1');
    const b = await s.connect('secret-token-aaaaaaaaaaaa-2');
    await s.imp(a); await s.imp(b);
    expect(s.domains()).toHaveLength(1);
    const list = await json(await s.w.api(s.C.token, 'GET', CONNECTIONS));
    expect(list.accounts).toHaveLength(1);
    expect(list.accounts[0]).toMatchObject({ id: 'acct-1', domains: 1, state: 'working' });
    expect(list.accounts[0].connections.map((c: any) => c.id).sort()).toEqual([a, b].sort());
  });

  it('an account whose only connection is broken needs reconnecting; the domains stay verified', async () => {
    const s = await setup({ 'one.com': {} });
    const id = await s.connect();
    await s.imp(id);
    s.w.db.sqlite.prepare("UPDATE cloudflare_connections SET status = 'broken' WHERE id = ?").run(id);
    const list = await json(await s.w.api(s.C.token, 'GET', CONNECTIONS));
    expect(list.accounts[0]).toMatchObject({ state: 'needs_reconnect', domains: 1 });
    expect(s.domains()[0]).toMatchObject({ domain: 'one.com', verified_via: 'cloudflare' });
  });
});
