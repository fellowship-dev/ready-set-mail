// Review round 2: how much of each limit one honest sign-up spends, and the placeholder-name flag for an agency's first workspace.
// The numbers: AUTH_LIMITER is 10 requests per 60 s per IP (wrangler.jsonc); sign-up is also 10 per hour per IP (D1); the sign-up code mail is 5 per
// hour and 10 per day per ADDRESS (CODE_MAIL_CAPS; round 3: it was 2 and 4).
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { call, enterCode, lastCodeFor, makeEnv, pendingCookieOf } from './helpers';
import { HOSTED_ENV } from '../hosted/world';
import { CODE_MAIL_CAPS } from '../../src/auth/codes';
import { PLACEHOLDER_NAME_KEY } from '../../src/auth/names';
import { dohFetch } from '../../packages/dns-checks/test/helpers';

vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));
beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.stubGlobal('fetch', dohFetch({}, [])); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const json = async (r: Response) => await r.json() as any;
const IP = '198.51.100.9';

/** The binding as Cloudflare documents it: `limit` requests per `period` seconds per key, counted here. */
function limiter(limit = 10) {
  const seen: string[] = [];
  return { seen, binding: { limit: vi.fn(async ({ key }: { key: string }) => { seen.push(key); return { success: seen.filter(k => k === key).length <= limit }; }) } };
}
function hosted() {
  const db = createMigratedD1();
  const lim = limiter();
  const env = makeEnv(db, { ...HOSTED_ENV, SEND_EMAIL: { send: vi.fn(async () => {}) }, AUTH_LIMITER: lim.binding });
  return { db, env, lim, rows: (sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[] };
}
type W = ReturnType<typeof hosted>;
const post = (w: W, path: string, body: object, cookie?: string) => call(w.env, 'POST', path, { body, headers: cookie ? { cookie } : {}, ip: IP });
const ABOUT = { name: 'Dana Whitfield', organization: 'Brightwave Studio', whose_email: 'company' };

describe('one honest sign-up against the limits', () => {
  it('the plain path spends 3 of the 10 per minute (sign-up, S2, the code)', async () => {
    const w = hosted();
    const res = await post(w, '/api/auth/signup', { email: 'dana@brightwave-mail.com', password: 'password-123' });
    const cookie = pendingCookieOf(res);
    expect((await post(w, '/api/auth/signup/profile', ABOUT, cookie)).status).toBe(200);
    expect((await enterCode(w.env, cookie, await lastCodeFor(w.env, 'dana@brightwave-mail.com'), { ip: IP })).status).toBe(200);
    expect(w.lim.seen.length).toBe(3);
  });

  it('with a resend, a wrong code, and a start-over to a corrected address it spends 7 of 10 and is never refused', async () => {
    const w = hosted();
    const first = await post(w, '/api/auth/signup', { email: 'dana@brightwave-mial.com', password: 'password-123' }); // 1: a typo in the address
    const cookie = pendingCookieOf(first);
    expect((await post(w, '/api/auth/signup/profile', ABOUT, cookie)).status).toBe(200); // 2
    expect((await post(w, '/api/auth/signup/resend', { cf_turnstile_token: 'ok' }, cookie)).status).toBe(200); // 3
    expect((await post(w, '/api/auth/signup/cancel', {}, cookie)).status).toBe(200); // not counted
    expect((await call(w.env, 'GET', '/api/auth/signup/pending', { ip: IP })).status).toBe(200); // not counted
    const again = await post(w, '/api/auth/signup', { email: 'dana@brightwave-mail.com', password: 'password-123' }); // 4
    expect(again.status).toBe(200);
    const cookie2 = pendingCookieOf(again);
    expect((await post(w, '/api/auth/signup/profile', ABOUT, cookie2)).status).toBe(200); // 5
    expect((await enterCode(w.env, cookie2, '000000', { ip: IP })).status).toBe(400); // 6: a mistyped code
    expect((await enterCode(w.env, cookie2, await lastCodeFor(w.env, 'dana@brightwave-mail.com'), { ip: IP })).status).toBe(200); // 7
    expect(w.lim.seen.length).toBe(7);
    expect(w.lim.seen.length).toBeLessThanOrEqual(10);
  });

  it('an honest flow never hits the address cap: sign up, the code expires, password again, "Send a new code", then start over to the same address', async () => {
    expect(CODE_MAIL_CAPS.signup).toEqual({ hour: 5, day: 10 });
    const w = hosted();
    const a = await post(w, '/api/auth/signup', { email: 'dana@brightwave-mail.com', password: 'password-123' }); // mail 1
    const b = await post(w, '/api/auth/signup', { email: 'dana@brightwave-mail.com', password: 'password-123' }, pendingCookieOf(a)); // the code expired: password again, mail 2
    const c = await post(w, '/api/auth/signup/resend', { cf_turnstile_token: 'ok' }, pendingCookieOf(b)); // "Send a new code", mail 3
    await post(w, '/api/auth/signup/cancel', {}, pendingCookieOf(c));
    const d = await post(w, '/api/auth/signup', { email: 'dana@brightwave-mail.com', password: 'password-123' }); // start over, same address, mail 4
    for (const r of [a, b, c, d]) expect(r.status).toBe(200);
    expect((await enterCode(w.env, pendingCookieOf(d), await lastCodeFor(w.env, 'dana@brightwave-mail.com'), { ip: IP })).status).toBe(200);
  });

  it('two attacker sign-ups for an address do not block its owner', async () => {
    const w = hosted();
    for (let i = 0; i < 2; i++) expect((await post(w, '/api/auth/signup', { email: 'blocked@harbor-lane.org', password: `attacker-pass-${i}` })).status).toBe(200);
    const own = await post(w, '/api/auth/signup', { email: 'blocked@harbor-lane.org', password: 'owners-own-pass-1' });
    expect(own.status).toBe(200);
    expect((await enterCode(w.env, pendingCookieOf(own), await lastCodeFor(w.env, 'blocked@harbor-lane.org'), { ip: IP })).status).toBe(200);
  });

  it('the 6th code mail in an hour is refused with the REAL time left, not a fixed hour', async () => {
    const w = hosted();
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) expect((await post(w, '/api/auth/signup', { email: 'dana@brightwave-mail.com', password: 'password-123' })).status).toBe(200);
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 20 * 60_000 + 5_000);
    const sixth = await post(w, '/api/auth/signup', { email: 'dana@brightwave-mail.com', password: 'password-123' });
    expect(sixth.status).toBe(429);
    const body = await json(sixth);
    expect(body.code).toBe('code_mail_limit');
    expect(body.error).toBe("We sent several codes to this address recently, so we can't send another yet. Try again in 40 minutes.");
    expect(Number(sixth.headers.get('retry-after'))).toBeGreaterThan(39 * 60);
    expect(Number(sixth.headers.get('retry-after'))).toBeLessThanOrEqual(40 * 60);
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 59 * 60_000 + 30_000);
    expect((await json(await post(w, '/api/auth/signup', { email: 'dana@brightwave-mail.com', password: 'password-123' }))).error).toMatch(/Try again in 1 minute\.$/);
    // The same words for an address that already has an account (anti-enumeration)
    const known = hosted();
    for (let i = 0; i < 6; i++) { const r = await post(known, '/api/auth/signup', { email: 'x@brightwave-mail.com', password: 'password-123' }); if (r.status === 429) expect((await json(r)).error).toMatch(/^We sent several codes/); }
  });
});

describe('the placeholder name of an agency\'s first workspace is a flag, not the words "New client"', () => {
  async function agency(w: W, email: string, org = 'Northside IT', whose = 'clients') {
    const res = await post(w, '/api/auth/signup', { email, password: 'password-123' });
    const cookie = pendingCookieOf(res);
    await post(w, '/api/auth/signup/profile', { name: 'Sam Ortiz', organization: org, whose_email: whose }, cookie);
    return (await json(await enterCode(w.env, cookie, await lastCodeFor(w.env, email), { ip: IP }))).token as string;
  }
  const names = (w: W, email: string) => w.rows('SELECT ws.id, ws.name FROM workspaces ws JOIN memberships m ON m.workspace_id = ws.id JOIN users u ON u.id = m.user_id WHERE u.email = ?', email);
  const flag = (w: W, id: string) => w.rows('SELECT value FROM settings WHERE workspace_id = ? AND key = ?', id, PLACEHOLDER_NAME_KEY);

  it('an agency sign-up flags its first workspace; the first domain renames it', async () => {
    const w = hosted();
    const token = await agency(w, 'sam@northside-it.com');
    const [ws] = names(w, 'sam@northside-it.com');
    expect(ws!.name).toBe('New client');
    expect(flag(w, ws!.id)).toHaveLength(1);
    await call(w.env, 'POST', '/api/domains', { key: token, body: { domain: 'brightwave-mail.com' } });
    expect(names(w, 'sam@northside-it.com')[0]!.name).toBe('brightwave-mail.com');
  });

  it('a company workspace whose organization is literally called "New client" is never renamed', async () => {
    const w = hosted();
    const token = await agency(w, 'dana@brightwave-mail.com', 'New client', 'company');
    const [ws] = names(w, 'dana@brightwave-mail.com');
    expect(ws!.name).toBe('New client');
    expect(flag(w, ws!.id)).toHaveLength(0);
    await call(w.env, 'POST', '/api/domains', { key: token, body: { domain: 'brightwave-mail.com' } });
    expect(names(w, 'dana@brightwave-mail.com')[0]!.name).toBe('New client');
  });

  it('a name the owner chose is theirs: renaming clears the flag, and a domain no longer renames it', async () => {
    const w = hosted();
    const token = await agency(w, 'sam@northside-it.com');
    const [ws] = names(w, 'sam@northside-it.com');
    expect((await call(w.env, 'PATCH', `/api/workspaces/${ws!.id}`, { key: token, body: { name: 'New client' } })).status).toBe(200);
    expect(flag(w, ws!.id)).toHaveLength(0);
    await call(w.env, 'POST', '/api/domains', { key: token, body: { domain: 'brightwave-mail.com' } });
    expect(names(w, 'sam@northside-it.com')[0]!.name).toBe('New client');
  });

  it('a typo\'d first domain, removed, lets the corrected one name the workspace; a second domain never renames it', async () => {
    const w = hosted();
    const token = await agency(w, 'sam@northside-it.com');
    await call(w.env, 'POST', '/api/domains', { key: token, body: { domain: 'brightwave-mial.com' } });
    expect(names(w, 'sam@northside-it.com')[0]!.name).toBe('brightwave-mial.com');
    const claim = w.rows("SELECT id FROM domain_claims WHERE domain = 'brightwave-mial.com'")[0];
    expect((await call(w.env, 'DELETE', `/api/domains/claims/${claim.id}`, { key: token })).status).toBeLessThan(300);
    await call(w.env, 'POST', '/api/domains', { key: token, body: { domain: 'brightwave-mail.com' } });
    expect(names(w, 'sam@northside-it.com')[0]!.name).toBe('brightwave-mail.com');
    await call(w.env, 'POST', '/api/domains', { key: token, body: { domain: 'harbor-lane.org' } });
    expect(names(w, 'sam@northside-it.com')[0]!.name).toBe('brightwave-mail.com');
  });
});
