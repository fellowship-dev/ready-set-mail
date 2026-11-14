// Unauthenticated /api/auth/* and /api/invites/* routes.
//
// The dashboard's endpoints (status, setup, signup, login, code, logout, forgot, reset, invites) are thin layers over Better
// Auth, which they call in-process so its password hashing and session handling apply. A short allow-list of Better Auth's own
// endpoints (OAuth, sessions, change-password) is exposed as-is under /api/auth/; everything else (notably /sign-up/email, which
// would bypass the sign-up policy) is not.
//
// Sign-in codes (src/auth/codes.ts): hosted sign-up, sign-in, password reset and invite acceptance end with a six-digit code
// emailed to the address, typed in the same browser. A self-hosted instance uses them too when it can send mail, unless its
// operator set SIGNIN_CODES=off (signinCodes below).
import type { BoundEnv as Env } from '../index';
import { authLookups, forWorkspace, globalQueries, workspaceLifecycle, IMPLICIT_WORKSPACE_ID } from '@ready-set-mail/db';
import { logAudit, type AuditEntry } from '../audit/log';
import { track } from '../telemetry';
import { TenantContext } from '../tenancy/context';
import { hashPassword, verifyPassword } from '../api/password';
import { AUTH_BASE_PATH, createAuth, type Auth } from './index';
import { baseUrl, enabledOAuthProviders, isSaas } from './config';
import type { SignupIntent } from './signup-policy';
import { currentUser, passesCsrfCheck } from './session';
import { verifyBootstrapProof } from './bootstrap';
import { verifyTurnstile } from './turnstile';
import { hostedSignupClosed, SIGNUP_CLOSED_MESSAGE, turnstileSecret, turnstileSiteKey } from './bot-protection';
import { clearSigninFailures, legacyVerifyLinkPage, recordSigninFailure, resetUnprovenNames, signinWait } from './welcome';
import { cleanName } from './names';
import { deviceCookie, knownDevice, rotateDeviceEpoch } from './device';
import { d1RateLimitStorage } from './rate-limit';
import {
  CODE_MAX_TRIES, CODE_SECONDS, checkCode, clearPendingCookie, codeCheckWait, codeMailWait, dropAttemptsOf, peekAttempt,
  pendingCookie, pendingHandle, poolFor, recordCodeFailure, startAttempt, type Attempt, type CodePurpose,
} from './codes';
import { mailReady, requestedFrom, sendCodeEmail, sendSignupNotice } from './mail';
import { legal, legalStatus } from './legal';
import { helpUrl } from '../funnel/config';
import { emailCheckAvailable } from '../hosted/config';
import { hostedServiceUrl } from '../hosted-service';

const json = (data: unknown, status = 200) => Response.json(data, { status });
const err = (message: string, status: number, code?: string) => json({ error: message, ...(code ? { code } : {}) }, status);

/** Set-Cookie values (workers-types predates Headers.getSetCookie). */
const setCookies = (h: Headers): string[] => (h as Headers & { getSetCookie(): string[] }).getSetCookie();

/**
 * Platform-level settings (Turnstile keys, first-run state) live on the implicit workspace. Nothing
 * tenant-owned is read through this: user data always goes through the caller's own TenantContext.
 */
const platform = (env: Env) => forWorkspace(env.DB, IMPLICIT_WORKSPACE_ID);

/** Audit an auth event in the workspace the user acts in (their first membership). */
function auditUser(env: Env, ctx: ExecutionContext, userId: string, entry: AuditEntry, workspaceId?: string): void {
  ctx.waitUntil((async () => {
    const ws = workspaceId ?? (await authLookups(env.DB).membershipsOf(userId))[0]?.workspace_id;
    if (ws) logAudit({ db: env.DB, workspaceId: ws }, entry);
  })().catch(() => {}));
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Longest password accepted (PBKDF2 of a huge body is a cheap way to burn CPU). */
const MAX_PASSWORD = 256;

/** Better Auth endpoints reachable from outside, as `METHOD /path`. */
const PASSTHROUGH: readonly RegExp[] = [
  /^GET \/get-session$/,
  /^POST \/sign-in\/social$/,
  /^GET \/callback\/(github|google)$/,
  /^GET \/error$/,
  /^POST \/sign-out$/,
  /^GET \/list-sessions$/,
  /^POST \/revoke-session$/,
  /^POST \/revoke-sessions$/,
  /^POST \/revoke-other-sessions$/,
  /^POST \/change-password$/,
];

async function readJson<T>(request: Request): Promise<T> {
  try {
    return await request.json() as T;
  } catch {
    throw { status: 400, message: 'Invalid JSON body' };
  }
}

function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown';
}

/** Calls a Better Auth endpoint in-process, as if the browser had. */
function callAuth(
  auth: Auth,
  env: Env,
  request: Request,
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  const origin = baseUrl(env, new URL(request.url).origin);
  // Pass the caller's real Origin through so Better Auth's own origin check sees it (not ours).
  const headers = new Headers({ origin: request.headers.get('origin') ?? origin, 'content-type': 'application/json', ...init.headers });
  const ip = request.headers.get('cf-connecting-ip');
  if (ip) headers.set('cf-connecting-ip', ip);
  const ua = request.headers.get('user-agent');
  if (ua) headers.set('user-agent', ua);
  return auth.handler(new Request(`${origin}${AUTH_BASE_PATH}${path}`, {
    method: init.method ?? 'POST',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  }));
}

/** Too many failed sign-ins for one address: the same answer whether or not it has an account. */
function throttled(seconds: number): Response {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  const out = err(`Too many sign-in attempts for this address. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}, or reset your password to sign in now.`, 429, 'signin_throttled');
  out.headers.set('retry-after', String(seconds));
  return out;
}

const minutesText = (seconds: number) => { const m = Math.max(1, Math.ceil(seconds / 60)); return `${m} minute${m === 1 ? '' : 's'}`; };

/** Better Auth's error → our `{ error }` shape, keeping its status. */
async function authError(res: Response, fallback: string): Promise<Response> {
  const body = await res.json().catch(() => null) as { message?: string } | null;
  const status = res.status === 429 ? 429 : res.status >= 500 ? 500 : res.status;
  const message = status === 429 ? 'Too many requests — try again later' : (body?.message ?? fallback);
  const out = json({ error: message }, status);
  const retry = res.headers.get('retry-after') ?? res.headers.get('x-retry-after');
  if (retry) out.headers.set('retry-after', retry);
  return out;
}

/** Browsers always say where a request came from; scripts (curl, tests, the CLI) do not. */
const fromBrowser = (request: Request): boolean => request.headers.has('origin') || request.headers.has('sec-fetch-site');

/**
 * The session response. The session itself travels in the HttpOnly cookie, which script on the page cannot read, so a
 * browser is never handed the token in the body. Non-browser callers (no Origin / Sec-Fetch-Site) get `{ token }` to
 * send as a bearer credential.
 */
function sessionResponse(request: Request, res: Response, body: Record<string, unknown>, status = 200): Response {
  const token = fromBrowser(request) ? undefined : res.headers.get('set-auth-token');
  const out = json({ ...(token !== undefined ? { token } : {}), ...body }, status);
  for (const cookie of setCookies(res.headers)) out.headers.append('set-cookie', cookie);
  return out;
}

async function limited(env: Env, request: Request): Promise<boolean> {
  if (!env.AUTH_LIMITER) return false;
  const { success } = await env.AUTH_LIMITER.limit({ key: clientIp(request) });
  return !success;
}

/** A per-IP limit kept in D1 (every isolate agrees), for routes Better Auth's own limiter no longer sees. */
async function ipLimited(env: Env, request: Request, name: string, rule: { window: number; max: number }): Promise<boolean> {
  return !(await d1RateLimitStorage(env.DB).consume(`${name}:ip:${clientIp(request)}`, rule)).allowed;
}

/**
 * Bot check. A configured Turnstile secret (hosted: TURNSTILE_SECRET_KEY; else the platform setting) requires a valid
 * token. Hosted sign-up fails closed: without both keys nobody can create an account, so a misconfiguration cannot turn
 * Ready Set Mail into an open mail relay. Sign-in and reset are never locked by missing keys: closed means no NEW accounts,
 * and an existing user signs in (and resets) without the check, since the page cannot render it. The mail those can trigger is
 * capped per address (codeMailWait) and the routes are rate limited per IP. When the keys ARE configured, every form keeps
 * the check. Returns the refusal, or null to carry on.
 */
async function botCheck(env: Env, request: Request, token: string | undefined, purpose: 'signup' | 'signin'): Promise<Response | null> {
  if (await hostedSignupClosed(env)) return purpose === 'signup' ? err(SIGNUP_CLOSED_MESSAGE, 503) : null;
  const secret = await turnstileSecret(env);
  if (!secret) return null;
  if (!token || !(await verifyTurnstile(token, secret, request.headers.get('CF-Connecting-IP') ?? ''))) return err('Bot check failed', 403);
  return null;
}

/**
 * A random password nobody is told, for a hosted account created before its mailbox is proven. It cannot be used to
 * sign in; the code step replaces it with the password typed in the attempt the code confirms.
 */
const unusablePassword = (): string => [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');

/** Creates a user through Better Auth under the given sign-up intent and returns its session response. */
async function signUp(
  env: Env, request: Request, ctx: ExecutionContext, intent: SignupIntent,
  p: { name: string; email: string; password: string },
): Promise<{ res: Response; user?: { id: string; email: string } }> {
  const auth = await createAuth(env, request, { intent, ctx });
  const res = await callAuth(auth, env, request, '/sign-up/email', { body: p });
  if (!res.ok) return { res };
  const data = await res.clone().json() as { user?: { id: string; email: string } };
  return { res, user: data.user };
}

/**
 * Whether sign-in codes are in force. Hosted: always (it cannot be turned off). Self-host: when the instance can send mail
 * (SEND_EMAIL and a sender address), unless SIGNIN_CODES=off; without mail, sign-in is the password alone, so an owner is never
 * locked out by a code that cannot be delivered.
 */
export async function signinCodes(env: Env): Promise<{ on: boolean; reason: 'hosted' | 'mail' | 'no_mail' | 'turned_off' }> {
  if (isSaas(env)) return { on: true, reason: 'hosted' };
  if (!(await mailReady(env))) return { on: false, reason: 'no_mail' };
  if ((env as Env & { SIGNIN_CODES?: string }).SIGNIN_CODES?.trim().toLowerCase() === 'off') return { on: false, reason: 'turned_off' };
  return { on: true, reason: 'mail' };
}

const secureOrigin = (env: Env, request: Request) => baseUrl(env, new URL(request.url).origin).startsWith('https://');

/** A well-formed hash nothing matches, verified against when an address has no password: a missing account costs the same PBKDF2 time as a wrong password. */
const TIMING_HASH = `${'0'.repeat(32)}:${'0'.repeat(64)}`;

/** Does this account's own password match? Unverified (hosted) accounts never match: nobody chose their password. */
async function passwordMatches(env: Env, user: { id: string; email_verified: number | boolean } | null, password: string): Promise<boolean> {
  const row = user ? await env.DB.prepare("SELECT password FROM auth_accounts WHERE user_id = ?1 AND provider_id = 'credential'").bind(user.id).first<{ password: string | null }>() : null;
  const ok = await verifyPassword(password, row?.password || TIMING_HASH).catch(() => false);
  return ok && !!row?.password && !!user && (!isSaas(env) || !!user.email_verified);
}

/**
 * Start a code attempt and answer the form: the pending-attempt cookie (replacing, and dropping, the one this browser held)
 * and `{ code_required, purpose, email }`. The same answer whether the code was sent, was over the address's allowance, or
 * the attempt is a decoy (userId null). Over the allowance the attempt is a decoy too: a code nobody was sent can never
 * match, so the number of codes that can be guessed at is the number actually mailed.
 */
async function answerWithCode(
  env: Env, request: Request, ctx: ExecutionContext, attempt: Attempt,
  send: { code: boolean; notice?: boolean } = { code: true },
): Promise<Response> {
  const secure = secureOrigin(env, request);
  const origin = baseUrl(env, new URL(request.url).origin);
  const mailing = !!attempt.userId && send.code && !(await codeMailWait(env, attempt.email, poolFor(attempt.purpose)));
  if (attempt.userId && send.code && !mailing) console.warn('[auth] code email not sent: per-address limit reached');
  const { handle, code } = await startAttempt(env, pendingHandle(request, secure), mailing ? attempt : { ...attempt, userId: null, passwordHash: undefined, invite: undefined });
  if (mailing) {
    ctx.waitUntil(sendCodeEmail(env, attempt.email, code, attempt.purpose, origin, requestedFrom(request)).catch(() => {}));
  } else if (send.notice) {
    ctx.waitUntil((async () => {
      if (await codeMailWait(env, attempt.email, 'signup')) return;
      await sendSignupNotice(env, attempt.email, origin);
    })().catch(() => {}));
  }
  const out = json({ code_required: true, purpose: attempt.purpose, email: attempt.email, expires_in: CODE_SECONDS });
  out.headers.append('set-cookie', pendingCookie(handle, secure));
  return out;
}

/** Opens a session for a user whose code step is done; the response carries the session cookie (and token for scripts). */
async function openSession(env: Env, request: Request, ctx: ExecutionContext, userId: string, body: Record<string, unknown>): Promise<Response> {
  const auth = await createAuth(env, request, { ctx });
  const headers = new Headers();
  for (const h of ['user-agent', 'cf-connecting-ip']) { const v = request.headers.get(h); if (v) headers.set(h, v); }
  const res = await (auth.api as unknown as { startCodeSession(o: { body: { userId: string }; headers: Headers; asResponse: true }): Promise<Response> })
    .startCodeSession({ body: { userId }, headers, asResponse: true });
  if (!res.ok) return err('could not sign in', 500);
  const out = sessionResponse(request, res, body);
  const secure = secureOrigin(env, request);
  out.headers.append('set-cookie', await deviceCookie(env, userId, secure));
  out.headers.append('set-cookie', clearPendingCookie(secure));
  return out;
}

/**
 * The address is proven by a code typed in the attempt that set `passwordHash`: that password, and only that one, becomes the
 * account's, in one statement that applies only while the account is still unverified (two attempts at once: one wins).
 * Every other pending attempt of the account is dropped, its sessions end, and names typed before are reset.
 */
async function proveAddress(env: Env, userId: string, email: string, passwordHash: string, terms: string | undefined): Promise<boolean> {
  const db = env.DB;
  const now = Math.floor(Date.now() / 1000);
  const [, verified] = await db.batch([
    db.prepare("UPDATE auth_accounts SET password = ?1 WHERE user_id = ?2 AND provider_id = 'credential' AND (SELECT email_verified FROM users WHERE id = ?2) = 0").bind(passwordHash, userId),
    db.prepare("UPDATE users SET email_verified = 1, terms_accepted_at = CASE WHEN ?3 IS NULL THEN terms_accepted_at ELSE ?4 END, terms_version = COALESCE(?3, terms_version) WHERE id = ?1 AND email_verified = 0 AND EXISTS (SELECT 1 FROM auth_accounts WHERE user_id = ?1 AND provider_id = 'credential' AND password = ?2)")
      .bind(userId, passwordHash, terms ?? null, now),
  ]);
  if ((verified?.meta.changes ?? 0) !== 1) return false;
  await dropAttemptsOf(env, userId);
  await globalQueries(db).sessions.revokeAll(userId);
  await resetUnprovenNames(db, userId, email);
  await rotateDeviceEpoch(env, userId);
  await clearSigninFailures(env, email);
  return true;
}

/** Set an account's password (reset by code). Creates the password login for an account that only had OAuth. */
async function setPassword(env: Env, userId: string, passwordHash: string): Promise<void> {
  const r = await env.DB.prepare("UPDATE auth_accounts SET password = ?1, updated_at = unixepoch() WHERE user_id = ?2 AND provider_id = 'credential'").bind(passwordHash, userId).run();
  if ((r.meta.changes ?? 0) === 0) {
    await env.DB.prepare("INSERT INTO auth_accounts (id, user_id, provider_account_id, provider_id, password) VALUES (?1, ?2, ?2, 'credential', ?3)").bind(crypto.randomUUID(), userId, passwordHash).run();
  }
}

/** Refusal wording for a code. */
function codeRefusal(refused: 'code_expired' | 'code_wrong' | 'code_used_up', triesLeft?: number): Response {
  if (refused === 'code_wrong') return err(`That code is not right. ${triesLeft} ${triesLeft === 1 ? 'try' : 'tries'} left.`, 400, 'code_wrong');
  if (refused === 'code_used_up') return err(`That code was entered wrong ${CODE_MAX_TRIES} times, so it no longer works. Send a new code.`, 410, 'code_used_up');
  return err('This code has expired or was replaced by a newer one. Send a new code.', 410, 'code_expired');
}

/**
 * The shared front half of /api/auth/code and /api/auth/reset: the attempt this browser holds, the limits, and the code.
 * Returns the confirmed attempt, or the response to send.
 */
async function confirmCode(env: Env, request: Request, code: unknown, purposes: readonly CodePurpose[]): Promise<{ attempt: Attempt } | { response: Response }> {
  const handle = pendingHandle(request, secureOrigin(env, request));
  const pending = handle ? await peekAttempt(env, handle) : null;
  if (!handle || !pending || !purposes.includes(pending.purpose)) return { response: codeRefusal('code_expired') };
  const ip = clientIp(request);
  const wait = await codeCheckWait(env, pending, ip);
  if (wait) {
    const out = err(`Too many wrong codes. Try again in ${minutesText(wait)}.`, 429, 'code_throttled');
    out.headers.set('retry-after', String(wait));
    return { response: out };
  }
  const result = await checkCode(env, handle, typeof code === 'string' ? code.replace(/\s+/g, '') : '');
  if ('refused' in result) {
    if (result.refused !== 'code_expired') await recordCodeFailure(env, pending, ip);
    return { response: codeRefusal(result.refused, result.triesLeft) };
  }
  return { attempt: result.attempt };
}

/**
 * `tenantFor` yields the TenantContext of the caller if signed in, else the anonymous platform context.
 */
export async function handleAuthRoute(
  request: Request, env: Env, ctx: ExecutionContext, tenantFor: () => Promise<TenantContext>,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();
  if (!path.startsWith('/api/auth/') && !path.startsWith('/api/invites/')) return null;

  // Login-CSRF defence: every POST must be same-origin (when a browser says where it came from)
  // and, apart from body-less logout, explicit JSON — a cross-site <form> can only send text/plain.
  if (method === 'POST') {
    if (!passesCsrfCheck(request, env, { allowNonBrowser: true })) return err('cross-origin request rejected', 403);
    const ct = request.headers.get('content-type') ?? '';
    if (path !== '/api/auth/logout' && !/^application\/json\b/i.test(ct)) return err('Content-Type must be application/json', 415);
  }

  // ── GET /api/auth/status ────────────────────────────────────
  if (path === '/api/auth/status' && method === 'GET') {
    const saas = isSaas(env);
    const configured = saas ? true : await platform(env).team.hasOwner();
    // Workspace-specific facts (custom domain, base domain, domains) come from the caller's own tenant
    // when they are signed in; an anonymous visitor gets the self-host instance's, or nothing in saas.
    const t = await tenantFor();
    const mine = !saas || !!t.userId ? t : null;
    const [siteKey, closed, customDomainRow, telemetryRow, codes] = await Promise.all([
      turnstileSiteKey(env),
      hostedSignupClosed(env),
      mine?.scope.settings.get('custom_domain') ?? null,
      mine?.scope.settings.get('telemetry_opted_in') ?? null,
      signinCodes(env),
    ]);
    const existingDomains = mine ? await mine.scope.domains.list() : [];
    const baseDomain = mine?.settings.baseDomain;
    // Hosted without bot protection: no new accounts (sign-up answers 503), while existing users still sign in and reset
    // their password (see botCheck). Say exactly that, so the page offers sign-in and no sign-up form.
    const noBotProtection = closed;
    return json({
      configured,
      mode: saas ? 'saas' : 'self-host',
      // Self-host only, and only when HOSTED_SERVICE_URL is set: the installer-proof screen mentions it once.
      ...(hostedServiceUrl(env) ? { hosted_service_url: hostedServiceUrl(env) } : {}),
      signup_open: saas && !noBotProtection,
      signin_available: true,
      ...(noBotProtection ? { signup_unavailable_reason: 'bot_protection_not_configured' } : {}),
      // Closed: an OAuth login still signs in an existing user; the user-creation hook refuses a new account.
      oauth_providers: enabledOAuthProviders(env),
      prefill: { name: '', email: '' },
      telemetry_default: telemetryRow?.value === 'true',
      turnstile_site_key: siteKey,
      custom_domain: customDomainRow?.value ?? null,
      base_domain: baseDomain ?? null,
      has_domain: existingDomains.length > 0 || !!baseDomain,
      // Hosted only: the booking link behind "Talk to Max". A self-hosted instance's
      // BOOKING_URL belongs to its own funnel mail, so its dashboard never shows it.
      help_url: saas ? helpUrl(env) : null,
      // Whether the free email check can work: hosted needs a canary domain to receive the test email.
      email_check: emailCheckAvailable(env),
      // Whether sign-in ends with an emailed code, and why (hosted | mail | no_mail | turned_off).
      signin_codes: codes.on,
      signin_codes_reason: codes.reason,
      // Terms, privacy and operator: hosted always; self-host only what its operator configured.
      legal: legalStatus(env),
    });
  }

  // ── POST /api/auth/setup — first-run owner (self-host; closed once an owner exists) ──
  if (path === '/api/auth/setup' && method === 'POST') {
    const ip = clientIp(request);
    if (await limited(env, request)) return err('Too many requests — try again later', 429);
    if (isSaas(env)) return err('sign up at /api/auth/signup', 409);
    if (await platform(env).team.hasOwner()) return err('already configured — use /api/auth/login', 409);

    const bootstrapProof = request.headers.get('x-ready-set-mail-bootstrap')
      || request.headers.get('x-inbox-angel-bootstrap') // @legacy-name: header before the rename to Ready Set Mail (2026-11-13); remove after every installation's owner setup is done
      || '';
    if (!(await verifyBootstrapProof(env, bootstrapProof))) return err('installer proof required', 403);
    const body = await readJson<{ name?: string; email?: string; password?: string; telemetry?: boolean; cf_turnstile_token?: string }>(request);
    if (!body.email || !body.password) return err('email and password are required', 400);
    if (body.password.length < 8) return err('password must be at least 8 characters', 400);
    if (!EMAIL_RE.test(body.email)) return err('invalid email', 400);
    { const bot = await botCheck(env, request, body.cf_turnstile_token, 'signup'); if (bot) return bot; }

    const email = body.email.toLowerCase().trim();
    const { res, user } = await signUp(env, request, ctx, { kind: 'setup', bootstrapProof }, { name: cleanName(body.name) || email, email, password: body.password });
    if (!res.ok || !user) return authError(res, 'sign-up failed');

    // Self-host: the instance owner is verified at setup (there may be no outbound email to verify with).
    await globalQueries(env.DB).users.markEmailVerified(user.id);
    if (body.telemetry !== undefined) await platform(env).settings.set('telemetry_opted_in', body.telemetry ? 'true' : 'false');
    auditUser(env, ctx, user.id, {
      actor_id: user.id, actor_email: email, actor_type: 'user',
      action: 'auth.setup',
      resource_type: 'user', resource_id: user.id, resource_name: email,
      after_value: { email, role: 'owner' },
      meta: { ip },
    });
    track(new TenantContext({ env, workspaceId: IMPLICIT_WORKSPACE_ID }), { event: 'instance.born' }); // fire-and-forget

    const hasDomain = (await platform(env).domains.list()).length > 0 || !!(await platform(env).settings.get('base_domain'))?.value;
    return sessionResponse(request, res, { has_domain: hasDomain }, 201);
  }

  // ── POST /api/auth/signup — new workspace (MODE=saas): email + password, then the emailed code ──
  // The answer is the same whether the address is new, waiting for its code, or already an account (no enumeration). Nothing
  // typed here touches an existing account: the password is held in the attempt and becomes the account's only when this
  // attempt's code is typed (POST /api/auth/code). A verified owner may get a notice instead of a code, within the allowance.
  if (path === '/api/auth/signup' && method === 'POST') {
    if (await limited(env, request)) return err('Too many requests — try again later', 429);
    if (!isSaas(env)) return err('sign-up is closed — ask an owner for an invite', 403);
    if (await hostedSignupClosed(env)) return err(SIGNUP_CLOSED_MESSAGE, 503);
    if (await ipLimited(env, request, 'signup', { window: 3600, max: 10 })) return err('Too many requests — try again later', 429);
    const body = await readJson<{ email?: string; password?: string; cf_turnstile_token?: string }>(request);
    if (!body.email || !body.password) return err('email and password are required', 400);
    if (body.password.length < 8) return err('password must be at least 8 characters', 400);
    if (body.password.length > MAX_PASSWORD) return err(`password must be at most ${MAX_PASSWORD} characters`, 400);
    if (!EMAIL_RE.test(body.email)) return err('invalid email', 400);
    { const bot = await botCheck(env, request, body.cf_turnstile_token, 'signup'); if (bot) return bot; }

    const email = body.email.toLowerCase().trim();
    const passwordHash = await hashPassword(body.password);
    let user = await globalQueries(env.DB).users.byEmail(email);
    if (!user) {
      // Hosted: no name before the address is proven (it would be whoever typed it), and a password nobody knows.
      const created = await signUp(env, request, ctx, { kind: 'signup' }, { name: email, email, password: unusablePassword() });
      user = await globalQueries(env.DB).users.byEmail(email); // also when two sign-ups raced and the other created it
      if (!user) return authError(created.res, 'sign-up failed');
      if (created.user) auditUser(env, ctx, user.id, {
        actor_id: user.id, actor_email: email, actor_type: 'user',
        action: 'auth.signup', resource_type: 'user', resource_id: user.id, resource_name: email,
        after_value: { email, role: 'owner' }, meta: { ip: clientIp(request) },
      });
    }
    const terms = legal(env).termsVersion ?? undefined;
    if (user.email_verified) return answerWithCode(env, request, ctx, { purpose: 'signup', userId: null, email }, { code: false, notice: true });
    return answerWithCode(env, request, ctx, { purpose: 'signup', userId: user.id, email, passwordHash, terms });
  }

  // ── POST /api/auth/login — password; then, when codes are on, the emailed code ──
  if (path === '/api/auth/login' && method === 'POST') {
    if (await limited(env, request)) return err('Too many requests — try again later', 429);
    const body = await readJson<{ email?: string; password?: string; cf_turnstile_token?: string }>(request);
    if (!body.email || !body.password) return err('email and password are required', 400);
    if (body.password.length > MAX_PASSWORD) return err('invalid credentials', 401);
    { const bot = await botCheck(env, request, body.cf_turnstile_token, 'signin'); if (bot) return bot; }
    const email = body.email.toLowerCase().trim();
    // Per-address failure throttle (10 wrong passwords in 15 minutes), counted the same for addresses with no account, whether
    // or not the bot check is configured. A password reset clears it.
    const wait = await signinWait(env, email);
    if (wait) {
      // A device that signed in to this very account before skips the per-address lock (the per-IP limits still apply).
      const known = await globalQueries(env.DB).users.byEmail(email);
      if (!known || !(await knownDevice(env, request, known.id))) return throttled(wait);
    }

    const codes = await signinCodes(env);
    if (codes.on) {
      if (await ipLimited(env, request, 'signin', { window: 60, max: 10 })) return err('Too many requests — try again later', 429);
      const user = await globalQueries(env.DB).users.byEmail(email);
      if (!user || !(await passwordMatches(env, user, body.password))) {
        await recordSigninFailure(env, email);
        return err('invalid credentials', 401);
      }
      await clearSigninFailures(env, email);
      // The right password proves who is asking, so the mail allowance can be stated plainly (nobody else learns anything).
      const mailWait = await codeMailWait(env, email, 'signin');
      if (mailWait) {
        const out = err(`We have sent this address several sign-in codes recently. Use the newest one you received, or try again in ${minutesText(mailWait)}.`, 429, 'code_mail_limit');
        out.headers.set('retry-after', String(mailWait));
        return out;
      }
      const secure = secureOrigin(env, request);
      const { handle, code } = await startAttempt(env, pendingHandle(request, secure), { purpose: 'signin', userId: user.id, email });
      const origin = baseUrl(env, url.origin);
      ctx.waitUntil(sendCodeEmail(env, email, code, 'signin', origin, requestedFrom(request)).catch(() => {}));
      const out = json({ code_required: true, purpose: 'signin', email, expires_in: CODE_SECONDS });
      out.headers.append('set-cookie', pendingCookie(handle, secure));
      return out;
    }

    // Codes off (self-host without mail, or SIGNIN_CODES=off): the password alone signs in, through Better Auth.
    const auth = await createAuth(env, request, { ctx });
    const res = await callAuth(auth, env, request, '/sign-in/email', { body: { email, password: body.password } });
    if (!res.ok) {
      if (res.status === 429) return authError(res, 'too many requests');
      await recordSigninFailure(env, email);
      return err('invalid credentials', 401);
    }
    await clearSigninFailures(env, email);

    const { user } = await res.clone().json() as { user: { id: string; email: string } };
    auditUser(env, ctx, user.id, {
      actor_id: user.id, actor_email: user.email, actor_type: 'user',
      action: 'auth.login',
      resource_type: 'user', resource_id: user.id, resource_name: user.email,
      meta: { ip: clientIp(request) },
    });
    const out = sessionResponse(request, res, {});
    out.headers.append('set-cookie', await deviceCookie(env, user.id, secureOrigin(env, request)));
    return out;
  }

  // ── POST /api/auth/code — the emailed code, in the browser that asked for it: finishes sign-up, an invite or sign-in ──
  if (path === '/api/auth/code' && method === 'POST') {
    if (await limited(env, request)) return err('Too many requests — try again later', 429);
    const body = await readJson<{ code?: unknown }>(request);
    const confirmed = await confirmCode(env, request, body.code, ['signup', 'invite', 'signin']);
    if ('response' in confirmed) return confirmed.response;
    const { attempt } = confirmed;
    const userId = attempt.userId!;
    const ip = clientIp(request);

    if (attempt.purpose === 'signin') {
      const user = await globalQueries(env.DB).users.byId(userId);
      if (!user || (isSaas(env) && !user.email_verified)) return codeRefusal('code_expired');
      auditUser(env, ctx, userId, {
        actor_id: userId, actor_email: user.email, actor_type: 'user',
        action: 'auth.login', resource_type: 'user', resource_id: userId, resource_name: user.email,
        meta: { ip, code: 'email' },
      });
      return openSession(env, request, ctx, userId, { purpose: 'signin' });
    }

    // Sign-up or invite: the password typed in THIS attempt becomes the account's, now that the address is proven.
    if (!attempt.passwordHash || !(await proveAddress(env, userId, attempt.email, attempt.passwordHash, attempt.terms))) return codeRefusal('code_expired');
    auditUser(env, ctx, userId, {
      actor_id: userId, actor_email: attempt.email, actor_type: 'user',
      action: 'auth.email_verified', resource_type: 'user', resource_id: userId, resource_name: attempt.email,
      meta: { ip, password: 'chosen', code: 'email', ...(attempt.terms ? { terms: attempt.terms } : {}) },
    });
    let joined: { workspace_id: string; workspace_name: string | null } | null = null;
    if (attempt.purpose === 'invite' && attempt.invite) {
      // The code proved the invited address: the invite is accepted now, as the verified account.
      const invite = await authLookups(env.DB).inviteByToken(attempt.invite);
      if (invite && !invite.used_at && invite.expires_at >= Math.floor(Date.now() / 1000) && invite.email === attempt.email) {
        const team = forWorkspace(env.DB, invite.workspace_id).team;
        if (await team.claimInvite(invite.token)) {
          await team.addMember(userId, invite.role === 'admin' ? 'admin' : 'member');
          joined = { workspace_id: invite.workspace_id, workspace_name: (await workspaceLifecycle(env.DB).get(invite.workspace_id))?.name ?? null };
          auditUser(env, ctx, userId, {
            actor_id: userId, actor_email: attempt.email, actor_type: 'user',
            action: 'auth.invite_accepted', resource_type: 'user', resource_id: userId, resource_name: attempt.email,
            after_value: { email: attempt.email, role: invite.role, invited_by: invite.invited_by },
          }, invite.workspace_id);
        }
      }
    }
    return openSession(env, request, ctx, userId, { purpose: attempt.purpose, ...(joined ?? {}) });
  }

  // ── GET /api/auth/verify-email — links sent before the welcome-page design ──
  // Changes nothing and creates nothing: a page moves the token into the welcome page's fragment (no Location carries it).
  if (path === '/api/auth/verify-email' && method === 'GET') return legacyVerifyLinkPage();

  // ── Retired: the emailed link's welcome page and its resend ──
  // Links already in inboxes open a page that says to sign in or create the account again (which sends a code).
  if ((path === '/api/auth/welcome' || path === '/api/auth/resend-verification') && method === 'POST') {
    return err('Email links are no longer used. Sign in, or create your account again with the same email to get a code.', 410, 'link_retired');
  }

  // ── POST /api/auth/logout ───────────────────────────────────
  if (path === '/api/auth/logout' && method === 'POST') {
    const key = request.headers.get('x-api-key') ?? '';
    const headers: Record<string, string> = {};
    const cookie = request.headers.get('cookie');
    if (cookie) headers.cookie = cookie;
    if (key) headers.authorization = `Bearer ${key}`;
    const auth = await createAuth(env, request, { ctx });
    const res = await callAuth(auth, env, request, '/sign-out', { headers, body: {} });
    const out = json({ ok: true });
    for (const c of setCookies(res.headers)) out.headers.append('set-cookie', c);
    return out;
  }

  // ── POST /api/auth/forgot — a reset code; always the same answer, whether or not the email exists ──
  if (path === '/api/auth/forgot' && method === 'POST') {
    if (await limited(env, request)) return err('Too many requests — try again later', 429);
    const body = await readJson<{ email?: string; cf_turnstile_token?: string }>(request);
    if (!body.email) return err('email is required', 400);
    if (await ipLimited(env, request, 'reset', { window: 3600, max: 10 })) return err('Too many requests — try again later', 429);
    // The bot check when the keys are set; never closed (an existing user can always reset).
    { const bot = await botCheck(env, request, body.cf_turnstile_token, 'signin'); if (bot) return bot; }
    const email = body.email.toLowerCase().trim();
    const user = EMAIL_RE.test(email) ? await globalQueries(env.DB).users.byEmail(email) : null;
    if (user) auditUser(env, ctx, user.id, {
      actor_id: user.id, actor_email: user.email, actor_type: 'user',
      action: 'auth.password_reset', resource_type: 'user', resource_id: user.id, resource_name: user.email,
      meta: { phase: 'requested' },
    });
    return answerWithCode(env, request, ctx, { purpose: 'reset', userId: user?.id ?? null, email });
  }

  // ── POST /api/auth/reset — the emailed reset code and a new password, in the browser that asked ──
  // Sets the password, proves the address (an account still waiting for its sign-up code is confirmed by this), ends every
  // session and pending attempt, and signs in: no second code right after a reset.
  if (path === '/api/auth/reset' && method === 'POST') {
    if (await limited(env, request)) return err('Too many requests — try again later', 429);
    const body = await readJson<{ code?: unknown; password?: string }>(request);
    if (!body.password || body.password.length < 8) return err('password must be at least 8 characters', 400);
    if (body.password.length > MAX_PASSWORD) return err(`password must be at most ${MAX_PASSWORD} characters`, 400);
    const confirmed = await confirmCode(env, request, body.code, ['reset']);
    if ('response' in confirmed) return confirmed.response;
    const userId = confirmed.attempt.userId!;
    const user = await globalQueries(env.DB).users.byId(userId);
    if (!user) return codeRefusal('code_expired');
    await setPassword(env, userId, await hashPassword(body.password));
    if (!user.email_verified) {
      await globalQueries(env.DB).users.markEmailVerified(userId);
      await resetUnprovenNames(env.DB, userId, user.email);
    }
    await dropAttemptsOf(env, userId);
    await globalQueries(env.DB).sessions.revokeAll(userId);
    await rotateDeviceEpoch(env, userId);
    await clearSigninFailures(env, user.email); // whoever was guessing this account's password no longer holds the person up
    auditUser(env, ctx, userId, {
      actor_id: userId, actor_email: user.email, actor_type: 'user',
      action: 'auth.password_reset', resource_type: 'user', resource_id: userId,
      meta: { phase: 'completed', code: 'email' },
    });
    return openSession(env, request, ctx, userId, { purpose: 'reset' });
  }

  // ── Invites: GET info, POST accept ──────────────────────────
  const inviteMatch = path.match(/^\/api\/invites\/([^/]+)$/);
  if (inviteMatch && (method === 'GET' || method === 'POST')) {
    const invite = await authLookups(env.DB).inviteByToken(inviteMatch[1]);
    if (!invite || invite.used_at || invite.expires_at < Math.floor(Date.now() / 1000)) {
      return err('invite not found or expired', 404);
    }
    const existingUser = await globalQueries(env.DB).users.byEmail(invite.email);
    const workspaceName = (await workspaceLifecycle(env.DB).get(invite.workspace_id))?.name ?? null;
    // Hosted: an account still waiting for its code is not an existing login; the invitee confirms the address here.
    const hasLogin = !!existingUser && (!isSaas(env) || !!existingUser.email_verified);
    if (method === 'GET') {
      // Lets the page offer "sign in to accept" instead of a password form. The token holder is the invitee.
      const me = hasLogin ? await currentUser(request, env, ctx).catch(() => null) : null;
      return json({
        email: invite.email, invited_by: invite.invited_by, role: invite.role,
        workspace_id: invite.workspace_id, workspace_name: workspaceName,
        user_exists: hasLogin,
        signed_in_as: me?.email ?? null,
      });
    }

    // An invite to an email that already has a login: add a membership, never a second user.
    if (hasLogin && existingUser) {
      if (await limited(env, request)) return err('Too many requests — try again later', 429);
      const me = await currentUser(request, env, ctx).catch(() => null);
      if (!me) return err('sign in as ' + invite.email + ' to accept this invite', 401);
      if (isSaas(env) && !me.emailVerified) return err('verify your email address before accepting this invite', 403, 'email_not_verified');
      if (me.email.toLowerCase() !== invite.email) return err(`this invite is for ${invite.email}, but you are signed in as ${me.email} — sign out and sign in as ${invite.email} to accept it`, 403, 'wrong_user');
      const team = forWorkspace(env.DB, invite.workspace_id).team;
      if (!(await team.claimInvite(invite.token))) return err('invite not found or expired', 404);
      await team.addMember(me.id, invite.role === 'admin' ? 'admin' : 'member');
      auditUser(env, ctx, me.id, {
        actor_id: me.id, actor_email: me.email, actor_type: 'user',
        action: 'auth.invite_accepted',
        resource_type: 'user', resource_id: me.id, resource_name: me.email,
        after_value: { email: me.email, role: invite.role, invited_by: invite.invited_by, existing_user: true },
      }, invite.workspace_id);
      return json({ ok: true, workspace_id: invite.workspace_id, workspace_name: workspaceName }, 200);
    }

    if (await limited(env, request)) return err('Too many requests — try again later', 429);
    // Closed sign-up creates no account here either. Said explicitly: Better Auth turns a refusal from the user-creation hook
    // into a generic answer while email verification is required, which would look like success.
    if (isSaas(env) && (await hostedSignupClosed(env))) return err(SIGNUP_CLOSED_MESSAGE, 503);
    const body = await readJson<{ name?: string; password?: string }>(request);
    if (!isSaas(env) && (!cleanName(body.name) || !body.password)) return err('name and password are required', 400);
    if (isSaas(env) && !body.password) return err('password is required', 400);
    if (body.password && body.password.length < 8) return err('password must be at least 8 characters', 400);
    if (body.password && body.password.length > MAX_PASSWORD) return err(`password must be at most ${MAX_PASSWORD} characters`, 400);

    // Hosted: holding the link is not proof of owning the address. The invitee gets a login with no password anyone knows and
    // no workspace; the code emailed to the invited address sets the password typed here, verifies it and accepts the invite.
    if (isSaas(env)) {
      const passwordHash = await hashPassword(body.password!);
      let user = existingUser;
      if (!user) {
        const created = await signUp(env, request, ctx, { kind: 'invitee', token: invite.token }, { name: invite.email, email: invite.email, password: unusablePassword() });
        user = await globalQueries(env.DB).users.byEmail(invite.email);
        if (!user) return authError(created.res, 'could not create account');
      }
      return answerWithCode(env, request, ctx, { purpose: 'invite', userId: user.id, email: invite.email, passwordHash, invite: invite.token, terms: legal(env).termsVersion ?? undefined });
    }

    const { res, user } = await signUp(env, request, ctx, { kind: 'invite', token: invite.token }, {
      name: cleanName(body.name), email: invite.email, password: body.password!, // required above for self-host
    });
    if (!res.ok || !user) return authError(res, 'could not accept invite');
    // Self-host: an invited teammate is verified by the invite itself (there is no verification mail to rely on).
    await globalQueries(env.DB).users.markEmailVerified(user.id);
    // The form showed the operator's terms when it has configured them: record that they were accepted.
    const terms = legal(env).termsVersion;
    if (terms) await env.DB.prepare('UPDATE users SET terms_accepted_at = ?1, terms_version = ?2 WHERE id = ?3').bind(Math.floor(Date.now() / 1000), terms, user.id).run();
    auditUser(env, ctx, user.id, {
      actor_id: user.id, actor_email: invite.email, actor_type: 'user',
      action: 'auth.invite_accepted',
      resource_type: 'user', resource_id: user.id, resource_name: invite.email,
      after_value: { email: invite.email, role: invite.role, invited_by: invite.invited_by },
    }, invite.workspace_id);
    return sessionResponse(request, res, {}, 201);
  }

  // ── Better Auth's own endpoints: OAuth, sessions, change-password ──
  if (path.startsWith(`${AUTH_BASE_PATH}/`)) {
    const rel = path.slice(AUTH_BASE_PATH.length);
    if (!PASSTHROUGH.some(re => re.test(`${method} ${rel}`))) return err('not found', 404);
    if (await limited(env, request)) return err('Too many requests — try again later', 429);
    const auth = await createAuth(env, request, { ctx });
    // The dashboard holds its session token in X-Api-Key; Better Auth reads it as a Bearer token.
    const headers = new Headers(request.headers);
    const key = headers.get('x-api-key');
    if (key && !headers.has('authorization')) headers.set('authorization', `Bearer ${key}`);
    let body: BodyInit | null = method === 'GET' ? null : await request.text();
    if (method === 'POST' && rel === '/change-password') {
      // A password change always signs out every other session; the caller cannot opt out.
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(body as string); } catch { return err('Invalid JSON body', 400); }
      body = JSON.stringify({ ...parsed, revokeOtherSessions: true });
    }
    // "Sign out everywhere" and a password change: whoever it is must be known first.
    const everywhere = method === 'POST' && (rel === '/revoke-sessions' || rel === '/revoke-other-sessions');
    const changing = method === 'POST' && rel === '/change-password';
    const caller = everywhere || changing ? await currentUser(request, env, ctx).catch(() => null) : null;
    const res = await auth.handler(new Request(request.url, { method, headers, body }));
    // It also ends this account's device cookies' skip of the per-address sign-in lock (a password change does by itself).
    if (everywhere && caller && res.ok) await rotateDeviceEpoch(env, caller.id);
    // A new password voids every code attempt started with the old one.
    if (changing && caller && res.ok) await dropAttemptsOf(env, caller.id);
    if (fromBrowser(request) && res.headers.has('set-auth-token')) {
      // Same rule as sessionResponse: a browser holds its session in the cookie only.
      const clean = new Response(res.body, res);
      clean.headers.delete('set-auth-token');
      return clean;
    }
    return res;
  }

  return null;
}
