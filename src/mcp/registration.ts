// Open app registration (RFC 7591), the part this product adds around the OAuth library. It is off unless MCP_DCR_ENABLED=1
// (ADR 0015); the hosted service turns it on. Everything that makes it safe to switch on lives here, in one place:
//   - what a registration may say (name, redirect addresses, public clients only), checked BEFORE the library stores anything;
//   - how many may arrive: a per-address budget per minute (src/mcp/rate-limit.ts), a per-address budget per day, a whole-instance budget per day
//     that one address cannot use up, and a ceiling on stored apps that evicts the oldest unapproved app instead of refusing;
//   - how long an app nobody approved is kept (hours, not days): a registry of unapproved apps (globalQueries.agentClients), emptied by an
//     opportunistic clean-up on every registration and by the daily job, both scanning by age, so the store cannot fill and stay full;
//   - an audit entry for each registration, refusal and deletion.
// The library still validates and stores; this module only narrows what reaches it.
import { accessLookups, globalQueries, IMPLICIT_WORKSPACE_ID } from '@ready-set-mail/db';
import type { BoundEnv } from '../index';
import { logAudit } from '../audit/log';
import { UNNAMED_APP } from './consent';
import { vetClientName, MAX_NAME_LENGTH } from './client-names';
import { addressKey, tooManyRequests } from './rate-limit';

/**
 * Limits, with their basis:
 * - addressDailyLimit 20 a day: a person registers an assistant once per install, so one address (an office, a home, a shared network exit)
 *   rarely needs more than a handful; 20 leaves room for a team behind one address and is far below the instance budget.
 * - dailyLimit 2,000 a day, whole instance: 100 addresses at their own limit. It is a backstop against many addresses at once, sized so
 *   that no single address can use more than 1% of it. Unapproved apps live 24 hours, so at most about this many wait at any time.
 * - maxClients 5,000 stored apps (waiting and approved): about 5 MB of KV records. At it, the oldest waiting app is evicted to make room.
 * - unusedHours 24: long enough to sign in and approve the same or the next day; an app nobody approved by then is gone.
 */
export const REGISTRATION_DEFAULTS = { dailyLimit: 2000, addressDailyLimit: 20, maxClients: 5000, unusedHours: 24 } as const;
/** Opportunistic clean-up on each registration: how many expired apps to delete first. */
const CLEANUP_PER_REGISTRATION = 10;
/** The daily job: apps deleted per run (each is one KV delete, and a Worker invocation has a subrequest budget), and the time it may take. */
const SWEEP_BATCH = 100, SWEEP_MAX_DELETIONS = 800, SWEEP_BUDGET_MS = 25_000;
export const MAX_REDIRECT_URIS = 5;
export { MAX_NAME_LENGTH };
const MAX_BODY_BYTES = 16 * 1024;
const MAX_URI_LENGTH = 2048;
const DAY_MS = 86_400_000;
const DAILY_KEY = 'oauth-register:day';
const ADDRESS_DAILY_PREFIX = 'oauth-register:day:';
const HOUR_MS = 3_600_000;
/** One app lists this private-use address next to its https ones; the library never sends a code to it, so listing it is harmless. */
const LISTED_ONLY_REDIRECTS: readonly string[] = ['cursor://anysphere.cursor-mcp/oauth/callback'];
export const isLoopbackHost = (host: string) => host === '127.0.0.1' || host === '[::1]' || host === 'localhost';
/** The key prefix of an approved connection's record (src/mcp/connections.ts). */
export const CONNECTION_PREFIX = 'mcp_connection:';
type RegistrationEnv = Pick<BoundEnv, 'DB' | 'OAUTH_KV' | 'MCP_DCR_DAILY_LIMIT' | 'MCP_DCR_ADDRESS_DAILY_LIMIT' | 'MCP_DCR_MAX_CLIENTS' | 'MCP_DCR_UNUSED_HOURS'>;

const positive = (value: string | undefined, fallback: number) => { const n = Number(value); return Number.isInteger(n) && n >= 1 ? n : fallback; };
export function registrationLimits(env: Pick<RegistrationEnv, 'MCP_DCR_DAILY_LIMIT' | 'MCP_DCR_ADDRESS_DAILY_LIMIT' | 'MCP_DCR_MAX_CLIENTS' | 'MCP_DCR_UNUSED_HOURS'>) {
  return {
    dailyLimit: positive(env.MCP_DCR_DAILY_LIMIT, REGISTRATION_DEFAULTS.dailyLimit),
    addressDailyLimit: positive(env.MCP_DCR_ADDRESS_DAILY_LIMIT, REGISTRATION_DEFAULTS.addressDailyLimit),
    maxClients: positive(env.MCP_DCR_MAX_CLIENTS, REGISTRATION_DEFAULTS.maxClients),
    unusedHours: positive(env.MCP_DCR_UNUSED_HOURS, REGISTRATION_DEFAULTS.unusedHours),
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
  if (url.username || url.password || /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(uri)) return 'A redirect address cannot contain a user name or password.';
  if (uri.includes('#')) return 'A redirect address cannot contain a fragment.';
  if (url.protocol === 'https:') return url.hostname ? null : 'A redirect address needs a host name.';
  if (url.protocol === 'http:') return isLoopbackHost(url.hostname) ? null : 'A redirect address must use https, or http on localhost, 127.0.0.1 or [::1].';
  return 'A redirect address must use https, or http on localhost, 127.0.0.1 or [::1].';
}

const GRANTS: readonly string[] = Object.freeze(['authorization_code', 'refresh_token']);
const OPTIONAL_URIS: readonly string[] = Object.freeze(['client_uri', 'logo_uri', 'policy_uri', 'tos_uri']);

/** Check a registration and return the body the library will see: only the fields it needs, public client, the two grants, one response type. */
export function vetRegistration(raw: unknown): { ok: true; body: Record<string, unknown>; name: string; withheld?: 'reserved' } | ({ ok: false } & Refusal) {
  const refuse = (code: Refusal['code'], description: string, reason: string) => ({ ok: false as const, code, description, reason });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return refuse('invalid_client_metadata', 'The request body must be a JSON object.', 'not_an_object');
  const m = raw as Record<string, unknown>;
  const uris = m.redirect_uris;
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > MAX_REDIRECT_URIS) return refuse('invalid_redirect_uri', `redirect_uris must list between 1 and ${MAX_REDIRECT_URIS} addresses.`, 'redirect_uri_count');
  for (const uri of uris) {
    const problem = redirectProblem(uri);
    if (problem) return refuse('invalid_redirect_uri', problem, 'redirect_uri_rejected');
  }
  let name: string | null = null, withheld: 'reserved' | undefined;
  if (m.client_name !== undefined && m.client_name !== null) {
    if (typeof m.client_name !== 'string') return refuse('invalid_client_metadata', 'client_name must be text.', 'name_rejected');
    const verdict = vetClientName(m.client_name);
    if (!verdict.ok) return refuse('invalid_client_metadata', verdict.reason, 'name_rejected');
    name = verdict.name;
    withheld = verdict.withheld;
  }
  const method = m.token_endpoint_auth_method;
  if (method !== undefined && method !== 'none') return refuse('invalid_client_metadata', 'Only public clients can register here: set token_endpoint_auth_method to "none".', 'confidential_client');
  const grants = m.grant_types === undefined ? [...GRANTS] : m.grant_types;
  if (!Array.isArray(grants) || !grants.length || !grants.includes('authorization_code') || grants.some(g => !GRANTS.includes(g as string))) return refuse('invalid_client_metadata', 'grant_types may only be authorization_code and refresh_token, and must include authorization_code.', 'grant_types');
  const responses = m.response_types === undefined ? ['code'] : m.response_types;
  if (!Array.isArray(responses) || responses.length !== 1 || responses[0] !== 'code') return refuse('invalid_client_metadata', 'response_types may only be ["code"].', 'response_types');
  // A withheld or empty name is not sent on: the app is shown by its address (src/mcp/connections.ts, clientIdentity).
  const body: Record<string, unknown> = { ...(name ? { client_name: name } : {}), redirect_uris: uris, grant_types: grants, response_types: ['code'], token_endpoint_auth_method: 'none' };
  for (const key of OPTIONAL_URIS) {
    const value = m[key];
    if (typeof value === 'string' && value.length <= MAX_URI_LENGTH && /^https?:\/\//i.test(value)) body[key] = value;
  }
  return { ok: true, body, name: name ?? UNNAMED_APP, ...(withheld ? { withheld } : {}) };
}

const hostsOf = (uris: unknown) => [...new Set((Array.isArray(uris) ? uris : []).map(u => { try { return new URL(String(u)).origin; } catch { return 'invalid'; } }))].slice(0, MAX_REDIRECT_URIS);

function refusal(status: number, code: string, description: string, retryAfter?: number): Response {
  return Response.json({ error: code, error_description: description }, { status, headers: { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', ...(retryAfter ? { 'Retry-After': String(retryAfter) } : {}) } });
}

/** Instance-level events (no person, no workspace yet) go to the instance's own audit scope, the one the platform's other instance settings use. */
function audit(env: Pick<BoundEnv, 'DB'>, ctx: ExecutionContext | undefined, action: string, entry: { id?: string; name?: string; meta?: Record<string, unknown> }) {
  logAudit({ db: env.DB, workspaceId: IMPLICIT_WORKSPACE_ID }, { actor_type: 'system', action, resource_type: 'agent_client', resource_id: entry.id ?? null, resource_name: entry.name ?? null, meta: entry.meta ?? null }, ctx);
}

/**
 * Delete up to `max` apps that registered more than `unusedHours` ago and that nobody approved. A registry row is removed when an app is approved
 * (`forgetApprovedClient`), so every row is an unapproved app; the connection records are still asked, so a row that outlived an approval is healed
 * rather than deleted with a live app. The app's record is deleted straight from storage: an app that was never approved has no grants to revoke.
 */
export async function expireUnapprovedClients(env: Pick<RegistrationEnv, 'DB' | 'OAUTH_KV' | 'MCP_DCR_UNUSED_HOURS' | 'MCP_DCR_DAILY_LIMIT' | 'MCP_DCR_ADDRESS_DAILY_LIMIT' | 'MCP_DCR_MAX_CLIENTS'>, ctx: ExecutionContext | undefined, max: number, now = Date.now(), why: 'expired' | 'evicted' = 'expired'): Promise<number> {
  const q = globalQueries(env.DB).agentClients;
  const cutoff = why === 'expired' ? now - registrationLimits(env).unusedHours * HOUR_MS : undefined;
  const due = await q.oldest(max, cutoff);
  if (!due.length) return 0;
  const used = await accessLookups(env.DB).connectedClientIds(CONNECTION_PREFIX, due.map(d => d.clientId));
  const gone: string[] = [], healed: string[] = [];
  for (const app of due) {
    if (used.has(app.clientId)) { healed.push(app.clientId); continue; }
    await env.OAUTH_KV!.delete(`client:${app.clientId}`);
    gone.push(app.clientId);
    audit(env, ctx, why === 'expired' ? 'agent.client_expired' : 'agent.client_evicted', { id: app.clientId, meta: { registered_at: Math.floor(app.registeredAt / 1000), unused_hours: registrationLimits(env).unusedHours } });
  }
  await q.remove([...gone, ...healed]);
  return gone.length;
}

/** An app was approved: it stays, whatever its age (its refresh tokens need it), so it is no longer a candidate for expiry. */
export const forgetApprovedClient = (env: Pick<BoundEnv, 'DB'>, clientId: string) => globalQueries(env.DB).agentClients.remove([clientId]);

/**
 * POST /oauth/register with MCP_DCR_ENABLED=1: vet, clean up a little, count, then hand the narrowed body to the library. Returns the library's answer
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
  const meta = { name: vetted.name, redirect_hosts: hosts, ...(vetted.withheld ? { name_withheld: vetted.withheld } : {}) };
  const agents = globalQueries(env.DB).agentClients;
  // Clean up first, a few at a time, so the store drains at least as fast as it fills (the daily job takes the rest).
  await expireUnapprovedClients(env, ctx, CLEANUP_PER_REGISTRATION, now).catch(() => 0);
  const q = globalQueries(env.DB).rateLimit;
  // This address's day first: a refused address spends nothing of the instance's budget, so one address cannot use the others' up.
  const address = `${ADDRESS_DAILY_PREFIX}${addressKey(request)}`;
  const mine = await q.hitUnder(address, now, DAY_MS, limits.addressDailyLimit);
  if (!mine) {
    const row = await q.peek(address, now, DAY_MS);
    return refused(tooManyRequests(row ? Math.max(1, Math.ceil((row.lastRequest + DAY_MS - now) / 1000)) : 3600, 'This address has registered as many apps as it may today. Try again tomorrow.'), 'address_daily_limit', meta);
  }
  const counted = await q.hitUnder(DAILY_KEY, now, DAY_MS, limits.dailyLimit);
  if (!counted) {
    await q.giveBack(address, mine.lastRequest);
    const row = await q.peek(DAILY_KEY, now, DAY_MS);
    return refused(tooManyRequests(row ? Math.max(1, Math.ceil((row.lastRequest + DAY_MS - now) / 1000)) : 3600, 'This server has accepted as many new app registrations as it allows for today. Try again later.'), 'daily_limit', meta);
  }
  const giveBack = () => Promise.all([q.giveBack(DAILY_KEY, counted.lastRequest), q.giveBack(address, mine.lastRequest)]);
  // The ceiling counts every stored app. At it, the oldest app nobody approved makes room; only when every stored app is approved is the registration refused.
  const stored = await agents.count() + await accessLookups(env.DB).connectedClientCount(CONNECTION_PREFIX);
  if (stored >= limits.maxClients && await expireUnapprovedClients(env, ctx, Math.min(CLEANUP_PER_REGISTRATION, stored - limits.maxClients + 1), now, 'evicted') === 0) {
    await giveBack();
    return refused(refusal(503, 'temporarily_unavailable', 'This server has reached its limit of registered apps, and every one of them is in use. Try again later, or ask the person who runs it.', 3600), 'client_cap', meta);
  }
  const response = await forward(new Request(request.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(vetted.body) }));
  if (response.status === 201) {
    const clientId = ((await response.clone().json().catch(() => null)) as { client_id?: string } | null)?.client_id;
    if (clientId) await agents.add(clientId, now, !!vetted.withheld);
    audit(env, ctx, 'agent.client_registered', { id: clientId, name: vetted.name, meta: { redirect_hosts: hosts, ...(vetted.withheld ? { name_withheld: vetted.withheld } : {}) } });
  } else {
    await giveBack();
    audit(env, ctx, 'agent.client_registration_refused', { name: vetted.name, meta: { reason: 'library_refused', status: response.status, redirect_hosts: hosts } });
  }
  return response;
}

export interface SweepResult { deleted: number; truncated: boolean; remaining: number }

/**
 * The daily clean-up: delete every app that registered more than MCP_DCR_UNUSED_HOURS ago and that nobody approved, oldest first, in batches until none are
 * left, the run has deleted as many as one invocation's subrequest budget allows, or its time is up. An approved app stays, whatever its age.
 */
export async function sweepUnusedClients(env: RegistrationEnv, now = Date.now(), clock: () => number = Date.now): Promise<SweepResult> {
  // A scheduled run has no request to wait on: collect the audit writes and wait for them before it ends.
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as ExecutionContext;
  const started = clock();
  let deleted = 0, truncated = false;
  try {
    for (;;) {
      if (deleted >= SWEEP_MAX_DELETIONS || clock() - started > SWEEP_BUDGET_MS) { truncated = true; break; }
      const n = await expireUnapprovedClients(env, ctx, Math.min(SWEEP_BATCH, SWEEP_MAX_DELETIONS - deleted), now);
      deleted += n;
      if (n === 0) break;
    }
    const cutoff = now - registrationLimits(env).unusedHours * HOUR_MS;
    const remaining = truncated ? (await globalQueries(env.DB).agentClients.oldest(1, cutoff)).length : 0;
    return { deleted, truncated: truncated && remaining > 0, remaining };
  } finally { await Promise.allSettled(pending); }
}
