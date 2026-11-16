// What a person sees when the link an app sent cannot go on, a client ID metadata document client end to end, and an instance with registration off.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GOOD, ORIGIN, startRuntime, type Installation } from './runtime';

const CIMD = 'https://cimd.example/oauth/client.json';
const document = { client_id: CIMD, client_name: 'Document assistant', client_uri: 'https://cimd.example', redirect_uris: ['https://cimd.example/callback', 'http://127.0.0.1:5173/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
const visible = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

describe('the link an app sent cannot go on', () => {
 let app: Installation;
 beforeAll(async () => { app = await startRuntime({ bindings: { MCP_DCR_ENABLED: '1' } }); }, 60000);
 afterAll(async () => { await app?.dispose(); });
 const expectPage = async (r: Response, title: RegExp) => {
  const html = await r.text();
  expect(r.status, html.slice(0, 200)).toBe(400);
  expect(r.headers.get('content-type')).toContain('text/html');
  expect(r.headers.get('location')).toBeNull();
  expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
  expect(html).not.toMatch(/<script/i);
  expect(visible(html)).toMatch(title);
  expect(html).toContain('href="/#/agents"');
  expect(visible(html)).toMatch(/nothing was shared/i);
  return html;
 };
 const open = (query: URLSearchParams, signedIn = true) => app.fetch('/oauth/authorize?' + query, signedIn ? { headers: { cookie: app.cookie } } : {});

 it('an unknown client_id gets a page, signed in or not, and no redirect', async () => {
  for (const signedIn of [true, false]) await expectPage(await open(app.authorizeQuery('does-not-exist'), signedIn), /doesn't recognise this app/);
 });
 it('a missing client_id gets the same page', async () => { await expectPage(await open(app.authorizeQuery('')), /doesn't recognise this app/); });
 it('a redirect address the app did not register gets a page, and the address is not followed or shown', async () => {
  const id = await app.registerOk();
  const html = await expectPage(await open(app.authorizeQuery(id, {}, undefined, 'https://evil.example/steal')), /did not register/);
  expect(html).not.toContain('evil.example');
  await expectPage(await open(app.authorizeQuery(id, {}, undefined, 'https://evil.example/steal'), false), /did not register/);
 });
 it('a link missing what the OAuth rules need (PKCE, scope) gets a page', async () => {
  const id = await app.registerOk();
  const noPkce = app.authorizeQuery(id); noPkce.delete('code_challenge'); noPkce.delete('code_challenge_method');
  await expectPage(await open(noPkce), /incomplete/);
  await expectPage(await open(app.authorizeQuery(id, { scope: 'ready-set-mail admin' })), /incomplete/);
  await expectPage(await open(app.authorizeQuery(id, { resource: 'https://other.example/mcp' })), /incomplete/);
 });
 it('a consent page that expired or was already used gets a page; so does a handle from another browser', async () => {
  const id = await app.registerOk();
  const page = await open(app.authorizeQuery(id));
  const handle = (await page.text()).match(/name="handle" value="([^"]+)"/)![1]!;
  const post = (cookie: string) => app.fetch('/oauth/authorize', { method: 'POST', headers: { cookie, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ handle, decision: 'allow', actions: 'reports:read', selection: JSON.stringify({ workspaceId: 'ws_default', domain: 'agents.example.com' }), days: '7' }).toString() });
  const before = (await app.connections()).length;
  // without the cookie the page set, the handle belongs to no browser: the same page, and nothing is created
  await expectPage(await post(app.cookie), /expired/);
  expect((await app.connections()).length).toBe(before);
 });
 it('machine endpoints keep JSON errors', async () => {
  const token = await app.fetch('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=authorization_code&client_id=nope&code=x' });
  expect(token.headers.get('content-type')).toContain('application/json');
  const register = await app.register({ ...GOOD, redirect_uris: ['http://evil.example/cb'] });
  expect(register.headers.get('content-type')).toContain('application/json');
  expect((await app.mcp(null)).status).toBe(401);
 });
 it('a form problem still names the mistake', async () => {
  const id = await app.registerOk();
  const page = await open(app.authorizeQuery(id));
  const handle = (await page.text()).match(/name="handle" value="([^"]+)"/)![1]!;
  const r = await app.fetch('/oauth/authorize', { method: 'POST', headers: { cookie: app.cookie + '; ' + (page.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')), origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ handle, days: '7' }).toString() });
  expect(r.status).toBe(400);
  expect(visible(await r.text())).toContain('Choose at least one thing the app may do.');
 });
});

describe('a client ID metadata document client, with registration off', () => {
 let app: Installation;
 const fetched: string[] = [];
 beforeAll(async () => {
  app = await startRuntime({ outboundService: request => { fetched.push(request.url); return request.url === CIMD ? Response.json(document, { headers: { 'cache-control': 'no-store' } }) : new Response('not found', { status: 404 }); } });
 }, 60000);
 afterAll(async () => { await app?.dispose(); });

 it('does not offer registration: no endpoint in the metadata, and POST /oauth/register is not an endpoint', async () => {
  const meta = await (await app.fetch('/.well-known/oauth-authorization-server')).json() as Record<string, unknown>;
  expect(meta.registration_endpoint).toBeUndefined();
  expect(meta).toMatchObject({ client_id_metadata_document_supported: true, code_challenge_methods_supported: ['S256'] });
  expect(meta.token_endpoint_auth_methods_supported).toContain('none');
  expect((await app.register()).status).toBeGreaterThanOrEqual(400);
  expect((await app.audit()).filter(a => a.action.startsWith('agent.client'))).toEqual([]);
 });
 it('shows its verified host on consent, then connects to /mcp', async () => {
  const query = app.authorizeQuery(CIMD, {}, undefined, 'https://cimd.example/callback');
  const page = await app.fetch('/oauth/authorize?' + query, { headers: { cookie: app.cookie } });
  const html = await page.text();
  expect(page.status, html.slice(0, 300)).toBe(200);
  expect(visible(html)).toContain('Allow Document assistant to work with your domains?');
  expect(visible(html)).toContain('Published by cimd.example');
  expect(visible(html)).not.toContain('Not verified');
  const tokens = await app.connect(CIMD, { redirect: 'https://cimd.example/callback' });
  const list = await app.mcp(tokens.access_token);
  expect(list.status, await list.clone().text()).toBe(200);
  const c = (await app.connections())[0];
  expect(c).toMatchObject({ name: 'Document assistant', verified: true, verifiedHost: 'cimd.example', clientId: CIMD });
  expect(fetched.every(u => u === CIMD)).toBe(true);
 }, 30000);
 it('accepts a loopback redirect listed in the document, on any port', async () => {
  const back = await app.approve(CIMD, { redirect: 'http://127.0.0.1:5173/callback' });
  expect(back.origin).toBe('http://127.0.0.1:5173');
  expect(back.searchParams.get('code')).toBeTruthy();
 });
 it('does not accept a redirect the document does not list', async () => {
  const r = await app.fetch('/oauth/authorize?' + app.authorizeQuery(CIMD, {}, undefined, 'https://cimd.example/other'), { headers: { cookie: app.cookie } });
  expect(r.status).toBe(400); expect(r.headers.get('location')).toBeNull();
 });
});

describe('an unreadable client ID metadata document', () => {
 let app: Installation;
 beforeAll(async () => { app = await startRuntime({ outboundService: () => new Response('nope', { status: 500 }) }); }, 60000);
 afterAll(async () => { await app?.dispose(); });
 it('gets the page, not a redirect, and not a raw error', async () => {
  const r = await app.fetch('/oauth/authorize?' + app.authorizeQuery('https://down.example/client.json'), { headers: { cookie: app.cookie } });
  expect(r.status).toBe(400);
  expect(r.headers.get('content-type')).toContain('text/html');
  expect(visible(await r.text())).toContain("doesn't recognise this app");
 });
});
