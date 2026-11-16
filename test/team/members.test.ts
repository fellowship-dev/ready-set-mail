// Members: the owner changes roles, a new invite replaces the open one for the same address, and the member list says who has nowhere else to go.
import { describe, it, expect } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { call, inviteAndAccept, makeEnv, setupOwner } from '../auth/helpers';

const rows = (db: any, sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[];
const json = async (res: Response) => (await res.json()) as any;

async function world() {
  const db = createMigratedD1();
  const env = makeEnv(db);
  const owner = await setupOwner(env);
  const admin = await inviteAndAccept(env, owner, 'admin@example.com', 'admin');
  const member = await inviteAndAccept(env, owner, 'member@example.com', 'member');
  const id = (email: string) => rows(db, 'SELECT id FROM users WHERE email = ?', email)[0].id as string;
  const roleOf = (email: string) => rows(db, 'SELECT m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ? AND m.workspace_id = ?', email, 'ws_default')[0]?.role;
  const setRole = (key: string, userId: string, role: unknown) => call(env, 'POST', `/api/workspaces/ws_default/members/${userId}/role`, { key, body: { role } });
  return { db, env, owner, admin, member, id, roleOf, setRole };
}

describe('POST /api/workspaces/:id/members/:userId/role', () => {
  it('the owner makes a member an admin and an admin a member, and each change is audited', async () => {
    const w = await world();
    const up = await w.setRole(w.owner, w.id('member@example.com'), 'admin');
    expect(up.status).toBe(200);
    expect(await json(up)).toEqual({ ok: true, role: 'admin', changed: true });
    expect(w.roleOf('member@example.com')).toBe('admin');
    expect((await w.setRole(w.owner, w.id('admin@example.com'), 'member')).status).toBe(200);
    expect(w.roleOf('admin@example.com')).toBe('member');
    const audit = rows(w.db, "SELECT actor_email, resource_name, before_value, after_value FROM audit_log WHERE action = 'team.role_changed' ORDER BY id");
    expect(audit).toEqual([
      { actor_email: 'owner@example.com', resource_name: 'member@example.com', before_value: '{"role":"member"}', after_value: '{"role":"admin"}' },
      { actor_email: 'owner@example.com', resource_name: 'admin@example.com', before_value: '{"role":"admin"}', after_value: '{"role":"member"}' },
    ]);
  });

  it('saying the role someone already has changes nothing and writes no audit entry', async () => {
    const w = await world();
    expect(await json(await w.setRole(w.owner, w.id('member@example.com'), 'member'))).toMatchObject({ ok: true, changed: false });
    expect(rows(w.db, "SELECT * FROM audit_log WHERE action = 'team.role_changed'")).toEqual([]);
  });

  it('an admin and a member are refused, and nothing changes', async () => {
    const w = await world();
    for (const key of [w.admin, w.member]) {
      const res = await w.setRole(key, w.id('member@example.com'), 'admin');
      expect(res.status).toBe(403);
    }
    expect(w.roleOf('member@example.com')).toBe('member');
    expect(rows(w.db, "SELECT * FROM audit_log WHERE action = 'team.role_changed'")).toEqual([]);
  });

  it('refuses the owner row, yourself, owner as a target role, an unknown person and a bad role', async () => {
    const w = await world();
    expect((await w.setRole(w.owner, w.id('owner@example.com'), 'member')).status).toBe(400); // yourself (the owner row)
    expect((await w.setRole(w.owner, w.id('member@example.com'), 'owner')).status).toBe(400);
    expect((await w.setRole(w.owner, w.id('member@example.com'), 'root')).status).toBe(400);
    expect((await w.setRole(w.owner, 'nobody', 'admin')).status).toBe(404);
    expect(w.roleOf('owner@example.com')).toBe('owner');
    // after a transfer the new owner may change roles and the old owner (an admin now) is an ordinary row
    expect((await call(w.env, 'POST', '/api/workspaces/ws_default/transfer-ownership', { key: w.owner, body: { user_id: w.id('admin@example.com') } })).status).toBe(200);
    expect((await w.setRole(w.admin, w.id('owner@example.com'), 'member')).status).toBe(200);
    expect((await w.setRole(w.owner, w.id('member@example.com'), 'admin')).status).toBe(403);
    expect(w.roleOf('admin@example.com')).toBe('owner');
  });
});

describe('POST /api/team/invite twice for the same address', () => {
  it('the second link replaces the first: one pending invite, the first token no longer works', async () => {
    const w = await world();
    const invite = async (role = 'member') => json(await call(w.env, 'POST', '/api/team/invite', { key: w.owner, body: { email: 'New@Example.com', role } }));
    const first = await invite();
    expect(first.replaced).toBe(0);
    const second = await invite('admin');
    expect(second.replaced).toBe(1);
    const pending = (await json(await call(w.env, 'GET', '/api/team/invites', { key: w.owner }))).invites;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ email: 'new@example.com', role: 'admin' });
    expect((await call(w.env, 'GET', `/api/invites/${first.token}`)).status).not.toBe(200);
    expect((await call(w.env, 'GET', `/api/invites/${second.token}`)).status).toBe(200);
    expect(rows(w.db, "SELECT resource_name FROM audit_log WHERE action = 'auth.invite_revoked'")).toEqual([{ resource_name: 'new@example.com' }]);
  });

  it('invites to different addresses stay separate', async () => {
    const w = await world();
    for (const email of ['a@example.com', 'b@example.com']) await call(w.env, 'POST', '/api/team/invite', { key: w.owner, body: { email } });
    expect((await json(await call(w.env, 'GET', '/api/team/invites', { key: w.owner }))).invites).toHaveLength(2);
  });
});

describe('GET /api/team', () => {
  it('says how many other workspaces each person is in, so the page can warn before a removal deletes a login', async () => {
    const w = await world();
    const lexgo = (await json(await call(w.env, 'POST', '/api/workspaces', { key: w.owner, body: { name: 'Lexgo' } }))).id as string;
    w.db.sqlite.prepare("INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, ?, 'member')").run(lexgo, w.id('member@example.com'));
    const { users } = await json(await call(w.env, 'GET', '/api/team', { key: w.owner }));
    const other = (email: string) => users.find((u: any) => u.email === email).other_workspaces;
    expect(other('member@example.com')).toBe(1);
    expect(other('admin@example.com')).toBe(0);
    expect(other('owner@example.com')).toBe(1);
  });
});
