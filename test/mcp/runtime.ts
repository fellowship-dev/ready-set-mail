// A real workerd (Miniflare) installation for the agent-connection tests: the Worker with the MCP server, a migrated D1, KV, an owner who is
// signed in, and the helpers that walk the browser steps an agent's person takes (consent) and the steps the agent takes (register, token, /mcp).
import { build } from 'esbuild';
import { Miniflare, type MiniflareOptions } from 'miniflare';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const ORIGIN = 'https://ia.example.com';
export const PROOF = 'runtime-installer-proof-32-characters-minimum';
const SOURCE = `
import { coreWorker } from './src/index.ts';
import { withMcpAuthorization } from './src/auth/mcp-issuer.ts';
import { createInboxMcpHandler } from './src/mcp/transport.ts';
export default withMcpAuthorization(coreWorker, createInboxMcpHandler());`;

let bundle: Promise<string> | undefined;
const bundled = () => bundle ??= build({ stdin: { contents: SOURCE, resolveDir: process.cwd(), sourcefile: 'runtime-agents.ts', loader: 'ts' }, bundle: true, format: 'esm', platform: 'browser', conditions: ['workerd', 'worker', 'browser'], external: ['cloudflare:*', 'node:*'], write: false }).then(r => r.outputFiles[0]!.text);

export const cookieOf = (response: Response) => response.headers.getSetCookie().map(v => v.split(';')[0]).join('; ');
export const json = (data: unknown, headers: Record<string, string> = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(data) });
export const GOOD = { client_name: 'Test assistant', redirect_uris: ['https://client.example/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };

export async function pkce() {
  const verifier = 'runtime-pkce-verifier-at-least-forty-three-characters';
  return { verifier, challenge: Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url') };
}

export async function startRuntime(opts: { bindings?: Record<string, unknown>; ratelimits?: MiniflareOptions['ratelimits']; outboundService?: (request: Request) => Promise<Response> | Response; owner?: boolean } = {}) {
  const runtime = new Miniflare({
    modules: [{ type: 'ESModule', path: 'worker.mjs', contents: await bundled() }],
    compatibilityDate: '2026-05-22', compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
    kvNamespaces: ['OAUTH_KV'], d1Databases: ['DB'], bindings: { BETTER_AUTH_URL: ORIGIN, BOOTSTRAP_SECRET: PROOF, MCP_DCR_ADDRESS_DAILY_LIMIT: '1000', ...opts.bindings },
    ...(opts.ratelimits ? { ratelimits: opts.ratelimits } : {}), ...(opts.outboundService ? { outboundService: opts.outboundService } : {}),
  });
  const db = await runtime.getD1Database('DB');
  await db.prepare('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL)').run();
  for (const name of (await readdir('migrations')).filter(n => n.endsWith('.sql')).sort()) {
    for (const statement of (await readFile(resolve('migrations', name), 'utf8')).replace(/--[^\n]*/g, '').split(';').filter(s => s.trim())) await db.prepare(statement).run();
    await db.prepare('INSERT INTO d1_migrations(name) VALUES (?)').bind(name).run();
  }
  const fetch = (path: string, init?: RequestInit) => runtime.dispatchFetch(ORIGIN + path, { ...init, redirect: 'manual' });
  let cookie = '';
  if (opts.owner !== false) {
    const setup = await fetch('/api/auth/setup', { ...json({ email: 'owner@example.com', password: 'runtime-test-password' }, { 'x-ready-set-mail-bootstrap': PROOF }) });
    if (setup.status !== 201) throw new Error('owner setup failed: ' + setup.status + await setup.text());
    cookie = cookieOf(setup as unknown as Response);
    await db.prepare("INSERT INTO domains(workspace_id,domain,rua_address) VALUES ('ws_default','agents.example.com','rua@reports.example.com')").run();
  }
  const authorizeQuery = (clientId: string, extra: Record<string, string> = {}, challenge = 'A'.repeat(43), redirect = 'https://client.example/callback') =>
    new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, scope: 'ready-set-mail', resource: ORIGIN + '/mcp', state: 'opaque-state', code_challenge: challenge, code_challenge_method: 'S256', ...extra });
  const register = (data: unknown = GOOD, headers: Record<string, string> = {}) => fetch('/oauth/register', json(data, headers));
  const registerOk = async (data: unknown = GOOD, headers: Record<string, string> = {}) => {
    const r = await register(data, headers);
    if (r.status !== 201) throw new Error('registration refused: ' + r.status + await r.text());
    return (await r.json() as { client_id: string }).client_id;
  };
  /** Browser steps: open the consent page, allow. Returns the redirect the client receives. */
  async function approve(clientId: string, o: { redirect?: string; challenge?: string; days?: string; actions?: string[] } = {}) {
    const query = authorizeQuery(clientId, {}, o.challenge, o.redirect);
    const page = await fetch('/oauth/authorize?' + query, { headers: { cookie } });
    const html = await page.text();
    if (page.status !== 200) throw new Error('consent page ' + page.status + html.slice(0, 300));
    const handle = html.match(/name="handle" value="([^"]+)"/)![1]!;
    const form = new URLSearchParams({ handle, decision: 'allow', selection: JSON.stringify({ workspaceId: 'ws_default', domain: 'agents.example.com' }), days: o.days ?? '7' });
    for (const a of o.actions ?? ['resources:read', 'reports:read']) form.append('actions', a);
    const posted = await fetch('/oauth/authorize', { method: 'POST', headers: { cookie: cookie + '; ' + cookieOf(page as unknown as Response), origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() });
    if (posted.status !== 302) throw new Error('consent POST ' + posted.status + await posted.text());
    return new URL(posted.headers.get('location')!);
  }
  /** The whole connection: consent, then the token exchange the agent makes. */
  async function connect(clientId: string, o: { redirect?: string; days?: string; actions?: string[] } = {}) {
    const { verifier, challenge } = await pkce();
    const back = await approve(clientId, { ...o, challenge });
    const redirectUri = o.redirect ?? 'https://client.example/callback';
    const token = await fetch('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code: back.searchParams.get('code')!, code_verifier: verifier, redirect_uri: redirectUri, resource: ORIGIN + '/mcp' }).toString() });
    if (token.status !== 200) throw new Error('token ' + token.status + await token.text());
    return await token.json() as { access_token: string; refresh_token: string };
  }
  const mcp = (token: string | null, body: unknown = { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers: Record<string, string> = {}) => fetch('/mcp', { method: 'POST', headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25', ...headers }, body: JSON.stringify(body) });
  const connections = async () => (await (await fetch('/api/mcp/connections', { headers: { cookie } })).json() as { connections: any[] }).connections;
  const audit = async (like = 'agent.%') => (await db.prepare('SELECT action, resource_id, resource_name, meta, actor_type, workspace_id FROM audit_log WHERE action LIKE ? ORDER BY id').bind(like).all()).results as Array<{ action: string; resource_id: string | null; resource_name: string | null; meta: string | null; actor_type: string; workspace_id: string }>;
  return { runtime, db, kv: await runtime.getKVNamespace('OAUTH_KV'), fetch, cookie, authorizeQuery, register, registerOk, approve, connect, mcp, connections, audit, dispose: () => runtime.dispose() };
}
export type Installation = Awaited<ReturnType<typeof startRuntime>>;
