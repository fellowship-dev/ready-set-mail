// Verify of a pending claim proves itself through Cloudflare, with no TXT record: only when an allowed zone of an ACTIVE
// connection of THIS workspace contains the domain.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { call, makeEnv, signupVerified } from '../auth/helpers';
import { HOSTED_ENV } from '../hosted/world';
import { dohFetch } from '../../packages/dns-checks/test/helpers';
import { ConnectionService } from '../../src/connections/service';

const json = async (r: Response) => await r.json() as any;
const ZONE_ID = '1'.repeat(32);
afterEach(() => vi.restoreAllMocks());

async function world() {
  const db = createMigratedD1();
  const env = makeEnv(db, { ...HOSTED_ENV });
  const rows = (sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[];
  const mk = async (email: string) => {
    const token = await signupVerified(env, email);
    const ws = rows('SELECT m.workspace_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ?', email)[0].workspace_id as string;
    db.sqlite.prepare("INSERT INTO settings (workspace_id, key, value) VALUES (?, 'reports_domain', ?)").run(ws, `reports.${email.split('@')[0]}.test`);
    return { token, ws };
  };
  const A = await mk('a@example.com');
  const B = await mk('b@example.com');
  // Cloudflare says the zone is active; public DNS holds no claim TXT anywhere (every name is NXDOMAIN).
  const dnsCalls: string[] = [];
  const NS = ['a.ns.cloudflare.com.', 'b.ns.cloudflare.com.'];
  const dns: Record<string, any> = {};
  const live: { name: string; status?: string; type?: string; name_servers?: string[] } = { name: 'acme.com', status: 'active', type: 'full', name_servers: ['a.ns.cloudflare.com', 'b.ns.cloudflare.com'] };
  vi.stubGlobal('fetch', async (url: string, init?: unknown) => dohFetch({ 'NS acme.com': NS, 'NS harbor-lane.org': NS, ...dns }, dnsCalls)(url, init as any));
  vi.spyOn(ConnectionService.prototype, 'clientFor').mockImplementation(async () => ({
    getZone: async (id: string) => ({ id, ...live }),
  }) as any);
  const claim = async (who: { token: string }, domain: string) => (await json(await call(env, 'POST', '/api/domains', { key: who.token, body: { domain } }))).claim as { id: number };
  const verify = (who: { token: string }, id: number) => call(env, 'POST', `/api/domains/claims/${id}/verify`, { key: who.token });
  const connect = (ws: string, opts: { allowed?: boolean; blocked?: boolean; status?: string; zone?: string } = {}) => {
    const zone = opts.zone ?? 'acme.com';
    db.sqlite.prepare("INSERT INTO cloudflare_connections (id, workspace_id, label, auth_type, token_envelope, status) VALUES ('cfc_1', ?, 'x', 'token', 'e', ?)").run(ws, opts.status ?? 'active');
    if (opts.allowed ?? true) db.sqlite.prepare("INSERT INTO cloudflare_connection_zones (connection_id, workspace_id, zone_id, zone_name) VALUES ('cfc_1', ?, ?, ?)").run(ws, ZONE_ID, zone);
    if (opts.blocked) db.sqlite.prepare("INSERT INTO cloudflare_connection_blocked_zones (connection_id, workspace_id, zone_id, zone_name) VALUES ('cfc_1', ?, ?, ?)").run(ws, ZONE_ID, zone);
    live.name = zone;
  };
  /** A domain some workspace has verified (by TXT, say). */
  const verified = (ws: string, domain: string) => db.sqlite.prepare("INSERT INTO domains (workspace_id, domain, rua_address, verified_via) VALUES (?, ?, 'rua@x', 'txt')").run(ws, domain);
  return { db, env, rows, A, B, claim, verify, connect, verified, dnsCalls, live, dns };
}

describe('Verify of a pending claim through Cloudflare', () => {
  it('an allowed zone of the workspace’s active connection verifies it with no TXT record', async () => {
    const w = await world();
    const c = await w.claim(w.A, 'acme.com'); // pending: no connection yet
    expect(w.rows('SELECT * FROM domains')).toEqual([]);
    w.connect(w.A.ws);
    const res = await w.verify(w.A, c.id);
    expect(res.status).toBe(201);
    expect(w.rows("SELECT verified_via FROM domains WHERE domain = 'acme.com'")).toEqual([{ verified_via: 'cloudflare' }]);
    expect(w.dnsCalls.filter(k => /_readysetmail|_inboxangel/.test(k))).toEqual([]); // the claim TXT was never even looked up
  });

  it('a zone that is on the connection but not allowed does not verify', async () => {
    const w = await world();
    const c = await w.claim(w.A, 'acme.com');
    w.connect(w.A.ws, { allowed: false, blocked: true });
    const res = await w.verify(w.A, c.id);
    expect(res.status).toBe(422);
    expect((await json(res)).verified).toBe(false);
    expect(w.rows('SELECT * FROM domains')).toEqual([]);
  });

  it('a connection of another workspace does not verify', async () => {
    const w = await world();
    const c = await w.claim(w.A, 'acme.com');
    w.connect(w.B.ws);
    const res = await w.verify(w.A, c.id);
    expect(res.status).toBe(422);
    expect(w.rows('SELECT * FROM domains')).toEqual([]);
  });

  it('a connection that is not active does not verify', async () => {
    const w = await world();
    const c = await w.claim(w.A, 'acme.com');
    w.connect(w.A.ws, { status: 'broken' });
    expect((await w.verify(w.A, c.id)).status).toBe(422);
    expect(w.rows('SELECT * FROM domains')).toEqual([]);
  });

  describe('only a real, delegated, full zone proves ownership (otherwise the TXT proof)', () => {
    it.each([['partial (CNAME) setup', { type: 'partial' }], ['secondary zone', { type: 'secondary' }], ['no type reported', { type: undefined }], ['pending zone', { status: 'pending' }], ['moved zone', { status: 'moved' }]])('%s does not verify', async (_n, patch) => {
      const w = await world();
      const c = await w.claim(w.A, 'acme.com');
      w.connect(w.A.ws);
      Object.assign(w.live, patch);
      expect((await w.verify(w.A, c.id)).status).toBe(422);
      expect(w.rows('SELECT * FROM domains')).toEqual([]);
    });

    it('public NS records that are not the zone\'s Cloudflare name servers do not verify', async () => {
      const w = await world();
      const c = await w.claim(w.A, 'acme.com');
      w.connect(w.A.ws);
      w.dns['NS acme.com'] = ['ns1.elsewhere.example.'];
      expect((await w.verify(w.A, c.id)).status).toBe(422);
      expect(w.rows('SELECT * FROM domains')).toEqual([]);
    });

    it('one public NS outside the zone\'s list is enough to refuse', async () => {
      const w = await world();
      const c = await w.claim(w.A, 'acme.com');
      w.connect(w.A.ws);
      w.dns['NS acme.com'] = ['a.ns.cloudflare.com.', 'ns1.elsewhere.example.'];
      expect((await w.verify(w.A, c.id)).status).toBe(422);
    });

    it.each([['SERVFAIL'], ['TIMEOUT'], ['NODATA']])('an NS lookup that fails (%s) falls back to the TXT proof: not verified by Cloudflare', async (v) => {
      const w = await world();
      const c = await w.claim(w.A, 'acme.com');
      w.connect(w.A.ws);
      w.dns['NS acme.com'] = v;
      expect((await w.verify(w.A, c.id)).status).toBe(422);
      expect(w.rows('SELECT * FROM domains')).toEqual([]);
    });

    it('Cloudflare not reporting name servers is not proof either', async () => {
      const w = await world();
      const c = await w.claim(w.A, 'acme.com');
      w.connect(w.A.ws);
      w.live.name_servers = undefined;
      expect((await w.verify(w.A, c.id)).status).toBe(422);
    });

    it('the TXT proof still works when Cloudflare does not prove it', async () => {
      const w = await world();
      const c = await w.claim(w.A, 'acme.com');
      w.connect(w.A.ws);
      w.live.type = 'partial';
      const claim = w.rows('SELECT token FROM domain_claims WHERE id = ?', c.id)[0];
      w.dns['TXT _readysetmail.acme.com'] = [`readysetmail-verify=${claim.token}`];
      expect((await w.verify(w.A, c.id)).status).toBe(201);
      expect(w.rows("SELECT verified_via FROM domains WHERE domain = 'acme.com'")).toEqual([{ verified_via: 'txt' }]);
    });
  });

  describe('hosted: a zone does not prove a name next to someone else\'s verified parent or child', () => {
    it('B asks for x.harbor-lane.org while A has verified harbor-lane.org: TXT proof only', async () => {
      const w = await world();
      w.verified(w.A.ws, 'harbor-lane.org');
      const c = await w.claim(w.B, 'x.harbor-lane.org');
      w.connect(w.B.ws, { zone: 'harbor-lane.org' });
      expect((await w.verify(w.B, c.id)).status).toBe(422);
      expect(w.rows("SELECT * FROM domains WHERE workspace_id = ?", w.B.ws)).toEqual([]);
    });

    it('B asks for harbor-lane.org while A has verified x.harbor-lane.org: TXT proof only', async () => {
      const w = await world();
      w.verified(w.A.ws, 'x.harbor-lane.org');
      const c = await w.claim(w.B, 'harbor-lane.org');
      w.connect(w.B.ws, { zone: 'harbor-lane.org' });
      expect((await w.verify(w.B, c.id)).status).toBe(422);
      expect(w.rows("SELECT * FROM domains WHERE workspace_id = ?", w.B.ws)).toEqual([]);
    });

    it('an unrelated name of another workspace, and a lookalike (notharbor-lane.org), do not block', async () => {
      const w = await world();
      w.verified(w.A.ws, 'notharbor-lane.org');
      w.verified(w.A.ws, 'other.example');
      const c = await w.claim(w.B, 'harbor-lane.org');
      w.connect(w.B.ws, { zone: 'harbor-lane.org' });
      expect((await w.verify(w.B, c.id)).status).toBe(201);
    });

    it('the same workspace holding the parent is not "someone else"', async () => {
      const w = await world();
      w.verified(w.B.ws, 'harbor-lane.org');
      const res = await call(w.env, 'POST', '/api/domains', { key: w.B.token, body: { domain: 'x.harbor-lane.org' } });
      expect(res.status).toBe(201); // admitted through its own parent, no claim
    });
  });
});
