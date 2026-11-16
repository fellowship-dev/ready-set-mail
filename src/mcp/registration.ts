// Open app registration (RFC 7591), the part this product adds around the OAuth library. It is off unless MCP_DCR_ENABLED=1
// (ADR 0018). Everything that makes it safe to switch on lives here, in one place:
//   - what a registration may say (name, redirect addresses, public clients only), checked BEFORE the library stores anything;
//   - how many may arrive: the per-address budget (src/mcp/rate-limit.ts), a whole-instance daily count, a ceiling on stored apps;
//   - the daily sweep that deletes an app nobody ever approved;
//   - an audit entry for each registration, refusal and deletion.
// The library still validates and stores; this module only narrows what reaches it.
import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { accessLookups, globalQueries, IMPLICIT_WORKSPACE_ID } from '@ready-set-mail/db';
import type { BoundEnv } from '../index';
import { logAudit } from '../audit/log';
import { UNNAMED_APP } from './consent';
import { tooManyRequests } from './rate-limit';

export const REGISTRATION_DEFAULTS = { dailyLimit: 200, maxClients: 1000, unusedDays: 7 } as const;
export const MAX_REDIRECT_URIS = 5;
export const MAX_NAME_LENGTH = 80;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_URI_LENGTH = 2048;
const DAY_MS = 86_400_000;
const DAILY_KEY = 'oauth-register:day';
/** One app lists this private-use address next to its https ones; the library never sends a code to it, so listing it is harmless. */
const LISTED_ONLY_REDIRECTS: readonly string[] = ['cursor://anysphere.cursor-mcp/oauth/callback'];
const isLoopbackHost = (host: string) => host === '127.0.0.1' || host === '[::1]' || host === 'localhost';
/** The key prefix of an approved connection's record (src/mcp/connections.ts). */
export const CONNECTION_PREFIX = 'mcp_connection:';
/** Sweep bounds per daily run: apps looked at, apps deleted. Deleting one scans the stored grants, so deletions are few. */
const SWEEP_MAX_PAGES = 5, SWEEP_PAGE = 100, SWEEP_MAX_DELETIONS = 50;

type RegistrationEnv = Pick<BoundEnv, 'DB' | 'OAUTH_KV' | 'MCP_DCR_DAILY_LIMIT' | 'MCP_DCR_MAX_CLIENTS' | 'MCP_DCR_UNUSED_DAYS'>;

const positive = (value: string | undefined, fallback: number) => { const n = Number(value); return Number.isInteger(n) && n >= 1 ? n : fallback; };
export function registrationLimits(env: Pick<RegistrationEnv, 'MCP_DCR_DAILY_LIMIT' | 'MCP_DCR_MAX_CLIENTS' | 'MCP_DCR_UNUSED_DAYS'>) {
  return {
    dailyLimit: positive(env.MCP_DCR_DAILY_LIMIT, REGISTRATION_DEFAULTS.dailyLimit),
    maxClients: positive(env.MCP_DCR_MAX_CLIENTS, REGISTRATION_DEFAULTS.maxClients),
    unusedDays: positive(env.MCP_DCR_UNUSED_DAYS, REGISTRATION_DEFAULTS.unusedDays),
  };
}

type Refusal = { code: 'invalid_redirect_uri' | 'invalid_client_metadata'; description: string; reason: string };

/** Whether this redirect address may be listed: https, or http on this computer (any port). */
export function redirectProblem(uri: unknown): string | null {
  if (typeof uri !== 'string' || !uri || uri.length > MAX_URI_LENGTH) return 'Each redirect address must be a text of at most 2048 characters.';
  if (LISTED_ONLY_REDIRECTS.includes(uri)) return null;
  if (uri.includes('*')) return 'A redirect address cannot contain a wildcard.';
  let url: URL;
  try { url = new URL(uri); } catch { return 'A redirect address must be a full URL.'; }
  if (url.username || url.password) return 'A redirect address cannot contain a user name or password.';
  if (uri.includes('#')) return 'A redirect address cannot contain a fragment.';
  if (url.protocol === 'https:') return url.hostname ? null : 'A redirect address needs a host name.';
  if (url.protocol === 'http:') return isLoopbackHost(url.hostname) ? null : 'A redirect address must use https, or http on localhost, 127.0.0.1 or [::1].';
  return 'A redirect address must use https, or http on localhost, 127.0.0.1 or [::1].';
}

/** An app's own name: plain text only, so what the consent page and the list show cannot carry a link or markup. */
export function nameProblem(name: string): string | null {
  if (name.length > MAX_NAME_LENGTH) return `client_name must be at most ${MAX_NAME_LENGTH} characters.`;
  if (/[\p{C}\p{Zl}\p{Zp}<>&]/u.test(name)) return 'client_name must be plain text, without control characters, < > or &.';
  if (/[a-z][a-z0-9+.-]*:\/\/|\bwww\./i.test(name)) return 'client_name must be a name, not a web address.';
  return null;
}

const GRANTS: readonly string[] = Object.freeze(['authorization_code', 'refresh_token']);
const OPTIONAL_URIS: readonly string[] = Object.freeze(['client_uri', 'logo_uri', 'policy_uri', 'tos_uri']);

/** Check a registration and return the body the library will see: only the fields it needs, public client, the two grants, one response type. */
export function vetRegistration(raw: unknown): { ok: true; body: Record<string, unknown>; name: string } | ({ ok: false } & Refusal) {
  const refuse = (code: Refusal['code'], description: string, reason: string) => ({ ok: false as const, code, description, reason });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return refuse('invalid_client_metadata', 'The request body must be a JSON object.', 'not_an_object');
  const m = raw as Record<string, unknown>;
  const uris = m.redirect_uris;
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > MAX_REDIRECT_URIS) return refuse('invalid_redirect_uri', `redirect_uris must list between 1 and ${MAX_REDIRECT_URIS} addresses.`, 'redirect_uri_count');
  for (const uri of uris) {
    const problem = redirectProblem(uri);
    if (problem) return refuse('invalid_redirect_uri', problem, 'redirect_uri_rejected');
  }
  let name = UNNAMED_APP;
  if (m.client_name !== undefined && m.client_name !== null) {
    if (typeof m.client_name !== 'string') return refuse('invalid_client_metadata', 'client_name must be text.', 'name_rejected');
    const trimmed = m.client_name.trim();
    const problem = nameProblem(trimmed);
    if (problem) return refuse('invalid_client_metadata', problem, 'name_rejected');
    if (trimmed) name = trimmed.replace(/ {2,}/g, ' ');
  }
  const method = m.token_endpoint_auth_method;
  if (method !== undefined && method !== 'none') return refuse('invalid_client_metadata', 'Only public clients can register here: set token_endpoint_auth_method to "none".', 'confidential_client');
  const grants = m.grant_types === undefined ? [...GRANTS] : m.grant_types;
  if (!Array.isArray(grants) || !grants.length || !grants.includes('authorization_code') || grants.some(g => !GRANTS.includes(g as string))) return refuse('invalid_client_metadata', 'grant_types may only be authorization_code and refresh_token, and must include authorization_code.', 'grant_types');
  const responses = m.response_types === undefined ? ['code'] : m.response_types;
  if (!Array.isArray(responses) || responses.length !== 1 || responses[0] !== 'code') return refuse('invalid_client_metadata', 'response_types may only be ["code"].', 'response_types');
  const body: Record<string, unknown> = { client_name: name, redirect_uris: uris, grant_types: grants, response_types: ['code'], token_endpoint_auth_method: 'none' };
  for (const key of OPTIONAL_URIS) {
    const value = m[key];
    if (typeof value === 'string' && value.length <= MAX_URI_LENGTH && /^https?:\/\//i.test(value)) body[key] = value;
  }
  return { ok: true, body, name };
}

const hostsOf = (uris: unknown) => [...new Set((Array.isArray(uris) ? uris : []).map(u => { try { return new URL(String(u)).origin; } catch { return 'invalid'; } }))].slice(0, MAX_REDIRECT_URIS);

/** Registered apps stored now, counted up to `limit` (key names only, so a count costs one list call per thousand). */
export async function countRegisteredClients(env: Pick<BoundEnv, 'OAUTH_KV'>, limit: number): Promise<number> {
  let count = 0, cursor: string | undefined;
  do {
    const page = await env.OAUTH_KV!.list({ prefix: 'client:', limit: Math.min(1000, limit - count + 1), cursor });
    count += page.keys.length;
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && count <= limit);
  return count;
}

function refusal(status: number, code: string, description: string, retryAfter?: number): Response {
  return Response.json({ error: code, error_description: description }, { status, headers: { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', ...(retryAfter ? { 'Retry-After': String(retryAfter) } : {}) } });
}

/** Instance-level events (no person, no workspace yet) go to the instance's own audit scope, the one the platform's other instance settings use. */
function audit(env: Pick<BoundEnv, 'DB'>, ctx: ExecutionContext | undefined, action: string, entry: { id?: string; name?: string; meta?: Record<string, unknown> }) {
  logAudit({ db: env.DB, workspaceId: IMPLICIT_WORKSPACE_ID }, { actor_type: 'system', action, resource_type: 'agent_client', resource_id: entry.id ?? null, resource_name: entry.name ?? null, meta: entry.meta ?? null }, ctx);
}

/**
 * POST /oauth/register with MCP_DCR_ENABLED=1: vet, count, then hand the narrowed body to the library. Returns the library's answer
 * (201 with the new client id) or a refusal with an RFC 7591 error body. `forward` is the OAuth provider.
 */
export async function handleRegistration(request: Request, env: RegistrationEnv, ctx: ExecutionContext | undefined, forward: (request: Request) => Promise<Response>, now = Date.now()): Promise<Response> {
  const limits = registrationLimits(env);
  const refused = (response: Response, reason: string, meta: Record<string, unknown> = {}) => { audit(env, ctx, 'agent.client_registration_refused', { meta: { reason, ...meta } }); return response; };
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return refused(refusal(413, 'invalid_client_metadata', 'The registration is too large.'), 'too_large');
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return refused(refusal(413, 'invalid_client_metadata', 'The registration is too large.'), 'too_large');
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return refused(refusal(400, 'invalid_client_metadata', 'The request body must be JSON.'), 'malformed'); }
  const vetted = vetRegistration(raw);
  if (!vetted.ok) return refused(refusal(400, vetted.code, vetted.description), vetted.reason, { redirect_hosts: hostsOf((raw as { redirect_uris?: unknown } | null)?.redirect_uris) });
  const hosts = hostsOf(vetted.body.redirect_uris);
  if (await countRegisteredClients(env, limits.maxClients) >= limits.maxClients) {
    return refused(refusal(503, 'temporarily_unavailable', 'This server has reached its limit of registered apps. Try again later, or ask the person who runs it.', 3600), 'client_cap', { name: vetted.name, redirect_hosts: hosts });
  }
  const q = globalQueries(env.DB).rateLimit;
  const counted = await q.hitUnder(DAILY_KEY, now, DAY_MS, limits.dailyLimit);
  if (!counted) {
    const row = await q.peek(DAILY_KEY, now, DAY_MS);
    const after = row ? Math.max(1, Math.ceil((row.lastRequest + DAY_MS - now) / 1000)) : 3600;
    return refused(tooManyRequests(after, 'This server has accepted as many new app registrations as it allows for today. Try again later.'), 'daily_limit', { name: vetted.name, redirect_hosts: hosts });
  }
  const response = await forward(new Request(request.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(vetted.body) }));
  if (response.status === 201) {
    const clientId = ((await response.clone().json().catch(() => null)) as { client_id?: string } | null)?.client_id;
    audit(env, ctx, 'agent.client_registered', { id: clientId, name: vetted.name, meta: { redirect_hosts: hosts } });
  } else {
    await q.giveBack(DAILY_KEY, counted.lastRequest);
    audit(env, ctx, 'agent.client_registration_refused', { name: vetted.name, meta: { reason: 'library_refused', status: response.status, redirect_hosts: hosts } });
  }
  return response;
}

export interface SweepResult { looked: number; deleted: number; truncated: boolean }

/**
 * The daily clean-up: delete a registered app that is older than MCP_DCR_UNUSED_DAYS and that no one ever approved (no connection record names it).
 * An app someone approved stays, whatever its age: its refresh tokens need it. Bounded per run; what is left waits for tomorrow.
 */
export async function sweepUnusedClients(env: RegistrationEnv, api: Pick<OAuthHelpers, 'listClients' | 'deleteClient'>, now = Math.floor(Date.now() / 1000)): Promise<SweepResult> {
  // A scheduled run has no request to wait on: collect the audit writes and wait for them before it ends.
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as ExecutionContext;
  try { return await sweep(env, api, ctx, now); } finally { await Promise.allSettled(pending); }
}

async function sweep(env: RegistrationEnv, api: Pick<OAuthHelpers, 'listClients' | 'deleteClient'>, ctx: ExecutionContext, now: number): Promise<SweepResult> {
  const cutoff = now - registrationLimits(env).unusedDays * 86400;
  const result: SweepResult = { looked: 0, deleted: 0, truncated: false };
  let cursor: string | undefined;
  for (let page = 0; page < SWEEP_MAX_PAGES; page++) {
    const listed = await api.listClients({ limit: SWEEP_PAGE, cursor });
    result.looked += listed.items.length;
    const old = listed.items.filter(c => c.registrationDate !== undefined && c.registrationDate <= cutoff);
    const used = await accessLookups(env.DB).connectedClientIds(CONNECTION_PREFIX, old.map(c => c.clientId));
    for (const client of old) {
      if (used.has(client.clientId)) continue;
      if (result.deleted >= SWEEP_MAX_DELETIONS) { result.truncated = true; return result; }
      await api.deleteClient(client.clientId);
      result.deleted++;
      audit(env, ctx, 'agent.client_expired', { id: client.clientId, name: client.clientName ?? UNNAMED_APP, meta: { registered_at: client.registrationDate, unused_days: registrationLimits(env).unusedDays } });
    }
    cursor = listed.cursor;
    if (!cursor) return result;
  }
  result.truncated = true;
  return result;
}
