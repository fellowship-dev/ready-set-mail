// Review round 2: how much of each limit one honest sign-up spends, and the placeholder-name flag for an agency's first workspace.
// The numbers: AUTH_LIMITER is 10 requests per 60 s per IP (wrangler.jsonc); sign-up is also 10 per hour per IP (D1); the sign-up code mail is 2 per
// hour and 4 per day per ADDRESS (CODE_MAIL_CAPS). None of them is changed.
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

  it('what is spent per ADDRESS stays as it was: the sign-up code mail is 2 an hour, so a resend and a start-over to the SAME address is the third mail and waits', async () => {
    expect(CODE_MAIL_CAPS.signup).toEqual({ hour: 2, day: 4 });
    const w = hosted();
    const a = await post(w, '/api/auth/signup', { email: 'dana@brightwave-mail.com', password: 'password-123' });
    const cookie = pendingCookieOf(a);
    expect((await post(w, '/api/auth/signup/resend', { cf_turnstile_token: 'ok' }, cookie)).status).toBe(200);
    await post(w, '/api/auth/signup/cancel', {}, cookie);
    const third = await post(w, '/api/auth/signup', { email: 'dana@brightwave-mail.com', password: 'password-123' });
    expect(third.status).toBe(429);
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
