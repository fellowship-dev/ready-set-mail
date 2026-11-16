// What an agent and its person meet, end to end in workerd: discovery, the 401 challenge, registration (vetted), consent, the token, /mcp, the list
// of approved agents, last use, revoke. ADR 0022. The real clients differ from these only in who sends the requests.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GOOD, ORIGIN, startRuntime, type Installation } from './runtime';

let app: Installation;
beforeAll(async () => { app = await startRuntime({ bindings: { MCP_DCR_ENABLED: '1' } }); }, 60000);
afterAll(async () => { await app?.dispose(); });

describe('discovery', () => {
 it('serves the protected-resource document at the root and the path-inserted address, the same', async () => {
  const [root, inserted] = await Promise.all(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'].map(p => app.fetch(p)));
  expect(root!.status).toBe(200); expect(inserted!.status).toBe(200);
  const doc = await root!.json() as Record<string, unknown>;
  expect(doc).toEqual(await inserted!.json());
  expect(doc).toMatchObject({ resource: ORIGIN + '/mcp', authorization_servers: [ORIGIN], bearer_methods_supported: ['header'], scopes_supported: ['ready-set-mail'], resource_name: 'Ready Set Mail' });
 });
 it('answers HEAD and OPTIONS at the root, and refuses other methods', async () => {
  expect((await app.fetch('/.well-known/oauth-protected-resource', { method: 'HEAD' })).status).toBe(200);
  expect((await app.fetch('/.well-known/oauth-protected-resource', { method: 'OPTIONS', headers: { origin: 'https://claude.ai', 'access-control-request-method': 'GET' } })).status).toBe(204);
  expect((await app.fetch('/.well-known/oauth-protected-resource', { method: 'POST' })).status).toBe(405);
 });
 it('does not serve a document for another resource', async () => {
  expect((await app.fetch('/.well-known/oauth-protected-resource/other')).status).toBe(404);
 });
 it('publishes the authorization server complete: registration, S256, public clients, client ID metadata documents', async () => {
  const meta = await (await app.fetch('/.well-known/oauth-authorization-server')).json() as Record<string, any>;
  expect(meta).toMatchObject({ issuer: ORIGIN, authorization_endpoint: ORIGIN + '/oauth/authorize', token_endpoint: ORIGIN + '/oauth/token', registration_endpoint: ORIGIN + '/oauth/register', code_challenge_methods_supported: ['S256'], client_id_metadata_document_supported: true });
  expect(meta.token_endpoint_auth_methods_supported).toContain('none');
  expect(meta.grant_types_supported).toEqual(expect.arrayContaining(['authorization_code', 'refresh_token']));
 });
});

describe('the 401 challenge', () => {
 const challenge = (r: Response) => r.headers.get('www-authenticate') ?? '';
 const want = `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`;
 it('names the metadata address when no token is presented', async () => {
  const r = await app.mcp(null);
  expect(r.status).toBe(401);
  expect(challenge(r)).toContain(want);
 });
 it('names it, with error="invalid_token", when the token is unknown', async () => {
  const r = await app.mcp('not-a-real-token');
  expect(r.status).toBe(401);
  expect(challenge(r)).toContain(want); expect(challenge(r)).toContain('error="invalid_token"');
 });
 it('names it when the connection was revoked after the token was issued (the apiHandler path)', async () => {
  const clientId = await app.registerOk({ ...GOOD, client_name: 'Challenge client' });
  const tokens = await app.connect(clientId);
  expect((await app.mcp(tokens.access_token)).status).toBe(200);
  const record = (await app.connections()).find(c => c.calledItself === 'Challenge client')!;
  await app.db.prepare('UPDATE access_principals SET disabled_at = 1 WHERE id = ?').bind(record.principalId).run();
  const r = await app.mcp(tokens.access_token);
  expect(r.status).toBe(401);
  expect(challenge(r)).toContain(want); expect(challenge(r)).toContain('error="invalid_token"');
  expect(await r.json()).toEqual({ error: 'invalid_token' });
 });
});

describe('registration is vetted before the library stores anything', () => {
 const refused = async (data: unknown, error: string, matches?: RegExp) => {
  const r = await app.register(data);
  const body = await r.json() as { error: string; error_description: string };
  expect(r.status, JSON.stringify(body)).toBe(400);
  expect(body.error).toBe(error);
  if (matches) expect(body.error_description).toMatch(matches);
 };
 const accepted = (uris: string[]) => app.register({ ...GOOD, redirect_uris: uris });
 it('accepts https and loopback http on any port (Claude, ChatGPT, Cursor, VS Code, Claude Code)', async () => {
  for (const uris of [
   ['https://claude.ai/api/mcp/auth_callback'], ['https://chatgpt.com/connector_platform_oauth_redirect'], ['https://chatgpt.com/connector/oauth/abc123'],
   ['https://www.cursor.com/agents/mcp/oauth/callback', 'http://localhost:8787/callback'], ['http://127.0.0.1:33418', 'https://vscode.dev/redirect'],
   ['http://localhost:51234/callback'], ['http://[::1]:8080/callback'],
   ['https://www.cursor.com/agents/mcp/oauth/callback', 'cursor://anysphere.cursor-mcp/oauth/callback'],
  ]) { const r = await accepted(uris); expect(r.status, uris.join() + await r.clone().text()).toBe(201); }
 });
 it('refuses addresses a code must never be sent to', async () => {
  for (const uri of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'http://example.com/cb', 'http://localhost.evil.com/cb', 'https://*.example.com/cb', 'https://client.example/cb#frag', 'https://user:pw@client.example/cb', 'custom-app://callback', 'ftp://client.example/cb', 'not a url', '', 'cursor://other.app/oauth/callback']) {
   await refused({ ...GOOD, redirect_uris: [uri] }, 'invalid_redirect_uri');
  }
 });
 it('wants one to five redirect addresses', async () => {
  await refused({ ...GOOD, redirect_uris: [] }, 'invalid_redirect_uri', /between 1 and 5/);
  await refused({ ...GOOD, redirect_uris: undefined }, 'invalid_redirect_uri');
  await refused({ ...GOOD, redirect_uris: 'https://client.example/cb' }, 'invalid_redirect_uri');
  await refused({ ...GOOD, redirect_uris: Array.from({ length: 6 }, (_, i) => `https://client.example/cb${i}`) }, 'invalid_redirect_uri', /between 1 and 5/);
  expect((await accepted(Array.from({ length: 5 }, (_, i) => `https://client.example/cb${i}`))).status).toBe(201);
 });
 it('refuses a name that is markup, a web address, too long, mixed-alphabet or claims to be verified, and stores a missing or famous one as none', async () => {
  for (const name of ['<img src=x onerror=alert(1)>', 'a & b', 'https://evil.example/login', 'visit www.evil.example', 'x'.repeat(81), 'two\nlines', 'bidi \u202Eevil', 42, '\u0421laude', 'Claude (official) \u2713 Verified by Anthropic', 'Verified assistant', 'Trusted \u2705']) {
   await refused({ ...GOOD, client_name: name }, 'invalid_client_metadata');
  }
  // A missing or blank name is stored as none; a name that is, or contains, a famous one is accepted but withheld (ADR 0022); any other is kept, tidied.
  for (const [given, stored] of [[undefined, undefined], ['   ', undefined], ['  Claude   Code  ', undefined], ['Cursor (laptop)', undefined], ['Claude', undefined], ['  My   agent ', 'My agent']] as const) {
   const r = await app.register({ ...GOOD, client_name: given });
   expect(r.status).toBe(201);
   expect((await r.json() as { client_name?: string }).client_name).toBe(stored);
  }
 });
 it('takes public clients only, with the two grants and the code response', async () => {
  await refused({ ...GOOD, token_endpoint_auth_method: 'client_secret_basic' }, 'invalid_client_metadata', /public/);
  await refused({ ...GOOD, grant_types: ['authorization_code', 'client_credentials'] }, 'invalid_client_metadata');
  await refused({ ...GOOD, grant_types: ['refresh_token'] }, 'invalid_client_metadata');
  await refused({ ...GOOD, response_types: ['token'] }, 'invalid_client_metadata');
  await refused([GOOD], 'invalid_client_metadata');
  const r = await app.register({ client_name: 'Bare', redirect_uris: ['https://client.example/cb'] });
  expect(r.status).toBe(201);
  expect(await r.json()).toMatchObject({ token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
 });
 it('refuses a body that is not JSON or is too large', async () => {
  const bad = await app.fetch('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
  expect(bad.status).toBe(400); expect((await bad.json() as { error: string }).error).toBe('invalid_client_metadata');
  const big = await app.fetch('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...GOOD, client_name: 'a'.repeat(20000) }) });
  expect(big.status).toBe(413);
 });
 it('drops what it does not need: no secret is issued, no contacts or key sets are stored', async () => {
  const r = await app.register({ ...GOOD, contacts: ['a@b.example'], jwks_uri: 'https://client.example/jwks', client_uri: 'https://client.example', scope: 'everything' });
  const body = await r.json() as Record<string, unknown>;
  expect(r.status).toBe(201);
  expect(body.client_secret).toBeUndefined(); expect(body.contacts).toBeUndefined(); expect(body.jwks_uri).toBeUndefined();
 });
});

describe('a connection, from registration to revoke', () => {
 it('lists the app by its name, what it can reach and when it was last used; revoke ends it', async () => {
  const clientId = await app.registerOk({ ...GOOD, client_name: 'Flow assistant' });
  const tokens = await app.connect(clientId, { actions: ['resources:read', 'reports:read', 'diagnostics:run'] });
  const list = await app.mcp(tokens.access_token);
  expect(list.status, await list.clone().text()).toBe(200);
  const tools = new Set([...(await list.text()).matchAll(/"name":"([a-z_]+)"/g)].map(m => m[1]));
  expect(tools.size).toBe(10);
  const who = await app.mcp(tokens.access_token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'whoami', arguments: {} } });
  expect(who.status, await who.clone().text()).toBe(200);
  const waited = async () => { for (let i = 0; i < 20; i++) { const c = (await app.connections()).find(x => x.calledItself === 'Flow assistant'); if (c?.lastUsedAt) return c; await new Promise(r => setTimeout(r, 100)); } };
  const c = await waited();
  expect(c).toMatchObject({ name: 'client.example', calledItself: 'Flow assistant', verified: false, revoked: false, workspaceName: 'Default', access: { workspaces: ['Default'], domains: ['agents.example.com'], products: [], actions: ['resources:read', 'reports:read', 'diagnostics:run'] } });
  expect(c.lastUsedAt).toBeGreaterThan(c.createdAt - 1);
  expect(c.expiresAt - c.createdAt).toBe(7 * 86400);
  // revoke: through the browser's own endpoint, with its origin
  const revoked = await app.fetch('/api/mcp/connections/' + c.principalId, { method: 'DELETE', headers: { cookie: app.cookie, origin: ORIGIN } });
  expect(revoked.status).toBe(200);
  const after = await app.mcp(tokens.access_token);
  expect(after.status).toBe(401);
  expect(after.headers.get('www-authenticate')).toContain('resource_metadata=');
  expect((await app.connections()).find(x => x.principalId === c.principalId)).toMatchObject({ revoked: true });
 }, 30000);
 it('writes last use at most once every five minutes', async () => {
  const clientId = await app.registerOk({ ...GOOD, client_name: 'Busy agent' });
  const tokens = await app.connect(clientId);
  for (let i = 0; i < 4; i++) { await (await app.mcp(tokens.access_token)).text(); await new Promise(r => setTimeout(r, 150)); }
  const find = async () => (await app.connections()).find(x => x.calledItself === 'Busy agent')!;
  const first = await find();
  expect(first.lastUsedAt).toBeTruthy();
  const key = 'mcp_connection:' + first.principalId;
  const stored = JSON.parse(((await app.db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first()) as { value: string }).value);
  // Written once, then left alone for the window: pretend the write was 4 minutes ago and call again.
  await app.db.prepare('UPDATE settings SET value = ? WHERE key = ?').bind(JSON.stringify({ ...stored, lastUsedAt: stored.lastUsedAt - 240 }), key).run();
  await (await app.mcp(tokens.access_token)).text(); await new Promise(r => setTimeout(r, 300));
  expect((await find()).lastUsedAt).toBe(stored.lastUsedAt - 240);
  await app.db.prepare('UPDATE settings SET value = ? WHERE key = ?').bind(JSON.stringify({ ...stored, lastUsedAt: stored.lastUsedAt - 400 }), key).run();
  await (await app.mcp(tokens.access_token)).text();
  for (let i = 0; i < 20 && (await find()).lastUsedAt === stored.lastUsedAt - 400; i++) await new Promise(r => setTimeout(r, 100));
  expect((await find()).lastUsedAt).toBeGreaterThanOrEqual(stored.lastUsedAt);
 }, 30000);
});
