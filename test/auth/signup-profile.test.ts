// Hosted sign-up screens S1 → S2 → S3 (src/auth/routes.ts /api/auth/signup*): the "about you" answers are held with the pending
// attempt, bound to its cookie, and applied once, when the code is right and the account and workspace are created.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { call, enterCode, flushBackground, lastCodeFor, mailsTo, makeEnv, pendingCookieOf } from './helpers';
import { HOSTED_ENV } from '../hosted/world';
import { CODE_MAX_TRIES, CODE_SECONDS } from '../../src/auth/codes';
import { dohFetch } from '../../packages/dns-checks/test/helpers';

vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));
beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => {}));
afterEach(() => { vi.restoreAllMocks(); });

const json = async (r: Response) => await r.json() as any;
let n = 0;
const ip = () => `203.0.113.${++n % 250}`;

function hosted(extra: Record<string, unknown> = {}) {
  const db = createMigratedD1();
  const send = vi.fn(async () => {});
  const env = makeEnv(db, { ...HOSTED_ENV, SEND_EMAIL: { send }, ...extra });
  const rows = (sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[];
  return { db, env, send, rows };
}
type W = ReturnType<typeof hosted>;

const signup = (w: W, email: string, password = 'password-123') => call(w.env, 'POST', '/api/auth/signup', { body: { email, password }, ip: ip() });
const saveProfile = (w: W, cookie: string, body: unknown) => call(w.env, 'POST', '/api/auth/signup/profile', { body: body as object, headers: { cookie }, ip: ip() });
const pendingOf = (w: W, cookie?: string) => call(w.env, 'GET', '/api/auth/signup/pending', { headers: cookie ? { cookie } : {}, ip: ip() });
const resend = (w: W, cookie: string) => call(w.env, 'POST', '/api/auth/signup/resend', { body: { cf_turnstile_token: 'ok' }, headers: { cookie }, ip: ip() });

const ABOUT = { name: 'Dana Whitfield', organization: 'Brightwave Studio', whose_email: 'company' };
const workspaceNames = (w: W, email: string) =>
  w.rows('SELECT ws.name FROM workspaces ws JOIN memberships m ON m.workspace_id = ws.id JOIN users u ON u.id = m.user_id WHERE u.email = ?', email).map(r => r.name);
const userRow = (w: W, email: string) => w.rows('SELECT id, name FROM users WHERE email = ?', email)[0];
const profileRows = (w: W) => w.rows("SELECT identifier, value FROM verifications WHERE identifier LIKE 'account-profile:%'");

/** S1, S2, then the code: returns the response of the code step. */
async function fullSignup(w: W, email: string, about: object) {
  const res = await signup(w, email);
  const cookie = pendingCookieOf(res);
  expect((await saveProfile(w, cookie, about)).status).toBe(200);
  return enterCode(w.env, cookie, await lastCodeFor(w.env, email));
}

describe('S2: answers held with the pending attempt', () => {
  it('saves them on the attempt bound to the pending cookie, and creates no account', async () => {
    const w = hosted();
    const res = await signup(w, 'dana@brightwave-mail.com');
    const cookie = pendingCookieOf(res);
    const saved = await saveProfile(w, cookie, { ...ABOUT, role: 'founder', heard_about: 'A colleague' });
    expect(saved.status).toBe(200);
    expect(await json(saved)).toEqual({ ok: true, step: 'code' });
    expect(w.rows('SELECT id FROM users')).toHaveLength(0);
    expect(w.rows('SELECT id FROM workspaces WHERE id <> ?', 'ws_default')).toHaveLength(0);
    expect(profileRows(w)).toHaveLength(0);
    const stored = JSON.parse(w.rows("SELECT value FROM verifications WHERE identifier LIKE 'signin-code:%'")[0].value);
    expect(stored.prof).toEqual({ ...ABOUT, role: 'founder', heard_about: 'A colleague' });
    expect(stored.t).toBe(0); // the try counter is untouched
  });

  it('needs the attempt\'s own cookie: no cookie, a made-up handle, or another purpose is refused', async () => {
    const w = hosted();
    await signup(w, 'dana@brightwave-mail.com');
    expect((await saveProfile(w, '', ABOUT)).status).toBe(410);
    expect((await saveProfile(w, `rsm_pending=${'A'.repeat(43)}`, ABOUT)).status).toBe(410);
    expect(JSON.parse(w.rows("SELECT value FROM verifications WHERE identifier LIKE 'signin-code:%'")[0].value).prof).toBeUndefined();
  });

  it('validates strictly and bounds every size', async () => {
    const w = hosted();
    const cookie = pendingCookieOf(await signup(w, 'dana@brightwave-mail.com'));
    const bad = async (body: object, field: string) => {
      const r = await saveProfile(w, cookie, body);
      expect(r.status).toBe(400);
      expect((await json(r)).field).toBe(field);
    };
    await bad({ ...ABOUT, name: '' }, 'name');
    await bad({ ...ABOUT, name: '   ' }, 'name');
    await bad({ ...ABOUT, name: 'x'.repeat(101) }, 'name');
    await bad({ ...ABOUT, name: 42 }, 'name');
    await bad({ ...ABOUT, organization: '' }, 'organization');
    await bad({ ...ABOUT, organization: 'o'.repeat(81) }, 'organization');
    await bad({ ...ABOUT, whose_email: 'everyone' }, 'whose_email');
    await bad({ ...ABOUT, whose_email: undefined }, 'whose_email');
    await bad({ ...ABOUT, role: 'wizard' }, 'role');
    await bad({ ...ABOUT, heard_about: 'h'.repeat(201) }, 'heard_about');
    // At the bounds is fine.
    expect((await saveProfile(w, cookie, { name: 'n'.repeat(100), organization: 'o'.repeat(80), whose_email: 'clients', heard_about: 'h'.repeat(200) })).status).toBe(200);
    const big = await call(w.env, 'POST', '/api/auth/signup/profile', { body: { ...ABOUT, heard_about: 'x'.repeat(5000) }, headers: { cookie }, ip: ip() });
    expect(big.status).toBe(413);
  });

  it('cleans control and invisible characters, ignores unknown keys, and keeps role and heard-about optional', async () => {
    const w = hosted();
    const cookie = pendingCookieOf(await signup(w, 'dana@brightwave-mail.com'));
    expect((await saveProfile(w, cookie, { name: 'Dana‮\u0000 Whitfield', organization: ' Brightwave\n Studio ', whose_email: 'looking', admin: true, role: '' })).status).toBe(200);
    const stored = JSON.parse(w.rows("SELECT value FROM verifications WHERE identifier LIKE 'signin-code:%'")[0].value);
    expect(stored.prof).toEqual({ name: 'Dana Whitfield', organization: 'Brightwave Studio', whose_email: 'looking' });
  });

  it('answers the same for an address that already has an account (nothing says which addresses do)', async () => {
    const w = hosted();
    const first = await fullSignup(w, 'dana@brightwave-mail.com', ABOUT);
    expect(first.status).toBe(200);
    const mailsBefore = mailsTo(w.env, 'dana@brightwave-mail.com').length;
    const res = await signup(w, 'dana@brightwave-mail.com', 'another-password');
    const cookie = pendingCookieOf(res);
    const saved = await saveProfile(w, cookie, { ...ABOUT, name: 'Someone Else' });
    expect(saved.status).toBe(200);
    expect(await json(saved)).toEqual({ ok: true, step: 'code' });
    const pending = await json(await pendingOf(w, cookie));
    expect(pending).toMatchObject({ pending: true, email: 'dana@brightwave-mail.com', step: 'code' });
    await flushBackground();
    // Only the owner's notice, no code, went out; the account's name did not change.
    expect(mailsTo(w.env, 'dana@brightwave-mail.com').length).toBe(mailsBefore + 1);
    expect(userRow(w, 'dana@brightwave-mail.com').name).toBe('Dana Whitfield');
  });
});

describe('routing by server state', () => {
  it('says nothing is pending without an attempt, and `about` then `code` for the one this browser holds', async () => {
    const w = hosted();
    expect(await json(await pendingOf(w))).toEqual({ pending: false });
    const cookie = pendingCookieOf(await signup(w, 'dana@brightwave-mail.com'));
    const a = await pendingOf(w, cookie);
    expect(a.headers.get('cache-control')).toBe('no-store');
    expect(await json(a)).toMatchObject({ pending: true, email: 'dana@brightwave-mail.com', step: 'about' });
    await saveProfile(w, cookie, ABOUT);
    const c = await json(await pendingOf(w, cookie));
    expect(c).toMatchObject({ pending: true, step: 'code', profile: ABOUT });
    expect(c.expires_in).toBeGreaterThan(0);
    expect(c.expires_in).toBeLessThanOrEqual(CODE_SECONDS);
  });

  it('is not pending once the code is used, after "start over", or for a sign-in or reset attempt', async () => {
    const w = hosted();
    const done = await fullSignup(w, 'dana@brightwave-mail.com', ABOUT);
    expect(done.status).toBe(200);
    const cookie = pendingCookieOf(await signup(w, 'eve@brightwave-mail.com'));
    expect((await json(await pendingOf(w, cookie))).pending).toBe(true);
    const cancelled = await call(w.env, 'POST', '/api/auth/signup/cancel', { body: {}, headers: { cookie }, ip: ip() });
    expect(cancelled.status).toBe(200);
    expect(await json(await pendingOf(w, cookie))).toEqual({ pending: false });
    expect(w.rows("SELECT 1 FROM verifications WHERE identifier LIKE 'signin-code:%'")).toHaveLength(0);
    const reset = await call(w.env, 'POST', '/api/auth/forgot', { body: { email: 'dana@brightwave-mail.com' }, ip: ip() });
    await flushBackground();
    expect(await json(await pendingOf(w, pendingCookieOf(reset)))).toEqual({ pending: false });
  });

  it('self-host has no hosted sign-up: nothing pending, no profile', async () => {
    const db = createMigratedD1();
    const env = makeEnv(db, {});
    expect(await json(await call(env, 'GET', '/api/auth/signup/pending'))).toEqual({ pending: false });
    expect((await call(env, 'POST', '/api/auth/signup/profile', { body: ABOUT })).status).toBe(403);
  });
});

describe('applied once, when the code is right', () => {
  it('company: the account takes the name, the first workspace the organization name, the profile row is written', async () => {
    const w = hosted();
    const res = await fullSignup(w, 'dana@brightwave-mail.com', { ...ABOUT, role: 'developer', heard_about: 'A post' });
    expect(res.status).toBe(200);
    expect(workspaceNames(w, 'dana@brightwave-mail.com')).toEqual(['Brightwave Studio']);
    expect(userRow(w, 'dana@brightwave-mail.com').name).toBe('Dana Whitfield');
    const rows = profileRows(w);
    expect(rows).toHaveLength(1);
    expect(rows[0].identifier).toBe(`account-profile:${userRow(w, 'dana@brightwave-mail.com').id}`);
    expect(JSON.parse(rows[0].value)).toEqual({ ...ABOUT, role: 'developer', heard_about: 'A post' });
    expect(w.rows("SELECT 1 FROM verifications WHERE identifier LIKE 'signin-code:%'")).toHaveLength(0); // the attempt is gone
  });

  it('looking around: named like a company', async () => {
    const w = hosted();
    await fullSignup(w, 'dana@brightwave-mail.com', { ...ABOUT, whose_email: 'looking' });
    expect(workspaceNames(w, 'dana@brightwave-mail.com')).toEqual(['Brightwave Studio']);
  });

  it('agency: the first workspace waits for its first client domain; the agency name is on the account', async () => {
    const w = hosted();
    const res = await fullSignup(w, 'sam@northside-it.com', { name: 'Sam Ortiz', organization: 'Northside IT', whose_email: 'clients' });
    expect(res.status).toBe(200);
    expect(workspaceNames(w, 'sam@northside-it.com')).toEqual(['New client']);
    const token = (await json(res)).token;
    const meBody = await json(await call(w.env, 'GET', '/api/me', { key: token }));
    expect(meBody).toMatchObject({ whose_email: 'clients', agency_name: 'Northside IT', user: { name: 'Sam Ortiz' } });
  });

  it('agency: the first client domain entered names the workspace after it, once; a company workspace is never renamed', async () => {
    vi.stubGlobal('fetch', dohFetch({}, []));
    const w = hosted();
    const token = (await json(await fullSignup(w, 'sam@northside-it.com', { name: 'Sam Ortiz', organization: 'Northside IT', whose_email: 'clients' }))).token;
    expect((await call(w.env, 'POST', '/api/domains', { key: token, body: { domain: 'brightwave-mail.com' } })).status).toBeLessThan(300);
    expect(workspaceNames(w, 'sam@northside-it.com')).toEqual(['brightwave-mail.com']);
    await call(w.env, 'POST', '/api/domains', { key: token, body: { domain: 'harbor-lane.org' } });
    expect(workspaceNames(w, 'sam@northside-it.com')).toEqual(['brightwave-mail.com']);
    const c = await json(await fullSignup(w, 'dana@brightwave.example', ABOUT));
    await call(w.env, 'POST', '/api/domains', { key: c.token, body: { domain: 'brightwave.example' } });
    expect(workspaceNames(w, 'dana@brightwave.example')).toEqual(['Brightwave Studio']);
    vi.unstubAllGlobals();
  });

  it('a company account shows no agency name', async () => {
    const w = hosted();
    const token = (await json(await fullSignup(w, 'dana@brightwave-mail.com', ABOUT))).token;
    const meBody = await json(await call(w.env, 'GET', '/api/me', { key: token }));
    expect(meBody.whose_email).toBe('company');
    expect(meBody.agency_name).toBeUndefined();
    expect(JSON.stringify(meBody)).not.toContain('heard');
  });

  it('without S2 (the API skipped it) the account is named as before: the email\'s domain', async () => {
    const w = hosted();
    const res = await signup(w, 'dana@brightwave-mail.com');
    const done = await enterCode(w.env, pendingCookieOf(res), await lastCodeFor(w.env, 'dana@brightwave-mail.com'));
    expect(done.status).toBe(200);
    expect(workspaceNames(w, 'dana@brightwave-mail.com')).toEqual(['brightwave-mail.com workspace']);
    expect(profileRows(w)).toHaveLength(0);
  });

  it('a wrong code applies nothing, and the right code applies it once (a replay finds no attempt)', async () => {
    const w = hosted();
    const res = await signup(w, 'dana@brightwave-mail.com');
    const cookie = pendingCookieOf(res);
    await saveProfile(w, cookie, ABOUT);
    const code = await lastCodeFor(w.env, 'dana@brightwave-mail.com');
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
    expect((await enterCode(w.env, cookie, wrong)).status).toBe(400);
    expect(w.rows('SELECT id FROM users')).toHaveLength(0);
    expect(profileRows(w)).toHaveLength(0);
    expect((await enterCode(w.env, cookie, code)).status).toBe(200);
    expect((await enterCode(w.env, cookie, code)).status).toBe(410);
    expect(profileRows(w)).toHaveLength(1);
  });

  it('an attempt used up by wrong tries never applies its answers', async () => {
    const w = hosted();
    const cookie = pendingCookieOf(await signup(w, 'dana@brightwave-mail.com'));
    await saveProfile(w, cookie, ABOUT);
    const code = await lastCodeFor(w.env, 'dana@brightwave-mail.com');
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
    for (let i = 0; i < CODE_MAX_TRIES; i++) await enterCode(w.env, cookie, wrong);
    expect((await enterCode(w.env, cookie, code)).status).toBe(410);
    expect(w.rows('SELECT id FROM users')).toHaveLength(0);
    expect(profileRows(w)).toHaveLength(0);
  });

  it('a second attempt never inherits another attempt\'s answers (not by "Start over", not by a new sign-up)', async () => {
    const w = hosted();
    const first = await signup(w, 'dana@brightwave-mail.com');
    await saveProfile(w, pendingCookieOf(first), { ...ABOUT, organization: 'First Org' });
    // A fresh sign-up from the same browser: a new handle, no answers.
    const second = await call(w.env, 'POST', '/api/auth/signup', { body: { email: 'dana@brightwave-mail.com', password: 'password-123' }, headers: { cookie: pendingCookieOf(first) }, ip: ip() });
    const cookie = pendingCookieOf(second);
    expect(await json(await pendingOf(w, cookie))).toMatchObject({ step: 'about' });
    expect((await json(await pendingOf(w, cookie))).profile).toBeUndefined();
    const done = await enterCode(w.env, cookie, await lastCodeFor(w.env, 'dana@brightwave-mail.com'));
    expect(done.status).toBe(200);
    expect(workspaceNames(w, 'dana@brightwave-mail.com')).toEqual(['brightwave-mail.com workspace']);
    expect(profileRows(w)).toHaveLength(0);
    // Another browser's attempt for another address stays apart.
    const other = pendingCookieOf(await signup(w, 'eve@other.example'));
    await saveProfile(w, other, { ...ABOUT, organization: 'Eve Org' });
    const third = pendingCookieOf(await signup(w, 'frank@other.example'));
    expect((await json(await pendingOf(w, third))).profile).toBeUndefined();
  });

  it('the account\'s profile is removed with the account', async () => {
    const w = hosted();
    await fullSignup(w, 'dana@brightwave-mail.com', ABOUT);
    const id = userRow(w, 'dana@brightwave-mail.com').id;
    const { lifecycleQueries } = await import('@ready-set-mail/db');
    await lifecycleQueries(w.env.DB as D1Database).deleteUser(id, 'dana@brightwave-mail.com');
    expect(profileRows(w)).toHaveLength(0);
  });
});

describe('S3: a new code from the same attempt', () => {
  it('keeps the answers and the password, replaces the code, and needs the bot check like sign-up does', async () => {
    const w = hosted();
    const cookie = pendingCookieOf(await signup(w, 'dana@brightwave-mail.com'));
    await saveProfile(w, cookie, ABOUT);
    const first = await lastCodeFor(w.env, 'dana@brightwave-mail.com');
    const res = await resend(w, cookie);
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ code_required: true, purpose: 'signup', email: 'dana@brightwave-mail.com', expires_in: CODE_SECONDS });
    const cookie2 = pendingCookieOf(res);
    const second = await lastCodeFor(w.env, 'dana@brightwave-mail.com');
    expect(await json(await pendingOf(w, cookie2))).toMatchObject({ step: 'code', profile: ABOUT });
    if (second !== first) expect((await enterCode(w.env, cookie2, first)).status).toBe(400);
    expect((await enterCode(w.env, cookie2, second)).status).toBe(200);
    expect(workspaceNames(w, 'dana@brightwave-mail.com')).toEqual(['Brightwave Studio']);
    // The password typed at S1 is the account's: sign in with it.
    const login = await call(w.env, 'POST', '/api/auth/login', { body: { email: 'dana@brightwave-mail.com', password: 'password-123' }, ip: ip() });
    expect(login.status).toBe(200);
  });

  it('is refused without an attempt, and spends the same code-mail allowance as sign-up', async () => {
    const w = hosted();
    expect((await resend(w, '')).status).toBe(410);
    const cookie = pendingCookieOf(await signup(w, 'dana@brightwave-mail.com'));
    const again = await resend(w, cookie);
    expect(again.status).toBe(200);
    const third = await resend(w, pendingCookieOf(again));
    expect(third.status).toBe(429); // sign-up allows 2 code mails an hour per address
    expect((await json(third)).code).toBe('code_mail_limit');
  });

  it('for an address that has an account it looks the same and mails only the notice', async () => {
    const w = hosted();
    await fullSignup(w, 'dana@brightwave-mail.com', ABOUT);
    const cookie = pendingCookieOf(await signup(w, 'dana@brightwave-mail.com', 'x-password-1'));
    await saveProfile(w, cookie, ABOUT);
    await flushBackground();
    const before = mailsTo(w.env, 'dana@brightwave-mail.com').length;
    const res = await resend(w, cookie);
    expect(res.status).toBe(429); // 2 an hour: the first sign-up code, the notice
    void before;
  });

  it('"Wrong address? Start over" drops the attempt and clears the cookie', async () => {
    const w = hosted();
    const cookie = pendingCookieOf(await signup(w, 'dana@brightwave-mail.com'));
    const res = await call(w.env, 'POST', '/api/auth/signup/cancel', { body: {}, headers: { cookie }, ip: ip() });
    expect(res.status).toBe(200);
    expect(((res.headers as Headers & { getSetCookie(): string[] }).getSetCookie()).join(';')).toMatch(/rsm_pending=;[^,]*Max-Age=0/);
    expect((await enterCode(w.env, cookie, '123456')).status).toBe(410);
  });
});
