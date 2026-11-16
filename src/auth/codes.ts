// Six-digit emailed codes: the second step of every hosted sign-up, sign-in, password reset and invite acceptance, and of a
// self-hosted sign-in once that person has proven that codes reach them.
//
// A code belongs to one pending attempt. The attempt is a row in the existing verifications table, keyed by a SHA-256 of a
// random handle that only the browser that started it holds, in an HttpOnly, SameSite=Strict cookie (`__Host-` prefixed over
// https, so no other subdomain can plant one). The handle is not a session: it opens nothing, and it lives exactly as long as
// its code (CODE_SECONDS). A code typed in another browser has no handle to go with it, so it does nothing.
//
// The row holds what the attempt will do once the code is right and nothing else: the account (or, for a hosted sign-up or
// invite of a new address, that the account is to be created then), the address, a keyed hash of the code (HMAC-SHA256 under
// the auth secret, never the code itself), the number of tries, and for sign-up the hash of the password typed in that same
// attempt. Every new attempt gets a new handle; a browser that starts one drops the attempt its old cookie pointed at, so
// asking for a new code always invalidates the previous one.
//
// Limits (all counted in D1 with one conditional statement each, so every isolate agrees and parallel requests cannot all
// pass a stale read):
//  - CODE_MAX_TRIES wrong tries per code; the try is counted before the comparison;
//  - wrong-code budgets across codes (codeBudgets): a wrong code is reserved before the comparison and given back when the
//    code was right (or never compared), so only genuinely wrong comparisons count. Sign-in (which needs the password first):
//    SIGNIN_FAILS_PER_HOUR and SIGNIN_FAILS_PER_DAY per address. Sign-up, invite and reset (which anyone can start for an
//    address): OPEN_FAILS_PER_DAY per address together, with a separate budget for a browser holding that account's device
//    cookie. CODE_FAILS_PER_IP an hour per IP, across every address;
//  - the first try on a freshly mailed code is always compared, even over the open and per-IP budgets, so a stranger who
//    spends them cannot stop the owner who types the code right first time. "First" is decided atomically: the try is counted
//    before anything else, and only the request that moved the attempt's count from 0 to 1 is the first try, however many
//    arrive at once (one extra guess per mailed code at most, and mailed codes are bounded by the mail allowances);
//  - mail allowances per address and pool (CODE_MAIL_CAPS), which also bound how many codes a guesser can get.
import { globalQueries } from '@ready-set-mail/db';
import type { AuthEnv } from './config';
import { authSecret } from './secret';
import { d1RateLimitStorage } from './rate-limit';
import { addressKey } from './welcome';

/** `confirm`: a self-hosted user's test code (Settings), which turns sign-in codes on for them once entered. */
export type CodePurpose = 'signup' | 'invite' | 'signin' | 'reset' | 'confirm';

/** How long a code (and the attempt it belongs to) works. The email and the pages state this number. */
export const CODE_SECONDS = 10 * 60;
export const CODE_MINUTES = CODE_SECONDS / 60;
export const CODE_LENGTH = 6;
/** Wrong tries per code; the next answer is "send a new code". */
export const CODE_MAX_TRIES = 5;
/** Wrong sign-in (and test) codes per address: an hour, and a day (then code entry waits for the next day or a reset). */
export const SIGNIN_FAILS_PER_HOUR = 10;
export const SIGNIN_FAILS_PER_DAY = 20;
/** After this many wrong sign-in codes in a day, the account's owner is told once that someone has their password. */
export const SIGNIN_ALERT_AT = 10;
/** Wrong sign-up, invite and reset codes per address and day, together (a device-cookie browser has its own). */
export const OPEN_FAILS_PER_DAY = 10;
/** Wrong codes per IP, per hour, across addresses. */
export const CODE_FAILS_PER_IP = 30;
const HOUR = 3600;
const DAY = 86400;

/**
 * Code mail per address, per pool. Separate pools, so one cannot use up another: a stranger can spend `signup` (bot-checked)
 * and `reset` (bot-checked on hosted), never `signin`, which only sends after the right password, nor `reset-device`, which is
 * the reset allowance of a browser that holds the account's device cookie.
 * `signup` also carries hosted invite codes and the "someone tried to sign up with your address" notice; `signin` also carries
 * self-host test codes and the wrong-codes alert. An address with no account is never mailed by a reset request.
 */
export type MailPool = 'signup' | 'signin' | 'reset' | 'reset-device';
export const CODE_MAIL_CAPS: Readonly<Record<MailPool, { hour: number; day: number }>> = Object.freeze({
  signup: { hour: 2, day: 4 },
  signin: { hour: 10, day: 30 },
  reset: { hour: 3, day: 10 },
  'reset-device': { hour: 3, day: 10 },
});
export const poolFor = (purpose: CodePurpose): MailPool => (purpose === 'invite' ? 'signup' : purpose === 'confirm' ? 'signin' : purpose);

/** Spend one mail from the address's allowance for this pool. Returns 0 when allowed, else the seconds until it would be. */
export async function codeMailWait(env: AuthEnv, email: string, pool: MailPool): Promise<number> {
  const limiter = d1RateLimitStorage(env.DB as D1Database);
  const k = addressKey(email);
  const cap = CODE_MAIL_CAPS[pool];
  const hour = await limiter.consume(`code-mail:${pool}:h:${k}`, { window: HOUR, max: cap.hour });
  if (!hour.allowed) return hour.retryAfter ?? HOUR;
  const day = await limiter.consume(`code-mail:${pool}:d:${k}`, { window: DAY, max: cap.day });
  return day.allowed ? 0 : (day.retryAfter ?? DAY);
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
export const identifierFor = async (handle: string) => `signin-code:${await sha256(handle)}`;

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
  /**
   * The account the code is for. Null with `create`: a hosted sign-up or invite of an address with no account yet, created
   * when the code is right. Null without `create`: a decoy (an address that cannot use this step); its code was never sent
   * and nothing matches it.
   */
  userId: string | null;
  create?: boolean;
  email: string;
  /** Sign-up and invite: the password hash typed in this attempt, the only one that can become the account's. */
  passwordHash?: string;
  /** Invite: the invite this attempt accepts. */
  invite?: string;
  /** Sign-up and invite: the terms version shown on the form, recorded at verification. */
  terms?: string;
}

interface Stored { p: CodePurpose; u: string | null; n?: 1; e: string; c: string; t: number; pw?: string; inv?: string; terms?: string }

/** The attempt as a decoy: it keeps the purpose and address, and can do nothing. */
export const decoyOf = (a: Attempt): Attempt => ({ purpose: a.purpose, userId: null, email: a.email });

/**
 * Start an attempt: drop the one this browser held (if any), store the new one, and return its handle and code. A decoy
 * looks the same from outside; its code is never sent.
 */
export async function startAttempt(env: AuthEnv, previousHandle: string | null, a: Attempt, now = Date.now()): Promise<{ handle: string; code: string }> {
  const db = env.DB as D1Database;
  const handle = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const id = await identifierFor(handle);
  const code = newCode();
  const stored: Stored = {
    p: a.purpose, u: a.userId, ...(a.userId === null && a.create ? { n: 1 as const } : {}), e: a.email, c: await codeMac(env, id, code), t: 0,
    ...(a.passwordHash ? { pw: a.passwordHash } : {}), ...(a.invite ? { inv: a.invite } : {}), ...(a.terms ? { terms: a.terms } : {}),
  };
  const stmts = [
    db.prepare("DELETE FROM verifications WHERE identifier LIKE 'signin-code:%' AND expires_at < ?1").bind(Math.floor(now / 1000)),
    db.prepare('INSERT INTO verifications (id, identifier, value, expires_at) VALUES (?1, ?2, ?3, ?4)').bind(crypto.randomUUID(), id, JSON.stringify(stored), Math.floor(now / 1000) + CODE_SECONDS),
  ];
  if (previousHandle) stmts.unshift(db.prepare('DELETE FROM verifications WHERE identifier = ?1').bind(await identifierFor(previousHandle)));
  await db.batch(stmts);
  return { handle, code };
}

/** Drop the attempt behind a handle (its code could not be sent). */
export async function dropAttempt(env: AuthEnv, handle: string): Promise<void> {
  await (env.DB as D1Database).prepare('DELETE FROM verifications WHERE identifier = ?1').bind(await identifierFor(handle)).run();
}

/** The live attempt behind a handle and how many tries it has had, without spending one (the limits need them). */
export async function peekAttempt(env: AuthEnv, handle: string, now = Date.now()): Promise<(Attempt & { tries: number }) | null> {
  const row = await (env.DB as D1Database).prepare('SELECT value FROM verifications WHERE identifier = ?1 AND expires_at >= ?2').bind(await identifierFor(handle), Math.floor(now / 1000)).first<{ value: string }>();
  if (!row) return null;
  const s = JSON.parse(row.value) as Stored;
  return { ...toAttempt(s), tries: s.t };
}

const toAttempt = (s: Stored): Attempt => ({
  purpose: s.p, userId: s.u, ...(s.n ? { create: true } : {}), email: s.e,
  ...(s.pw ? { passwordHash: s.pw } : {}), ...(s.inv ? { invite: s.inv } : {}), ...(s.terms ? { terms: s.terms } : {}),
});

export type CodeRefusal = 'code_expired' | 'code_wrong' | 'code_used_up';

/** A try counted on an attempt. `firstTry`: this request moved the count from 0 to 1 (exactly one request per attempt). */
export interface CountedTry { id: string; stored: Stored; firstTry: boolean }

/**
 * Count one try on the attempt behind `handle`, atomically and only while fewer than CODE_MAX_TRIES were made. Done before
 * anything else (the wrong-code budgets, the comparison), so concurrent requests each get their own count and only one of
 * them can be the first try.
 */
export async function countTry(env: AuthEnv, handle: string, now = Date.now()): Promise<CountedTry | { refused: 'code_expired' | 'code_used_up' }> {
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
  return { id, stored, firstTry: stored.t === 1 };
}

/** Give a counted try back: the request was refused by a wrong-code budget before any comparison. */
export async function uncountTry(env: AuthEnv, counted: CountedTry): Promise<void> {
  await (env.DB as D1Database).prepare("UPDATE verifications SET value = json_set(value, '$.t', json_extract(value, '$.t') - 1) WHERE identifier = ?1 AND json_extract(value, '$.t') > 0").bind(counted.id).run();
}

/**
 * Compare a code with a counted try's attempt, in constant time. A right code deletes the attempt, so it works once even when
 * sent twice at the same moment. `compared` says whether a comparison happened (only a compared wrong code is a wrong code).
 */
export async function compareCode(env: AuthEnv, counted: CountedTry, code: string): Promise<{ attempt: Attempt } | { refused: CodeRefusal; triesLeft?: number; compared: boolean }> {
  const { id, stored } = counted;
  const wellFormed = new RegExp(`^\\d{${CODE_LENGTH}}$`).test(code);
  const mac = await codeMac(env, id, wellFormed ? code : 'x');
  const decoy = stored.u === null && !stored.n;
  if (!wellFormed || !sameString(mac, stored.c) || decoy) {
    const left = CODE_MAX_TRIES - stored.t;
    return left > 0 ? { refused: 'code_wrong', triesLeft: left, compared: true } : { refused: 'code_used_up', compared: true };
  }
  const used = await (env.DB as D1Database).prepare('DELETE FROM verifications WHERE identifier = ?1').bind(id).run();
  if ((used.meta.changes ?? 0) !== 1) return { refused: 'code_expired', compared: false }; // the same code, sent twice: one wins
  return { attempt: toAttempt(stored) };
}

/** Count a try and compare (no wrong-code budgets): the whole check, for callers that apply none. */
export async function checkCode(env: AuthEnv, handle: string, code: string, now = Date.now()): Promise<{ attempt: Attempt } | { refused: CodeRefusal; triesLeft?: number; compared: boolean }> {
  const counted = await countTry(env, handle, now);
  if ('refused' in counted) return { refused: counted.refused, compared: false };
  return compareCode(env, counted, code);
}

/** Drop every pending attempt of an account (its password was set or changed: whatever was typed before is void). */
export async function dropAttemptsOf(env: AuthEnv, userId: string): Promise<void> {
  await (env.DB as D1Database).prepare("DELETE FROM verifications WHERE identifier LIKE 'signin-code:%' AND json_extract(value, '$.u') = ?1").bind(userId).run();
}

// ── Self-host: codes are asked for only from someone they have reached ──

/** The proof that codes reach this account's address: a row in the existing verifications table (no migration). */
const provenIdentifier = (userId: string) => `code-proven:${userId}`;

/** Has this account ever entered a right code (so mail is known to reach it)? */
export async function codeProven(env: AuthEnv, userId: string): Promise<boolean> {
  return !!(await (env.DB as D1Database).prepare('SELECT 1 AS x FROM verifications WHERE identifier = ?1').bind(provenIdentifier(userId)).first());
}

export async function markCodeProven(env: AuthEnv, userId: string): Promise<void> {
  const db = env.DB as D1Database;
  await db.batch([
    db.prepare('DELETE FROM verifications WHERE identifier = ?1').bind(provenIdentifier(userId)),
    db.prepare('INSERT INTO verifications (id, identifier, value, expires_at) VALUES (?1, ?2, ?3, ?4)').bind(crypto.randomUUID(), provenIdentifier(userId), String(Math.floor(Date.now() / 1000)), Math.floor(Date.now() / 1000) + 20 * 365 * DAY),
  ]);
}

// ── Wrong-code budgets across codes ──────────────────────────────

export type BudgetKind = 'signin-hour' | 'signin-day' | 'open-day' | 'ip';
interface Budget { kind: BudgetKind; key: string; window: number; max: number; firstTryCompared: boolean }

/**
 * The budgets a wrong code spends. Sign-in and test codes: the address's hourly and daily sign-in budgets (no first-try
 * exception: only the password holder can start these attempts, so the daily cap must hold). Sign-up, invite and reset: one
 * daily budget per address together, or the device budget when the browser holds this account's device cookie. Every
 * purpose: the IP's hourly budget.
 */
function codeBudgets(attempt: Pick<Attempt, 'purpose' | 'email'>, ip: string, device: boolean): Budget[] {
  const k = addressKey(attempt.email);
  const ipBudget: Budget = { kind: 'ip', key: `code-fail:ip:${ip}`, window: HOUR, max: CODE_FAILS_PER_IP, firstTryCompared: true };
  // The day first: when both are spent, the answer names the longer wait and the way through (a reset).
  if (attempt.purpose === 'signin' || attempt.purpose === 'confirm') {
    return [
      { kind: 'signin-day', key: `code-fail:signin:d:${k}`, window: DAY, max: SIGNIN_FAILS_PER_DAY, firstTryCompared: false },
      { kind: 'signin-hour', key: `code-fail:signin:h:${k}`, window: HOUR, max: SIGNIN_FAILS_PER_HOUR, firstTryCompared: false },
      ipBudget,
    ];
  }
  return [{ kind: 'open-day', key: `code-fail:open:d:${device ? 'device:' : ''}${k}`, window: DAY, max: OPEN_FAILS_PER_DAY, firstTryCompared: true }, ipBudget];
}

export type Reservation = { keys: string[]; signinDayCount: number | null };

/**
 * Reserve one wrong code in every budget before the comparison (one conditional statement each). Over a budget: refused,
 * with what was reserved given back, unless this is the first try on its code and the budget lets a first try through.
 */
export async function reserveWrongCode(
  env: AuthEnv, attempt: Pick<Attempt, 'purpose' | 'email'>, ip: string, opts: { device: boolean; firstTry: boolean }, now = Date.now(),
): Promise<{ reserved: Reservation } | { refused: BudgetKind; wait: number }> {
  const db = env.DB as D1Database;
  const q = globalQueries(db).rateLimit;
  const reserved: Reservation = { keys: [], signinDayCount: null };
  for (const b of codeBudgets(attempt, ip, opts.device)) {
    const row = await q.hitUnder(b.key, now, b.window * 1000, b.max);
    if (row) {
      reserved.keys.push(b.key);
      if (b.kind === 'signin-day') reserved.signinDayCount = row.count;
      continue;
    }
    if (opts.firstTry && b.firstTryCompared) continue;
    await giveBack(env, reserved);
    const start = await db.prepare('SELECT last_request FROM auth_rate_limits WHERE key = ?1').bind(b.key).first<{ last_request: number }>();
    return { refused: b.kind, wait: Math.max(1, Math.ceil(((start?.last_request ?? now) + b.window * 1000 - now) / 1000)) };
  }
  return { reserved };
}

/** The code was right, or never compared: what was reserved for it is given back. */
export async function giveBack(env: AuthEnv, reserved: Reservation): Promise<void> {
  const db = env.DB as D1Database;
  if (reserved.keys.length === 0) return;
  await db.batch(reserved.keys.map(k => db.prepare('UPDATE auth_rate_limits SET count = count - 1 WHERE key = ?1 AND count > 0').bind(k)));
}

/** A password reset ends a stranger's hold on the address's sign-in codes. */
export async function clearSigninCodeBudgets(env: AuthEnv, email: string): Promise<void> {
  const k = addressKey(email);
  await (env.DB as D1Database).prepare('DELETE FROM auth_rate_limits WHERE key IN (?1, ?2)').bind(`code-fail:signin:h:${k}`, `code-fail:signin:d:${k}`).run();
}

/** At most one "someone has your password" alert a day per address. True when this one may be sent. */
export async function signinAlertAllowed(env: AuthEnv, email: string): Promise<boolean> {
  return (await d1RateLimitStorage(env.DB as D1Database).consume(`code-alert:signin:${addressKey(email)}`, { window: DAY, max: 1 })).allowed;
}
