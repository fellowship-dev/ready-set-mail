// Refresh tokens: used once, with a short grace window (ADR 0022). The one place that decides what a refresh token that is presented a second time means.
//
// A refresh token is used once; presenting one that was already replaced ends the connection (OAuth 2.1 draft-ietf-oauth-v2-1 section 4.3.1: on presentation of
// an invalidated refresh token the server revokes the active refresh token and the grant; RFC 9700 section 4.14.2, the same rule). A public client has nothing
// else to prove who is asking, so this is what makes a stolen token useless. But a client is not one request at a time: two tool calls that both find the access
// token expired both refresh with the same token (sub-second apart), and a response can be lost on the way back, which leaves the client holding only an
// invalidated token (draft section 4.3.3). Ending the connection for either would make the person approve again for nothing.
//
// So the first use of a token is remembered, with the answer it got, for REFRESH_GRACE_MS (30 seconds). Inside that window the SAME token presented again
// gets the SAME answer, not a second rotation. Outside it, or for any older token (two or more rotations back), it ends the connection as before.
// 30 seconds is the default of Okta's "Grace period for token rotation" (range 0-60 s, https://developer.okta.com/docs/guides/refresh-tokens/main/) and the
// same idea as Auth0's "Rotation Overlap Period" (`leeway`, seconds; only the previous token may be reused in it, an older one is breach detection,
// https://auth0.com/docs/secure/tokens/refresh-tokens/configure-refresh-token-rotation). It covers parallel calls and one retry after a lost response,
// and a stolen copy is useful for at most 30 seconds and only to receive the tokens the real client already holds.
//
// Atomic on D1 (KV is not): the first request to insert a row keyed by the token's hash wins the rotation (`refresh_rotations`, migration 0021); the library
// rotates; the answer is stored encrypted under a key derived from the presented token itself, so the row is useless without it. Requests that lose the
// insert wait briefly for that answer. If the winner fails, its claim is dropped and the others get a retryable error: a failure is never taken for a leak.
import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { accessLookups, forWorkspace, globalQueries } from '@ready-set-mail/db';
import type { BoundEnv } from '../index';
import { logAudit } from '../audit/log';

/** How long after its first use a refresh token may be presented again and get the same answer. */
export const REFRESH_GRACE_MS = 30_000;
/** A refresh token lives this long (the provider's `refreshTokenTTL`); a row of `refresh_rotations` is kept as long. */
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 86400;
/** A request that lost the claim looks for the winner's answer this often, for this long. */
const WAIT_STEP_MS = 100, WAIT_MAX_MS = 5_000;
/** A claim not finished after this long was abandoned (the request that held it died) and may be taken over. */
const CLAIM_STALE_MS = 10_000;

const sha256Hex = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))).map(b => b.toString(16).padStart(2, '0')).join('');
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string) => Uint8Array.from(atob(text), c => c.charCodeAt(0));

/** AES-GCM key derived (HKDF-SHA-256) from the refresh token itself: whoever holds the token can read the answer, nobody else. */
async function answerKey(token: string, tokenHash: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(token), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('ready-set-mail refresh grace v1'), info: new TextEncoder().encode(tokenHash) }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function seal(token: string, tokenHash: string, answer: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(tokenHash) }, await answerKey(token, tokenHash), new TextEncoder().encode(answer)));
  return `${b64(iv)}.${b64(cipher)}`;
}
async function unseal(token: string, tokenHash: string, sealed: string): Promise<string | null> {
  const [iv, cipher] = sealed.split('.');
  if (!iv || !cipher) return null;
  try { return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: new TextEncoder().encode(tokenHash) }, await answerKey(token, tokenHash), unb64(cipher))); } catch { return null; }
}

interface GrantRecord { refreshTokenId?: string; previousRefreshTokenId?: string; metadata?: { principalId?: string } }

const NO_CACHE = Object.freeze({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
const tokenJson = (body: string) => new Response(body, { status: 200, headers: { 'Content-Type': 'application/json', ...NO_CACHE } });
/** The winner failed, or is slow: the client may ask again. Never a sign of a leak. */
const tryAgain = () => Response.json({ error: 'temporarily_unavailable', error_description: 'The refresh could not be completed. Try again.' }, { status: 503, headers: { ...NO_CACHE, 'Retry-After': '1' } });

export interface RefreshOptions { now?: () => number; sleep?: (ms: number) => Promise<void> }

/**
 * Handle a refresh_token request to /oauth/token. Returns the answer, or null when the request is not a refresh of a known grant (the library answers it).
 * `forward` is the OAuth provider: it does the rotation for the one request that wins the claim.
 */
export async function handleRefreshToken(request: Request, env: Pick<BoundEnv, 'DB' | 'OAUTH_KV'>, ctx: ExecutionContext, api: Pick<OAuthHelpers, 'revokeGrant'>, forward: (request: Request) => Promise<Response>, options: RefreshOptions = {}): Promise<Response | null> {
  if (request.method !== 'POST' || !(request.headers.get('content-type') ?? '').startsWith('application/x-www-form-urlencoded')) return null;
  const form = await request.clone().formData().catch(() => null);
  const token = form?.get('grant_type') === 'refresh_token' ? form.get('refresh_token') : null;
  if (typeof token !== 'string') return null;
  const [userId, grantId, secret, ...rest] = token.split(':');
  if (!userId || !grantId || !secret || rest.length) return null;
  const grantKey = `grant:${userId}:${grantId}`;
  const grant = await env.OAUTH_KV!.get<GrantRecord>(grantKey, { type: 'json' });
  if (!grant) return null;
  const hash = await sha256Hex(token);
  const clock = options.now ?? Date.now, sleep = options.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const rotations = globalQueries(env.DB).refreshRotations;
  const isCurrent = grant.refreshTokenId === hash, isPrevious = grant.previousRefreshTokenId === hash;

  if (isCurrent) {
    if (await rotations.claim(hash, grantKey, clock())) return rotate();
    // A row exists for the current token: another request is rotating it right now, or one that started it never finished.
    if (await rotations.takeOver(hash, clock(), clock() - CLAIM_STALE_MS)) return rotate();
    return answerFromRow();
  }
  const row = await rotations.get(hash);
  // Not the current token, and never used here: the library answers (invalid_grant), unless the grant says it was replaced before rotations were recorded.
  if (!row) return isPrevious ? endConnection() : null;
  // Used before. Only the previous token, inside the window, gets the answer again; anything older is a leak.
  return isPrevious ? answerFromRow() : endConnection();

  async function rotate(): Promise<Response> {
    let response: Response;
    try { response = await forward(request); } catch (e) { await rotations.release(hash).catch(() => {}); throw e; }
    if (response.status !== 200) { await rotations.release(hash).catch(() => {}); return response; }
    try { await rotations.finish(hash, await seal(token as string, hash, await response.clone().text())); } catch { /* the client holds its tokens; the row stays pending, so a repeat gets 'try again' until the window ends */ }
    return response;
  }

  async function answerFromRow(): Promise<Response> {
    for (let waited = 0; ; waited += WAIT_STEP_MS) {
      const stored = await rotations.get(hash);
      if (!stored) return tryAgain();
      const age = clock() - stored.first_used_at;
      if (age > REFRESH_GRACE_MS) return endConnection();
      if (stored.state === 'done' && stored.response) {
        const text = await unseal(token as string, hash, stored.response);
        if (!text) return endConnection();
        // The access token keeps its original end time: say how long it has left, not how long it had.
        const body = JSON.parse(text) as { expires_in?: number };
        if (typeof body.expires_in === 'number') body.expires_in = Math.max(1, body.expires_in - Math.floor(age / 1000));
        return tokenJson(JSON.stringify(body));
      }
      if (waited >= WAIT_MAX_MS) return tryAgain();
      await sleep(WAIT_STEP_MS);
    }
  }

  /** A token that was replaced, used again after the window or from further back: end the grant, every token of it and the approval in Settings. */
  async function endConnection(): Promise<Response> {
    await api.revokeGrant(grantId!, userId!).catch(() => {});
    const principalId = grant!.metadata?.principalId;
    const principal = principalId ? await accessLookups(env.DB).principalById(principalId) : null;
    if (principal && principal.user_id === userId) {
      await forWorkspace(env.DB, principal.workspace_id).access.principals.disable(principal.id, Math.floor(Date.now() / 1000));
      logAudit({ db: env.DB, workspaceId: principal.workspace_id }, { actor_type: 'system', action: 'agent.refresh_token_replayed', resource_type: 'agent_connection', resource_id: principal.id, resource_name: principal.name }, ctx);
    }
    return Response.json({ error: 'invalid_grant', error_description: 'This refresh token was already used, so the connection has been ended. Connect again and approve it again.' }, { status: 400, headers: NO_CACHE });
  }
}

/** The daily clean-up: delete the rows of tokens first used longer ago than a refresh token lives (such a token cannot be presented any more). Bounded; returns how many went. */
export async function purgeOldRotations(env: Pick<BoundEnv, 'DB'>, now = Date.now()): Promise<number> {
  const cutoff = now - REFRESH_TOKEN_TTL_SECONDS * 1000, q = globalQueries(env.DB).refreshRotations;
  let total = 0;
  for (let i = 0; i < PURGE_BATCHES; i++) {
    const n = await q.purgeBefore(cutoff, PURGE_BATCH);
    total += n;
    if (n < PURGE_BATCH) break;
  }
  return total;
}
const PURGE_BATCH = 500, PURGE_BATCHES = 10;
