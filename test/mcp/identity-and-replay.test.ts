// Who an app is told to be, and what happens to a refresh token used twice, in workerd (ADR 0015): a self-registered name is never the identity a person is
// shown, a client document is fetched without following redirects, an approval link carries the person through sign-in, and a refresh token replayed after it
// was replaced ends the connection.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GOOD, ORIGIN, startRuntime, type Installation } from './runtime';

const visible = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

describe('a self-registered app is shown by its address, whatever it calls itself', () => {
 let app: Installation;
 beforeAll(async () => { app = await startRuntime({ bindings: { MCP_DCR_ENABLED: '1' } }); }, 60000);
 afterAll(async () => { await app?.dispose(); });
 const consent = async (clientId: string, redirect = 'https://client.example/callback') => {
  const page = await app.fetch('/oauth/authorize?' + app.authorizeQuery(clientId, {}, undefined, redirect), { headers: { cookie: app.cookie } });
  const html = await page.text();
  expect(page.status, html.slice(0, 300)).toBe(200);
  return html;
 };

 it('"Claude": the page leads with the address, never the name, and nothing is pre-ticked', async () => {
  const html = await consent(await app.registerOk({ ...GOOD, client_name: 'Claude' }));
  expect(html).toContain('<h1>Allow the app at client.example to work with your domains?</h1>');
  expect(html).not.toMatch(/<h1>[^<]*Claude/);
  expect(visible(html)).not.toContain('Claude');
  expect(visible(html)).toContain('Not verified: nobody has checked who this app is. It gave no name.');
  expect(html).not.toMatch(/<input[^>]* checked/);
 });
 it('a name that is not famous is shown as what the app calls itself, below the address', async () => {
  const html = await consent(await app.registerOk({ ...GOOD, client_name: 'Mail Helper' }));
  expect(html).toContain('<h1>Allow the app at client.example to work with your domains?</h1>');
  expect(visible(html)).toContain('It calls itself “Mail Helper”. The app chose that name, so it may not be who it says.');
 });
 it('an app on this computer is called that', async () => {
  const id = await app.registerOk({ ...GOOD, client_name: 'Local tool', redirect_uris: ['http://127.0.0.1:5173/cb'] });
  const html = await consent(id, 'http://127.0.0.1:5173/cb');
  expect(html).toContain('<h1>Allow an app on this computer to work with your domains?</h1>');
 });
 it('the approved agent is listed by its address, with the name as what it calls itself', async () => {
  const id = await app.registerOk({ ...GOOD, client_name: 'Listed Helper', redirect_uris: ['https://listed.example/cb'] });
  await app.connect(id, { redirect: 'https://listed.example/cb' });
  const c = (await app.connections()).find(x => x.clientId === id);
  expect(c).toMatchObject({ name: 'listed.example', calledItself: 'Listed Helper', verified: false });
  const famous = await app.registerOk({ ...GOOD, client_name: 'Claude', redirect_uris: ['https://famous.example/cb'] });
  await app.connect(famous, { redirect: 'https://famous.example/cb' });
  const f = (await app.connections()).find(x => x.clientId === famous);
  expect(f).toMatchObject({ name: 'famous.example', verified: false });
  expect(f.calledItself).toBeUndefined();
 }, 60000);
 it('approving an app takes it off the list of apps that expire, so the clean-up cannot take it', async () => {
  const id = await app.registerOk({ ...GOOD, redirect_uris: ['https://approved.example/cb'] });
  expect(await app.db.prepare('SELECT COUNT(*) AS n FROM auth_rate_limits WHERE key = ?').bind('agent-client:' + id).first()).toEqual({ n: 1 });
  await app.connect(id, { redirect: 'https://approved.example/cb' });
  expect(await app.db.prepare('SELECT COUNT(*) AS n FROM auth_rate_limits WHERE key = ?').bind('agent-client:' + id).first()).toEqual({ n: 0 });
 }, 60000);

 it('signed out, the approval page links to "Sign in and continue", carrying this request and nothing else', async () => {
  const id = await app.registerOk();
  const query = app.authorizeQuery(id).toString();
  const page = await app.fetch('/oauth/authorize?' + query);
  const html = await page.text();
  expect(page.status).toBe(401);
  const href = html.match(/href="(\/\?continue=[^"]+)"/)![1]!.replace(/&amp;/g, '&');
  const url = new URL(href, ORIGIN);
  expect(url.searchParams.get('continue')).toBe('/oauth/authorize?' + query);
  expect(url.hash).toBe('#/');
  expect(visible(html)).toContain('Sign in and continue');
 });
});

describe('a refresh token is used once', () => {
 let app: Installation;
 beforeAll(async () => { app = await startRuntime({ bindings: { MCP_DCR_ENABLED: '1' } }); }, 60000);
 afterAll(async () => { await app?.dispose(); });
 const refresh = (clientId: string, token: string) => app.fetch('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: token, resource: ORIGIN + '/mcp' }).toString() });

 it('the current token works, again and again, as the client rotates it', async () => {
  const id = await app.registerOk();
  const first = await app.connect(id);
  const a = await refresh(id, first.refresh_token);
  expect(a.status).toBe(200);
  const second = await a.json() as { refresh_token: string; access_token: string };
  const b = await refresh(id, second.refresh_token);
  expect(b.status).toBe(200);
  expect((await app.mcp((await b.json() as { access_token: string }).access_token)).status).toBe(200);
 }, 60000);

 it('a token that was already replaced is refused, and the whole connection ends: its newer token, its access token and its approval', async () => {
  const id = await app.registerOk({ ...GOOD, redirect_uris: ['https://replay.example/cb'] });
  const first = await app.connect(id, { redirect: 'https://replay.example/cb' });
  const rotated = await (await refresh(id, first.refresh_token)).json() as { refresh_token: string; access_token: string };
  expect((await app.mcp(rotated.access_token)).status).toBe(200);
  const replay = await refresh(id, first.refresh_token);
  expect(replay.status).toBe(400);
  expect(await replay.json()).toMatchObject({ error: 'invalid_grant', error_description: expect.stringContaining('already used') });
  expect((await refresh(id, rotated.refresh_token)).status).toBe(400);
  expect((await app.mcp(rotated.access_token)).status).toBe(401);
  expect((await app.connections()).find(c => c.clientId === id)).toMatchObject({ revoked: true });
  expect((await app.audit()).filter(a => a.action === 'agent.refresh_token_replayed')).toHaveLength(1);
 }, 60000);

 it('a made-up or foreign token is the library\'s ordinary refusal, and ends nothing', async () => {
  const id = await app.registerOk({ ...GOOD, redirect_uris: ['https://other.example/cb'] });
  const tokens = await app.connect(id, { redirect: 'https://other.example/cb' });
  expect((await refresh(id, 'a:b:c')).status).toBe(400);
  expect((await refresh(id, 'not-a-token')).status).toBe(400);
  expect((await app.mcp(tokens.access_token)).status).toBe(200);
 }, 60000);
});

describe('a client document is not followed to another address', () => {
 const CIMD = 'https://cimd.example/oauth/client.json';
 const ELSEWHERE = 'https://elsewhere.example/client.json';
 const document = { client_id: CIMD, client_name: 'Redirected', redirect_uris: ['https://cimd.example/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
 const fetched: string[] = [];
 let app: Installation;
 beforeAll(async () => {
  app = await startRuntime({ outboundService: request => {
   fetched.push(request.url);
   if (request.url === CIMD) return new Response(null, { status: 302, headers: { location: ELSEWHERE } });
   if (request.url === ELSEWHERE) return Response.json({ ...document, client_name: 'Elsewhere' });
   return new Response('not found', { status: 404 });
  } });
 }, 60000);
 afterAll(async () => { await app?.dispose(); });

 it('a document that answers with a redirect is a document that could not be read: the unknown-app page, and the other address is never asked', async () => {
  const page = await app.fetch('/oauth/authorize?' + app.authorizeQuery(CIMD, {}, undefined, 'https://cimd.example/callback'), { headers: { cookie: app.cookie } });
  expect(page.status).toBe(400);
  expect(page.headers.get('location')).toBeNull();
  expect(visible(await page.text())).toContain("doesn't recognise this app");
  expect(fetched).toContain(CIMD);
  expect(fetched).not.toContain(ELSEWHERE);
 });
});
