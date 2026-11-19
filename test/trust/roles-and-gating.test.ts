// Roles and invites, and what the hosted service switches off.
import { describe, it, expect } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { call, makeEnv, setupOwner, inviteAndAccept } from '../auth/helpers';

const json = async (r: Response) => await r.json() as any;

async function team() {
  const db = createMigratedD1();
  const env = makeEnv(db);
  const owner = await setupOwner(env);
  const admin = await inviteAndAccept(env, owner, 'admin@example.com', 'admin');
  const member = await inviteAndAccept(env, owner, 'member@example.com', 'member');
  const rows = (sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[];
  return { db, env, owner, admin, member, rows };
}
const invite = (w: Awaited<ReturnType<typeof team>>, key: string, email: string, role?: string) =>
  call(w.env, 'POST', '/api/team/invite', { key, body: { email, role } });

describe('who can grant what', () => {
  it('only an owner can invite an admin; admins can invite members', async () => {
    const w = await team();
    expect((await invite(w, w.admin, 'x1@example.com', 'admin')).status).toBe(403);
    expect((await invite(w, w.admin, 'x2@example.com', 'member')).status).toBe(201);
    expect((await invite(w, w.admin, 'x3@example.com')).status).toBe(201);
    expect((await invite(w, w.owner, 'x4@example.com', 'admin')).status).toBe(201);
    expect(w.rows("SELECT email FROM invites WHERE email = 'x1@example.com'")).toEqual([]);
    expect(w.rows("SELECT role FROM invites WHERE email = 'x4@example.com'")).toEqual([{ role: 'admin' }]);
  });

  it('owner cannot be granted by invite, by anyone', async () => {
    const w = await team();
    expect((await invite(w, w.admin, 'o1@example.com', 'owner')).status).toBe(403);
    expect((await invite(w, w.owner, 'o2@example.com', 'owner')).status).toBe(400);
    expect(w.rows("SELECT * FROM invites WHERE email IN ('o1@example.com', 'o2@example.com')")).toEqual([]);
  });

  it('members are read-only: they can read, and cannot invite, list invites, revoke, remove or write anything', async () => {
    const w = await team();
    expect((await call(w.env, 'GET', '/api/domains', { key: w.member })).status).toBe(200);
    expect((await invite(w, w.member, 'm1@example.com')).status).toBe(403);
    expect((await call(w.env, 'GET', '/api/team/invites', { key: w.member })).status).toBe(403);
    expect((await call(w.env, 'DELETE', '/api/team/invites/0123456789abcdef', { key: w.member })).status).toBe(403);
    expect((await call(w.env, 'GET', '/api/team', { key: w.member })).status).toBe(403);
    expect((await call(w.env, 'POST', '/api/domains', { key: w.member, body: { domain: 'x.example.net' } })).status).toBe(403);
    expect((await call(w.env, 'POST', '/api/domains/claims/1/verify', { key: w.member, body: {} })).status).toBe(403);
    expect((await call(w.env, 'POST', '/api/settings/base-domain', { key: w.member, body: { domain: 'x.example.net' } })).status).toBe(403);
    expect(w.rows('SELECT COUNT(*) n FROM invites')).toEqual([{ n: 2 }]); // only the two used to build the team
  });

  it('an admin cannot remove an admin or the owner; only the owner removes an admin', async () => {
    const w = await team();
    const ids = Object.fromEntries(w.rows('SELECT id, email FROM users').map(u => [u.email, u.id]));
    expect((await call(w.env, 'DELETE', `/api/team/${ids['owner@example.com']}`, { key: w.admin })).status).toBe(403);
    expect((await call(w.env, 'DELETE', `/api/team/${ids['admin@example.com']}`, { key: w.owner })).status).toBe(200);
  });
});

describe('pending invites: list and revoke', () => {
  it('owners and admins list pending invites without the token, and revoke them; the link then stops working', async () => {
    const w = await team();
    const sent = await json(await invite(w, w.admin, 'late@example.com'));
    for (const key of [w.owner, w.admin]) {
      const res = await call(w.env, 'GET', '/api/team/invites', { key });
      const text = await res.text();
      expect(text).not.toContain(sent.token);
      const list = JSON.parse(text).invites;
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ email: 'late@example.com', role: 'member', invited_by: 'admin@example.com' });
      expect(list[0].id).toMatch(/^[0-9a-f]{16}$/);
    }
    const id = (await json(await call(w.env, 'GET', '/api/team/invites', { key: w.owner }))).invites[0].id;
    expect((await call(w.env, 'DELETE', `/api/team/invites/${id}`, { key: w.admin })).status).toBe(200);
    expect((await json(await call(w.env, 'GET', '/api/team/invites', { key: w.owner }))).invites).toEqual([]);
    expect((await call(w.env, 'DELETE', `/api/team/invites/${id}`, { key: w.owner })).status).toBe(404);
    expect((await call(w.env, 'POST', `/api/invites/${sent.token}`, { body: { name: 'L', password: 'password-123' } })).status).toBe(404);
    expect(w.rows("SELECT action FROM audit_log WHERE action = 'auth.invite_revoked'")).toHaveLength(1);
  });

  it('used invites are not listed', async () => {
    const w = await team();
    expect((await json(await call(w.env, 'GET', '/api/team/invites', { key: w.owner }))).invites).toEqual([]);
  });

  it('removing a member revokes the invites they sent', async () => {
    const w = await team();
    await invite(w, w.admin, 'pending1@example.com');
    await invite(w, w.owner, 'pending2@example.com');
    const adminId = w.rows("SELECT id FROM users WHERE email = 'admin@example.com'")[0].id;
    expect((await call(w.env, 'DELETE', `/api/team/${adminId}`, { key: w.owner })).status).toBe(200);
    const left = (await json(await call(w.env, 'GET', '/api/team/invites', { key: w.owner }))).invites.map((i: any) => i.email);
    expect(left).toEqual(['pending2@example.com']);
  });
});

describe('the hosted service switches off the self-host-only account endpoints', () => {
  const SELF_HOST_ONLY: Array<[string, string, unknown]> = [
    ['POST', '/api/setup/email-routing', {}],
    ['POST', '/api/setup/custom-domain', { domain: 'x.example.net' }],
    ['POST', '/api/settings/register-destination', { email: 'a@example.com' }],
    // Meaningful only with the install's own reports domain: the default domain.
    ['PUT', '/api/domains/1/set-default', undefined],
    // SPF flattening: its daily refresh is not wired for hosted, and it rewrites the customer's SPF in place.
    ['GET', '/api/domains/1/spf-flatten', undefined],
    ['POST', '/api/domains/1/spf-flatten', {}],
    ['DELETE', '/api/domains/1/spf-flatten', undefined],
    ['GET', '/api/domains/1/spf-flatten/preview', undefined],
    // Monitoring alerts: built from the workspace's own reports domain and sender, which a hosted workspace has neither of (src/monitor/notify.ts).
    ['PATCH', '/api/domains/1/alerts', { alerts_enabled: false }],
    ['GET', '/api/domains/1/monitor-subs', undefined],
    ['PATCH', '/api/monitor-subs/1', { active: false }],
  ];

  it('are 404 in saas mode for every role, and still routed in self-host', async () => {
    const hosted = makeEnv(createMigratedD1(), { MODE: 'saas', SAAS_ENABLED: '1' });
    const { signupVerified } = await import('../auth/helpers');
    const token = await signupVerified(hosted, 'a@example.com');
    for (const [m, p, body] of SELF_HOST_ONLY) {
      const res = await call(hosted, m, p, { key: token, body });
      expect(res.status, `${m} ${p}`).toBe(404);
      expect((await json(res)).error).toMatch(/not available on the hosted service/);
    }
    const w = await team();
    for (const [m, p, body] of SELF_HOST_ONLY) {
      const res = await call(w.env, m, p, { key: w.owner, body });
      expect(await res.clone().text(), `${m} ${p}`).not.toMatch(/not available on the hosted service/);
    }
  });

  it('set-default changes nothing on the hosted service, and works on self-host', async () => {
    const hdb = createMigratedD1();
    const hosted = makeEnv(hdb, { MODE: 'saas', SAAS_ENABLED: '1' });
    const { signupVerified } = await import('../auth/helpers');
    const token = await signupVerified(hosted, 'a@example.com');
    const ws = hdb.sqlite.prepare('SELECT workspace_id FROM memberships').get().workspace_id as string;
    hdb.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address, verified_via) VALUES (1, ?, 'a-corp.com', '', 'txt')").run(ws);
    const res = await call(hosted, 'PUT', '/api/domains/1/set-default', { key: token });
    expect(res.status).toBe(404);
    expect((await json(res)).error).toMatch(/not available on the hosted service/);
    expect(hdb.sqlite.prepare('SELECT is_default FROM domains WHERE id = 1').get().is_default).toBe(0);
    expect(hdb.sqlite.prepare("SELECT COUNT(*) AS n FROM settings WHERE key IN ('zone_id','zone_name','cf_account_id')").get().n).toBe(0);

    const w = await team();
    w.db.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address, verified_via) VALUES (1, 'ws_default', 'a-corp.com', '', 'txt')").run();
    const ok = await call(w.env, 'PUT', '/api/domains/1/set-default', { key: w.owner });
    expect(ok.status).toBe(200);
    expect(w.db.sqlite.prepare('SELECT is_default FROM domains WHERE id = 1').get().is_default).toBe(1);
  });

  it('SPF flattening: hosted refuses and writes nothing; self-host still answers', async () => {
    const hdb = createMigratedD1();
    const hosted = makeEnv(hdb, { MODE: 'saas', SAAS_ENABLED: '1' });
    const { signupVerified } = await import('../auth/helpers');
    const token = await signupVerified(hosted, 'a@example.com');
    const ws = hdb.sqlite.prepare('SELECT workspace_id FROM memberships').get().workspace_id as string;
    hdb.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address, verified_via) VALUES (1, ?, 'a-corp.com', '', 'txt')").run(ws);
    const res = await call(hosted, 'POST', '/api/domains/1/spf-flatten', { key: token, body: {} });
    expect(res.status).toBe(404);
    expect((await json(res)).error).toMatch(/not available on the hosted service/);
    expect(hdb.sqlite.prepare('SELECT COUNT(*) AS n FROM spf_flatten_config').get().n).toBe(0);

    const w = await team();
    w.db.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address, verified_via) VALUES (1, 'ws_default', 'a-corp.com', '', 'txt')").run();
    const ok = await call(w.env, 'GET', '/api/domains/1/spf-flatten', { key: w.owner });
    expect(ok.status).toBe(200);
  });

  it('MTA-STS: hosted without policy hosting configured refuses to turn it on and writes nothing (the capability check, not a blanket 404); self-host still routes it', async () => {
    const hdb = createMigratedD1();
    const hosted = makeEnv(hdb, { MODE: 'saas', SAAS_ENABLED: '1' });
    const { signupVerified } = await import('../auth/helpers');
    const token = await signupVerified(hosted, 'a@example.com');
    const ws = hdb.sqlite.prepare('SELECT workspace_id FROM memberships').get().workspace_id as string;
    hdb.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address, verified_via) VALUES (1, ?, 'a-corp.com', '', 'txt')").run(ws);
    const post = await call(hosted, 'POST', '/api/domains/1/mta-sts', { key: token, body: {} });
    expect(post.status).toBe(403);
    expect(await json(post)).toMatchObject({ code: 'mta_sts_unavailable', reason: 'not_configured' });
    expect((await call(hosted, 'PATCH', '/api/domains/1/mta-sts', { key: token, body: { mode: 'enforce' } })).status).toBe(404); // nothing to change
    expect((await call(hosted, 'DELETE', '/api/domains/1/mta-sts', { key: token, body: {} })).status).toBe(204); // nothing to remove
    expect(hdb.sqlite.prepare('SELECT COUNT(*) AS n FROM mta_sts_config').get().n).toBe(0);
    const read = await call(hosted, 'GET', '/api/domains/1/mta-sts', { key: token });
    expect(read.status).toBe(200);
    expect(await json(read)).toMatchObject({ available: false, unavailable_reason: 'not_configured' }); // the card says why

    const w = await team();
    w.db.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address, verified_via) VALUES (1, 'ws_default', 'a-corp.com', '', 'txt')").run();
    for (const m of ['POST', 'PATCH', 'DELETE']) {
      const res = await call(w.env, m, '/api/domains/1/mta-sts', { key: w.owner, body: m === 'PATCH' ? { mode: 'enforce' } : {} });
      expect(await res.clone().text(), m).not.toMatch(/not available on the hosted service/);
    }
  });
});
