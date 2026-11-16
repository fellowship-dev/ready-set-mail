// Members: the owner changes roles, a new invite replaces the open one for the same address, and the member list says who has nowhere else to go.
import { describe, it, expect } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { call, inviteAndAccept, makeEnv, setupOwner } from '../auth/helpers';
import { delegatedKey } from '../auth/grant-fixture';
import { forWorkspace } from '@ready-set-mail/db';

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

  it('requests made at once leave exactly one live link: the newest, never none', async () => {
    for (const n of [2, 3, 6]) {
      const w = await world();
      const sent = await Promise.all(Array.from({ length: n }, () => call(w.env, 'POST', '/api/team/invite', { key: w.owner, body: { email: 'race@example.com' } })));
      expect(sent.map(r => r.status)).toEqual(Array(n).fill(201));
      const tokens = (await Promise.all(sent.map(json))).map(b => b.token as string);
      expect(rows(w.db, "SELECT token FROM invites WHERE email = 'race@example.com' AND used_at IS NULL")).toHaveLength(1);
      const live = (await Promise.all(tokens.map(t => call(w.env, 'GET', `/api/invites/${t}`)))).filter(r => r.status === 200);
      expect(live, `${n} requests`).toHaveLength(1);
    }
  });

  it('the worst interleaving: every request inserts before any of them revokes the others, and the newest still survives', async () => {
    const w = await world();
    const team = forWorkspace(w.db as any, 'ws_default').team;
    const tokens = ['t1', 't2', 't3', 't4'];
    for (const token of tokens) await team.insertInvite({ token, email: 'race@example.com', role: 'member', invited_by: 'owner@example.com', expires_at: Math.floor(Date.now() / 1000) + 3600 });
    for (const token of tokens) await team.revokePendingFor('race@example.com', token);
    expect(rows(w.db, "SELECT token FROM invites WHERE email = 'race@example.com'")).toEqual([{ token: 't4' }]);
    // the other order of the revokes gives the same result
    const w2 = await world();
    const team2 = forWorkspace(w2.db as any, 'ws_default').team;
    for (const token of tokens) await team2.insertInvite({ token, email: 'race@example.com', role: 'member', invited_by: 'owner@example.com', expires_at: Math.floor(Date.now() / 1000) + 3600 });
    for (const token of [...tokens].reverse()) await team2.revokePendingFor('race@example.com', token);
    expect(rows(w2.db, "SELECT token FROM invites WHERE email = 'race@example.com'")).toEqual([{ token: 't4' }]);
  });

  it('an admin\'s member invite does not cancel the owner\'s admin invite to the same address: refused, and the owner\'s link keeps working', async () => {
    const w = await world();
    const ownerInvite = await json(await call(w.env, 'POST', '/api/team/invite', { key: w.owner, body: { email: 'new@example.com', role: 'admin' } }));
    const refused = await call(w.env, 'POST', '/api/team/invite', { key: w.admin, body: { email: 'new@example.com', role: 'member' } });
    expect(refused.status).toBe(409);
    expect((await json(refused)).error).toBe('new@example.com already has an open admin invite from an owner. Ask an owner to change it, or wait until it is used.');
    expect((await call(w.env, 'GET', `/api/invites/${ownerInvite.token}`)).status).toBe(200);
    expect(rows(w.db, "SELECT role FROM invites WHERE email = 'new@example.com'")).toEqual([{ role: 'admin' }]);
    // an admin's member invite still replaces an earlier MEMBER invite, and the owner may replace anything
    const m1 = await json(await call(w.env, 'POST', '/api/team/invite', { key: w.admin, body: { email: 'plain@example.com' } }));
    const m2 = await json(await call(w.env, 'POST', '/api/team/invite', { key: w.admin, body: { email: 'plain@example.com' } }));
    expect(m2.replaced).toBe(1);
    expect((await call(w.env, 'GET', `/api/invites/${m1.token}`)).status).not.toBe(200);
    expect((await json(await call(w.env, 'POST', '/api/team/invite', { key: w.owner, body: { email: 'new@example.com', role: 'member' } }))).replaced).toBe(1);
  });

  it('invites to different addresses stay separate', async () => {
    const w = await world();
    for (const email of ['a@example.com', 'b@example.com']) await call(w.env, 'POST', '/api/team/invite', { key: w.owner, body: { email } });
    expect((await json(await call(w.env, 'GET', '/api/team/invites', { key: w.owner }))).invites).toHaveLength(2);
  });
});

describe('a person in two workspaces: a change in one never touches the other', () => {
  /** member@ also belongs to ws_two, as an admin, with an API key and an agent approval there. */
  async function twoWorkspaces() {
    const w = await world();
    const userId = w.id('member@example.com');
    w.db.sqlite.exec("INSERT INTO workspaces (id, name) VALUES ('ws_two', 'Two')");
    w.db.sqlite.prepare("INSERT INTO memberships (workspace_id, user_id, role) VALUES ('ws_two', ?, 'admin')").run(userId);
    w.db.sqlite.prepare("INSERT INTO api_keys (id, workspace_id, user_id, name, prefix, key_hash) VALUES ('k-two', 'ws_two', ?, 'two', 'rsm_', 'h-two')").run(userId);
    w.db.sqlite.prepare("INSERT INTO api_keys (id, workspace_id, user_id, name, prefix, key_hash) VALUES ('k-one', 'ws_default', ?, 'one', 'rsm_', 'h-one')").run(userId);
    // Only an owner approves agents: they are one for a moment, as in the removal test above.
    const setRoles = (one: string, two: string) => { w.db.sqlite.prepare("UPDATE memberships SET role = ? WHERE user_id = ? AND workspace_id = 'ws_default'").run(one, userId); w.db.sqlite.prepare("UPDATE memberships SET role = ? WHERE user_id = ? AND workspace_id = 'ws_two'").run(two, userId); };
    setRoles('owner', 'owner');
    const agent = await delegatedKey(w.db as any, { workspaceId: 'ws_two', userId, name: 'Agent in two', domain: 'two.example.com' });
    const agentOne = await delegatedKey(w.db as any, { workspaceId: 'ws_default', userId, name: 'Agent in one', domain: 'one.example.com' });
    setRoles('member', 'admin');
    const roleIn = (workspace: string) => rows(w.db, 'SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?', workspace, userId)[0]?.role;
    return { w, userId, agent, agentOne, roleIn };
  }

  it('changing a role here leaves the role there', async () => {
    const { w, userId, roleIn } = await twoWorkspaces();
    const up = await w.setRole(w.owner, userId, 'admin');
    expect(up.status).toBe(200);
    expect(roleIn('ws_default')).toBe('admin');
    expect(roleIn('ws_two')).toBe('admin');
    expect((await w.setRole(w.owner, userId, 'member')).status).toBe(200);
    expect(roleIn('ws_default')).toBe('member');
    expect(roleIn('ws_two')).toBe('admin'); // not demoted with it
    // and the data layer on its own: a workspace's team query reaches only its own rows
    rows(w.db, "UPDATE memberships SET role = 'admin' WHERE workspace_id = 'ws_default' AND user_id = ?", userId);
    await forWorkspace(w.db as any, 'ws_default').team.setRole(userId, 'member');
    expect(roleIn('ws_two')).toBe('admin');
  });

  it('removing them here ends their keys and agent approvals here, and only here', async () => {
    const { w, userId, agent, agentOne, roleIn } = await twoWorkspaces();
    expect((await call(w.env, 'DELETE', `/api/team/${userId}`, { key: w.owner })).status).toBe(200);
    expect(roleIn('ws_default')).toBeUndefined();
    expect(roleIn('ws_two')).toBe('admin');
    expect(rows(w.db, "SELECT id, revoked_at IS NOT NULL AS r FROM api_keys WHERE id IN ('k-one', 'k-two') ORDER BY id")).toEqual([{ id: 'k-one', r: 1 }, { id: 'k-two', r: 0 }]);
    expect(rows(w.db, 'SELECT workspace_id, disabled_at IS NOT NULL AS d FROM access_principals WHERE user_id = ? ORDER BY workspace_id', userId)).toEqual([{ workspace_id: 'ws_default', d: 1 }, { workspace_id: 'ws_two', d: 0 }]);
    expect(rows(w.db, 'SELECT workspace_id, revoked_at IS NOT NULL AS r FROM access_grants ORDER BY workspace_id')).toEqual([{ workspace_id: 'ws_default', r: 1 }, { workspace_id: 'ws_two', r: 0 }]);
    expect(rows(w.db, 'SELECT workspace_id, revoked_at IS NOT NULL AS r FROM access_credentials ORDER BY workspace_id')).toEqual([{ workspace_id: 'ws_default', r: 1 }, { workspace_id: 'ws_two', r: 0 }]);
    expect((await call(w.env, 'GET', '/api/resources', { key: agentOne.key })).status).toBe(401);
    expect((await call(w.env, 'GET', '/api/resources', { key: agent.key })).status).toBe(200); // the other workspace's approval still works
  });

  it('leaving here does the same: the other workspace keeps their keys and approvals', async () => {
    const { w, userId, roleIn } = await twoWorkspaces();
    expect((await call(w.env, 'POST', '/api/workspaces/ws_default/leave', { key: w.member, body: {} })).status).toBe(200);
    expect(roleIn('ws_two')).toBe('admin');
    expect(rows(w.db, "SELECT id FROM api_keys WHERE revoked_at IS NULL AND user_id = ?", userId)).toEqual([{ id: 'k-two' }]);
    expect(rows(w.db, 'SELECT COUNT(*) AS n FROM access_credentials WHERE revoked_at IS NULL')[0].n).toBe(1);
  });
});

describe('removing a member keeps their login', () => {
  const removeMember = (w: Awaited<ReturnType<typeof world>>, email: string) => call(w.env, 'DELETE', `/api/team/${w.id(email)}`, { key: w.owner });

  it('their user row and session stay, their keys and agent approvals for the workspace end, the workspace keeps its data', async () => {
    const w = await world();
    const userId = w.id('member@example.com');
    const domain = (await json(await call(w.env, 'POST', '/api/domains', { key: w.owner, body: { domain: 'acme-test.com' } })));
    expect(domain.error).toBeUndefined();
    // What they hold here: an agent approval (principal + grant + credential) and an API key.
    // (Only an owner approves agents; this person was one before ownership moved on.)
    const setMemberRole = (role: string) => w.db.sqlite.prepare("UPDATE memberships SET role = ? WHERE user_id = ? AND workspace_id = 'ws_default'").run(role, userId);
    setMemberRole('owner');
    const agent = await delegatedKey(w.db as any, { workspaceId: 'ws_default', userId, name: 'Their agent', domain: 'acme-test.com' });
    w.db.sqlite.prepare("INSERT INTO api_keys (id, workspace_id, user_id, name, prefix, key_hash) VALUES ('k1', 'ws_default', ?, 'old', 'rsm_', 'hash1')").run(userId);
    setMemberRole('member');
    expect((await call(w.env, 'GET', '/api/resources', { key: agent.key })).status).toBe(200);

    expect((await removeMember(w, 'member@example.com')).status).toBe(200);

    expect(rows(w.db, 'SELECT id FROM users WHERE id = ?', userId)).toEqual([{ id: userId }]);
    expect(rows(w.db, 'SELECT * FROM memberships WHERE user_id = ?', userId)).toEqual([]);
    expect(rows(w.db, "SELECT revoked_at IS NOT NULL AS r FROM api_keys WHERE id = 'k1'")).toEqual([{ r: 1 }]);
    expect(rows(w.db, 'SELECT disabled_at IS NOT NULL AS d FROM access_principals WHERE user_id = ?', userId)).toEqual([{ d: 1 }]);
    expect(rows(w.db, 'SELECT revoked_at IS NOT NULL AS r FROM access_grants WHERE workspace_id = ?', 'ws_default')).toEqual([{ r: 1 }]);
    expect(rows(w.db, 'SELECT revoked_at IS NOT NULL AS r FROM access_credentials WHERE workspace_id = ?', 'ws_default')).toEqual([{ r: 1 }]);
    expect((await call(w.env, 'GET', '/api/resources', { key: agent.key })).status).toBe(401);
    // The workspace's data is untouched.
    expect(rows(w.db, "SELECT domain FROM domains WHERE workspace_id = 'ws_default'")).toEqual([{ domain: 'acme-test.com' }]);

    // Their session still works: signed in, in no workspace, with nothing offered but a way to start or accept one.
    const me = await call(w.env, 'GET', '/api/me', { key: w.member });
    expect(me.status).toBe(200);
    expect(await json(me)).toMatchObject({ user: { email: 'member@example.com' }, workspace_id: null, role: null });
    const data = await call(w.env, 'GET', '/api/domains', { key: w.member });
    expect(data.status).toBe(403);
    expect(await json(data)).toMatchObject({ code: 'no_workspace' });
    // The owner's list no longer has them, and the team page no longer says anything about other workspaces.
    const { users } = await json(await call(w.env, 'GET', '/api/team', { key: w.owner }));
    expect(users.map((u: any) => u.email)).not.toContain('member@example.com');
    expect(users.every((u: any) => !('other_workspaces' in u))).toBe(true);
  });

  it('invited again, they accept the new invite and are back in', async () => {
    const w = await world();
    await removeMember(w, 'member@example.com');
    const inv = await call(w.env, 'POST', '/api/team/invite', { key: w.owner, body: { email: 'member@example.com', role: 'member' } });
    expect(inv.status).toBe(201);
    const { token } = await json(inv);
    const me = await json(await call(w.env, 'GET', '/api/me', { key: w.member }));
    expect(me.pending_invites.map((i: any) => i.token)).toContain(token);
    const accepted = await call(w.env, 'POST', `/api/invites/${token}`, { key: w.member, body: {} });
    expect([200, 201]).toContain(accepted.status);
    expect(w.roleOf('member@example.com')).toBe('member');
    expect((await call(w.env, 'GET', '/api/domains', { key: w.member })).status).toBe(200);
  });
});

describe('leaving your only workspace', () => {
  it('a member or admin may; they keep their login and session, their keys end, they land on "no workspace"', async () => {
    const w = await world();
    for (const [email, key] of [['member@example.com', w.member], ['admin@example.com', w.admin]] as const) {
      const userId = w.id(email);
      w.db.sqlite.prepare("INSERT INTO api_keys (id, workspace_id, user_id, name, prefix, key_hash) VALUES (?, 'ws_default', ?, 'old', 'rsm_', ?)").run(`k-${userId}`, userId, `h-${userId}`);
      const left = await call(w.env, 'POST', '/api/workspaces/ws_default/leave', { key, body: {} });
      expect(left.status).toBe(200);
      expect(rows(w.db, 'SELECT id FROM users WHERE id = ?', userId)).toEqual([{ id: userId }]);
      expect(rows(w.db, 'SELECT revoked_at IS NOT NULL AS r FROM api_keys WHERE user_id = ?', userId)).toEqual([{ r: 1 }]);
      expect(await json(await call(w.env, 'GET', '/api/me', { key }))).toMatchObject({ workspace_id: null });
    }
  });

  it('the only owner may not, whether or not it is their only workspace: they hand ownership on first', async () => {
    const w = await world();
    const res = await call(w.env, 'POST', '/api/workspaces/ws_default/leave', { key: w.owner, body: {} });
    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe('last_owner');
    expect(w.roleOf('owner@example.com')).toBe('owner');
  });
});

