// Sign-in codes, after the independent security review of PR 162: one block per finding (B1 self-host lockout, B2 denial of
// reset and sign-up codes, B3 account existence by timing) and per strengthening decision. Each test fails without its fix.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { call, enterCode, flushBackground, inviteAndAccept, lastCodeFor, mailsTo, makeEnv, pendingCookieOf, setupOwner, signupVerified } from '../auth/helpers';
import { HOSTED_ENV } from '../hosted/world';
import { OPEN_FAILS_PER_DAY, SIGNIN_ALERT_AT, SIGNIN_FAILS_PER_DAY, SIGNIN_FAILS_PER_HOUR } from '../../src/auth/codes';
import { SIGNIN_ALERT_SUBJECT, SIGNUP_NOTICE_SUBJECT } from '../../src/auth/mail';

const json = async (r: Response) => await r.json() as any;
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

let n = 0;
const ip = () => `203.0.113.${++n % 250}`;
const login = (env: any, email: string, password: string, headers: Record<string, string> = {}) => call(env, 'POST', '/api/auth/login', { body: { email, password }, ip: ip(), headers });
const forgot = (env: any, email: string, headers: Record<string, string> = {}) => call(env, 'POST', '/api/auth/forgot', { body: { email }, ip: ip(), headers });
const resetWith = (env: any, cookie: string, code: string, password: string, headers: Record<string, string> = {}) => call(env, 'POST', '/api/auth/reset', { body: { code, password }, ip: ip(), headers: { cookie, ...headers } });
const me = (env: any, token: string) => call(env, 'GET', '/api/me', { key: token });
const otherThan = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');
const codesTo = async (env: any, email: string) => { await flushBackground(); return mailsTo(env, email).filter(m => /^\d{6} is your Ready Set Mail code$/.test(m.subject)); };
const MAIL_LIMIT = /^Several codes were sent to this address recently\. Use the newest one, or try again in \d+ minutes?\.$/;
const auditActions = (db: any, action: string) => db.sqlite.prepare('SELECT action, meta FROM audit_log WHERE action = ?').all(action) as any[];
const deviceCookieOf = (res: Response) => (res.headers as any).getSetCookie().find((c: string) => c.startsWith('rsm_device='))!.split(';')[0] as string;

function hosted(send = vi.fn(async (_m: unknown) => {})) {
  const db = createMigratedD1();
  const env = makeEnv(db, { ...HOSTED_ENV, SEND_EMAIL: { send } });
  return { db, env, send, rows: (sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[] };
}
/** A self-hosted instance whose mail binding throws (Cloudflare: the destination is not a verified Email Routing address). */
const undeliverable = () => vi.fn(async (_m: unknown) => { throw new Error('destination address is not a verified address'); });

describe('B1: a self-hosted owner is never locked out by a code that cannot arrive', () => {
  it('mail configured but undeliverable: sign-in is the password alone; reset answers exactly as for an unknown address', async () => {
    const db = createMigratedD1();
    const env = makeEnv(db, { SEND_EMAIL: { send: undeliverable() } });
    await setupOwner(env);
    const status = await json(await call(env, 'GET', '/api/auth/status'));
    expect([status.signin_codes, status.signin_codes_reason, status.signin_code_sender_domain]).toEqual([true, 'mail', 'reports.example.com']);
    const r = await login(env, 'owner@example.com', 'correct-horse-battery');
    expect(r.status).toBe(200);
    expect((await json(r)).token).toBeTruthy();
    // The owner's reset code is sent after the answer (and refused by the provider); an unknown address is mailed nothing.
    // Both answers are the same, so the reset form tells nobody whether an address has an account (the self-host oracle).
    const f = await forgot(env, 'owner@example.com');
    const u = await forgot(env, 'nobody@example.com');
    expect([f.status, u.status]).toEqual([200, 200]);
    expect({ ...(await json(f)), email: '*' }).toEqual({ ...(await json(u)), email: '*' });
    await flushBackground();
    await flushBackground();
    expect(auditActions(db, 'auth.code_not_sent').map(r => JSON.parse(r.meta).purpose)).toEqual(['reset']);
  });

  it('a test code from Settings turns codes on for that person, and only for them; a teammate without proof is password-only', async () => {
    const send = vi.fn(async (_m: unknown) => {});
    const env = makeEnv(createMigratedD1(), { SEND_EMAIL: { send } });
    const owner = await setupOwner(env);
    const teammate = await inviteAndAccept(env, owner, 'mate@example.com', 'member');
    expect((await json(await call(env, 'GET', '/api/auth/codes', { key: owner }))).on_for_me).toBe(false);
    expect((await json(await login(env, 'owner@example.com', 'correct-horse-battery'))).token).toBeTruthy();

    const test = await call(env, 'POST', '/api/auth/codes/test', { key: owner, body: {} });
    expect(test.status).toBe(200);
    expect(await json(test.clone())).toMatchObject({ code_required: true, purpose: 'confirm', email: 'owner@example.com' });
    expect(mailsTo(env, 'owner@example.com').at(-1)!.text).toContain('confirm that Ready Set Mail sign-in codes reach you');
    const wrong = await call(env, 'POST', '/api/auth/codes/confirm', { key: owner, body: { code: otherThan(await lastCodeFor(env, 'owner@example.com')) }, headers: { cookie: pendingCookieOf(test) } });
    expect(wrong.status).toBe(400);
    const ok = await call(env, 'POST', '/api/auth/codes/confirm', { key: owner, body: { code: await lastCodeFor(env, 'owner@example.com') }, headers: { cookie: pendingCookieOf(test) } });
    expect(await json(ok)).toEqual({ ok: true, on_for_me: true });
    expect((await json(await call(env, 'GET', '/api/auth/codes', { key: owner }))).on_for_me).toBe(true);

    expect((await json(await login(env, 'owner@example.com', 'correct-horse-battery'))).code_required).toBe(true);
    const mate = await json(await login(env, 'mate@example.com', 'invitee-password-1'));
    expect(mate.code_required).toBeUndefined();
    expect((await me(env, mate.token)).status).toBe(200);
    expect((await json(await call(env, 'GET', '/api/auth/codes', { key: teammate }))).on_for_me).toBe(false);
  });

  it('a test code that cannot be sent says so and leaves codes off', async () => {
    const env = makeEnv(createMigratedD1(), { SEND_EMAIL: { send: undeliverable() } });
    const owner = await setupOwner(env);
    const r = await call(env, 'POST', '/api/auth/codes/test', { key: owner, body: {} });
    expect(r.status).toBe(503);
    expect((await json(r)).error).toBe("We couldn't send a code to owner@example.com. This instance may not be able to deliver mail to that address, so sign-in codes stay off for you.");
    expect((await json(await call(env, 'GET', '/api/auth/codes', { key: owner }))).on_for_me).toBe(false);
  });

  it('a proven person whose sign-in code cannot be sent is not signed in: told so, proof kept, audited', async () => {
    const send = vi.fn(async (_m: unknown) => {});
    const db = createMigratedD1();
    const env = makeEnv(db, { SEND_EMAIL: { send } });
    const owner = await setupOwner(env);
    const test = await call(env, 'POST', '/api/auth/codes/test', { key: owner, body: {} });
    await call(env, 'POST', '/api/auth/codes/confirm', { key: owner, body: { code: await lastCodeFor(env, 'owner@example.com') }, headers: { cookie: pendingCookieOf(test) } });
    send.mockImplementation(async () => { throw new Error('mail is down'); });
    const r = await login(env, 'owner@example.com', 'correct-horse-battery');
    expect(r.status).toBe(503);
    expect(await json(r)).toEqual({ error: "We couldn't email your code. Try again, or ask whoever runs this instance (they can turn codes off with SIGNIN_CODES=off).", code: 'code_not_sent' });
    expect((r.headers as any).getSetCookie().filter((c: string) => /session_token|rsm_pending=./.test(c))).toEqual([]);
    expect((await json(await call(env, 'GET', '/api/auth/codes', { key: owner }))).on_for_me).toBe(true);
    await flushBackground();
    expect(auditActions(db, 'auth.code_not_sent').map(a => JSON.parse(a.meta).purpose)).toEqual(['signin']);
    // An unproven teammate is unaffected: password alone, as before.
    send.mockImplementation(async () => {});
  });

  it('a reset code that reaches a self-hosted person also turns codes on for them', async () => {
    const send = vi.fn(async (_m: unknown) => {});
    const env = makeEnv(createMigratedD1(), { SEND_EMAIL: { send } });
    await setupOwner(env);
    const f = await forgot(env, 'owner@example.com');
    const done = await resetWith(env, pendingCookieOf(f), await lastCodeFor(env, 'owner@example.com'), 'a-new-password-1');
    expect(done.status).toBe(200);
    expect((await json(await login(env, 'owner@example.com', 'a-new-password-1'))).code_required).toBe(true);
  });

  it('hosted is unchanged: a code every time, and a send failure reads the same for every address', async () => {
    const h = hosted();
    await signupVerified(h.env, 'known@example.com', 'a-password-1');
    expect((await json(await login(h.env, 'known@example.com', 'a-password-1'))).code_required).toBe(true);
    h.send.mockImplementation(async () => { throw new Error('mail is down'); });
    const forNew = await call(h.env, 'POST', '/api/auth/signup', { body: { email: 'new@example.com', password: 'a-password-1' }, ip: ip() });
    const forKnown = await call(h.env, 'POST', '/api/auth/signup', { body: { email: 'known@example.com', password: 'a-password-1' }, ip: ip() });
    expect([forNew.status, forKnown.status]).toEqual([503, 503]);
    const a = await json(forNew), b = await json(forKnown);
    expect(a).toEqual({ error: "We couldn't send the code. Try again in a minute.", code: 'code_not_sent' });
    expect(b).toEqual(a);
    expect([(forNew.headers as any).getSetCookie().length, (forKnown.headers as any).getSetCookie().length]).toEqual([0, 0]);
    // Reset sends after the answer: during a mail outage it looks sent (the documented cost), the same for every address.
    const fNew = await forgot(h.env, 'nobody@example.com'), fKnown = await forgot(h.env, 'known@example.com');
    expect([fNew.status, fKnown.status]).toEqual([200, 200]);
    expect({ ...(await json(fNew)), email: '*' }).toEqual({ ...(await json(fKnown)), email: '*' });
  });
});

describe('B2: a stranger cannot stop the owner from using a reset or sign-up code', () => {
  /** A stranger's reset attempt for `email` (a different browser), with `wrong` junk codes typed into it. */
  async function strangerSpends(env: any, email: string, wrong: number) {
    const f = await forgot(env, email);
    const cookie = pendingCookieOf(f);
    const answers: number[] = [];
    for (let i = 0; i < wrong; i++) answers.push((await enterCodeTo(env, '/api/auth/reset', cookie, '000000')).status);
    return answers;
  }
  const enterCodeTo = (env: any, path: string, cookie: string, code: string) => call(env, 'POST', path, { body: { code, password: 'whatever-password-1' }, ip: ip(), headers: { cookie } });

  it('only genuinely wrong comparisons count: refusals of a used-up code do not', async () => {
    const h = hosted();
    await signupVerified(h.env, 'victim@example.com', 'a-password-1');
    // 5 compared (4 wrong + the 5th used up), then 3 refusals of a used-up code that were never compared.
    expect(await strangerSpends(h.env, 'victim@example.com', 8)).toEqual([400, 400, 400, 400, 410, 410, 410, 410]);
    // The second attempt still gets all five comparisons: 5 + 5 = OPEN_FAILS_PER_DAY, nothing over.
    expect(OPEN_FAILS_PER_DAY).toBe(10);
    expect(await strangerSpends(h.env, 'victim@example.com', 5)).toEqual([400, 400, 400, 400, 410]);
  });

  it('over the daily budget, the first try on a freshly mailed code is still compared: the owner who types it right gets in', async () => {
    const h = hosted();
    await signupVerified(h.env, 'victim@example.com', 'a-password-1');
    await strangerSpends(h.env, 'victim@example.com', 5);
    await strangerSpends(h.env, 'victim@example.com', 5);
    const f = await forgot(h.env, 'victim@example.com'); // the third reset mail this hour, within the allowance
    const code = (await codesTo(h.env, 'victim@example.com')).at(-1)!.subject.slice(0, 6);
    const done = await resetWith(h.env, pendingCookieOf(f), code, 'the-victims-new-1');
    expect(done.status).toBe(200);
  });

  it('a second try over the budget is refused with the truth and the way through', async () => {
    const h = hosted();
    await signupVerified(h.env, 'victim@example.com', 'a-password-1');
    await strangerSpends(h.env, 'victim@example.com', 5);
    await strangerSpends(h.env, 'victim@example.com', 5);
    const f = await forgot(h.env, 'victim@example.com');
    const code = (await codesTo(h.env, 'victim@example.com')).at(-1)!.subject.slice(0, 6);
    expect((await resetWith(h.env, pendingCookieOf(f), otherThan(code), 'the-victims-new-1')).status).toBe(400); // first try: compared
    const second = await resetWith(h.env, pendingCookieOf(f), code, 'the-victims-new-1');
    expect(second.status).toBe(429);
    expect((await json(second)).error).toBe('Too many wrong codes for this address today. Ask for a new code and enter it carefully: the first try on a new code always counts.');
  });

  it("the owner's browser (device cookie) has its own reset mail allowance and its own wrong-code budget", async () => {
    const h = hosted();
    const s = await call(h.env, 'POST', '/api/auth/signup', { body: { email: 'victim@example.com', password: 'a-password-1' }, ip: ip() });
    const signedUp = await enterCode(h.env, pendingCookieOf(s), await lastCodeFor(h.env, 'victim@example.com'));
    const device = deviceCookieOf(signedUp);
    // A stranger spends the address's reset mail (3 this hour) and its wrong-code budget.
    await strangerSpends(h.env, 'victim@example.com', 5);
    await strangerSpends(h.env, 'victim@example.com', 5);
    await strangerSpends(h.env, 'victim@example.com', 1);
    const before = (await codesTo(h.env, 'victim@example.com')).length;
    const over = await forgot(h.env, 'victim@example.com'); // the address's allowance is spent: said plainly, nothing sent
    expect(over.status).toBe(429);
    expect((await json(over)).error).toMatch(MAIL_LIMIT);
    expect((await codesTo(h.env, 'victim@example.com')).length).toBe(before);
    const f = await forgot(h.env, 'victim@example.com', { cookie: device });
    const mine = await codesTo(h.env, 'victim@example.com');
    expect(mine.length).toBe(before + 1);
    const cookie = `${pendingCookieOf(f)}; ${device}`;
    const code = mine.at(-1)!.subject.slice(0, 6);
    expect((await resetWith(h.env, cookie, otherThan(code), 'the-victims-new-1')).status).toBe(400);
    expect((await resetWith(h.env, cookie, otherThan(code), 'the-victims-new-1')).status).toBe(400);
    expect((await resetWith(h.env, cookie, code, 'the-victims-new-1')).status).toBe(200);
  });

  it('a sign-up code for a new address: the same budget shape, and the first try always counts', async () => {
    const h = hosted();
    const signup = (pw: string) => call(h.env, 'POST', '/api/auth/signup', { body: { email: 'new@example.com', password: pw }, ip: ip() });
    for (const _ of [0, 1]) {
      const c = pendingCookieOf(await signup('stranger-pass-1'));
      for (let i = 0; i < 5; i++) await enterCode(h.env, c, '000000');
    }
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 3601_000); // the next hour: new sign-up mail, but the day's wrong-code budget is spent
    const c = pendingCookieOf(await signup('stranger-pass-1'));
    const answers: number[] = [];
    for (let i = 0; i < 5; i++) answers.push((await enterCode(h.env, c, '000000')).status);
    expect(answers).toEqual([400, 429, 429, 429, 429]); // only the first try on a new code is compared
    const mine = await signup('the-owners-pass-1');
    const done = await enterCode(h.env, pendingCookieOf(mine), await lastCodeFor(h.env, 'new@example.com'));
    expect(done.status).toBe(200);
    expect((await login(h.env, 'new@example.com', 'the-owners-pass-1')).status).toBe(200);
  });

  it('N1: a parallel burst cannot all claim the first try: 15 wrong codes over 3 fresh codes compare at most the limit plus one first try per code', async () => {
    const h = hosted();
    await signupVerified(h.env, 'victim@example.com', 'a-password-1');
    const cookies: string[] = [];
    for (let i = 0; i < 3; i++) cookies.push(pendingCookieOf(await forgot(h.env, 'victim@example.com')));
    const all = await Promise.all(cookies.flatMap(c => Array.from({ length: 5 }, () => enterCodeTo(h.env, '/api/auth/reset', c, '000000'))));
    const compared = all.filter(r => r.status === 400 || r.status === 410).length;
    expect(compared).toBeLessThanOrEqual(OPEN_FAILS_PER_DAY + 3);
    expect(all.filter(r => r.status === 429).length).toBe(15 - compared);
    expect(compared).toBeGreaterThanOrEqual(OPEN_FAILS_PER_DAY);
  });

  it('over the mail allowance the answer says so, the same for an account and an address without one', async () => {
    const h = hosted();
    await signupVerified(h.env, 'known@example.com', 'a-password-1');
    for (let i = 0; i < 3; i++) {
      expect((await forgot(h.env, 'known@example.com')).status).toBe(200);
      expect((await forgot(h.env, 'nobody@example.com')).status).toBe(200);
    }
    const k = await forgot(h.env, 'known@example.com'), u = await forgot(h.env, 'nobody@example.com');
    expect([k.status, u.status]).toEqual([429, 429]);
    const said = await json(k);
    expect(said.error).toMatch(MAIL_LIMIT);
    expect(await json(u)).toEqual(said);
  });

  it('wrong-code budgets are atomic: parallel wrong codes across attempts cannot pass the hourly sign-in cap', async () => {
    const h = hosted();
    await signupVerified(h.env, 'a@example.com', 'a-password-1');
    const cookies: string[] = [];
    for (let i = 0; i < 3; i++) cookies.push(pendingCookieOf(await login(h.env, 'a@example.com', 'a-password-1')));
    const all = await Promise.all(cookies.flatMap(c => Array.from({ length: 5 }, () => enterCode(h.env, c, '000000'))));
    const compared = all.filter(r => r.status === 400 || r.status === 410).length;
    expect(compared).toBe(SIGNIN_FAILS_PER_HOUR);
    expect(all.filter(r => r.status === 429).length).toBe(15 - SIGNIN_FAILS_PER_HOUR);
  });
});

describe('sign-in with the password already known: a daily cap and one warning email', () => {
  it(`${SIGNIN_FAILS_PER_DAY} wrong sign-in codes a day, then code entry waits; the ${SIGNIN_ALERT_AT}th sends one warning; a reset clears it`, async () => {
    const h = hosted();
    await signupVerified(h.env, 'a@example.com', 'a-password-1');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now());
    const wrongTen = async () => {
      for (const _ of [0, 1]) {
        const c = pendingCookieOf(await login(h.env, 'a@example.com', 'a-password-1'));
        for (let i = 0; i < 5; i++) expect([400, 410]).toContain((await enterCode(h.env, c, '000000')).status);
      }
    };
    await wrongTen();
    await flushBackground();
    const alerts = () => mailsTo(h.env, 'a@example.com').filter(m => m.subject === SIGNIN_ALERT_SUBJECT);
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]!.text).toContain('whoever it was knows your password. Change your password');
    vi.setSystemTime(Date.now() + 3601_000);
    await wrongTen();
    await flushBackground();
    expect(alerts()).toHaveLength(1);
    // Day budget spent: even the right code on a fresh attempt is refused until tomorrow or a reset.
    const l = await login(h.env, 'a@example.com', 'a-password-1');
    const refused = await enterCode(h.env, pendingCookieOf(l), await lastCodeFor(h.env, 'a@example.com'));
    expect(refused.status).toBe(429);
    expect((await json(refused)).error).toBe('Too many wrong codes for this account today. Try again tomorrow, or reset your password to sign in now.');
    // The wrong codes never touched the wrong-password throttle; a reset clears the code budget.
    const f = await forgot(h.env, 'a@example.com');
    expect((await resetWith(h.env, pendingCookieOf(f), (await codesTo(h.env, 'a@example.com')).at(-1)!.subject.slice(0, 6), 'a-new-password-1')).status).toBe(200);
    const again = await login(h.env, 'a@example.com', 'a-new-password-1');
    expect((await enterCode(h.env, pendingCookieOf(again), await lastCodeFor(h.env, 'a@example.com'))).status).toBe(200);
  });
});

describe('B3: whether an address has an account is not in the answer, nor in the work done', () => {
  /** Counts D1 statements prepared and PBKDF2 derivations during `fn`. */
  async function work(db: any, fn: () => Promise<unknown>) {
    let statements = 0;
    const prepare = db.prepare.bind(db);
    db.prepare = (sql: string) => { statements++; return prepare(sql); };
    const derive = vi.spyOn(crypto.subtle, 'deriveBits');
    const before = derive.mock.calls.length;
    try { await fn(); } finally { db.prepare = prepare; }
    const pbkdf2 = derive.mock.calls.length - before;
    derive.mockRestore();
    return { statements, pbkdf2 };
  }

  it('sign-up creates nothing until the code is right', async () => {
    const h = hosted();
    const users = () => h.rows("SELECT id, email_verified FROM users WHERE email = 'new@example.com'");
    const workspaces = () => h.rows('SELECT id FROM workspaces').length;
    const ws = workspaces();
    const s = await call(h.env, 'POST', '/api/auth/signup', { body: { email: 'new@example.com', password: 'a-password-1' }, ip: ip() });
    expect(s.status).toBe(200);
    expect(users()).toHaveLength(0);
    expect(workspaces()).toBe(ws);
    expect((await enterCode(h.env, pendingCookieOf(s), await lastCodeFor(h.env, 'new@example.com'))).status).toBe(200);
    expect(users()).toEqual([expect.objectContaining({ email_verified: 1 })]);
    expect(workspaces()).toBe(ws + 1);
  });

  it('sign-up does the same work for a new and an existing address (statements, password hashes, one email)', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // no opportunistic rate-limit sweep in either request
    const h = hosted();
    await signupVerified(h.env, 'known@example.com', 'a-password-1');
    const signup = (email: string) => call(h.env, 'POST', '/api/auth/signup', { body: { email, password: 'a-password-1' }, ip: ip() });
    const sent = () => h.send.mock.calls.length;
    let mails = sent();
    const forNew = await work(h.db, () => signup('new@example.com'));
    expect(sent() - mails).toBe(1);
    mails = sent();
    const forKnown = await work(h.db, () => signup('known@example.com'));
    expect(sent() - mails).toBe(1);
    expect(mailsTo(h.env, 'known@example.com').at(-1)!.subject).toBe(SIGNUP_NOTICE_SUBJECT);
    expect(forKnown).toEqual(forNew);
  });

  it('a reset request for an unknown address mails nothing and answers like one for an account (whose code goes out after the answer)', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const h = hosted();
    await signupVerified(h.env, 'known@example.com', 'a-password-1');
    let ru: Response | undefined, rk: Response | undefined;
    const unknown = await work(h.db, async () => { ru = await forgot(h.env, 'nobody@example.com'); });
    const known = await work(h.db, async () => { rk = await forgot(h.env, 'known@example.com'); });
    expect([ru!.status, rk!.status]).toEqual([200, 200]);
    expect({ ...(await json(ru!)), email: '*' }).toEqual({ ...(await json(rk!)), email: '*' });
    expect(unknown.pbkdf2).toBe(known.pbkdf2);
    await flushBackground();
    expect(mailsTo(h.env, 'nobody@example.com')).toEqual([]);
    expect((await codesTo(h.env, 'known@example.com')).length).toBe(2); // the sign-up code and the reset code
  });

  it('sign-in does the same work for an unknown address and a wrong password: one query, one real PBKDF2 verification', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const h = hosted();
    await signupVerified(h.env, 'known@example.com', 'a-password-1');
    await login(h.env, 'warm-up@example.com', 'nope-nope-1'); // the dummy hash is made once per isolate
    const unknown = await work(h.db, () => login(h.env, 'nobody@example.com', 'nope-nope-1'));
    const wrong = await work(h.db, () => login(h.env, 'known@example.com', 'nope-nope-1'));
    expect(unknown).toEqual(wrong);
    expect(unknown.pbkdf2).toBe(1);
  });
});

describe('strengthening', () => {
  it('hosted reset always has the bot check: without the keys it is unavailable, in plain words', async () => {
    const db = createMigratedD1();
    const env = makeEnv(db, { ...HOSTED_ENV, SEND_EMAIL: { send: vi.fn(async () => {}) }, TURNSTILE_SECRET_KEY: undefined, TURNSTILE_SITE_KEY: undefined });
    const r = await forgot(env, 'anyone@example.com');
    expect(r.status).toBe(503);
    expect(await json(r)).toEqual({ error: "Password reset isn't available right now. Try again later.", code: 'reset_unavailable' });
    const bad = hosted();
    expect((await call(bad.env, 'POST', '/api/auth/forgot', { body: { email: 'a@example.com', cf_turnstile_token: 'bad' }, ip: ip() })).status).toBe(403);
  });

  it('an old emailed link points a person who never chose a password to "Forgot your password?"', async () => {
    const h = hosted();
    const r = await call(h.env, 'POST', '/api/auth/welcome', { body: {}, ip: ip() });
    expect(r.status).toBe(410);
    expect((await json(r)).error).toBe('Email links are no longer used. Sign in, or, if you never chose a password, use "Forgot your password?" to choose one: we email you a code.');
  });
});
