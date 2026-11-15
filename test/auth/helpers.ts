import { vi } from 'vitest';
import type { Env } from '../../src/index';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { handleApi } from '../../src/api/router';

export const BASE = 'https://ia.example.com';
export const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

export type TestDb = ReturnType<typeof createMigratedD1>;

export function makeEnv(db: TestDb = createMigratedD1(), extra: Record<string, unknown> = {}): Env {
  // The platform's sender address, as the setup wizard would have stored it.
  db.sqlite.prepare("INSERT OR IGNORE INTO settings (workspace_id, key, value) VALUES ('ws_default', 'from_email', 'noreply@reports.example.com')").run();
  // Hosted sign-up is closed without a Turnstile secret and site key; tests send the token 'ok' (see test/setup-files/turnstile.ts).
  const turnstile = extra.MODE === 'saas' ? { TURNSTILE_SECRET_KEY: 'test-turnstile-secret', TURNSTILE_SITE_KEY: 'test-turnstile-site' } : {};
  return { BOOTSTRAP_SECRET: 'test-only-installer-proof-32-characters-minimum', DB: db as unknown as D1Database, CLOUDFLARE_ACCOUNT_ID: '', CLOUDFLARE_ZONE_ID: '', CLOUDFLARE_API_TOKEN: '', ...turnstile, ...extra } as unknown as Env;
}

let ipCounter = 0;
/** A distinct client IP per call, so the D1 rate limiter does not couple tests. */
export const freshIp = () => `10.0.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

export function req(method: string, path: string, opts: { key?: string; body?: unknown; headers?: Record<string, string>; ip?: string } = {}) {
  const headers: Record<string, string> = { 'cf-connecting-ip': opts.ip ?? freshIp(), ...opts.headers };
  if (path === '/api/auth/setup' && !Object.hasOwn(headers, 'x-ready-set-mail-bootstrap')) headers['x-ready-set-mail-bootstrap'] = 'test-only-installer-proof-32-characters-minimum';
  if (opts.key) headers['x-api-key'] = opts.key;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  let body = opts.body;
  if (/^\/api\/auth\/(signup|login|setup|forgot)$/.test(path) && body && typeof body === 'object' && !('cf_turnstile_token' in body)) body = { ...body, cf_turnstile_token: 'ok' };
  return new Request(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}

export const call = (env: Env, ...args: Parameters<typeof req>) => handleApi(req(...args), env, ctx);

/** Wait for the work routes hand to waitUntil (code mail is sent in the background). */
export const flushBackground = () => Promise.all((ctx.waitUntil as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(c => c[0]));

/** A capturing mail binding on this env (hosted tests get one if they did not bring their own). */
export function mailbox(env: Env): { send: ReturnType<typeof vi.fn> } {
  if (!env.SEND_EMAIL) (env as { SEND_EMAIL?: unknown }).SEND_EMAIL = { send: vi.fn(async () => {}) };
  return env.SEND_EMAIL as unknown as { send: ReturnType<typeof vi.fn> };
}

type Mail = { to: string[]; subject: string; text: string };
/** Every mail sent to this address so far, oldest first. */
export const mailsTo = (env: Env, email: string): Mail[] =>
  mailbox(env).send.mock.calls.map(c => c[0] as Mail).filter(m => m.to.includes(email.toLowerCase()));

/** The code in the newest code email to this address (after the background sends finished). */
export async function lastCodeFor(env: Env, email: string): Promise<string> {
  await flushBackground();
  const m = mailsTo(env, email).filter(x => /^\d{6} is your Ready Set Mail code$/.test(x.subject)).at(-1);
  if (!m) throw new Error(`no code email to ${email}`);
  return m.subject.slice(0, 6);
}

/** The pending-attempt cookie (`name=value`) a code step answered with. */
export function pendingCookieOf(res: Response): string {
  const c = ((res.headers as Headers & { getSetCookie(): string[] }).getSetCookie()).find(x => /^(__Host-)?rsm_pending=./.test(x));
  if (!c) throw new Error('no pending-attempt cookie');
  return c.split(';')[0]!;
}

/** Type a code in the browser that holds `cookie`. */
export const enterCode = (env: Env, cookie: string, code: string, opts: { ip?: string; headers?: Record<string, string> } = {}) =>
  call(env, 'POST', '/api/auth/code', { body: { code }, ip: opts.ip, headers: { cookie, ...opts.headers } });

/** Password, then the emailed code. Returns the session token (scripts get one in the body). */
export async function loginWithCode(env: Env, email: string, password: string, opts: { ip?: string } = {}): Promise<string> {
  mailbox(env);
  const res = await call(env, 'POST', '/api/auth/login', { body: { email, password }, ip: opts.ip });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const done = await enterCode(env, pendingCookieOf(res), await lastCodeFor(env, email), opts);
  if (done.status !== 200) throw new Error(`code failed: ${done.status} ${await done.text()}`);
  return (await done.json() as { token: string }).token;
}

export async function setupOwner(env: Env, email = 'owner@example.com', password = 'correct-horse-battery') {
  const res = await call(env, 'POST', '/api/auth/setup', { body: { email, password } });
  if (res.status !== 201) throw new Error(`setup failed: ${res.status} ${await res.text()}`);
  return (await res.json() as { token: string }).token;
}

/** Owner invites `email` with `role`; the invitee accepts. Returns their session token. */
export async function inviteAndAccept(env: Env, ownerToken: string, email: string, role: 'admin' | 'member', password = 'invitee-password-1') {
  const inv = await call(env, 'POST', '/api/team/invite', { key: ownerToken, body: { email, role } });
  if (inv.status !== 201) throw new Error(`invite failed: ${inv.status} ${await inv.text()}`);
  const { token } = await inv.json() as { token: string };
  const acc = await call(env, 'POST', `/api/invites/${token}`, { body: { name: email.split('@')[0], password } });
  if (acc.status === 201) return (await acc.json() as { token: string }).token; // self-host: the invite signs in
  if (acc.status !== 200) throw new Error(`accept failed: ${acc.status} ${await acc.text()}`);
  // Hosted: the link alone proves nothing. The code emailed to the invited address sets the password, verifies it and accepts.
  const done = await enterCode(env, pendingCookieOf(acc), await lastCodeFor(env, email));
  if (done.status !== 200) throw new Error(`code failed: ${done.status} ${await done.text()}`);
  return (await done.json() as { token: string }).token;
}


/**
 * Hosted sign-up as a verified user: email and password, then the emailed code (typed in the same "browser"). Returns the
 * session token the code step opens.
 */
export async function signupVerified(env: Env, email: string, password = 'password-123', _name = email) {
  mailbox(env);
  const res = await call(env, 'POST', '/api/auth/signup', { body: { email, password } });
  if (res.status !== 200) throw new Error(`signup failed: ${res.status} ${await res.text()}`);
  const done = await enterCode(env, pendingCookieOf(res), await lastCodeFor(env, email));
  if (done.status !== 200) throw new Error(`code failed: ${done.status} ${await done.text()}`);
  return (await done.json() as { token: string }).token;
}
