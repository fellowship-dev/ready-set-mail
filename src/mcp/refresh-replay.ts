// Refresh token replay (OAuth 2.1 draft-ietf-oauth-v2-1 section 4.3.1, RFC 9700 section 4.14.2): a refresh token is used once. The OAuth library keeps the
// previous token valid for one more use, which is what lets a client that lost a response retry, and is also what lets a stolen copy of the old token
// work. A public client has nothing else to prove who is asking, so a token that has already been replaced and is presented again is treated as a leak:
// the request is refused and the whole connection ends (the grant, every token of it, and the approval in Settings). The person connects again.
// Detected here, before the library sees the request, from the grant record it keeps; nothing else is stored.
import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { accessLookups, forWorkspace } from '@ready-set-mail/db';
import type { BoundEnv } from '../index';
import { logAudit } from '../audit/log';

const sha256Hex = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))).map(b => b.toString(16).padStart(2, '0')).join('');

interface GrantRecord { refreshTokenId?: string; previousRefreshTokenId?: string; metadata?: { principalId?: string } }

/** A refusal for a replayed refresh token (after ending its connection), or null when the request is not a replay. */
export async function refuseRefreshReplay(request: Request, env: Pick<BoundEnv, 'DB' | 'OAUTH_KV'>, ctx: ExecutionContext, api: Pick<OAuthHelpers, 'revokeGrant'>): Promise<Response | null> {
  if (request.method !== 'POST' || !(request.headers.get('content-type') ?? '').startsWith('application/x-www-form-urlencoded')) return null;
  const form = await request.clone().formData().catch(() => null);
  const token = form?.get('grant_type') === 'refresh_token' ? form.get('refresh_token') : null;
  if (typeof token !== 'string') return null;
  const [userId, grantId, secret, ...rest] = token.split(':');
  if (!userId || !grantId || !secret || rest.length) return null;
  const grant = await env.OAUTH_KV!.get<GrantRecord>(`grant:${userId}:${grantId}`, { type: 'json' });
  if (!grant) return null;
  const hash = await sha256Hex(token);
  if (grant.previousRefreshTokenId !== hash || grant.refreshTokenId === hash) return null;
  await api.revokeGrant(grantId, userId).catch(() => {});
  const principalId = grant.metadata?.principalId;
  const principal = principalId ? await accessLookups(env.DB).principalById(principalId) : null;
  if (principal && principal.user_id === userId) {
    await forWorkspace(env.DB, principal.workspace_id).access.principals.disable(principal.id, Math.floor(Date.now() / 1000));
    logAudit({ db: env.DB, workspaceId: principal.workspace_id }, { actor_type: 'system', action: 'agent.refresh_token_replayed', resource_type: 'agent_connection', resource_id: principal.id, resource_name: principal.name }, ctx);
  }
  return Response.json({ error: 'invalid_grant', error_description: 'This refresh token was already used, so the connection has been ended. Connect again and approve it again.' }, { status: 400, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
}
