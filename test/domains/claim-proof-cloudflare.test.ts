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
  const live: { name: string; status?: string; type?: string; name_servers?: string[]; account?: { id: string }; permissions?: string[] } = { name: 'acme.com', status: 'active', type: 'full', name_servers: ['a.ns.cloudflare.com', 'b.ns.cloudflare.com'], account: { id: 'acct-1' }, permissions: ['#zone:read', '#dns_records:edit'] };
  vi.stubGlobal('fetch', async (url: string, init?: unknown) => dohFetch({ 'NS acme.com': NS, 'NS harbor-lane.org': NS, ...dns }, dnsCalls)(url, init as any));
  vi.spyOn(ConnectionService.prototype, 'clientFor').mockImplementation(async () => ({
    getZone: async (id: string) => ({ id, ...live }),
  }) as any);
  const claim = async (who: { token: string }, domain: string) => (await json(await call(env, 'POST', '/api/domains', { key: who.token, body: { domain } }))).claim as { id: number };
  const verify = (who: { token: string }, id: number) => call(env, 'POST', `/api/domains/claims/${id}/verify`, { key: who.token });
  const connect = (ws: string, opts: { allowed?: boolean; blocked?: boolean; status?: string; zone?: string; id?: string; account?: string | null; zoneAccount?: string | null; authType?: 'token' | 'oauth'; scopes?: string | null } = {}) => {
    const zone = opts.zone ?? 'acme.com';
    const id = opts.id ?? 'cfc_1';
    db.sqlite.prepare("INSERT INTO cloudflare_connections (id, workspace_id, label, auth_type, token_envelope, status, cf_account_id, scopes) VALUES (?, ?, 'x', ?, 'e', ?, ?, ?)").run(id, ws, opts.authType ?? 'token', opts.status ?? 'active', opts.account === undefined ? 'acct-1' : opts.account, opts.scopes ?? null);
    if (opts.allowed ?? true) db.sqlite.prepare("INSERT INTO cloudflare_connection_zones (connection_id, workspace_id, zone_id, zone_name, cf_account_id) VALUES (?, ?, ?, ?, ?)").run(id, ws, ZONE_ID, zone, opts.zoneAccount === undefined ? 'acct-1' : opts.zoneAccount);
    if (opts.blocked) db.sqlite.prepare("INSERT INTO cloudflare_connection_blocked_zones (connection_id, workspace_id, zone_id, zone_name) VALUES (?, ?, ?, ?)").run(id, ws, ZONE_ID, zone);
    live.name = zone;
    dns[`NS ${zone}`] = NS;
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

describe('what a zone proof has to establish (added with the first-run import)', () => {
  it('a zone in another Cloudflare account than the connection\'s does not verify', async () => {
    const w = await world();
    const c = await w.claim(w.A, 'acme.com');
    w.connect(w.A.ws, { account: 'acct-1', zoneAccount: 'acct-1' });
    w.live.account = { id: 'acct-2' };
    expect((await w.verify(w.A, c.id)).status).toBe(422);
    expect(w.rows('SELECT * FROM domains')).toEqual([]);
  });

  it('a grant that covers several accounts (no account on the connection) is held to the account recorded for the zone', async () => {
    const w = await world();
    const c = await w.claim(w.A, 'acme.com');
    w.connect(w.A.ws, { account: null, zoneAccount: 'acct-1' });
    w.live.account = { id: 'acct-9' };
    expect((await w.verify(w.A, c.id)).status).toBe(422);
    w.live.account = { id: 'acct-1' };
    expect((await w.verify(w.A, c.id)).status).toBe(201);
  });

  it('a token without DNS edit on the zone does not verify; neither does one whose permissions Cloudflare does not say', async () => {
    const w = await world();
    const c = await w.claim(w.A, 'acme.com');
    w.connect(w.A.ws);
    w.live.permissions = ['#zone:read'];
    expect((await w.verify(w.A, c.id)).status).toBe(422);
    w.live.permissions = undefined;
    expect((await w.verify(w.A, c.id)).status).toBe(422);
    expect(w.rows('SELECT * FROM domains')).toEqual([]);
  });

  it('an OAuth grant whose scopes include DNS write is enough without a permissions list; a read-only grant is not', async () => {
    const w = await world();
    const c = await w.claim(w.A, 'acme.com');
    w.connect(w.A.ws, { authType: 'oauth', scopes: 'zone.read account-settings.read' });
    w.live.permissions = undefined;
    expect((await w.verify(w.A, c.id)).status).toBe(422);
    w.db.sqlite.prepare("UPDATE cloudflare_connections SET scopes = 'zone.read dns_records.write' WHERE id = 'cfc_1'").run();
    expect((await w.verify(w.A, c.id)).status).toBe(201);
  });

  describe('public suffixes', () => {
    it('a zone named co.uk proves nothing, not even example.co.uk', async () => {
      const w = await world();
      const c = await w.claim(w.A, 'example.co.uk');
      w.connect(w.A.ws, { zone: 'co.uk' });
      expect((await w.verify(w.A, c.id)).status).toBe(422);
      expect(w.rows('SELECT * FROM domains')).toEqual([]);
    });

    it('an example.co.uk zone proves example.co.uk and mail.example.co.uk, not the lookalike notexample.co.uk', async () => {
      const w = await world();
      w.connect(w.A.ws, { zone: 'example.co.uk' });
      // Adding a name inside a connected zone verifies it on the spot (admitDomain), no claim is made.
      for (const name of ['mail.example.co.uk', 'example.co.uk']) {
        expect((await call(w.env, 'POST', '/api/domains', { key: w.A.token, body: { domain: name } })).status).toBe(201);
      }
      const look = await call(w.env, 'POST', '/api/domains', { key: w.A.token, body: { domain: 'notexample.co.uk' } });
      expect(look.status).toBe(202); // a claim: the TXT record is the way
      expect(w.rows('SELECT domain, verified_via FROM domains ORDER BY domain')).toEqual([
        { domain: 'example.co.uk', verified_via: 'cloudflare' },
        { domain: 'mail.example.co.uk', verified_via: 'cloudflare' }, // each by its own zone proof: the subdomain was added first
      ]);
    });
  });

  describe('two workspaces', () => {
    it('B holding a claim on the exact name A verified is refused: the first to verify wins, whatever B\'s zone says', async () => {
      const w = await world();
      const c = await w.claim(w.B, 'harbor-lane.org');
      w.verified(w.A.ws, 'harbor-lane.org');
      w.connect(w.B.ws, { zone: 'harbor-lane.org' });
      const res = await w.verify(w.B, c.id);
      expect(res.status).toBe(409);
      expect((await json(res)).code).toBe('domain_taken');
      expect(w.rows('SELECT * FROM domains WHERE workspace_id = ?', w.B.ws)).toEqual([]);
    });

    it('both may hold a pending claim on one name; whoever proves it first gets it and the other claim is lost', async () => {
      const w = await world();
      const a = await w.claim(w.A, 'acme.com');
      const b = await w.claim(w.B, 'acme.com');
      w.connect(w.A.ws, { id: 'cfc_a' });
      w.connect(w.B.ws, { id: 'cfc_b', zone: 'acme.com' });
      expect((await w.verify(w.A, a.id)).status).toBe(201);
      expect((await w.verify(w.B, b.id)).status).toBe(409);
      expect(w.rows("SELECT workspace_id FROM domains WHERE domain = 'acme.com'")).toEqual([{ workspace_id: w.A.ws }]);
      expect(w.rows('SELECT status FROM domain_claims WHERE id = ?', b.id)).toEqual([{ status: 'lost' }]);
    });
  });

  it('the zone comes from the server\'s own read: a zone id, name or connection in the request body is ignored', async () => {
    const w = await world();
    const c = await w.claim(w.A, 'evil-site.org');
    const ok = await w.claim(w.A, 'shop.acme.com');
    w.connect(w.A.ws); // acme.com is the allowed zone
    const forged = await call(w.env, 'POST', `/api/domains/claims/${c.id}/verify`, { key: w.A.token, body: { zone_id: ZONE_ID, zone_name: 'evil-site.org', connection_id: 'cfc_1' } });
    expect(forged.status).toBe(422);
    expect(w.rows('SELECT * FROM domains')).toEqual([]);
    const res = await call(w.env, 'POST', `/api/domains/claims/${ok.id}/verify`, { key: w.A.token, body: { zone_id: '9'.repeat(32), zone_name: 'something-else.com' } });
    expect(res.status).toBe(201);
    expect(w.rows("SELECT cf_zone_id, cf_account_id FROM domains WHERE domain = 'shop.acme.com'")).toEqual([{ cf_zone_id: ZONE_ID, cf_account_id: 'acct-1' }]);
  });

  it('records the proof: on the domain row, and as a domain.proof audit entry with method, account, zone, connection and time', async () => {
    const w = await world();
    const c = await w.claim(w.A, 'acme.com');
    w.connect(w.A.ws);
    const before = Math.floor(Date.now() / 1000);
    expect((await w.verify(w.A, c.id)).status).toBe(201);
    const row = w.rows("SELECT verified_via, cf_account_id, cf_zone_id, verified_at FROM domains WHERE domain = 'acme.com'")[0];
    expect(row).toMatchObject({ verified_via: 'cloudflare', cf_account_id: 'acct-1', cf_zone_id: ZONE_ID });
    expect(row.verified_at).toBeGreaterThanOrEqual(before - 1);
    const audit = w.rows("SELECT after_value, resource_name FROM audit_log WHERE action = 'domain.proof'");
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0].after_value)).toMatchObject({ method: 'cloudflare_zone', cf_account_id: 'acct-1', zone_id: ZONE_ID, zone_name: 'acme.com', connection_id: 'cfc_1' });
    expect(JSON.parse(audit[0].after_value).at).toBeGreaterThanOrEqual(before - 1);
    expect(audit[0].resource_name).toBe('acme.com');
  });

  it('a TXT-proven domain records no Cloudflare proof', async () => {
    const w = await world();
    const c = await w.claim(w.A, 'acme.com');
    const claim = w.rows('SELECT token FROM domain_claims WHERE id = ?', c.id)[0];
    w.dns['TXT _readysetmail.acme.com'] = [`readysetmail-verify=${claim.token}`];
    expect((await w.verify(w.A, c.id)).status).toBe(201);
    expect(w.rows("SELECT cf_account_id, cf_zone_id, verified_at FROM domains WHERE domain = 'acme.com'")).toEqual([{ cf_account_id: null, cf_zone_id: null, verified_at: null }]);
    expect(w.rows("SELECT * FROM audit_log WHERE action = 'domain.proof'")).toEqual([]);
  });

  it('stays verified when the token is revoked afterwards or the connection is removed', async () => {
    const w = await world();
    const c = await w.claim(w.A, 'acme.com');
    w.connect(w.A.ws);
    expect((await w.verify(w.A, c.id)).status).toBe(201);
    w.db.sqlite.prepare("UPDATE cloudflare_connections SET status = 'revoked' WHERE id = 'cfc_1'").run();
    expect(w.rows("SELECT verified_via FROM domains WHERE domain = 'acme.com'")).toEqual([{ verified_via: 'cloudflare' }]);
    expect((await json(await call(w.env, 'GET', '/api/domains', { key: w.A.token }))).domains.map((d: any) => d.domain)).toEqual(['acme.com']);
    w.db.sqlite.prepare("DELETE FROM cloudflare_connections WHERE id = 'cfc_1'").run();
    expect(w.rows("SELECT verified_via, cf_zone_id FROM domains WHERE domain = 'acme.com'")).toEqual([{ verified_via: 'cloudflare', cf_zone_id: ZONE_ID }]);
    expect((await w.verify(w.A, c.id)).status).toBe(200); // a repeat answers with the domain it became
  });
});
