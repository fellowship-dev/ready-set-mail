// Email verification and account linking (SaaS): nobody gets a session, a workspace invite or a linked login
// on an address they have not proven. Self-host keeps working with no email setup.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { call, makeEnv, setupOwner, inviteAndAccept, signupVerified, req, enterCode, lastCodeFor, pendingCookieOf } from '../auth/helpers';
import { delegatedKey } from '../auth/grant-fixture';
import { createAuth } from '../../src/auth';
import { handleOAuthUserInfo } from 'better-auth/oauth2';

const json = async (r: Response) => await r.json() as any;
afterEach(() => vi.restoreAllMocks());

function saas() {
  const db = createMigratedD1();
  const send = vi.fn(async () => {});
  const env = makeEnv(db, { MODE: 'saas', SAAS_ENABLED: '1', SEND_EMAIL: { send } });
  const rows = (sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[];
  /** The newest code emailed to this address, typed in the browser that holds `res`'s attempt cookie. */
  const confirm = async (res: Response, email: string) => enterCode(env, pendingCookieOf(res), await lastCodeFor(env, email));
  return { db, env, send, rows, confirm };
}

describe('hosted sign-up requires a verified email', () => {
  it('signs up without a session, emails a code, and nobody can sign in until the code is typed', async () => {
    const w = saas();
    const res = await call(w.env, 'POST', '/api/auth/signup', { body: { email: 'New@Example.com', password: 'password-123' } });
    expect(res.status).toBe(200);
    expect(await json(res.clone())).toMatchObject({ code_required: true, purpose: 'signup', email: 'new@example.com' });
    expect((await json(res.clone())).token).toBeUndefined();
    expect((res.headers as any).getSetCookie().some((c: string) => /session_token/.test(c))).toBe(false);
    await lastCodeFor(w.env, 'new@example.com');
    expect(w.send).toHaveBeenCalledTimes(1);
    expect((w.send.mock.calls[0] as any)[0]).toMatchObject({ to: ['new@example.com'], subject: expect.stringMatching(/^\d{6} is your Ready Set Mail code$/) });

    // before the code: the password typed at sign-up is not yet the account's
    const early = await call(w.env, 'POST', '/api/auth/login', { body: { email: 'new@example.com', password: 'password-123' } });
    expect(early.status).toBe(401);
    expect(early.headers.get('set-cookie')).toBeNull();

    const done = await w.confirm(res, 'new@example.com');
    expect(done.status).toBe(200);
    expect((await json(done)).token).toBeTruthy();
    expect(w.rows("SELECT email_verified FROM users WHERE email = 'new@example.com'")).toEqual([{ email_verified: 1 }]);
    expect((await json(await call(w.env, 'POST', '/api/auth/login', { body: { email: 'new@example.com', password: 'password-123' } }))).code_required).toBe(true);
  });

  it('pre-registration does not hand an account to the real owner: the registrant’s password never becomes the account’s, and their sessions end', async () => {
    const w = saas();
    // the attacker registers the CFO's address with a password they know
    await call(w.env, 'POST', '/api/auth/signup', { body: { email: 'cfo@acme.com', password: 'attacker-password-1' } });
    const uid = w.rows("SELECT id FROM users WHERE email = 'cfo@acme.com'")[0].id;
    w.db.sqlite.prepare("INSERT INTO sessions (id, user_id, token, expires_at) VALUES ('s1', ?, 'attacker-session', 9999999999)").run(uid);
    // the real CFO signs up and types the code they received
    const own = await call(w.env, 'POST', '/api/auth/signup', { body: { email: 'cfo@acme.com', password: 'cfo-own-password-1' } });
    expect((await w.confirm(own, 'cfo@acme.com')).status).toBe(200);
    expect(w.rows("SELECT * FROM sessions WHERE user_id = ? AND token = 'attacker-session'", uid)).toEqual([]);
    expect((await call(w.env, 'POST', '/api/auth/login', { body: { email: 'cfo@acme.com', password: 'attacker-password-1' } })).status).toBe(401);
    expect((await call(w.env, 'POST', '/api/auth/login', { body: { email: 'cfo@acme.com', password: 'cfo-own-password-1' } })).status).toBe(200);
  });

  it('a reset request emails a code only to a real account, with the same answer for an unknown address', async () => {
    const w = saas();
    await signupVerified(w.env, 'a@example.com');
    w.send.mockClear();
    const real = await call(w.env, 'POST', '/api/auth/forgot', { body: { email: 'a@example.com' } });
    const ghost = await call(w.env, 'POST', '/api/auth/forgot', { body: { email: 'nobody@example.com' } });
    expect([real.status, ghost.status]).toEqual([200, 200]);
    await lastCodeFor(w.env, 'a@example.com');
    expect(w.send).toHaveBeenCalledTimes(1);
  });

  it('signing up again with an existing address looks the same and creates nothing', async () => {
    const w = saas();
    await call(w.env, 'POST', '/api/auth/signup', { body: { email: 'a@example.com', password: 'password-123' } });
    const again = await call(w.env, 'POST', '/api/auth/signup', { body: { email: 'a@example.com', password: 'another-pass-1' } });
    expect(again.status).toBe(200);
    expect(w.rows('SELECT COUNT(*) n FROM users')).toEqual([{ n: 1 }]);
    expect(w.rows('SELECT COUNT(*) n FROM workspaces WHERE id != ?', 'ws_default')).toEqual([{ n: 1 }]);
  });

  it('a session whose address is (or becomes) unverified gets no API access', async () => {
    const w = saas();
    const token = await signupVerified(w.env, 'a@example.com');
    expect((await call(w.env, 'GET', '/api/me', { key: token })).status).toBe(200);
    w.db.sqlite.prepare("UPDATE users SET email_verified = 0 WHERE email = 'a@example.com'").run();
    const res = await call(w.env, 'GET', '/api/me', { key: token });
    expect(res.status).toBe(403);
    expect((await json(res)).error).toMatch(/verify your email/);
  });

  it('self-host: invited teammates are marked verified (so OAuth linking works), and the migration backfills existing users', async () => {
    const db = createMigratedD1();
    const env = makeEnv(db);
    const owner = await setupOwner(env);
    await inviteAndAccept(env, owner, 'friend@example.com', 'member');
    expect(db.sqlite.prepare("SELECT email_verified FROM users WHERE email = 'friend@example.com'").all()).toEqual([{ email_verified: 1 }]);
    // migration backfill: a pre-existing implicit-workspace user
    db.sqlite.prepare("INSERT INTO users (id, email, name) VALUES ('old', 'old@example.com', 'Old')").run();
    db.sqlite.prepare("INSERT INTO memberships (workspace_id, user_id, role) VALUES ('ws_default', 'old', 'member')").run();
    const sql = require('node:fs').readFileSync('migrations/0004_trust_hardening.sql', 'utf8');
    db.sqlite.exec(sql.slice(sql.indexOf('UPDATE users SET email_verified')));
    expect(db.sqlite.prepare("SELECT email_verified FROM users WHERE id = 'old'").all()).toEqual([{ email_verified: 1 }]);
  });

  it('self-host: no verification needed anywhere, and the instance owner is verified at setup', async () => {
    const db = createMigratedD1();
    const env = makeEnv(db);
    const res = await call(env, 'POST', '/api/auth/setup', { body: { email: 'owner@example.com', password: 'correct-horse-battery' } });
    expect(res.status).toBe(201);
    expect((await json(res)).token).toBeTruthy();
    expect(db.sqlite.prepare("SELECT email_verified FROM users WHERE email = 'owner@example.com'").all()).toEqual([{ email_verified: 1 }]);
    const owner = (await json(await call(env, 'POST', '/api/auth/login', { body: { email: 'owner@example.com', password: 'correct-horse-battery' } }))).token;
    const member = await inviteAndAccept(env, owner, 'friend@example.com', 'member');
    expect((await call(env, 'GET', '/api/me', { key: member })).status).toBe(200);
  });
});

describe('account linking only between verified emails', () => {
  it('is configured so neither an unverified local account nor an unverified provider email is linked, and no provider is trusted blindly', async () => {
    for (const mode of [{ MODE: 'saas', SAAS_ENABLED: '1' }, {}]) {
      const env = makeEnv(createMigratedD1(), { ...mode, GITHUB_CLIENT_ID: 'g', GITHUB_CLIENT_SECRET: 's' });
      const auth = await createAuth(env as any, req('GET', '/api/auth/status'));
      expect((auth as any).options.account.accountLinking).toEqual({ enabled: true, requireLocalEmailVerified: true, trustedProviders: [] });
    }
  });

});

describe('sign-up bot check is mandatory when hosted', () => {
  it('fails closed without a Turnstile secret, and refuses a bad or missing token with one', async () => {
    const db = createMigratedD1();
    const noKey = makeEnv(db, { MODE: 'saas', SAAS_ENABLED: '1', TURNSTILE_SECRET_KEY: undefined });
    const closed = await call(noKey, 'POST', '/api/auth/signup', { body: { email: 'a@example.com', password: 'password-123' } });
    expect(closed.status).toBe(503);
    expect(db.sqlite.prepare('SELECT COUNT(*) n FROM users').all()).toEqual([{ n: 0 }]);
    const keyed = makeEnv(db, { MODE: 'saas', SAAS_ENABLED: '1' });
    expect((await call(keyed, 'POST', '/api/auth/signup', { body: { email: 'a@example.com', password: 'password-123', cf_turnstile_token: 'bad' } })).status).toBe(403);
    expect((await call(keyed, 'POST', '/api/auth/signup', { body: { email: 'a@example.com', password: 'password-123' } })).status).toBe(200);
  });
});

describe('invites are accepted only by a verified, matching email', () => {
  async function invited() {
    const w = saas();
    const owner = await signupVerified(w.env, 'owner@example.com');
    const inv = await json(await call(w.env, 'POST', '/api/team/invite', { key: owner, body: { email: 'friend@example.com' } }));
    return { ...w, owner, inviteToken: inv.token as string };
  }

  it('holding the link is not enough: a new invitee gets an unverified account, no membership and no session until the code', async () => {
    const w = await invited();
    const res = await call(w.env, 'POST', `/api/invites/${w.inviteToken}`, { body: { name: 'Friend', password: 'password-123' } });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ code_required: true, purpose: 'invite', email: 'friend@example.com' });
    expect(w.rows('SELECT used_at FROM invites')).toEqual([{ used_at: null }]);
    // and no workspace of their own either: signing up through an invite does not leave an empty personal workspace behind
    expect(w.rows("SELECT workspace_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = 'friend@example.com'")).toEqual([]);
    expect(w.rows("SELECT COUNT(*) n FROM workspaces WHERE id != 'ws_default'")).toEqual([{ n: 1 }]); // the owner's
    expect((await call(w.env, 'POST', '/api/auth/login', { body: { email: 'friend@example.com', password: 'password-123' } })).status).toBe(401);
  });

  it('an admin of the inviting workspace cannot accept for the invitee: the code goes to the invited address', async () => {
    const w = await invited();
    // the admin "accepts" with a password the admin knows...
    await call(w.env, 'POST', `/api/invites/${w.inviteToken}`, { body: { password: 'admins-password-1' } });
    // ...but the code went to the invitee; the admin cannot sign in as them, and their own session is the wrong address
    expect((await call(w.env, 'POST', '/api/auth/login', { body: { email: 'friend@example.com', password: 'admins-password-1' } })).status).toBe(401);
    const res = await call(w.env, 'POST', `/api/invites/${w.inviteToken}`, { key: w.owner, body: {} });
    expect(res.status).not.toBe(200);
    expect(w.rows('SELECT used_at FROM invites')).toEqual([{ used_at: null }]);
    // the real mailbox owner accepts with their own password; the admin's never became the account's
    const own = await call(w.env, 'POST', `/api/invites/${w.inviteToken}`, { body: { password: 'friends-own-password-1' } });
    expect((await w.confirm(own, 'friend@example.com')).status).toBe(200);
    expect((await call(w.env, 'POST', '/api/auth/login', { body: { email: 'friend@example.com', password: 'admins-password-1' } })).status).toBe(401);
    expect(w.rows('SELECT used_at IS NOT NULL AS used FROM invites')).toEqual([{ used: 1 }]);
  });

  it('an existing user whose address is not verified cannot accept', async () => {
    const w = await invited();
    const friend = await signupVerified(w.env, 'friend@example.com');
    w.db.sqlite.prepare("UPDATE users SET email_verified = 0 WHERE email = 'friend@example.com'").run();
    const res = await call(w.env, 'POST', `/api/invites/${w.inviteToken}`, { key: friend, body: {} });
    expect(res.status).not.toBe(200);
    expect(w.rows('SELECT used_at FROM invites')).toEqual([{ used_at: null }]);
  });

  it('a verified user signed in as a different email cannot accept someone else’s invite', async () => {
    const w = await invited();
    const other = await signupVerified(w.env, 'other@example.com');
    const res = await call(w.env, 'POST', `/api/invites/${w.inviteToken}`, { key: other, body: {} });
    expect(res.status).not.toBe(200);
    expect(w.rows('SELECT used_at FROM invites')).toEqual([{ used_at: null }]);
  });

  it('a verified invitee who is already registered accepts and joins', async () => {
    const w = await invited();
    const friend = await signupVerified(w.env, 'friend@example.com');
    expect((await call(w.env, 'POST', `/api/invites/${w.inviteToken}`, { key: friend, body: {} })).status).toBe(200);
  });
});

describe('delegated human credentials follow the owner’s verified address (hosted)', () => {
  it('a key of an unverified user is refused', async () => {
    const w = saas();
    await signupVerified(w.env, 'a@example.com');
    const uid = w.rows("SELECT id FROM users WHERE email = 'a@example.com'")[0].id;
    const workspaceId = w.rows('SELECT workspace_id FROM memberships WHERE user_id = ?', uid)[0].workspace_id;
    const created = await delegatedKey(w.db as any, { workspaceId, userId: uid, name: 'ci', domain: 'example.com' });
    const key = created.key as string;
    expect((await call(w.env, 'GET', '/api/resources', { key })).status).toBe(200);
    w.db.sqlite.prepare("UPDATE users SET email_verified = 0 WHERE email = 'a@example.com'").run();
    expect((await call(w.env, 'GET', '/api/resources', { key })).status).toBe(403);
  });
});

describe('OAuth account linking (behaviour)', () => {
  async function oauthSignIn(env: any, email: string, providerVerified: boolean) {
    const auth = await createAuth(env, req('GET', '/api/auth/status'));
    const context = await (auth as any).$context;
    return handleOAuthUserInfo({ context, request: undefined } as any, {
      userInfo: { id: 'gh-1', email, name: 'Someone', emailVerified: providerVerified },
      account: { providerId: 'github', accountId: 'gh-1', accessToken: 'at' },
      callbackURL: '/',
    } as any);
  }
  const ghAccounts = (w: any) => w.rows("SELECT user_id FROM auth_accounts WHERE provider_id = 'github'");

  it('does not link to a local account whose email nobody verified (the pre-registered account stays out of reach)', async () => {
    const w = saas();
    await call(w.env, 'POST', '/api/auth/signup', { body: { email: 'cfo@acme.com', password: 'attacker-password-1' } });
    const res = await oauthSignIn(w.env, 'cfo@acme.com', true);
    expect(res.error).toBeTruthy();
    expect(ghAccounts(w)).toEqual([]);
  });

  it('does not link when the provider does not vouch for the email', async () => {
    const w = saas();
    await signupVerified(w.env, 'cfo@acme.com');
    const res = await oauthSignIn(w.env, 'cfo@acme.com', false);
    expect(res.error).toBeTruthy();
    expect(ghAccounts(w)).toEqual([]);
  });

  it('links when both are verified, and every existing session of that user ends', async () => {
    const w = saas();
    const token = await signupVerified(w.env, 'cfo@acme.com');
    expect((await call(w.env, 'GET', '/api/me', { key: token })).status).toBe(200);
    const res = await oauthSignIn(w.env, 'cfo@acme.com', true);
    expect(res.error).toBeFalsy();
    expect(ghAccounts(w)).toHaveLength(1);
    expect((await call(w.env, 'GET', '/api/me', { key: token })).status).toBe(401); // the earlier session is gone
  });
});
