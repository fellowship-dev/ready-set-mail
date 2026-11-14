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
  vi.stubGlobal('fetch', dohFetch({}, dnsCalls));
  vi.spyOn(ConnectionService.prototype, 'clientFor').mockImplementation(async () => ({
    getZone: async (id: string) => ({ id, name: 'acme.com', status: 'active' }),
  }) as any);
  const claim = async (who: { token: string }, domain: string) => (await json(await call(env, 'POST', '/api/domains', { key: who.token, body: { domain } }))).claim as { id: number };
  const verify = (who: { token: string }, id: number) => call(env, 'POST', `/api/domains/claims/${id}/verify`, { key: who.token });
  const connect = (ws: string, opts: { allowed?: boolean; blocked?: boolean; status?: string } = {}) => {
    db.sqlite.prepare("INSERT INTO cloudflare_connections (id, workspace_id, label, auth_type, token_envelope, status) VALUES ('cfc_1', ?, 'x', 'token', 'e', ?)").run(ws, opts.status ?? 'active');
    if (opts.allowed ?? true) db.sqlite.prepare("INSERT INTO cloudflare_connection_zones (connection_id, workspace_id, zone_id, zone_name) VALUES ('cfc_1', ?, ?, 'acme.com')").run(ws, ZONE_ID);
    if (opts.blocked) db.sqlite.prepare("INSERT INTO cloudflare_connection_blocked_zones (connection_id, workspace_id, zone_id, zone_name) VALUES ('cfc_1', ?, ?, 'acme.com')").run(ws, ZONE_ID);
  };
  return { db, env, rows, A, B, claim, verify, connect, dnsCalls };
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
});
