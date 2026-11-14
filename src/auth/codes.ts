// Six-digit emailed codes: the second step of every hosted sign-up, sign-in, password reset and invite acceptance.
//
// A code belongs to one pending attempt. The attempt is a row in the existing verifications table, keyed by a SHA-256 of a
// random handle that only the browser that started it holds, in an HttpOnly, SameSite=Strict cookie (`__Host-` prefixed over
// https, so no other subdomain can plant one). The handle is not a session: it opens nothing, and it lives exactly as long as
// its code (CODE_SECONDS). A code typed in another browser has no handle to go with it, so it does nothing.
//
// The row holds what the attempt will do once the code is right and nothing else: the account, the address, a keyed hash of
// the code (HMAC-SHA256 under the auth secret, never the code itself), the number of tries, and for sign-up the hash of the
// password typed in that same attempt. Every new attempt gets a new handle; a browser that starts one drops the attempt its
// old cookie pointed at, so asking for a new code always invalidates the previous one.
//
// Limits (all counted in D1, so every isolate agrees):
//  - CODE_MAX_TRIES wrong tries per code; the try is counted before the comparison, so concurrent guesses cannot exceed it;
//  - CODE_FAILS_PER_ACCOUNT wrong codes an hour per address and purpose, across codes (a stranger who can start reset or
//    sign-up attempts for an address can spend that purpose's count, never sign-in's, which needs the password first);
//  - CODE_FAILS_PER_IP wrong codes an hour per IP, across every address;
//  - mail allowances per address and purpose (CODE_MAIL_CAPS), which also bound how many codes a guesser can get.
import type { AuthEnv } from './config';
import { authSecret } from './secret';
import { d1RateLimitStorage } from './rate-limit';
import { addressKey } from './welcome';

export type CodePurpose = 'signup' | 'invite' | 'signin' | 'reset';

/** How long a code (and the attempt it belongs to) works. The email and the pages state this number. */
export const CODE_SECONDS = 10 * 60;
export const CODE_MINUTES = CODE_SECONDS / 60;
export const CODE_LENGTH = 6;
/** Wrong tries per code; the next answer is "send a new code". */
export const CODE_MAX_TRIES = 5;
/** Wrong codes per address and purpose, per hour, across codes. */
export const CODE_FAILS_PER_ACCOUNT = 10;
/** Wrong codes per IP, per hour, across addresses. */
export const CODE_FAILS_PER_IP = 30;
export const CODE_FAIL_WINDOW_SECONDS = 3600;

/**
 * Code mail per address, per purpose. Separate pools, so one cannot use up another: a stranger can spend `signup` (bot-checked)
 * and `reset` (bot-checked when the keys are set), never `signin`, which only sends after the right password.
 * `signup` also carries hosted invite codes and the "someone tried to sign up with your address" notice.
 */
export type MailPool = 'signup' | 'signin' | 'reset';
export const CODE_MAIL_CAPS: Readonly<Record<MailPool, { hour: number; day: number }>> = Object.freeze({
  signup: { hour: 2, day: 4 },
  signin: { hour: 10, day: 30 },
  reset: { hour: 3, day: 10 },
});
export const poolFor = (purpose: CodePurpose): MailPool => (purpose === 'invite' ? 'signup' : purpose);

/** Spend one mail from the address's allowance for this pool. Returns 0 when allowed, else the seconds until it would be. */
export async function codeMailWait(env: AuthEnv, email: string, pool: MailPool): Promise<number> {
  const limiter = d1RateLimitStorage(env.DB as D1Database);
  const k = addressKey(email);
  const cap = CODE_MAIL_CAPS[pool];
  const hour = await limiter.consume(`code-mail:${pool}:h:${k}`, { window: 3600, max: cap.hour });
  if (!hour.allowed) return hour.retryAfter ?? 3600;
  const day = await limiter.consume(`code-mail:${pool}:d:${k}`, { window: 86400, max: cap.day });
  return day.allowed ? 0 : (day.retryAfter ?? 86400);
}

// ── The pending-attempt cookie ────────────────────────────────────

const COOKIE_SECURE = '__Host-rsm_pending';
const COOKIE_PLAIN = 'rsm_pending';

/** The cookie that carries an attempt's handle. `secure`: the dashboard is served over https. */
export function pendingCookie(handle: string, secure: boolean): string {
  return `${secure ? COOKIE_SECURE : COOKIE_PLAIN}=${handle}; Path=/; Max-Age=${CODE_SECONDS}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

/** Clears the cookie once the attempt is done. */
export function clearPendingCookie(secure: boolean): string {
  return `${secure ? COOKIE_SECURE : COOKIE_PLAIN}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

/** The handle the request carries, if any. Over https only the `__Host-` cookie counts. */
export function pendingHandle(request: Request, secure: boolean): string | null {
  const name = secure ? COOKIE_SECURE : COOKIE_PLAIN;
  const raw = (request.headers.get('cookie') ?? '').split(/;\s*/).find(c => c.startsWith(`${name}=`))?.slice(name.length + 1);
  return raw && /^[A-Za-z0-9_-]{43}$/.test(raw) ? raw : null;
}

// ── Codes and attempts ────────────────────────────────────────────

const b64url = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha256 = async (s: string) => b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
const identifierFor = async (handle: string) => `signin-code:${await sha256(handle)}`;

/** A uniformly random six-digit code (rejection sampling: no modulo bias). */
export function newCode(): string {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0]! < limit) return String(buf[0]! % 1_000_000).padStart(CODE_LENGTH, '0');
  }
}

/** The stored form of a code: HMAC-SHA256 under the auth secret, bound to its attempt. */
async function codeMac(env: AuthEnv, handleId: string, code: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(`signin-code:${await authSecret(env)}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${handleId}|${code}`)));
}

/** Constant-time comparison of two equal-format strings. */
function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface Attempt {
  purpose: CodePurpose;
  /** Null: a decoy (an address that cannot use this step); its code was never sent and nothing matches it. */
  userId: string | null;
  email: string;
  /** Sign-up and invite: the password hash typed in this attempt, the only one that can become the account's. */
  passwordHash?: string;
  /** Invite: the invite this attempt accepts. */
  invite?: string;
  /** Sign-up and invite: the terms version shown on the form, recorded at verification. */
  terms?: string;
}

interface Stored { p: CodePurpose; u: string | null; e: string; c: string; t: number; pw?: string; inv?: string; terms?: string }

/**
 * Start an attempt: drop the one this browser held (if any), store the new one, and return its handle and code. A decoy
 * (userId null) looks the same from outside; its code is never sent.
 */
export async function startAttempt(env: AuthEnv, previousHandle: string | null, a: Attempt, now = Date.now()): Promise<{ handle: string; code: string }> {
  const db = env.DB as D1Database;
  const handle = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const id = await identifierFor(handle);
  const code = newCode();
  const stored: Stored = { p: a.purpose, u: a.userId, e: a.email, c: await codeMac(env, id, code), t: 0, ...(a.passwordHash ? { pw: a.passwordHash } : {}), ...(a.invite ? { inv: a.invite } : {}), ...(a.terms ? { terms: a.terms } : {}) };
  const stmts = [
    db.prepare("DELETE FROM verifications WHERE identifier LIKE 'signin-code:%' AND expires_at < ?1").bind(Math.floor(now / 1000)),
    db.prepare('INSERT INTO verifications (id, identifier, value, expires_at) VALUES (?1, ?2, ?3, ?4)').bind(crypto.randomUUID(), id, JSON.stringify(stored), Math.floor(now / 1000) + CODE_SECONDS),
  ];
  if (previousHandle) stmts.unshift(db.prepare('DELETE FROM verifications WHERE identifier = ?1').bind(await identifierFor(previousHandle)));
  await db.batch(stmts);
  return { handle, code };
}

/** The live attempt behind a handle, without spending a try (for the limits, which need its address and purpose). */
export async function peekAttempt(env: AuthEnv, handle: string, now = Date.now()): Promise<Attempt | null> {
  const row = await (env.DB as D1Database).prepare('SELECT value FROM verifications WHERE identifier = ?1 AND expires_at >= ?2').bind(await identifierFor(handle), Math.floor(now / 1000)).first<{ value: string }>();
  return row ? toAttempt(JSON.parse(row.value) as Stored) : null;
}

const toAttempt = (s: Stored): Attempt => ({ purpose: s.p, userId: s.u, email: s.e, ...(s.pw ? { passwordHash: s.pw } : {}), ...(s.inv ? { invite: s.inv } : {}), ...(s.terms ? { terms: s.terms } : {}) });

export type CodeRefusal = 'code_expired' | 'code_wrong' | 'code_used_up';

/**
 * Check a code against the attempt behind `handle`. The try is counted first (atomically, only while fewer than
 * CODE_MAX_TRIES were made), then compared in constant time; a right code deletes the attempt, so it works once even when
 * sent twice at the same moment.
 */
export async function checkCode(env: AuthEnv, handle: string, code: string, now = Date.now()): Promise<{ attempt: Attempt } | { refused: CodeRefusal; triesLeft?: number }> {
  const db = env.DB as D1Database;
  const id = await identifierFor(handle);
  const nowS = Math.floor(now / 1000);
  const counted = await db.prepare("UPDATE verifications SET value = json_set(value, '$.t', json_extract(value, '$.t') + 1) WHERE identifier = ?1 AND expires_at >= ?2 AND json_extract(value, '$.t') < ?3 RETURNING value")
    .bind(id, nowS, CODE_MAX_TRIES).first<{ value: string }>();
  if (!counted) {
    const live = await db.prepare('SELECT 1 AS x FROM verifications WHERE identifier = ?1 AND expires_at >= ?2').bind(id, nowS).first();
    return { refused: live ? 'code_used_up' : 'code_expired' };
  }
  const stored = JSON.parse(counted.value) as Stored;
  const wellFormed = new RegExp(`^\\d{${CODE_LENGTH}}$`).test(code);
  const mac = await codeMac(env, id, wellFormed ? code : 'x');
  if (!wellFormed || !sameString(mac, stored.c) || stored.u === null) {
    const left = CODE_MAX_TRIES - stored.t;
    return left > 0 ? { refused: 'code_wrong', triesLeft: left } : { refused: 'code_used_up' };
  }
  const used = await db.prepare('DELETE FROM verifications WHERE identifier = ?1').bind(id).run();
  if ((used.meta.changes ?? 0) !== 1) return { refused: 'code_expired' }; // the same code, sent twice: one wins
  return { attempt: toAttempt(stored) };
}

/** Drop every pending attempt of an account (its password was set or changed: whatever was typed before is void). */
export async function dropAttemptsOf(env: AuthEnv, userId: string): Promise<void> {
  await (env.DB as D1Database).prepare("DELETE FROM verifications WHERE identifier LIKE 'signin-code:%' AND json_extract(value, '$.u') = ?1").bind(userId).run();
}

// ── Wrong-code limits across codes ───────────────────────────────

const accountKey = (purpose: CodePurpose, email: string) => `code-fail:${poolFor(purpose)}:${addressKey(email)}`;
const ipKey = (ip: string) => `code-fail:ip:${ip}`;

async function waitFor(db: D1Database, key: string, limit: number, now: number): Promise<number> {
  const row = await db.prepare('SELECT count, last_request FROM auth_rate_limits WHERE key = ?1').bind(key).first<{ count: number; last_request: number }>();
  if (!row) return 0;
  const end = row.last_request + CODE_FAIL_WINDOW_SECONDS * 1000;
  return row.count >= limit && now < end ? Math.max(1, Math.ceil((end - now) / 1000)) : 0;
}

/** Seconds before another code may be checked for this address and purpose, or from this IP; 0 when it may. */
export async function codeCheckWait(env: AuthEnv, attempt: Pick<Attempt, 'purpose' | 'email'>, ip: string, now = Date.now()): Promise<number> {
  const db = env.DB as D1Database;
  return Math.max(await waitFor(db, accountKey(attempt.purpose, attempt.email), CODE_FAILS_PER_ACCOUNT, now), await waitFor(db, ipKey(ip), CODE_FAILS_PER_IP, now));
}

/** Count one wrong code against the address (for this purpose) and the IP. */
export async function recordCodeFailure(env: AuthEnv, attempt: Pick<Attempt, 'purpose' | 'email'>, ip: string): Promise<void> {
  const limiter = d1RateLimitStorage(env.DB as D1Database);
  await limiter.consume(accountKey(attempt.purpose, attempt.email), { window: CODE_FAIL_WINDOW_SECONDS, max: CODE_FAILS_PER_ACCOUNT });
  await limiter.consume(ipKey(ip), { window: CODE_FAIL_WINDOW_SECONDS, max: CODE_FAILS_PER_IP });
}
