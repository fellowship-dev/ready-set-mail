// What is left of the emailed-link design, and the per-address sign-in throttle.
//
// Hosted accounts are confirmed with a six-digit code now (src/auth/codes.ts). Links sent before that change point at
// `<origin>/#/welcome/<token>` (or, older still, `GET /api/auth/verify-email?token=…`). Neither does anything any more: the
// first opens a page that says to sign in or to create the account again with the same email (which sends a code); the
// second answers a page that moves the token into that page's fragment, as it always did, so it is in no request line.
import { authLookups, forWorkspace, workspaceLifecycle } from '@ready-set-mail/db';
import type { AuthEnv } from './config';
import { d1RateLimitStorage } from './rate-limit';
import { cleanName, defaultWorkspaceName } from './names';

/**
 * Names typed before the address was proven belong to whoever typed them (possibly someone who registered this address to
 * plant text in the real owner's dashboard). When an address is proven they are replaced: the display name by the email
 * address (or a name given at that moment), the workspace sign-up made (owned by this account alone) by one derived from that
 * name, else from the email's domain. Workspaces the account was invited into are not touched.
 */
export async function resetUnprovenNames(db: D1Database, userId: string, email: string, name = ''): Promise<void> {
  const given = cleanName(name);
  await db.prepare('UPDATE users SET name = ?1 WHERE id = ?2').bind(given || email, userId).run();
  const workspaceName = defaultWorkspaceName(given, email);
  for (const m of await authLookups(db).membershipsOf(userId)) {
    if (m.role !== 'owner') continue;
    // Only a workspace this account alone is in: the one sign-up made (an unproven account can have done nothing else).
    if ((await forWorkspace(db, m.workspace_id).team.list()).length !== 1) continue;
    await workspaceLifecycle(db).rename(m.workspace_id, workspaceName);
  }
}

/** Clear the per-address sign-in failure count (a password chosen or reset, or a right password). */
export async function clearSigninFailures(env: AuthEnv, email: string): Promise<void> {
  await (env.DB as D1Database).prepare('DELETE FROM auth_rate_limits WHERE key = ?1').bind(signinFailureKey(email)).run();
}

/** Sign-in failures (wrong passwords) per address: 10 in 15 minutes, then attempts for that address wait out the rest of the window. */
export const SIGNIN_FAILURE_LIMIT = 10;
export const SIGNIN_FAILURE_WINDOW_SECONDS = 15 * 60;
const signinFailureKey = (email: string) => `signin-fail:${addressKey(email)}`;

/**
 * Seconds this address must wait before a password is checked again, or 0. Counted the same for addresses that have no account,
 * so the answer reveals nothing about which do.
 */
export async function signinWait(env: AuthEnv, email: string, now = Date.now()): Promise<number> {
  const row = await (env.DB as D1Database).prepare('SELECT count, last_request FROM auth_rate_limits WHERE key = ?1').bind(signinFailureKey(email)).first<{ count: number; last_request: number }>();
  if (!row) return 0;
  const end = row.last_request + SIGNIN_FAILURE_WINDOW_SECONDS * 1000;
  return row.count >= SIGNIN_FAILURE_LIMIT && now < end ? Math.max(1, Math.ceil((end - now) / 1000)) : 0;
}

/** Count one failed sign-in for this address (window starts at the first failure, as for every limit kept in D1). */
export async function recordSigninFailure(env: AuthEnv, email: string): Promise<void> {
  await d1RateLimitStorage(env.DB as D1Database).consume(signinFailureKey(email), { window: SIGNIN_FAILURE_WINDOW_SECONDS, max: SIGNIN_FAILURE_LIMIT });
}

/**
 * Links sent before the fragment design pointed at GET /api/auth/verify-email?token=…. That request changes nothing: it answers
 * a page whose script moves the token into the fragment of the welcome page (no Location header carries it), with no Referer.
 * The welcome page itself now only says what to do instead.
 */
const LEGACY_SCRIPT = "var t=new URLSearchParams(location.search).get('token')||'';location.replace('/#/welcome/'+encodeURIComponent(t));";
export async function legacyVerifyLinkPage(): Promise<Response> {
  const digest = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(LEGACY_SCRIPT)))));
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex"><title>Ready Set Mail</title></head><body><script>${LEGACY_SCRIPT}</script><noscript><p>Open Ready Set Mail and sign in, or create your account again with the same email to get a code.</p></noscript></body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': `default-src 'none'; script-src 'sha256-${digest}'; base-uri 'none'; frame-ancestors 'none'`,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/** A short key for an address (FNV-1a, two lanes): the rate-limit table never holds the address itself. */
export function addressKey(email: string): string {
  const s = email.toLowerCase().trim();
  let a = 0x811c9dc5, b = 0x050c5d1f;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 16777619);
    b = Math.imul(b ^ c, 2246822519);
  }
  return `${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
}
