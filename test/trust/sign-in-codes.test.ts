// Sign-in codes (src/auth/codes.ts): the threat model, one block per threat. Each test fails without the defence it names.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { call, ctx, enterCode, flushBackground, lastCodeFor, loginWithCode, mailsTo, makeEnv, pendingCookieOf, setupOwner, signupVerified } from '../auth/helpers';
import { HOSTED_ENV } from '../hosted/world';
import {
  CODE_FAILS_PER_ACCOUNT, CODE_FAILS_PER_IP, CODE_MAIL_CAPS, CODE_MAX_TRIES, CODE_SECONDS, newCode,
} from '../../src/auth/codes';
import { codeEmailText, SIGNUP_NOTICE_SUBJECT } from '../../src/auth/mail';
import { mailFooter } from '../../src/auth/legal';
import { SIGNIN_FAILURE_LIMIT } from '../../src/auth/welcome';

vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));
const json = async (r: Response) => await r.json() as any;
beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => {}));
afterEach(() => { vi.restoreAllMocks(); });

function hosted(extra: Record<string, unknown> = {}) {
  const db = createMigratedD1();
  const send = vi.fn(async () => {});
  const env = makeEnv(db, { ...HOSTED_ENV, SEND_EMAIL: { send }, ...extra });
  const rows = (sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[];
  const account = (email: string) => rows("SELECT u.id, u.name, u.email_verified, u.terms_accepted_at, u.terms_version, a.password FROM users u LEFT JOIN auth_accounts a ON a.user_id = u.id AND a.provider_id = 'credential' WHERE u.email = ?", email)[0];
  return { db, env, send, rows, account };
}
let n = 0;
const ip = () => `198.51.100.${++n % 250}`;
const signup = (env: any, email: string, password: string, headers: Record<string, string> = {}) => call(env, 'POST', '/api/auth/signup', { body: { email, password }, ip: ip(), headers });
const login = (env: any, email: string, password: string, headers: Record<string, string> = {}) => call(env, 'POST', '/api/auth/login', { body: { email, password }, ip: ip(), headers });
const me = (env: any, token: string) => call(env, 'GET', '/api/me', { key: token });
/** The code in the n-th (0-based) code email to this address. */
const nthCode = async (env: any, email: string, i: number) => { await flushBackground(); return mailsTo(env, email).filter(m => /is your Ready Set Mail code$/.test(m.subject))[i]!.subject.slice(0, 6); };
/** A code that is not `code`. */
const otherThan = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

describe('the code itself', () => {
  it('is six digits from a uniform cryptographic source, stored only as a keyed hash bound to its attempt', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) { const c = newCode(); expect(c).toMatch(/^\d{6}$/); seen.add(c); }
    expect(seen.size).toBeGreaterThan(1990);
    const w = hosted();
    await signup(w.env, 'a@example.com', 'a-password-1');
    const code = await lastCodeFor(w.env, 'a@example.com');
    const stored = w.rows("SELECT value FROM verifications WHERE identifier LIKE 'signin-code:%'");
    expect(stored).toHaveLength(1);
    expect(stored[0].value).not.toContain(code);
    expect(JSON.parse(stored[0].value).c).toMatch(/^[A-Za-z0-9_-]{43}$/); // HMAC-SHA256, base64url
  });

  it('the email: subject, what it is for, ten minutes, the ignore sentence, the operator line, and no link that signs in', async () => {
    const w = hosted();
    await signup(w.env, 'a@example.com', 'a-password-1');
    const code = await lastCodeFor(w.env, 'a@example.com');
    const mail = mailsTo(w.env, 'a@example.com').at(-1)!;
    expect(mail.subject).toBe(`${code} is your Ready Set Mail code`);
    expect(mail.text).toContain('Use this code to confirm your email address and finish creating your Ready Set Mail account:');
    expect(mail.text).toContain('It expires in 10 minutes');
    expect(mail.text).toContain("If you didn't ask for this, you can ignore this email; nobody can use it without the code.");
    expect(mail.text).toContain('Ready Set Mail is operated by Fellowship.dev, Inc. Privacy: https://readysetmail.com/privacy');
    expect(mail.text).not.toMatch(/#\/|token|\?/);
    expect(codeEmailText('123456', 'signin', 'https://app.example', null)).toContain('Use this code to finish signing in to Ready Set Mail:');
    expect(codeEmailText('123456', 'reset', 'https://app.example', null)).toContain('Use this code to reset your Ready Set Mail password:');
    expect(codeEmailText('123456', 'signup', 'https://app.example', 'Valdivia, CL')).toContain('Asked for from near Valdivia, CL');
  });
});

describe('happy paths', () => {
  it('sign-up: email + password, then the code: verified, signed in, the password typed at sign-up works', async () => {
    const w = hosted();
    const res = await signup(w.env, 'new@acme.com', 'new-password-1');
    expect(res.status).toBe(200);
    expect(await json(res.clone())).toEqual({ code_required: true, purpose: 'signup', email: 'new@acme.com', expires_in: CODE_SECONDS });
    expect(w.account('new@acme.com').email_verified).toBe(0);
    const done = await enterCode(w.env, pendingCookieOf(res), await lastCodeFor(w.env, 'new@acme.com'));
    expect(done.status).toBe(200);
    const body = await json(done);
    expect(body.purpose).toBe('signup');
    expect((await me(w.env, body.token)).status).toBe(200);
    expect(w.account('new@acme.com').email_verified).toBe(1);
    expect((await json(await login(w.env, 'new@acme.com', 'new-password-1'))).code_required).toBe(true);
  });

  it('sign-in: a wrong password sends nothing; the right one sends a code; the code signs in, every time', async () => {
    const w = hosted();
    await signupVerified(w.env, 'a@example.com', 'a-password-1');
    const before = mailsTo(w.env, 'a@example.com').length;
    expect((await login(w.env, 'a@example.com', 'wrong-password')).status).toBe(401);
    await flushBackground();
    expect(mailsTo(w.env, 'a@example.com').length).toBe(before);
    for (let i = 0; i < 3; i++) expect((await me(w.env, await loginWithCode(w.env, 'a@example.com', 'a-password-1'))).status).toBe(200);
  });
});

describe('threat 1: pre-registration and password overwrite', () => {
  it('an attacker signs up first with their password; the victim signs up and types their code: the victim\'s password, not the attacker\'s', async () => {
    const w = hosted();
    const attacker = await signup(w.env, 'victim@acme.com', 'attacker-pass-1');
    const victim = await signup(w.env, 'victim@acme.com', 'victim-pass-1');
    expect((await enterCode(w.env, pendingCookieOf(victim), await nthCode(w.env, 'victim@acme.com', 1))).status).toBe(200);
    expect((await login(w.env, 'victim@acme.com', 'attacker-pass-1')).status).toBe(401);
    expect((await json(await login(w.env, 'victim@acme.com', 'victim-pass-1'))).code_required).toBe(true);
    // the attacker's own attempt (even with its code) is dead after verification
    expect((await enterCode(w.env, pendingCookieOf(attacker), await nthCode(w.env, 'victim@acme.com', 0))).status).toBe(410);
  });

  it('the attacker signs up AFTER the victim to overwrite the pending password; the victim\'s code still sets the victim\'s password', async () => {
    const w = hosted();
    const victim = await signup(w.env, 'victim@acme.com', 'victim-pass-1');
    const attacker = await signup(w.env, 'victim@acme.com', 'attacker-pass-1');
    expect((await enterCode(w.env, pendingCookieOf(victim), await nthCode(w.env, 'victim@acme.com', 0))).status).toBe(200);
    expect((await login(w.env, 'victim@acme.com', 'attacker-pass-1')).status).toBe(401);
    expect((await login(w.env, 'victim@acme.com', 'victim-pass-1')).status).toBe(200);
    expect((await enterCode(w.env, pendingCookieOf(attacker), await nthCode(w.env, 'victim@acme.com', 1))).status).toBe(410);
  });

  it('the victim types the code of the attacker\'s attempt in their own browser: it does nothing (codes are bound to their attempt)', async () => {
    const w = hosted();
    const victim = await signup(w.env, 'victim@acme.com', 'victim-pass-1');
    await signup(w.env, 'victim@acme.com', 'attacker-pass-1');
    const attackersCode = await nthCode(w.env, 'victim@acme.com', 1);
    expect((await enterCode(w.env, pendingCookieOf(victim), attackersCode)).status).toBe(400);
    expect(w.account('victim@acme.com').email_verified).toBe(0);
  });

  it('nothing an unverified registrant typed survives: names are reset at verification', async () => {
    const w = hosted();
    const res = await signup(w.env, 'cfo@acme.com', 'cfo-pass-123');
    w.db.sqlite.prepare("UPDATE users SET name = 'Support: call +1 555 0100' WHERE email = 'cfo@acme.com'").run();
    w.db.sqlite.prepare("UPDATE workspaces SET name = 'planted' WHERE id IN (SELECT m.workspace_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = 'cfo@acme.com')").run();
    await enterCode(w.env, pendingCookieOf(res), await lastCodeFor(w.env, 'cfo@acme.com'));
    expect(w.account('cfo@acme.com').name).toBe('cfo@acme.com');
    expect(w.rows("SELECT w.name FROM workspaces w JOIN memberships m ON m.workspace_id = w.id JOIN users u ON u.id = m.user_id WHERE u.email = 'cfo@acme.com'")).toEqual([{ name: 'acme.com workspace' }]);
  });

  it('a verified account is never altered by a sign-up, and the answer is the same for new, pending and verified addresses', async () => {
    const w = hosted();
    const token = await signupVerified(w.env, 'owner@acme.com', 'owner-pass-1');
    await signup(w.env, 'pending@acme.com', 'pending-pass-1');
    const before = w.account('owner@acme.com');
    const answers = [];
    for (const email of ['fresh@acme.com', 'pending@acme.com', 'owner@acme.com']) {
      const r = await signup(w.env, email, 'attacker-pass-1');
      const body = await json(r);
      answers.push(JSON.stringify({ status: r.status, ...body, email: '*' }));
      expect(pendingCookieOf(r)).toMatch(/^__Host-rsm_pending=[A-Za-z0-9_-]{43}$/);
    }
    expect(new Set(answers).size).toBe(1);
    expect(w.account('owner@acme.com')).toEqual(before);
    expect((await me(w.env, token)).status).toBe(200); // their session is untouched
    expect((await login(w.env, 'owner@acme.com', 'attacker-pass-1')).status).toBe(401);
    await flushBackground();
    expect(mailsTo(w.env, 'owner@acme.com').at(-1)!.subject).toBe(SIGNUP_NOTICE_SUBJECT);
  });

  it('the "someone tried to sign up" notice is limited by the sign-up allowance', async () => {
    const w = hosted();
    await signupVerified(w.env, 'owner@acme.com', 'owner-pass-1');
    for (let i = 0; i < 6; i++) await signup(w.env, 'owner@acme.com', 'attacker-pass-1');
    await flushBackground();
    // the sign-up's own code used one of the hour's two
    expect(mailsTo(w.env, 'owner@acme.com').filter(m => m.subject === SIGNUP_NOTICE_SUBJECT)).toHaveLength(CODE_MAIL_CAPS.signup.hour - 1);
  });
});

describe('threat 2: guessing a code', () => {
  it(`${CODE_MAX_TRIES} wrong tries kill the code: the right one is refused after`, async () => {
    const w = hosted();
    await signupVerified(w.env, 'a@example.com', 'a-password-1');
    const res = await login(w.env, 'a@example.com', 'a-password-1');
    const cookie = pendingCookieOf(res);
    const code = await lastCodeFor(w.env, 'a@example.com');
    for (let i = CODE_MAX_TRIES - 1; i >= 0; i--) {
      const r = await enterCode(w.env, cookie, otherThan(code), { ip: ip() });
      if (i > 0) { expect(r.status).toBe(400); expect((await json(r)).error).toBe(`That code is not right. ${i} ${i === 1 ? 'try' : 'tries'} left.`); }
      else expect((await json(r)).code).toBe('code_used_up');
    }
    const late = await enterCode(w.env, cookie, code, { ip: ip() });
    expect(late.status).toBe(410);
    expect((await json(late)).code).toBe('code_used_up');
  });

  it(`across codes: ${CODE_FAILS_PER_ACCOUNT} wrong codes an hour per address and purpose, ${CODE_FAILS_PER_IP} per IP`, async () => {
    const w = hosted();
    await signupVerified(w.env, 'a@example.com', 'a-password-1');
    let wrong = 0;
    while (wrong < CODE_FAILS_PER_ACCOUNT) {
      const res = await login(w.env, 'a@example.com', 'a-password-1');
      const code = await lastCodeFor(w.env, 'a@example.com');
      for (let i = 0; i < 4 && wrong < CODE_FAILS_PER_ACCOUNT; i++, wrong++) await enterCode(w.env, pendingCookieOf(res), otherThan(code), { ip: ip() });
    }
    const res = await login(w.env, 'a@example.com', 'a-password-1');
    const r = await enterCode(w.env, pendingCookieOf(res), await lastCodeFor(w.env, 'a@example.com'), { ip: ip() });
    expect(r.status).toBe(429);
    expect((await json(r)).code).toBe('code_throttled');

    const v = hosted();
    const attacker = '203.0.113.9';
    for (let k = 0; k < CODE_FAILS_PER_IP / 2; k++) {
      const res = await signup(v.env, `t${k}@example.com`, 'pass-word-123');
      const code = await lastCodeFor(v.env, `t${k}@example.com`);
      for (let i = 0; i < 2; i++) await enterCode(v.env, pendingCookieOf(res), otherThan(code), { ip: attacker });
    }
    const last = await signup(v.env, 'z@example.com', 'pass-word-123');
    expect((await enterCode(v.env, pendingCookieOf(last), await lastCodeFor(v.env, 'z@example.com'), { ip: attacker })).status).toBe(429);
  }, 30000);

  it('over the mail allowance an attempt is a decoy: no unsent code can be guessed at', async () => {
    const w = hosted();
    await signupVerified(w.env, 'a@example.com', 'a-password-1');
    for (let i = 0; i < CODE_MAIL_CAPS.reset.hour + 2; i++) await call(w.env, 'POST', '/api/auth/forgot', { body: { email: 'a@example.com' }, ip: ip() });
    const owners = w.rows("SELECT json_extract(value, '$.u') AS u FROM verifications WHERE identifier LIKE 'signin-code:%' ORDER BY created_at, rowid").map(r => r.u);
    expect(owners.filter(u => u !== null)).toHaveLength(CODE_MAIL_CAPS.reset.hour);
    expect(owners.slice(-2)).toEqual([null, null]);
    await flushBackground();
    expect(mailsTo(w.env, 'a@example.com').filter(m => /code$/.test(m.subject))).toHaveLength(1 + CODE_MAIL_CAPS.reset.hour); // the sign-up's, then the allowance
  });

  it('expires after ten minutes', async () => {
    const w = hosted();
    const res = await signup(w.env, 'a@example.com', 'a-password-1');
    const code = await lastCodeFor(w.env, 'a@example.com');
    const t0 = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(t0 + CODE_SECONDS * 1000 + 1000);
    const r = await enterCode(w.env, pendingCookieOf(res), code);
    expect(r.status).toBe(410);
    expect((await json(r)).code).toBe('code_expired');
  });

  it('works once; asking for a new code (from the same browser) kills the previous one', async () => {
    const w = hosted();
    await signupVerified(w.env, 'a@example.com', 'a-password-1');
    const first = await login(w.env, 'a@example.com', 'a-password-1');
    const firstCode = await lastCodeFor(w.env, 'a@example.com');
    const second = await login(w.env, 'a@example.com', 'a-password-1', { cookie: pendingCookieOf(first) });
    const secondCode = await lastCodeFor(w.env, 'a@example.com');
    expect(pendingCookieOf(second)).not.toBe(pendingCookieOf(first));
    expect((await enterCode(w.env, pendingCookieOf(first), firstCode)).status).toBe(410);
    expect((await enterCode(w.env, pendingCookieOf(second), firstCode)).status).toBe(400);
    expect((await enterCode(w.env, pendingCookieOf(second), secondCode)).status).toBe(200);
    expect((await enterCode(w.env, pendingCookieOf(second), secondCode)).status).toBe(410); // single use
  });

  it('typed in another browser (no attempt cookie, or another attempt\'s) it does nothing', async () => {
    const w = hosted();
    await signupVerified(w.env, 'a@example.com', 'a-password-1');
    await signupVerified(w.env, 'b@example.com', 'b-password-1');
    await login(w.env, 'a@example.com', 'a-password-1');
    const code = await lastCodeFor(w.env, 'a@example.com');
    const other = await login(w.env, 'b@example.com', 'b-password-1');
    expect((await call(w.env, 'POST', '/api/auth/code', { body: { code } })).status).toBe(410);
    expect((await enterCode(w.env, pendingCookieOf(other), code)).status).toBe(400);
  });
});

describe('threat 3: mail flooding and denial', () => {
  it(`allowances per address: sign-up ${CODE_MAIL_CAPS.signup.hour}/h, sign-in ${CODE_MAIL_CAPS.signin.hour}/h, reset ${CODE_MAIL_CAPS.reset.hour}/h, separate pools`, () => {
    expect(CODE_MAIL_CAPS).toEqual({ signup: { hour: 2, day: 4 }, signin: { hour: 10, day: 30 }, reset: { hour: 3, day: 10 } });
  });

  it('sign-up codes need the bot check and stop at the allowance, with the same answer', async () => {
    const w = hosted();
    expect((await call(w.env, 'POST', '/api/auth/signup', { body: { email: 'v@example.com', password: 'pass-word-123', cf_turnstile_token: '' } })).status).toBe(403);
    const bodies = new Set<string>();
    for (let i = 0; i < 5; i++) bodies.add(JSON.stringify(await json(await signup(w.env, 'v@example.com', 'pass-word-123'))));
    await flushBackground();
    expect(bodies.size).toBe(1);
    expect(mailsTo(w.env, 'v@example.com')).toHaveLength(CODE_MAIL_CAPS.signup.hour);
  });

  it('a stranger flooding resets and sign-ups cannot stop the owner\'s sign-in codes', async () => {
    const w = hosted();
    await signupVerified(w.env, 'a@example.com', 'a-password-1');
    for (let i = 0; i < 8; i++) {
      await call(w.env, 'POST', '/api/auth/forgot', { body: { email: 'a@example.com' }, ip: ip() });
      await signup(w.env, 'a@example.com', 'attacker-pass-1');
    }
    expect((await me(w.env, await loginWithCode(w.env, 'a@example.com', 'a-password-1'))).status).toBe(200);
  });

  it('a person signing in many times: ten codes an hour; the eleventh sign-in says plainly why it waits', async () => {
    const w = hosted();
    await signupVerified(w.env, 'a@example.com', 'a-password-1');
    for (let i = 0; i < CODE_MAIL_CAPS.signin.hour; i++) await loginWithCode(w.env, 'a@example.com', 'a-password-1');
    const r = await login(w.env, 'a@example.com', 'a-password-1');
    expect(r.status).toBe(429);
    const body = await json(r);
    expect(body.code).toBe('code_mail_limit');
    expect(body.error).toMatch(/^We have sent this address several sign-in codes recently\. Use the newest one you received, or try again in \d+ minutes?\.$/);
  });
});

describe('threat 4: lockout', () => {
  it('a stranger\'s wrong codes (on reset or sign-up attempts they started) do not hold up the owner\'s sign-in', async () => {
    const w = hosted();
    await signupVerified(w.env, 'a@example.com', 'a-password-1');
    for (let k = 0; k < 3; k++) {
      const res = await call(w.env, 'POST', '/api/auth/forgot', { body: { email: 'a@example.com' }, ip: ip() });
      for (let i = 0; i < CODE_MAX_TRIES; i++) await enterCode(w.env, pendingCookieOf(res), '000000', { ip: ip() });
      const s = await signup(w.env, 'a@example.com', 'attacker-pass-1');
      for (let i = 0; i < CODE_MAX_TRIES; i++) await enterCode(w.env, pendingCookieOf(s), '000000', { ip: ip() });
    }
    expect((await me(w.env, await loginWithCode(w.env, 'a@example.com', 'a-password-1'))).status).toBe(200);
  });

  it('wrong passwords still lock the address after 10 (no code is ever sent for them)', async () => {
    const w = hosted();
    await signupVerified(w.env, 'a@example.com', 'a-password-1');
    for (let i = 0; i < SIGNIN_FAILURE_LIMIT; i++) await login(w.env, 'a@example.com', `wrong-${i}-xx`);
    expect((await login(w.env, 'a@example.com', 'a-password-1')).status).toBe(429);
  });
});

describe('threat 6: the pending-attempt handle is not a session', () => {
  it('HttpOnly, SameSite=Strict, Secure, __Host-, ten minutes; it opens nothing', async () => {
    const w = hosted();
    await signupVerified(w.env, 'a@example.com', 'a-password-1');
    const res = await login(w.env, 'a@example.com', 'a-password-1');
    const raw = (res.headers as any).getSetCookie().find((c: string) => c.startsWith('__Host-rsm_pending='));
    expect(raw).toMatch(/; Path=\/; Max-Age=600; HttpOnly; SameSite=Strict; Secure$/);
    expect(res.headers.has('set-auth-token')).toBe(false);
    expect((await json(res)).token).toBeUndefined();
    const cookie = pendingCookieOf(res);
    expect((await call(w.env, 'GET', '/api/me', { headers: { cookie } })).status).toBe(401);
    expect((await call(w.env, 'GET', '/api/me', { key: cookie.split('=')[1] })).status).toBe(401);
  });

  it('cannot be fixed by an attacker: a planted handle is replaced and dropped at the next form, never adopted', async () => {
    const w = hosted();
    await signupVerified(w.env, 'victim@acme.com', 'victim-pass-1');
    const planted = pendingCookieOf(await signup(w.env, 'other@acme.com', 'attacker-pass-1'));
    const res = await login(w.env, 'victim@acme.com', 'victim-pass-1', { cookie: planted });
    expect(pendingCookieOf(res)).not.toBe(planted);
    expect((await enterCode(w.env, planted, await lastCodeFor(w.env, 'victim@acme.com'))).status).toBe(410);
  });

  it('CSRF: the code endpoint refuses a foreign Origin and a text/plain body', async () => {
    const w = hosted();
    const res = await signup(w.env, 'a@example.com', 'a-password-1');
    const code = await lastCodeFor(w.env, 'a@example.com');
    const cookie = pendingCookieOf(res);
    expect((await call(w.env, 'POST', '/api/auth/code', { body: { code }, headers: { cookie, origin: 'https://evil.example' } })).status).toBe(403);
    const { handleApi } = await import('../../src/api/router');
    const plain = await handleApi(new Request('https://ia.example.com/api/auth/code', { method: 'POST', headers: { 'content-type': 'text/plain', cookie, origin: 'https://ia.example.com' }, body: JSON.stringify({ code }) }), w.env, ctx);
    expect(plain.status).toBe(415);
    expect(w.account('a@example.com').email_verified).toBe(0);
  });
});

describe('account deletion', () => {
  it('also removes the account\'s pending code attempts and its device epoch', async () => {
    const w = hosted();
    const token = await signupVerified(w.env, 'a@example.com', 'a-password-1');
    const uid = w.account('a@example.com').id;
    await login(w.env, 'a@example.com', 'a-password-1');
    const mine = () => w.rows("SELECT identifier FROM verifications WHERE identifier = ? OR (identifier LIKE 'signin-code:%' AND json_extract(value, '$.u') = ?)", `device-epoch:${uid}`, uid);
    expect(mine().length).toBeGreaterThanOrEqual(2);
    expect((await call(w.env, 'DELETE', '/api/account', { key: token, body: { confirm: 'a@example.com' } })).status).toBe(200);
    expect(mine()).toEqual([]);
  });
});

describe('threat 7: closed sign-up', () => {
  it('no new accounts; existing users sign in with the code step', async () => {
    const w = hosted();
    await signupVerified(w.env, 'a@example.com', 'a-password-1');
    const closed = { ...w.env, TURNSTILE_SECRET_KEY: undefined, TURNSTILE_SITE_KEY: undefined } as typeof w.env;
    expect((await signup(closed, 'new@example.com', 'pass-word-123')).status).toBe(503);
    expect(w.rows("SELECT COUNT(*) n FROM users WHERE email = 'new@example.com'")).toEqual([{ n: 0 }]);
    const r = await call(closed, 'POST', '/api/auth/login', { body: { email: 'a@example.com', password: 'a-password-1', cf_turnstile_token: '' }, ip: ip() });
    expect((await json(r.clone())).code_required).toBe(true);
    expect((await enterCode(closed, pendingCookieOf(r), await lastCodeFor(w.env, 'a@example.com'))).status).toBe(200);
  });
});

describe('password reset by code', () => {
  it('code + new password: signed in without a second code, other sessions and the old password gone; unknown addresses answer the same', async () => {
    const w = hosted();
    const old = await signupVerified(w.env, 'a@example.com', 'a-password-1');
    const res = await call(w.env, 'POST', '/api/auth/forgot', { body: { email: 'a@example.com' }, ip: ip() });
    const ghost = await call(w.env, 'POST', '/api/auth/forgot', { body: { email: 'ghost@example.com' }, ip: ip() });
    expect({ ...(await json(res.clone())), email: '*' }).toEqual({ ...(await json(ghost.clone())), email: '*' });
    const done = await call(w.env, 'POST', '/api/auth/reset', { body: { code: await lastCodeFor(w.env, 'a@example.com'), password: 'brand-new-pass-1' }, headers: { cookie: pendingCookieOf(res) }, ip: ip() });
    expect(done.status).toBe(200);
    expect((await me(w.env, (await json(done)).token)).status).toBe(200);
    expect((await me(w.env, old)).status).toBe(401);
    expect((await login(w.env, 'a@example.com', 'a-password-1')).status).toBe(401);
    expect((await login(w.env, 'a@example.com', 'brand-new-pass-1')).status).toBe(200);
    // a ghost's reset attempt never works
    expect((await call(w.env, 'POST', '/api/auth/reset', { body: { code: '123456', password: 'whatever-123' }, headers: { cookie: pendingCookieOf(ghost) } })).status).toBe(400);
  });

  it('a sign-in code cannot be used to reset, nor a reset code to sign in', async () => {
    const w = hosted();
    await signupVerified(w.env, 'a@example.com', 'a-password-1');
    const s = await login(w.env, 'a@example.com', 'a-password-1');
    expect((await call(w.env, 'POST', '/api/auth/reset', { body: { code: await lastCodeFor(w.env, 'a@example.com'), password: 'x-new-pass-1' }, headers: { cookie: pendingCookieOf(s) } })).status).toBe(410);
    const r = await call(w.env, 'POST', '/api/auth/forgot', { body: { email: 'a@example.com' }, ip: ip() });
    expect((await enterCode(w.env, pendingCookieOf(r), await lastCodeFor(w.env, 'a@example.com'))).status).toBe(410);
  });
});

describe('invites (hosted)', () => {
  it('the invitee sets a password and confirms with the code: verified, signed in, a member of the inviting workspace', async () => {
    const w = hosted();
    const owner = await signupVerified(w.env, 'owner@acme.com', 'owner-pass-1');
    const inv = await json(await call(w.env, 'POST', '/api/team/invite', { key: owner, body: { email: 'friend@acme.com', role: 'member' } }));
    const res = await call(w.env, 'POST', `/api/invites/${inv.token}`, { body: { password: 'friend-pass-1' }, ip: ip() });
    expect((await json(res.clone())).purpose).toBe('invite');
    const done = await enterCode(w.env, pendingCookieOf(res), await lastCodeFor(w.env, 'friend@acme.com'));
    expect(done.status).toBe(200);
    const body = await json(done);
    expect(body.workspace_id).toBe(w.rows('SELECT workspace_id FROM invites')[0].workspace_id);
    expect(w.rows("SELECT m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = 'friend@acme.com'")).toEqual([{ role: 'member' }]);
    expect((await me(w.env, body.token)).status).toBe(200);
  });
});

describe('links already in inboxes', () => {
  it('the retired welcome POST and resend answer 410 link_retired; the old GET shape still only moves the token into the fragment', async () => {
    const w = hosted();
    for (const p of ['/api/auth/welcome', '/api/auth/resend-verification']) {
      const r = await call(w.env, 'POST', p, { body: { token: 'x'.repeat(40), password: 'whatever-1', email: 'a@example.com' } });
      expect(r.status).toBe(410);
      expect((await json(r)).code).toBe('link_retired');
    }
    const page = await call(w.env, 'GET', '/api/auth/verify-email?token=abc');
    expect(page.status).toBe(200);
    expect(page.headers.get('location')).toBeNull();
  });
});

describe('terms acceptance', () => {
  it('is recorded when the code proves the address, not before', async () => {
    const w = hosted({ TERMS_VERSION: '2026-11-14' });
    const res = await signup(w.env, 'a@example.com', 'a-password-1');
    expect(w.account('a@example.com').terms_accepted_at).toBeNull();
    expect(w.account('a@example.com').terms_version).toBeNull();
    await enterCode(w.env, pendingCookieOf(res), await lastCodeFor(w.env, 'a@example.com'));
    expect(w.account('a@example.com').terms_version).toBe('2026-11-14');
    expect(Math.abs(w.account('a@example.com').terms_accepted_at - Date.now() / 1000)).toBeLessThan(60);
  });

  it('hosted status names the terms, privacy and operator; self-host shows nothing unless configured', async () => {
    const h = hosted();
    expect((await json(await call(h.env, 'GET', '/api/auth/status'))).legal).toEqual({ terms_url: 'https://readysetmail.com/terms', privacy_url: 'https://readysetmail.com/privacy', operator_name: 'Fellowship.dev, Inc.' });
    const self = makeEnv();
    expect((await json(await call(self, 'GET', '/api/auth/status'))).legal).toEqual({ terms_url: null, privacy_url: null, operator_name: null });
    expect(mailFooter(self)).toBe('');
    const half = makeEnv(createMigratedD1(), { TERMS_URL: 'https://ops.example/terms' });
    expect((await json(await call(half, 'GET', '/api/auth/status'))).legal.terms_url).toBeNull();
    const full = makeEnv(createMigratedD1(), { TERMS_URL: 'https://ops.example/terms', PRIVACY_URL: 'https://ops.example/privacy', OPERATOR_NAME: 'Ops Ltd', POSTAL_ADDRESS: '1 Main St' });
    expect((await json(await call(full, 'GET', '/api/auth/status'))).legal).toEqual({ terms_url: 'https://ops.example/terms', privacy_url: 'https://ops.example/privacy', operator_name: 'Ops Ltd' });
    expect(mailFooter(full)).toBe('Ready Set Mail is operated by Ops Ltd, 1 Main St. Privacy: https://ops.example/privacy');
    const site = makeEnv(createMigratedD1(), { ...HOSTED_ENV, SITE_URL: 'https://site.example/' });
    expect((await json(await call(site, 'GET', '/api/auth/status'))).legal.terms_url).toBe('https://site.example/terms');
  });
});

describe('self-host: codes follow the ability to send mail', () => {
  it('without mail: password only, owner setup as today, and the status says so', async () => {
    const env = makeEnv();
    await setupOwner(env);
    const status = await json(await call(env, 'GET', '/api/auth/status'));
    expect([status.signin_codes, status.signin_codes_reason]).toEqual([false, 'no_mail']);
    const r = await call(env, 'POST', '/api/auth/login', { body: { email: 'owner@example.com', password: 'correct-horse-battery' } });
    expect(r.status).toBe(200);
    expect((await json(r)).token).toBeTruthy();
  });

  it('with mail: the same code step; SIGNIN_CODES=off turns it off; hosted ignores the switch', async () => {
    const send = vi.fn(async () => {});
    const env = makeEnv(createMigratedD1(), { SEND_EMAIL: { send } });
    await setupOwner(env);
    expect((await json(await call(env, 'GET', '/api/auth/status'))).signin_codes_reason).toBe('mail');
    expect((await json(await call(env, 'POST', '/api/auth/login', { body: { email: 'owner@example.com', password: 'correct-horse-battery' } }))).code_required).toBe(true);
    expect((await me(env, await loginWithCode(env, 'owner@example.com', 'correct-horse-battery'))).status).toBe(200);
    const off = { ...env, SIGNIN_CODES: 'off' } as typeof env;
    expect((await json(await call(off, 'POST', '/api/auth/login', { body: { email: 'owner@example.com', password: 'correct-horse-battery' } }))).token).toBeTruthy();
    const h = hosted({ SIGNIN_CODES: 'off' });
    await signupVerified(h.env, 'a@example.com', 'a-password-1');
    expect((await json(await login(h.env, 'a@example.com', 'a-password-1'))).code_required).toBe(true);
  });
});
