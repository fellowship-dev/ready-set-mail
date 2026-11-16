// Review probes for PR 177, kept as tests (round 2: the hand-off probes now assert the fix; the plumbing is the reviewer's): pre-verification state and the four new sign-up endpoints, and the hand-off email.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { call, enterCode, flushBackground, lastCodeFor, makeEnv, pendingCookieOf, signupVerified, req } from './auth/helpers';
import { HOSTED_ENV } from './hosted/world';
import { handleApi } from '../src/api/router';
import { dohFetch } from '../packages/dns-checks/test/helpers';

vi.mock('../src/telemetry', () => ({ track: vi.fn() }));
beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.stubGlobal('fetch', dohFetch({}, [])); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const json = async (r: Response) => await r.json() as any;

function world(extra: Record<string, unknown> = {}) {
  const db = createMigratedD1();
  const send = vi.fn(async () => {});
  const env = makeEnv(db, { ...HOSTED_ENV, SEND_EMAIL: { send }, MAIL_REPLY_TO: 'hello@readysetmail.com', ...extra });
  const rows = (sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[];
  return { db, env, send, rows };
}
type W = ReturnType<typeof world>;
const IP = '198.51.100.7';
const signup = (w: W, email: string, ip = IP) => call(w.env, 'POST', '/api/auth/signup', { body: { email, password: 'password-123' }, ip });
const cancel = (w: W, cookie: string, ip = IP) => call(w.env, 'POST', '/api/auth/signup/cancel', { body: {}, headers: { cookie }, ip });

describe('probe: start over does not reset limits', () => {
  it('wrong-code budget per address carries across start over', async () => {
    const w = world();
    const results: number[] = [];
    for (let round = 0; round < 6; round++) {
      const res = await signup(w, 'victim@brightwave-mail.com', `203.0.113.${round + 1}`);
      if (res.status !== 200) { results.push(-res.status); break; }
      const cookie = pendingCookieOf(res);
      for (let t = 0; t < 5; t++) results.push((await enterCode(w.env, cookie, '000000', { ip: `203.0.113.${round + 1}` })).status);
      await cancel(w, cookie, `203.0.113.${round + 1}`);
    }
    // Report what happened; the budget must stop wrong tries well before 30 across 6 fresh attempts.
    console.log('PROBE wrong-code statuses across start-over rounds:', JSON.stringify(results));
    const wrongAccepted = results.filter((s) => s === 400 || s === 401 || s === 422).length;
    expect(wrongAccepted).toBeLessThan(30);
  });
  it('code-mail allowance per address carries across start over', async () => {
    const w = world();
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) { const r = await signup(w, 'dana@brightwave-mail.com', `192.0.2.${i + 1}`); statuses.push(r.status); if (r.status === 200) await cancel(w, pendingCookieOf(r), `192.0.2.${i + 1}`); }
    console.log('PROBE sign-up statuses with start over between:', JSON.stringify(statuses));
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });
});

describe('probe: CSRF on the new endpoints', () => {
  for (const path of ['/api/auth/signup/profile', '/api/auth/signup/resend', '/api/auth/signup/cancel']) {
    it(`${path}: cross-site origin and a form content type are refused`, async () => {
      const w = world();
      const cookie = pendingCookieOf(await signup(w, 'dana@brightwave-mail.com'));
      const cross = await handleApi(req('POST', path, { body: {}, headers: { cookie, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } }), w.env, { waitUntil: vi.fn() } as any);
      expect(cross.status).toBe(403);
      const r = req('POST', path, { headers: { cookie } });
      const form = new Request(r.url, { method: 'POST', headers: { ...Object.fromEntries(r.headers), 'content-type': 'text/plain' }, body: 'x' });
      expect((await handleApi(form, w.env, { waitUntil: vi.fn() } as any)).status).toBe(415);
    });
  }
});

describe('probe: the password between S1 and S3', () => {
  it('is held only as a hash on the attempt row, and the row is gone after start over and after verify', async () => {
    const w = world();
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => { logs.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a) => { logs.push(a.join(' ')); });
    const res = await call(w.env, 'POST', '/api/auth/signup', { body: { email: 'pw@brightwave-mail.com', password: 'Sup3r-Secret-Pass' }, ip: IP });
    const row = w.rows("SELECT value, expires_at FROM verifications WHERE identifier LIKE 'signin-code:%'")[0];
    expect(row.value).not.toContain('Sup3r-Secret-Pass');
    const stored = JSON.parse(row.value);
    console.info('PROBE stored pw shape:', String(stored.pw).replace(/[A-Za-z0-9+/=_-]{12,}/g, '…').slice(0, 60), 'ttl s:', row.expires_at - Math.floor(Date.now() / 1000));
    await cancel(w, pendingCookieOf(res));
    expect(w.rows("SELECT 1 FROM verifications WHERE identifier LIKE 'signin-code:%'")).toHaveLength(0);
    expect(logs.join('\n')).not.toContain('Sup3r-Secret-Pass');
  });
});

describe('probe: the hand-off email as a carrier', () => {
  async function owner(w: W, name: string, domain: string) {
    const key = await signupVerified(w.env, 'attacker@freemail.example');
    w.db.sqlite.prepare('UPDATE users SET name = ? WHERE email = ?').run(name, 'attacker@freemail.example');
    const claim = await call(w.env, 'POST', '/api/domains', { key, body: { domain } });
    return { key, claimStatus: claim.status };
  }
  it('an unproven claim on any domain plus a free-text name reach an arbitrary inbox in the subject line', async () => {
    const w = world();
    const { key, claimStatus } = await owner(w, 'PayPal Security: call +1 800 555 0100 or visit paypa1-help.com', 'paypal.com');
    const r = await call(w.env, 'POST', '/api/team/invite', { key, body: { email: 'anyone@victim.example', role: 'admin', handoff_domain: 'paypal.com' } });
    const sent = w.send.mock.calls.map((c) => c[0] as any).filter((m) => m.to.includes('anyone@victim.example'));
    console.info('PROBE claim:', claimStatus, 'handoff:', r.status, 'subject:', sent[0]?.subject);
    expect(r.status).toBe(403); // refused: an address outside the sender's own email domain, no proven domain in the workspace (item 16)
    expect(sent).toHaveLength(0);
  });
  it('how many hand-off emails one account can send in a day across workspaces', async () => {
    const w = world();
    const { key } = await owner(w, 'X', 'brightwave-mail.com');
    let sent = 0;
    for (let ws = 0; ws < 3; ws++) {
      let k = key;
      let wsId: string | null = null;
      if (ws > 0) {
        const made = await call(w.env, 'POST', '/api/workspaces', { key, body: { name: `W${ws}` } });
        if (made.status >= 300) { console.info('PROBE create workspace:', made.status, JSON.stringify(await json(made)).slice(0, 120)); break; }
        wsId = (await json(made)).id ?? (await json(made)).workspace?.id;
        await call(w.env, 'POST', '/api/domains', { key, body: { domain: `d${ws}.example` }, headers: wsId ? { 'x-workspace-id': wsId } : {} });
      }
      for (let i = 0; i < 12; i++) {
        const r = await call(w.env, 'POST', '/api/team/invite', { key: k, body: { email: `p${ws}-${i}@victim.example`, role: 'admin', handoff_domain: ws ? `d${ws}.example` : 'brightwave-mail.com' }, headers: wsId ? { 'x-workspace-id': wsId } : {} });
        if (r.status === 201) sent++;
        // revoke so the open cap of 5 does not bind; only the daily cap should
        const list = await json(await call(w.env, 'GET', '/api/team/invites', { key: k, headers: wsId ? { 'x-workspace-id': wsId } : {} }));
        for (const inv of list.invites ?? []) await call(w.env, 'DELETE', `/api/team/invites/${inv.id}`, { key: k, headers: wsId ? { 'x-workspace-id': wsId } : {} });
      }
    }
    console.info('PROBE hand-off emails sent by one account:', sent);
    expect(sent).toBe(0); // victim.example is outside the sender's email domain and nothing is proven: refused every time (the per-account cap itself is tested in team/handoff.test.ts)
  });
});

describe('probe: pending says nothing about accounts', () => {
  it('pending answers have the same keys and lifetime for a new address and one with an account', async () => {
    const w = world();
    await signupVerified(w.env, 'known@brightwave-mail.com');
    const a = await signup(w, 'known@brightwave-mail.com', '192.0.2.50');
    const b = await signup(w, 'new@brightwave-mail.com', '192.0.2.51');
    const pa = await json(await call(w.env, 'GET', '/api/auth/signup/pending', { headers: { cookie: pendingCookieOf(a) } }));
    const pb = await json(await call(w.env, 'GET', '/api/auth/signup/pending', { headers: { cookie: pendingCookieOf(b) } }));
    expect(Object.keys(pa).sort()).toEqual(Object.keys(pb).sort());
    expect(pa.step).toBe(pb.step);
    expect(Math.abs(pa.expires_in - pb.expires_in)).toBeLessThanOrEqual(1);
  });
});
