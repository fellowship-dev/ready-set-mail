import { delegatedKey } from './grant-fixture';
import { describe, it, expect, vi } from 'vitest';

import { call, makeEnv, setupOwner, req, ctx } from './helpers';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { handleApi } from '../../src/api/router';

vi.mock('../../src/env-utils', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return { ...actual, enrichEnv: vi.fn().mockResolvedValue(undefined), getBaseDomain: vi.fn().mockReturnValue(undefined),
    reportsDomain: vi.fn().mockReturnValue('reports.example.com'), fromEmail: vi.fn().mockReturnValue('noreply@reports.example.com') };
});

const saas = () => makeEnv(createMigratedD1(), { MODE: 'saas', SAAS_ENABLED: '1' });
const rows = (db: any, sql: string) => db.sqlite.prepare(sql).all() as any[];

describe('MODE=saas is an explicit opt-in', () => {
  it('is refused (503) without SAAS_ENABLED=1, but /health works', async () => {
    const env = makeEnv(createMigratedD1(), { MODE: 'saas' });
    const r = await call(env, 'POST', '/api/auth/signup', { body: { email: 'a@example.com', password: 'password-123' } });
    expect(r.status).toBe(503);
    expect((await r.json() as any).error).toContain('SAAS_ENABLED');
    expect((await call(env, 'GET', '/health')).status).toBe(200);
  });
});

describe('login CSRF', () => {
  const evilForm = (path: string, body: string, extra: Record<string, string> = {}) =>
    req('POST', path, { headers: { 'content-type': 'text/plain', origin: 'https://evil.example', ...extra } }) && new Request(`https://ia.example.com${path}`, {
      method: 'POST', headers: { 'content-type': 'text/plain', origin: 'https://evil.example', 'cf-connecting-ip': '9.9.9.9', ...extra }, body,
    });

  it('a cross-site text/plain POST is rejected on setup, signup, login, logout, forgot, reset and invite-accept', async () => {
    const env = makeEnv();
    await setupOwner(env);
    const json = '{"email":"owner@example.com","password":"correct-horse-battery","name":"x","token":"t"}';
    for (const p of ['/api/auth/setup', '/api/auth/signup', '/api/auth/login', '/api/auth/logout', '/api/auth/forgot', '/api/auth/reset', '/api/invites/abc']) {
      const res = await handleApi(evilForm(p, json), env, ctx);
      expect(res.status, p).toBe(403);
    }
    expect(rows(env.DB, 'SELECT COUNT(*) n FROM sessions')).toEqual([{ n: 1 }]); // only the owner's setup session
  });

  it('text/plain from our own origin (or no origin) is refused as 415; JSON from a foreign Origin as 403', async () => {
    const env = makeEnv();
    await setupOwner(env);
    const body = '{"email":"owner@example.com","password":"correct-horse-battery"}';
    const plain = await handleApi(new Request('https://ia.example.com/api/auth/login', { method: 'POST', headers: { 'content-type': 'text/plain', origin: 'https://ia.example.com', 'cf-connecting-ip': '9.9.9.8' }, body }), env, ctx);
    expect(plain.status).toBe(415);
    const foreign = await call(env, 'POST', '/api/auth/login', { headers: { origin: 'https://evil.example' }, body: JSON.parse(body) });
    expect(foreign.status).toBe(403);
    const same = await call(env, 'POST', '/api/auth/login', { headers: { origin: 'https://ia.example.com' }, body: JSON.parse(body) });
    expect(same.status).toBe(200);
  });

  it('Sec-Fetch-Site: cross-site without Origin is rejected; TRUSTED_ORIGINS are honoured', async () => {
    const env = makeEnv(createMigratedD1(), { TRUSTED_ORIGINS: 'https://app.example.org' });
    await setupOwner(env);
    const b = { email: 'owner@example.com', password: 'correct-horse-battery' };
    expect((await call(env, 'POST', '/api/auth/login', { headers: { 'sec-fetch-site': 'cross-site' }, body: b })).status).toBe(403);
    expect((await call(env, 'POST', '/api/auth/login', { headers: { origin: 'https://app.example.org' }, body: b })).status).toBe(200);
  });

  it('Better Auth sees the real Origin (not ours) on internal calls', async () => {
    const env = makeEnv(createMigratedD1(), { TRUSTED_ORIGINS: 'https://app.example.org' });
    await setupOwner(env);
    const res = await call(env, 'POST', '/api/auth/login', { headers: { origin: 'https://app.example.org' }, body: { email: 'owner@example.com', password: 'correct-horse-battery' } });
    expect(res.status).toBe(200);
  });
});

describe('change-password', () => {
  it('signs out every other session; API keys survive unless revoked', async () => {
    const env = makeEnv();
    const s1 = await setupOwner(env, 'owner@example.com', 'old-password-123');
    const s2 = (await (await call(env, 'POST', '/api/auth/login', { body: { email: 'owner@example.com', password: 'old-password-123' } })).json() as any).token as string;
    const db = env.DB as any;
    const userId = db.sqlite.prepare('SELECT id FROM users LIMIT 1').get().id;
    const key = (await delegatedKey(db,{ workspaceId:'ws_default', userId, name:'k', domain:'example.com' })).key;

    const res = await call(env, 'POST', '/api/auth/change-password', { key: s1, body: { currentPassword: 'old-password-123', newPassword: 'new-password-456' } });
    expect(res.status).toBe(200);
    expect((await call(env, 'GET', '/api/domains', { key: s2 })).status).toBe(401); // other session gone
    // Better Auth swaps the caller onto a fresh session and returns its token
    const fresh = res.headers.get('set-auth-token');
    expect(fresh).toBeTruthy();
    expect((await call(env, 'GET', '/api/domains', { key: fresh! })).status).toBe(200);
    expect(await (await import('../../src/auth/api-keys')).resolveApiKey(db,key)).not.toBeNull(); // explicit credentials survive password changes
    expect((await call(env, 'POST', '/api/auth/login', { body: { email: 'owner@example.com', password: 'new-password-456' } })).status).toBe(200);
  });

  it('a caller cannot opt out of revocation', async () => {
    const env = makeEnv();
    const s1 = await setupOwner(env, 'owner@example.com', 'old-password-123');
    const s2 = (await (await call(env, 'POST', '/api/auth/login', { body: { email: 'owner@example.com', password: 'old-password-123' } })).json() as any).token as string;
    await call(env, 'POST', '/api/auth/change-password', { key: s1, body: { currentPassword: 'old-password-123', newPassword: 'new-password-456', revokeOtherSessions: false } });
    expect((await call(env, 'GET', '/api/domains', { key: s2 })).status).toBe(401);
  });
});

describe('OWNER_EMAIL reserves first ownership', () => {
  const body = (email: string) => ({ email, password: 'password-123' });
  it('password: only that email may run first-run setup', async () => {
    const db = createMigratedD1();
    const env = makeEnv(db, { OWNER_EMAIL: 'Me@Example.com' });
    expect((await call(env, 'POST', '/api/auth/setup', { body: body('squatter@example.com') })).status).toBe(403);
    expect(rows(db, 'SELECT COUNT(*) n FROM users')).toEqual([{ n: 0 }]);
    expect((await call(env, 'POST', '/api/auth/setup', { body: body('me@example.com') })).status).toBe(201);
  });

  it('OAuth: the same rule applies to the first provider user', async () => {
    const { assertMaySignUp } = await import('../../src/auth/signup-policy');
    const env = makeEnv(createMigratedD1(), { OWNER_EMAIL: 'me@example.com' }) as any;
    await expect(assertMaySignUp(env, { kind: 'external' }, 'squatter@example.com')).rejects.toThrow(/reserved/);
    await expect(assertMaySignUp(env, { kind: 'external' }, 'ME@example.com')).rejects.toThrow(/installer proof/);
  });

  it('has no effect once an owner exists (invites still work)', async () => {
    const env = makeEnv(createMigratedD1(), { OWNER_EMAIL: 'me@example.com' });
    const owner = await setupOwner(env, 'me@example.com');
    const inv = await call(env, 'POST', '/api/team/invite', { key: owner, body: { email: 'friend@example.com' } });
    const { token } = await inv.json() as any;
    expect((await call(env, 'POST', `/api/invites/${token}`, { body: { name: 'F', password: 'password-123' } })).status).toBe(201);
  });
});

describe('sign-in and change-password refusals say something a person can act on', () => {
  it('a wrong password at sign-in and an unknown address answer with the same sentence and code', async () => {
    const env = makeEnv();
    await setupOwner(env, 'owner@example.com', 'old-password-123');
    const wrong = await call(env, 'POST', '/api/auth/login', { body: { email: 'owner@example.com', password: 'not-the-password' } });
    const unknown = await call(env, 'POST', '/api/auth/login', { body: { email: 'nobody@example.com', password: 'not-the-password' } });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual(await unknown.json());
    expect(await (await call(env, 'POST', '/api/auth/login', { body: { email: 'owner@example.com', password: 'x' } })).json()).toMatchObject({ error: 'That email and password do not match. Check both, or reset your password.', code: 'invalid_credentials' });
  });

  it('a wrong current password at change-password says so in `error`', async () => {
    const env = makeEnv();
    const s1 = await setupOwner(env, 'owner@example.com', 'old-password-123');
    const res = await call(env, 'POST', '/api/auth/change-password', { key: s1, body: { currentPassword: 'wrong-password-1', newPassword: 'new-password-456' } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'Your current password is not right. Check it and try again.', code: 'wrong_current_password' });
  });

  it('every other refusal has its own plain sentence, or a generic true one, and never the library\'s text', async () => {
    const env = makeEnv();
    const s1 = await setupOwner(env, 'owner@example.com', 'old-password-123');
    const change = async (body: unknown) => { const res = await call(env, 'POST', '/api/auth/change-password', { key: s1, body }); return { status: res.status, body: await res.json() as any }; };
    expect(await change({ currentPassword: 'old-password-123', newPassword: 'short' })).toMatchObject({ status: 400, body: { error: 'The new password is too short. Use at least 8 characters.', code: 'password_too_short' } });
    expect(await change({ currentPassword: 'old-password-123', newPassword: 'x'.repeat(129) })).toMatchObject({ status: 400, body: { error: 'The new password is too long. Use at most 128 characters.', code: 'password_too_long' } });
    // a malformed request (a missing or non-string field): the generic sentence, not "[body.newPassword] Invalid input: expected string…"
    for (const bad of [{ currentPassword: 'old-password-123' }, { currentPassword: 12345, newPassword: 'new-password-456' }, {}]) {
      const r = await change(bad);
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({ error: 'The password could not be changed. Check the current and the new password, then try again.', code: 'password_not_changed' });
      expect(JSON.stringify(r.body)).not.toMatch(/\[body|Invalid input|expected string/);
    }
    // and none of them was taken for "wrong current password"
    expect((await change({ currentPassword: 'old-password-123', newPassword: 'short' })).body.code).not.toBe('wrong_current_password');
  });
});
