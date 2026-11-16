import type { OAuthProviderOptions } from '@cloudflare/workers-oauth-provider';
import { accessLookups, globalQueries, forWorkspace } from '@ready-set-mail/db';
import type { BoundEnv } from '../index';
import type { AccessSubject } from '../access/principal';
import { resolveAccessSubject } from '../access/resolve';
import { isSaas } from './config';
import { resolveApiKey } from './api-keys';
import { invalidTokenResponse, mcpInstallation, mcpResourceMetadataUrl, PROTECTED_RESOURCE_ROOT_PATH } from '../mcp/discovery';
import { CONNECTION_PREFIX, handleRegistration, sweepUnusedClients } from '../mcp/registration';
import { handleMcpConnections } from '../mcp/connections';
import { refuseClientDocumentRedirects } from '../mcp/client-document-fetch';
import { sweepEndedConnections } from '../mcp/connection-limits';
import { handleRefreshToken, purgeOldRotations, REFRESH_TOKEN_TTL_SECONDS } from '../mcp/refresh-replay';
import { limitAnonymousAgentRequest, limitBrowserRequest, limitMcpRequest } from '../mcp/rate-limit';

// The OAuth library fetches client documents with the default (follow redirects); the draft forbids it (src/mcp/client-document-fetch.ts).
refuseClientDocumentRedirects();

export interface McpIdentity { principalId: string; issuer: string; resource: string; credentialId?: string }
export type McpHandler = { fetch(request: Request, env: BoundEnv, ctx: ExecutionContext & { props: McpIdentity }): Promise<Response> | Response };
export type DefaultHandler = { fetch(request: Request, env: BoundEnv, ctx: ExecutionContext): Promise<Response> | Response };

/** A connection's last-used time is written at most this often: an agent can make hundreds of requests a minute. */
export const AGENT_USE_WRITE_SECONDS = 300;

/** Informational timestamp only; grants and revocation stay authoritative in their own rows. */
export async function recordAgentUse(env: BoundEnv, subject: AccessSubject, now = Math.floor(Date.now() / 1000)): Promise<void> {
 if (subject.kind !== 'human') return;
 const settings = forWorkspace(env.DB, subject.workspaceId).settings;
 const key = `${CONNECTION_PREFIX}${subject.principalId}`;
 const row = await settings.get(key);
 if (!row) return;
 const connection = JSON.parse(row.value);
 if (connection.principalId !== subject.principalId || connection.userId !== subject.userId) return;
 if (typeof connection.lastUsedAt === 'number' && now - connection.lastUsedAt < AGENT_USE_WRITE_SECONDS) return;
 await settings.set(key, JSON.stringify({ ...connection, lastUsedAt: now }));
}

/** Re-resolve the current D1 identity and finite grant set on every request AND every refresh. */
export async function resolveMcpIdentity(env: BoundEnv, props: unknown): Promise<AccessSubject | null> {
 if (!props || typeof props !== 'object') return null;
 const p = props as McpIdentity, local = mcpInstallation(env);
 if (p.issuer !== local.issuer || p.resource !== local.resource || typeof p.principalId !== 'string') return null;
 const subject = await resolveAccessSubject(env.DB, p.principalId);
 if (!subject) return null;
 if (subject.kind === 'human') {
  const user = subject.userId && await globalQueries(env.DB).users.byId(subject.userId);
  if (!user || (isSaas(env) && !user.email_verified)) return null;
 }
 const now = Math.floor(Date.now() / 1000);
 if (p.credentialId) {
  const key = await accessLookups(env.DB).credentialById(p.credentialId);
  if (!key || key.principal_id !== p.principalId || key.revoked_at !== null || key.expires_at <= now) return null;
  subject.credentialId = p.credentialId;
 }
 const live = subject.grants.filter(g => g.revokedAt === null && g.expiresAt > now && (subject.kind !== 'human' || subject.memberships?.some(m => m.workspaceId === g.workspaceId)));
 if (!live.length) return null;
 return { ...subject, grants: live };
}

/** The provider's options: one place for what this installation tells agents and accepts from them. Protected handler is injected to avoid a Worker/server import cycle. */
async function mcpProviderOptions(env: BoundEnv, origin: string, handler: McpHandler, fallback: DefaultHandler) {
 const { OAuthError } = await import('@cloudflare/workers-oauth-provider');
 const local = mcpInstallation(env, origin);
 if (!env.OAUTH_KV) throw new Error('Configure instance-owned OAUTH_KV');
 const dcrEnabled = env.MCP_DCR_ENABLED === '1';
 const options: OAuthProviderOptions<BoundEnv> = {
  apiRoute: '/mcp',
  apiHandler: { async fetch(request, env, ctx) {
   const props = ctx.props as McpIdentity;
   const subject = await resolveMcpIdentity(env, props);
   if (!subject) return invalidTokenResponse(env);
   // Limited per connection and per workspace, never per IP: agent clients share cloud egress addresses.
   const limited = await limitMcpRequest(env, subject);
   if (limited) return limited;
   ctx.waitUntil(recordAgentUse(env, subject).catch(() => {}));
   return handler.fetch(request, env, ctx as ExecutionContext & { props: McpIdentity });
  } },
  defaultHandler: { async fetch(request, env, ctx) {
   return await handleMcpConnections(request, env, ctx, options) ?? fallback.fetch(request, env, ctx);
  } },
  authorizeEndpoint: `${local.issuer}/oauth/authorize`,
  tokenEndpoint: `${local.issuer}/oauth/token`,
  ...(dcrEnabled ? { clientRegistrationEndpoint: `${local.issuer}/oauth/register` } : {}),
  clientIdMetadataDocumentEnabled: true,
  resourceMetadata: { resource: local.resource, authorization_servers: [local.issuer], resource_name: 'Ready Set Mail' },
  scopesSupported: ['ready-set-mail'], requiredScopes: ['ready-set-mail'],
  accessTokenTTL: 900, refreshTokenTTL: REFRESH_TOKEN_TTL_SECONDS,
  async resolveExternalToken({ token, env }) {
   const key = await resolveApiKey(env.DB, token);
   if (!key) return null;
   const props: McpIdentity = { principalId: key.access.principalId, credentialId: key.keyId, ...local };
   return await resolveMcpIdentity(env, props) ? { props, audience: local.resource } : null;
  },
  async tokenExchangeCallback({ props, env, resource }) {
   if (resource !== local.resource || !(await resolveMcpIdentity(env, props))) throw new OAuthError('invalid_grant', { description: 'Connection revoked or expired' });
  },
 };
 return options;
}

/** Combined Workers OAuth provider. */
export async function createMcpProvider(env: BoundEnv, origin: string, handler: McpHandler, fallback: DefaultHandler) {
 const { OAuthProvider } = await import('@cloudflare/workers-oauth-provider');
 return new OAuthProvider(await mcpProviderOptions(env, origin, handler, fallback));
}

/**
 * Daily: delete the registered apps nobody approved in time (src/mcp/registration.ts), the connections that ended more than a week ago with the apps only they
 * used (src/mcp/connection-limits.ts), and the refresh tokens' grace rows that cannot matter any more (src/mcp/refresh-replay.ts). Nothing to do without agent storage.
 * Each part runs on its own: one failing does not stop the others, and the first error is thrown at the end so the cron logs it.
 */
export async function sweepAgentClients(env: BoundEnv) {
 if (!env.OAUTH_KV) return null;
 try { mcpInstallation(env); } catch { return null; }
 const failures: unknown[] = [];
 const run = async <T>(job: () => Promise<T>) => { try { return await job(); } catch (e) { failures.push(e); return null; } };
 const unapproved = await run(() => sweepUnusedClients(env));
 const ended = await run(() => sweepEndedConnections(env));
 const rotations = await run(() => purgeOldRotations(env));
 if (failures.length) throw failures[0];
 return { ...unapproved!, ended: ended!, rotationsPurged: rotations! };
}

/** Route only protocol/connection endpoints through OAuth; other Worker behavior remains intact. */
export function isMcpOAuthPath(path: string): boolean {
 return path === '/mcp' || path.startsWith('/mcp/') || path.startsWith('/oauth/') || path.startsWith('/.well-known/oauth-') || path === '/api/mcp/connections' || path.startsWith('/api/mcp/connections/');
}

export function withMcpAuthorization<T extends DefaultHandler>(worker: T, handler: McpHandler): T {
 return { ...worker, async fetch(request: Request, env: BoundEnv, ctx: ExecutionContext) {
  const path = new URL(request.url).pathname;
  if (!isMcpOAuthPath(path)) return worker.fetch(request, env, ctx);
  // Browser pages (consent, the connection list, revoke) keep the dashboard's per-IP budget; /mcp is limited per connection.
  if (path === '/oauth/authorize' || path.startsWith('/api/mcp/connections')) {
   const limited = await limitBrowserRequest(env, request);
   if (limited) return limited;
  }
  // Per-IP budgets, one per route (src/mcp/rate-limit.ts). A request that presents a token is not limited per IP:
  // a bad or expired token must get its 401, so the client refreshes.
  const agentPath = path === '/mcp' || path.startsWith('/mcp/');
  const route = path === '/oauth/token' ? 'token' : path === '/oauth/register' ? 'register' : agentPath && !request.headers.has('authorization') ? 'mcp' : null;
  if (route) {
   const limited = await limitAnonymousAgentRequest(env, request, route);
   if (limited) return limited;
  }
  try {
   const provider = await createMcpProvider(env, new URL(request.url).origin, handler, worker);
   // RFC 9728: a client that does not read the 401 challenge tries the root address. It gets the same document as the /mcp one.
   if (path === PROTECTED_RESOURCE_ROOT_PATH) request = new Request(mcpResourceMetadataUrl(env), request);
   // A refresh token is used once, with a short grace window; one used again after it, or an older one, ends the connection (src/mcp/refresh-replay.ts).
   if (path === '/oauth/token' && env.OAUTH_KV) {
    const { getOAuthApi } = await import('@cloudflare/workers-oauth-provider');
    const refreshed = await handleRefreshToken(request, env, ctx, getOAuthApi(await mcpProviderOptions(env, new URL(request.url).origin, handler, worker), env), forwarded => provider.fetch(forwarded, env, ctx));
    if (refreshed) return refreshed;
   }
   // Open registration (MCP_DCR_ENABLED=1) is vetted, counted and audited before the library stores anything.
   if (path === '/oauth/register' && request.method === 'POST' && env.MCP_DCR_ENABLED === '1') return await handleRegistration(request, env, ctx, forwarded => provider.fetch(forwarded, env, ctx));
   return await provider.fetch(request, env, ctx);
  }
  catch { return Response.json({ error: 'Agent authorization unavailable' }, { status: 503 }); }
 } };
}
