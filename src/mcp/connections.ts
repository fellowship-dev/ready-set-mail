import { authorizationProblem, pageHeaders, renderApprovalLimit, renderConsentPage, renderConsentProblem, renderSignedOutPage, resumePath, UNNAMED_APP, type ConsentModel } from './consent';
import { CONNECTION_PREFIX, forgetApprovedClient, isLoopbackHost } from './registration';
import { describedName } from './client-names';
import { approvalLimitReached, LIMIT_SENTENCES, type ApprovalLimit } from './connection-limits';
import { logAudit } from '../audit/log';
import type { OAuthProviderOptions, OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { accessLookups, authLookups, forWorkspace, globalQueries, IMPLICIT_WORKSPACE_ID, workspaceLifecycle } from '@ready-set-mail/db';
import { normalizeDomainName } from '@ready-set-mail/dns-checks';
import type { BoundEnv } from '../index';
import { currentUser, passesCsrfCheck } from '../auth/session';
import { ACCESS_ACTIONS, validActions } from '../access/grant';
import { authorizeResource } from '../access/resolve';
import type { AccessSubject } from '../access/principal';
import { isSaas } from '../auth/config';
import { mcpInstallation } from './discovery';
import { cleanName } from '../auth/names';
import { agentAuthorized } from '../product-analytics/steps';

const prefix = CONNECTION_PREFIX;
/** `name` is how the app is led with (`AppIdentity.lead`): an address, never a name the app chose. `calledItself` is that name, shown as the app's own words. */
export interface AgentConnection { principalId: string; userId: string; workspaceId: string; clientId: string; name: string; calledItself?: string; /** The app used the name of a well-known app, which is not kept or shown. */ nameWithheld?: boolean; /** The host of an app whose identity is verified (a client ID metadata document); absent for a self-registered app. */ verifiedHost?: string; createdAt: number; expiresAt: number; lastUsedAt?: number }
/** What a connection can reach, read from its live grants: names, never ids. */
export interface ConnectionAccess { workspaces: string[]; domains: string[]; products: string[]; actions: string[] }
/** As listed to its owner: the workspace by name, never only its id; what it can reach; whether the app named itself (not verified). */
export type ListedConnection = AgentConnection & { revoked: boolean; workspaceName: string | null; verified: boolean; access: ConnectionAccess };

/** Who an app is, as a person is told. `lead` is what is verifiable: the publisher's host for an app with a client document, otherwise the address the app sends you back to. */
export interface AppIdentity { lead: string; host: string; local: boolean; verifiedHost?: string; calledItself: string | null; /** It gave a name that was not stored because it is a well-known one. */ nameWithheld: boolean }

/**
 * How an app is introduced and whether it is verified: one rule for the consent page, the approved-agents list and the connection record. A client ID metadata
 * document on its own HTTPS host is verified: that host is the publisher. Anything else named itself, and what it calls itself is never the lead.
 */
export function clientIdentity(client: { clientName?: string } | null, clientId: string, redirectUri: string, nameWithheld = false): AppIdentity {
 let verifiedHost: string | undefined;
 try { const url = new URL(clientId); if (url.protocol === 'https:' && url.pathname !== '/') verifiedHost = url.hostname; } catch { /* a registered app's id is not a URL */ }
 let host = '';
 try { host = new URL(redirectUri).hostname; } catch { /* the library has already refused an address that is not one */ }
 const local = isLoopbackHost(host);
 const lead = verifiedHost ?? (local ? 'An app on this computer' : host || UNNAMED_APP);
 return { lead, host: verifiedHost ?? host, local, ...(verifiedHost ? { verifiedHost } : {}), calledItself: describedName(client?.clientName), nameWithheld: nameWithheld && !client?.clientName };
}

async function accessOf(env: BoundEnv, principalId: string, names: Map<string, string | null>): Promise<ConnectionAccess> {
 const access: ConnectionAccess = { workspaces: [], domains: [], products: [], actions: [] };
 const add = (list: string[], value: string | null | undefined) => { if (value && !list.includes(value)) list.push(value); };
 for (const g of await accessLookups(env.DB).grantsForPrincipal(principalId)) {
  if (!names.has(g.workspace_id)) names.set(g.workspace_id, (await workspaceLifecycle(env.DB).get(g.workspace_id))?.name ?? null);
  add(access.workspaces, cleanName(names.get(g.workspace_id)) || 'Unnamed workspace');
  add(access.domains, g.domain);
  if (g.product_id) add(access.products, cleanName((await forWorkspace(env.DB, g.workspace_id).access.products.get(g.product_id))?.name));
  try { for (const a of JSON.parse(g.actions) as string[]) add(access.actions, a); } catch { /* a grant with unreadable actions grants nothing (resolveAccessSubject skips it) */ }
 }
 return access;
}

/** Only the authenticated user's connection metadata; never grants or workspace contents. */
export async function listAgentConnections(env: BoundEnv, userId: string) {
 const connections: ListedConnection[] = [];
 const names = new Map<string, string | null>();
 for (const p of await accessLookups(env.DB).humanPrincipalsForUser(userId)) {
  const record = await forWorkspace(env.DB, p.workspace_id).settings.get(`${prefix}${p.id}`);
  if (!record) continue;
  const connection = JSON.parse(record.value) as AgentConnection;
  const workspaceId = connection.workspaceId ?? p.workspace_id;
  if (!names.has(workspaceId)) names.set(workspaceId, (await workspaceLifecycle(env.DB).get(workspaceId))?.name ?? null);
  connections.push({ ...connection, revoked: p.disabled_at !== null, workspaceName: names.get(workspaceId) ?? null, verified: !!connection.verifiedHost, access: await accessOf(env, p.id, names) });
 }
 return connections;
}

export async function revokeAgentConnection(env: BoundEnv, userId: string, principalId: string, api: OAuthHelpers) {
 const p = await accessLookups(env.DB).principalById(principalId);
 if (!p || p.kind !== 'human' || p.user_id !== userId) return false;
 // D1 denial completes BEFORE eventually-consistent provider cleanup starts.
 await forWorkspace(env.DB, p.workspace_id).access.principals.disable(principalId, Math.floor(Date.now() / 1000));
 let cursor: string | undefined;
 do {
  const page = await api.listUserGrants(userId, { cursor });
  for (const grant of page.items) if (grant.metadata?.principalId === principalId) await api.revokeGrant(grant.id, userId);
  cursor = page.cursor;
 } while (cursor);
 return true;
}

export async function handleMcpConnections(request: Request, env: BoundEnv, ctx: ExecutionContext, options: OAuthProviderOptions<BoundEnv>): Promise<Response | null> {
 const url = new URL(request.url), path = url.pathname;
 if (path !== '/oauth/authorize' && !path.startsWith('/api/mcp/connections')) return null;
 const { getOAuthApi, AuthorizationError } = await import('@cloudflare/workers-oauth-provider');
 const api = getOAuthApi(options, env);
 const user = await currentUser(request, env, ctx);
 if (!user || (isSaas(env) && !user.emailVerified)) {
  if (request.method === 'GET' && path === '/oauth/authorize') {
   // A link that cannot work at all is said so before asking anyone to sign in.
   try { await api.parseAuthRequest(request); } catch (e) { return authorizationFailure(failureOf(e)); }
   return new Response(renderSignedOutPage(user ? 'unverified' : 'signed_out', resumePath(url)), { status: 401, headers: pageHeaders() });
  }
  return Response.json({ error: 'Sign in required' }, { status: 401 });
 }
 const memberships = await authLookups(env.DB).membershipsOf(user.id);
 const actor: AccessSubject = { principalId: user.id, kind: 'human', userId: user.id, workspaceId: memberships[0]?.workspace_id ?? '', grants: [], session: true, memberships: memberships.map(m => ({ workspaceId: m.workspace_id, role: m.role })) };
 if (request.method !== 'GET' && (!request.headers.has('origin') || !passesCsrfCheck(request, env))) return Response.json({ error: 'cross-origin request rejected' }, { status: 403 });
 if (path === '/api/mcp/connections' && request.method === 'GET') {
  return Response.json({ connections: await listAgentConnections(env, user.id) });
 }
 if (path.startsWith('/api/mcp/connections/') && request.method === 'DELETE') {
  const id = path.slice('/api/mcp/connections/'.length);
  const p = await accessLookups(env.DB).principalById(id);
  if (!p || p.user_id !== user.id) return Response.json({ error: 'not found' }, { status: 404 });
  // Cleanup is best effort; denial is durable in D1 even when KV cannot be reached.
  await forWorkspace(env.DB, p.workspace_id).access.principals.disable(id, Math.floor(Date.now() / 1000));
  if (p.disabled_at === null) logAudit({ db: env.DB, workspaceId: p.workspace_id }, { actor_id: user.id, actor_email: user.email, actor_type: 'user', action: 'agent.connection_revoked', resource_type: 'agent_connection', resource_id: id, resource_name: p.name }, ctx);
  ctx.waitUntil(revokeAgentConnection(env, user.id, id, api).catch(() => {}));
  return Response.json({ revoked: true });
 }
 if (path !== '/oauth/authorize') return Response.json({ error: 'not found' }, { status: 404 });
 try {
  if (request.method === 'GET') {
   const authRequest = await api.parseAuthRequest(request);
   if (authRequest.scope.some(s => s !== 'ready-set-mail' && s !== 'offline_access')) return authorizationFailure('invalid_scope');
   // A person who already has as many apps connected as they may (or approved as many today) is told so before the form, not after filling it in.
   const reached = await approvalLimitReached(env, user.id, []);
   if (reached) return limitPage(env, ctx, user, reached);
   const description = await api.describeConsent(authRequest), consent = await api.beginConsent(authRequest);
   const identity = clientIdentity(await api.lookupClient(authRequest.clientId), authRequest.clientId, authRequest.redirectUri, await globalQueries(env.DB).agentClients.nameWithheld(authRequest.clientId));
   const named = new Map((await workspaceLifecycle(env.DB).listForUser(user.id)).map(w => [w.id, w.name]));
   const workspaces: ConsentModel['workspaces'] = [];
   for (const m of memberships) {
    const scope = forWorkspace(env.DB, m.workspace_id);
    const products = await scope.access.products.list();
    const choices: ConsentModel['workspaces'][number]['choices'] = [];
    for (const d of await scope.domains.list()) {
     choices.push({ value: JSON.stringify({ workspaceId: m.workspace_id, domain: d.domain }), domain: d.domain });
     for (const product of products) if ((await scope.access.products.mappings(product.id)).some(map => map.domain_id === d.id)) choices.push({ value: JSON.stringify({ workspaceId: m.workspace_id, productId: product.id, domain: d.domain }), domain: d.domain, product: product.name });
    }
    workspaces.push({ id: m.workspace_id, name: cleanName(named.get(m.workspace_id)) || 'Unnamed workspace', choices });
   }
   const html = renderConsentPage({
    client: { lead: identity.lead, calledItself: identity.calledItself, nameWithheld: identity.nameWithheld, publisher: identity.verifiedHost, redirectHost: description.redirectHost, loopback: !!description.redirectIsLoopback || identity.local },
    account: user.email, handle: consent.handle, workspaces, now: Math.floor(Date.now() / 1000),
   });
   return new Response(html, { headers: pageHeaders(consent.headers) });
  }
  if (request.method === 'POST') {
   if (!(request.headers.get('content-type') ?? '').startsWith('application/x-www-form-urlencoded')) return Response.json({ error: 'form required' }, { status: 415 });
   const form = await request.formData(), actions = form.getAll('actions');
   if (form.get('decision') === 'deny') {
    // Refusing consumes the handle and sends the client error=access_denied (with its state and iss). Nothing is created.
    const denied = await api.denyConsent(request, String(form.get('handle') ?? ''), { description: 'The user did not allow access' });
    const headers = new Headers(denied.headers); headers.set('Location', denied.redirectTo); headers.set('Cache-Control', 'no-store');
    return new Response(null, { status: 302, headers });
   }
   if (!validActions(actions) || actions.includes('access:manage')) return problem('Choose at least one thing the app may do.', 400);
   const selections = form.getAll('selection').map(s => JSON.parse(String(s)) as { workspaceId: string; productId?: string; domain: string });
   if (form.get('domain') && !form.get('workspaceId')) return problem('Choose the workspace for the new domain.', 400);
   if (form.get('domain')) selections.push({ workspaceId: String(form.get('workspaceId') ?? ''), domain: String(form.get('domain')).trim().toLowerCase() });
   const days = Number(form.get('days'));
   if (!selections.length) return problem('Choose at least one domain the app may use.', 400);
   if (selections.length > 100 || !Number.isInteger(days) || days < 1 || days > 30) return problem('Choose up to 100 domains and an end date between 1 and 30 days from now.', 400);
   // Validate every tuple/action using exactly the same live policy as REST/MCP.
   for (const s of selections) {
    if (!s.domain || (n => !n.ok || n.domain !== s.domain)(normalizeDomainName(s.domain))) return problem('Enter the new domain as a plain name, like example.com, and choose its workspace.', 400);
    if (s.productId) {
     const scope = forWorkspace(env.DB, s.workspaceId);
     if (!await scope.access.products.get(s.productId)) return Response.json({ error: 'Product unavailable' }, { status: 403 });
     const existing = await scope.domains.getByName(s.domain);
     if (existing && !(await scope.access.products.mappings(s.productId)).some(m => m.domain_id === existing.id)) return Response.json({ error: 'Domain is not mapped to product' }, { status: 403 });
    }
    for (const action of actions) await authorizeResource(env.DB, actor, action, s);
   }
   const reached = await approvalLimitReached(env, user.id, [selections[0]!.workspaceId]);
   if (reached) return limitPage(env, ctx, user, reached);
   const approved = await api.approveConsent(request, String(form.get('handle') ?? ''), { scope: ['ready-set-mail'] });
   // An approved app stays whatever its age: it leaves the list of apps that expire (src/mcp/registration.ts).
   const nameWithheld = await globalQueries(env.DB).agentClients.nameWithheld(approved.request.clientId);
   await forgetApprovedClient(env, approved.request.clientId);
   const principalId = crypto.randomUUID(), workspaceId = selections[0]!.workspaceId, now = Math.floor(Date.now() / 1000), expiresAt = now + days * 86400;
   const identity = clientIdentity(await api.lookupClient(approved.request.clientId), approved.request.clientId, approved.request.redirectUri, nameWithheld);
   await forWorkspace(env.DB, workspaceId).access.principals.create({ id: principalId, name: identity.lead, kind: 'human', user_id: user.id });
   try {
    for (const s of selections) await forWorkspace(env.DB, s.workspaceId).access.grants.create({ id: crypto.randomUUID(), workspace_id: s.workspaceId, principal_id: principalId, product_id: s.productId ?? null, domain: s.domain, actions: JSON.stringify(actions), expires_at: expiresAt });
    const local = mcpInstallation(env);
    const record: AgentConnection = { principalId, userId: user.id, workspaceId, clientId: approved.request.clientId, name: identity.lead, ...(identity.calledItself ? { calledItself: identity.calledItself } : {}), ...(identity.nameWithheld ? { nameWithheld: true } : {}), ...(identity.verifiedHost ? { verifiedHost: identity.verifiedHost } : {}), createdAt: now, expiresAt };
    await forWorkspace(env.DB, workspaceId).settings.set(`${prefix}${principalId}`, JSON.stringify(record));
    const completed = await api.completeAuthorization({ request: approved.request, userId: user.id, scope: ['ready-set-mail'], props: { principalId, ...local }, metadata: { principalId }, revokeExistingGrants: false });
    logAudit({ db: env.DB, workspaceId }, { actor_id: user.id, actor_email: user.email, actor_type: 'user', action: 'agent.connection_approved', resource_type: 'agent_connection', resource_id: principalId, resource_name: identity.lead, meta: { client_id: approved.request.clientId, actions, domains: selections.length, days } }, ctx);
    agentAuthorized(env, ctx, workspaceId, { actions: actions.length, domains: selections.length, days });
    const headers = new Headers(approved.headers); headers.set('Location', completed.redirectTo); headers.set('Cache-Control', 'no-store');
    return new Response(null, { status: 302, headers });
   } catch (error) {
    await forWorkspace(env.DB, workspaceId).access.principals.disable(principalId, now);
    throw error;
   }
  }
  return Response.json({ error: 'method not allowed' }, { status: 405 });
 } catch (e) {
  // Nothing here redirects: until the app and its redirect address are both checked, an address in the link is not trusted. A person gets a page.
  if (e instanceof AuthorizationError || request.method === 'GET') return authorizationFailure(failureOf(e));
  return Response.json({ error: 'Authorization rejected' }, { status: 403 });
 }
}
/** What went wrong, for `authorizationProblem`: the library's refusal text, or the client ID when its metadata document could not be read. */
function failureOf(e: unknown): string | undefined {
 if (e instanceof Error && e.name === 'CimdFetchError') return 'client_id';
 return (e as { description?: string })?.description;
}
function authorizationFailure(description: string | undefined) { return new Response(renderConsentProblem('', authorizationProblem(description)), { status: 400, headers: pageHeaders() }); }
function problem(message: string, status: number) { return new Response(renderConsentProblem(message), { status, headers: pageHeaders() }); }
/** A limit on connected apps was reached (src/mcp/connection-limits.ts): the page says which and what to do, and the audit log counts it so the numbers can be judged. */
function limitPage(env: BoundEnv, ctx: ExecutionContext, user: { id: string; email: string }, limit: ApprovalLimit) {
 const workspaceId = IMPLICIT_WORKSPACE_ID;
 logAudit({ db: env.DB, workspaceId }, { actor_id: user.id, actor_email: user.email, actor_type: 'user', action: 'agent.approval_limit_reached', resource_type: 'agent_connection', meta: { limit } }, ctx);
 return new Response(renderApprovalLimit(LIMIT_SENTENCES[limit]), { status: 429, headers: pageHeaders() });
}
