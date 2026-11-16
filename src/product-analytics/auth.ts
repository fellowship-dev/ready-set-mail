// Sign-up, code and sign-in steps (src/auth/routes.ts calls these, one line each; docs/analytics.md, "Sign-up and onboarding").
//
// A sign-up has no workspace until its code is right, so the attempt itself carries the analytics id: a small tag (`$.an`) in the
// pending attempt's row of the verifications table (src/auth/codes.ts), set for every attempt alike (decoys too, so the sign-up's
// constant work is unchanged) and gone with the attempt. "Send a new code" from the same browser carries the tag over, so resends
// and the time from the first code to the right one can be counted. When the code is right, the new workspace adopts the tag's id.
// Where the sign-up came from: the website's sign-up link carries `src=<page class>` (and the checker's `domain=` carry-over); the
// dashboard sends `src` and `from_checker` with the sign-up form, read from that link and kept in memory only. Only the closed list is
// kept (anything else is `other`, none is `cold`), and `from_checker` only as a boolean: never the domain.
import { authLookups } from '@ready-set-mail/db';
import { identifierFor } from '../auth/codes';
import { analyticsEnabled, capture, captureLater, captureMany, ev, type AnalyticsEnv, type Captured } from './capture';
import { SOURCES, codeWait, resendsBucket, shortWait, triesBucket, type Entry, type SignupMethod } from './events';
import { adoptAnalyticsId, analyticsIdFor, mintedId } from './identity';

type Ctx = Pick<ExecutionContext, 'waitUntil'> | undefined;
const nowS = () => Math.floor(Date.now() / 1000);

/** What a sign-up attempt carries for analytics: its id (minted here), codes sent so far, when the first was sent, where the person came from. */
export interface SignupTag { id: string; sends: number; at: number; entry: Entry; fromChecker: boolean }
interface StoredTag { i: string; s: number; a: number; e: string; c: 0 | 1 }

/** The website's `src` as an entry: one of the closed list, `other` for anything else, `cold` when there is none. */
export function entryOf(src: unknown): Entry {
  if (src === undefined || src === null || src === '') return 'cold';
  return typeof src === 'string' && (SOURCES as readonly string[]).includes(src) ? (src as Entry) : 'other';
}

function parseTag(raw: unknown): SignupTag | null {
  if (typeof raw !== 'string') return null;
  try {
    const t = JSON.parse(raw) as Partial<StoredTag>;
    const id = mintedId(t.i);
    if (!id || typeof t.s !== 'number' || typeof t.a !== 'number') return null;
    const entry = t.e === 'cold' ? 'cold' : entryOf(t.e);
    return { id, sends: Math.max(1, Math.floor(t.s)), at: t.a, entry, fromChecker: t.c === 1 };
  } catch {
    return null;
  }
}

/** The tag of the live attempt behind a handle and its tries so far. Null when analytics is off or there is no attempt. */
export async function attemptTag(env: AnalyticsEnv, handle: string | null): Promise<{ tag: SignupTag | null; tries: number } | null> {
  if (!handle || !env.DB || !analyticsEnabled(env)) return null;
  try {
    const row = await env.DB.prepare("SELECT json_extract(value, '$.an') AS an, json_extract(value, '$.t') AS t FROM verifications WHERE identifier = ?1 AND expires_at >= ?2")
      .bind(await identifierFor(handle), nowS()).first<{ an: string | null; t: number | null }>();
    return row ? { tag: parseTag(row.an), tries: typeof row.t === 'number' ? row.t : 0 } : null;
  } catch {
    return null;
  }
}

/**
 * POST /api/auth/signup: the tag for the attempt about to start. Carried over from this browser's live attempt (a new code asked for),
 * else new, with a fresh random id minted here. Null when analytics is off.
 */
export async function signupTag(env: AnalyticsEnv, previousHandle: string | null, body: { src?: unknown; from_checker?: unknown }): Promise<SignupTag | null> {
  if (!analyticsEnabled(env)) return null;
  const prior = (await attemptTag(env, previousHandle))?.tag;
  if (prior) return { ...prior, sends: prior.sends + 1 };
  return { id: crypto.randomUUID(), sends: 1, at: nowS(), entry: entryOf(body?.src), fromChecker: body?.from_checker === true };
}

/** The hooks answerWithCode runs for a sign-up attempt: store the tag on the new attempt, then count what was answered. */
export function signupHooks(env: AnalyticsEnv, ctx: Ctx, tag: SignupTag | null): { started(handle: string): Promise<void>; answered(mailed: boolean): void } | undefined {
  if (!tag) return undefined;
  return {
    async started(handle) {
      try {
        const stored: StoredTag = { i: tag.id, s: tag.sends, a: tag.at, e: tag.entry, c: tag.fromChecker ? 1 : 0 };
        await env.DB?.prepare("UPDATE verifications SET value = json_set(value, '$.an', json(?2)) WHERE identifier = ?1").bind(await identifierFor(handle), JSON.stringify(stored)).run();
      } catch { /* the attempt works without it */ }
    },
    answered(mailed) {
      const events: Captured[] = [];
      if (tag.sends === 1) events.push(ev('Signup Started', { method: 'email_code', entry: tag.entry, from_checker: tag.fromChecker }));
      if (mailed) events.push(ev('Signup Code Sent', { send: tag.sends === 1 ? 'first' : 'resend' }));
      captureMany(env, ctx, { analyticsId: tag.id }, events);
    },
  };
}

/** The workspace a person acts in first (their oldest membership), or null. */
async function firstWorkspace(db: D1Database, userId: string): Promise<string | null> {
  return (await authLookups(db).membershipsOf(userId))[0]?.workspace_id ?? null;
}

/**
 * POST /api/auth/code, sign-up or invite done. A new sign-up's workspace adopts the attempt's id first (awaited: the dashboard's
 * first request must find it), then the code and the new workspace are counted after the response.
 */
export async function codeVerified(
  env: AnalyticsEnv, ctx: Ctx,
  p: { userId: string; purpose: 'signup' | 'invite' | 'signin' | 'reset' | 'confirm'; tagged: { tag: SignupTag | null; tries: number } | null; created: boolean; joinedWorkspaceId?: string },
): Promise<void> {
  if (!env.DB || !analyticsEnabled(env) || (p.purpose !== 'signup' && p.purpose !== 'invite')) return;
  try {
    const workspaceId = p.purpose === 'invite' ? p.joinedWorkspaceId ?? null : await firstWorkspace(env.DB, p.userId);
    if (!workspaceId) return;
    const tag = p.tagged?.tag ?? null;
    const analyticsId = await adoptAnalyticsId(env.DB, workspaceId, p.purpose === 'signup' ? tag?.id ?? null : null);
    const events: Captured[] = [ev('Code Verified', {
      purpose: p.purpose, account_created: p.created, attempts: triesBucket((p.tagged?.tries ?? 0) + 1),
      ...(tag ? { entry: tag.entry, from_checker: tag.fromChecker, resends: resendsBucket(tag.sends - 1), wait: codeWait(nowS() - tag.at) } : {}),
    })];
    if (p.purpose === 'signup' && p.created) events.push(ev('Workspace Created', { source: 'signup', method: 'email_code' }));
    captureMany(env, ctx, { analyticsId }, events);
  } catch { /* never affects sign-up */ }
}

/** An invite accepted by its code (the workspace the person joined). */
export function inviteAccepted(env: AnalyticsEnv, ctx: Ctx, invite: { workspace_id: string; role: string; created_at: number }): void {
  capture(env, ctx, { workspaceId: invite.workspace_id }, 'Invite Accepted', { role: invite.role === 'admin' ? 'admin' : 'member', wait: shortWait(nowS() - invite.created_at) });
}

/** A sign-in completed. */
export function signedIn(env: AnalyticsEnv, ctx: Ctx, userId: string, method: 'code' | 'password' | 'oauth_google' | 'oauth_github'): void {
  const db = env.DB;
  if (!db) return;
  captureLater(env, ctx, async () => {
    const workspaceId = await firstWorkspace(db, userId);
    return workspaceId ? { subject: { workspaceId }, events: [ev('Signed In', { method })] } : null;
  });
}

/** `google` / `github` from a Better Auth OAuth callback path (`/api/auth/callback/<provider>`), else null. */
export function oauthMethodOf(request: Request): Extract<SignupMethod, 'oauth_google' | 'oauth_github'> | null {
  try {
    const m = /\/api\/auth\/callback\/(google|github)$/.exec(new URL(request.url).pathname);
    return m ? (m[1] === 'google' ? 'oauth_google' : 'oauth_github') : null;
  } catch {
    return null;
  }
}

/**
 * An account created by a Google or GitHub sign-up (src/auth/index.ts, after its workspace is provisioned): Signup Started and
 * Workspace Created, in that order, under the new workspace's random id. Only a new owner's own workspace counts (an invitee joins
 * someone else's). `entry` is not known on this path (the provider's redirect carries no `src`), so it is left out.
 */
export function oauthSignedUp(env: AnalyticsEnv, ctx: Ctx, method: 'oauth_google' | 'oauth_github', placed: { workspaceId: string; role: string } | null | undefined): void {
  const db = env.DB;
  if (!db || !placed?.workspaceId || placed.role !== 'owner') return;
  captureLater(env, ctx, async () => ({
    subject: { analyticsId: await analyticsIdFor(db, placed.workspaceId) },
    events: [ev('Signup Started', { method }), ev('Workspace Created', { source: 'signup', method })],
  }));
}

// ── Waiting on the new sign-up screens (draft PR 177, `onboarding-signup-first-run`; docs/analytics.md) ──
// These are defined and tested here; the routes they belong to exist only on that branch. When it merges, wire them with one line each:
//  - POST /api/auth/signup/profile, after saveAttemptProfile succeeds:  signupProfileSaved(env, ctx, handle, checked.profile);
//  - POST /api/auth/signup/resend, as the answerWithCode option:        { notice: 'signup', analytics: signupHooks(env, ctx, await signupTag(env, handle, {})) }
//  - the S4 setup choice, at the server call it makes (or a POST the screen adds): setupPathChosen(env, ctx, workspaceId, path, dnsProvider)

/** S2 "about you" saved on the pending attempt: only the closed answers, and whether the free-text "heard about" was filled. */
export async function signupProfileSaved(env: AnalyticsEnv, ctx: Ctx, handle: string | null, profile: { whose_email: string; role?: string; heard_about?: string }): Promise<void> {
  const tag = (await attemptTag(env, handle))?.tag;
  if (!tag) return;
  capture(env, ctx, { analyticsId: tag.id }, 'Signup Profile Saved', {
    whose_email: profile.whose_email as 'company' | 'clients' | 'looking',
    role: (profile.role ?? 'none') as 'founder' | 'developer' | 'it' | 'marketing' | 'agency' | 'other' | 'none',
    heard_about_given: !!profile.heard_about?.trim(),
  });
}

/** S4: the setup path the person chose (the allow-list drops anything outside the listed paths and DNS hosts). */
export function setupPathChosen(env: AnalyticsEnv, ctx: Ctx, workspaceId: string, path: 'cloudflare' | 'records' | 'dns_manager' | 'teammate', dnsProvider?: string): void {
  capture(env, ctx, { workspaceId }, 'Setup Path Chosen', { path, ...(dnsProvider ? { dns_provider: dnsProvider as 'unknown' } : {}) });
}
