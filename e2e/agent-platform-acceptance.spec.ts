import { test, expect } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { operatorCredentials, signIn } from './support/session';

// Run only on an isolated local installation. Secrets come from a private file,
// never arguments, reporter output, screenshots, storageState, or traces.
test.use({ ignoreHTTPSErrors: true, trace: 'off', video: 'off' });
test('operator enrollment, finite product access, revocation and responsive reports', async ({ page, playwright }) => {
  test.skip(!process.env.E2E_OPERATOR_FILE, 'Requires a private operator file and isolated Worker');
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  const operator = operatorCredentials();
  const serviceName = `Acceptance service ${Date.now()}`;
  const origin = new URL(process.env.E2E_BASE_URL!).origin;
  expect(['127.0.0.1', 'localhost']).toContain(new URL(origin).hostname);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Create your account|Sign in/ })).toBeVisible();
  const setup = await page.getByLabel('Installer proof').count() > 0;
  // Browser evaluation keeps sensitive field values out of locator error reports.
  await page.evaluate(({ email, password, proof, setup }) => {
    const values: Record<string, string> = { email, password, ...(setup ? { confirm: password, 'bootstrap-proof': proof } : {}) };
    for (const [id, value] of Object.entries(values)) {
      const field = document.getElementById(id) as HTMLInputElement;
      if (!field) throw new Error('Authentication field missing');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, { ...operator, setup });
  await page.getByRole('button', { name: setup ? 'Create account' : 'Sign in', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Main' }).or(page.getByRole('heading', { name: "What's your main domain?" })).or(page.getByRole('heading', { name: "Let's set up Ready Set Mail" }))).toBeVisible();
  const enrolled = await page.request.post('/api/domains', { headers: { Origin: origin }, data: { domain: 'agent-platform.example.com' } });
  expect(enrolled.ok()).toBe(true);
  const result = await enrolled.json();
  const id = result.domain.id;
  await page.goto('/#/settings');
  await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Access keys for scripts and services/ }).click();
  await page.getByLabel('New group name').fill('Acceptance product');
  await page.getByRole('button', { name: 'Create group', exact: true }).click();
  await expect(page.getByLabel('Group', { exact: true })).not.toHaveValue('');
  const productId = await page.getByLabel('Group', { exact: true }).inputValue();
  // Mapping is persisted before the controlled checkbox re-renders.
  await page.getByRole('checkbox', { name: /^agent-platform\.example\.com/ }).first().click();
  await expect(page.getByRole('group', { name: 'Domains this key may see' }).getByLabel('agent-platform.example.com')).toBeVisible();
  await page.getByRole('group', { name: 'Domains this key may see' }).getByLabel('agent-platform.example.com').check();
  await page.getByLabel('Key name').fill(serviceName);
  await page.getByRole('button', { name: 'Create key' }).click();
  const secret = page.getByLabel('New key', { exact: true });
  await expect(secret).toBeVisible();
  await expect(secret).toHaveAttribute('type', 'password');
  const credential = await secret.inputValue();
  const machine = await playwright.request.newContext({ baseURL: origin, ignoreHTTPSErrors: true, extraHTTPHeaders: { Authorization: `Bearer ${credential}` } });
  const allowed = await machine.get(`/api/resources?product_id=${productId}`);
  expect(allowed.status()).toBe(200);
  expect((await allowed.json()).domains.map((d: { domain: string }) => d.domain)).toEqual(['agent-platform.example.com']);
  await page.getByRole('button', { name: 'I saved the key, hide it' }).click();
  await expect(secret).toHaveCount(0);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`agent-settings-${width}.png`), fullPage: true });
  }
  await page.getByRole('button', { name: `Revoke ${serviceName}`, exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Revoke key' }).click();
  await expect.poll(async () => (await machine.get('/api/resources')).status()).toBe(401);
  await machine.dispose();
  // The app cached the domain list before the domain was enrolled through the API: reload so the domain page can find it.
  await page.reload();
  await page.goto(`/#/domains/${id}`);
  await page.getByRole('button', { name: /^Email health report/ }).click();
  await expect(page.getByText('Inbox placement', { exact: true })).toBeVisible({ timeout: 30_000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('agent-report-mobile.png'), fullPage: true });
  const registered = await page.request.post('/oauth/register', { data: {
    client_name: 'Local acceptance client', redirect_uris: ['https://client.example/callback'],
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
  } });
  expect(registered.status()).toBe(201);
  const { client_id } = await registered.json();
  const query = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: 'https://client.example/callback', scope: 'ready-set-mail', resource: origin + '/mcp', code_challenge: 'A'.repeat(43), code_challenge_method: 'S256' });
  await page.goto('/oauth/authorize?' + query);
  // A self-registered client is unverified: its claimed name is not the heading.
  await expect(page.getByRole('heading', { name: 'An app is asking to work with your domains' })).toBeVisible();
  // Plain-words permission, raw scope as secondary text; read-only statistics start unticked.
  const permission = page.getByRole('checkbox', { name: /Read email statistics.*metrics:read/ });
  await permission.focus();
  await page.keyboard.press('Space');
  await expect(permission).toBeChecked();
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`agent-consent-${width}.png`), fullPage: true });
  }
});

// ── An assistant connects end to end (ADR 0018). The real clients differ from this only in who sends the requests. ──
const SHOTS = process.env.E2E_SHOTS_DIR;
async function shot(page: import('@playwright/test').Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}
const challengeOf = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');
const TOOLS = ['whoami', 'list_products', 'list_domains', 'inspect_domain', 'add_domain', 'verify_domain', 'get_email_report', 'query_email_metrics', 'plan_remediation', 'get_source_status'];

test('an assistant connects: discovery from the 401, registration, consent, token, ten tools, Settings, revoke', async ({ page, playwright }) => {
  test.skip(!process.env.E2E_OPERATOR_FILE, 'Requires a private operator file and isolated Worker');
  test.setTimeout(180_000);
  page.setDefaultTimeout(15_000);
  const origin = new URL(process.env.E2E_BASE_URL!).origin;
  await signIn(page);
  const domain = `agent-connect-${Date.now()}.example.com`;
  expect((await page.request.post('/api/domains', { headers: { Origin: origin }, data: { domain } })).ok()).toBe(true);
  const agent = await playwright.request.newContext({ baseURL: origin, ignoreHTTPSErrors: true });

  // Discovery, the way a client does it: the 401 names the metadata, the metadata names the authorization server.
  const unauthorized = await agent.post('/mcp', { data: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers: { accept: 'application/json, text/event-stream' } });
  expect(unauthorized.status()).toBe(401);
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(unauthorized.headers()['www-authenticate'] ?? '')?.[1];
  expect(metadataUrl).toBe(`${origin}/.well-known/oauth-protected-resource/mcp`);
  const resource = await (await agent.get(metadataUrl!)).json();
  expect(resource).toMatchObject({ resource: `${origin}/mcp`, authorization_servers: [origin] });
  expect(await (await agent.get('/.well-known/oauth-protected-resource')).json()).toEqual(resource);
  const server = await (await agent.get(`${resource.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();
  expect(server).toMatchObject({ code_challenge_methods_supported: ['S256'], client_id_metadata_document_supported: true });
  expect(server.token_endpoint_auth_methods_supported).toContain('none');

  // Registration: a bad redirect is refused, a good one is stored.
  const refused = await agent.post(server.registration_endpoint, { data: { client_name: 'Bad redirect', redirect_uris: ['http://evil.example/cb'], token_endpoint_auth_method: 'none' } });
  expect(refused.status()).toBe(400);
  expect((await refused.json()).error).toBe('invalid_redirect_uri');
  const callback = 'http://127.0.0.1:33418/callback';
  const registered = await agent.post(server.registration_endpoint, { data: { client_name: 'E2E assistant', redirect_uris: [callback], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' } });
  expect(registered.status()).toBe(201);
  const { client_id } = await registered.json();

  // Consent, in the browser that is signed in. The callback is intercepted: nothing listens on that port.
  const verifier = randomBytes(32).toString('base64url');
  const reached = page.waitForRequest(request => request.url().startsWith('http://127.0.0.1:33418/'));
  await page.route('http://127.0.0.1:33418/**', route => route.abort());
  const query = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: callback, scope: 'ready-set-mail', resource: `${origin}/mcp`, state: 'e2e-state', code_challenge: challengeOf(verifier), code_challenge_method: 'S256' });
  await page.goto('/oauth/authorize?' + query);
  await expect(page.getByRole('heading', { name: 'An app is asking to work with your domains' })).toBeVisible();
  await expect(page.getByText('Not verified')).toBeVisible();
  for (const width of [375, 1440]) { await page.setViewportSize({ width, height: 900 }); await shot(page, `consent-registered-app-${width}`); }
  await page.getByRole('checkbox', { name: new RegExp(`^${domain.replace(/\./g, '\\.')}`) }).check();
  await page.getByRole('checkbox', { name: /See the domains you select/ }).check();
  await page.getByRole('checkbox', { name: /Read email health reports/ }).check();
  await page.getByRole('button', { name: 'Allow access' }).click();
  const back = new URL((await reached).url());
  expect(back.searchParams.get('state')).toBe('e2e-state');
  expect(back.searchParams.get('iss')).toBe(origin);
  const code = back.searchParams.get('code')!;

  // Token, then /mcp.
  const token = await agent.post('/oauth/token', { form: { grant_type: 'authorization_code', client_id, code, code_verifier: verifier, redirect_uri: callback, resource: `${origin}/mcp` } });
  expect(token.status()).toBe(200);
  const { access_token } = await token.json();
  const mcp = (body: object) => agent.post('/mcp', { data: body, headers: { authorization: `Bearer ${access_token}`, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' } });
  const listed = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  expect(listed.status()).toBe(200);
  const names = [...(await listed.text()).matchAll(/"name":"([a-z_]+)"/g)].map(m => m[1]);
  expect([...new Set(names)].sort()).toEqual([...TOOLS].sort());
  const who = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'whoami', arguments: {} } });
  expect(who.status()).toBe(200);
  expect(await who.text()).toContain(domain);

  // Settings → Agents lists it by name, with what it can reach, and when it was last used.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(async () => {
    await page.goto('/#/settings');
    const row = page.getByRole('listitem').filter({ hasText: 'E2E assistant' });
    await expect(row).toBeVisible({ timeout: 3_000 });
    await expect(row.getByText('Not verified')).toBeVisible();
    await expect(row.getByText(domain)).toBeVisible();
    await expect(row.getByText('Read email health reports')).toBeVisible();
    await expect(row.getByText('Last used').locator('xpath=following-sibling::dd[1]')).not.toHaveText('Not used yet');
  }).toPass({ timeout: 30_000 });
  for (const width of [375, 1440]) { await page.setViewportSize({ width, height: 900 }); await shot(page, `settings-approved-agents-before-revoke-${width}`); }
  await page.setViewportSize({ width: 1440, height: 900 });

  // Revoke: its next request is refused, and the row says so.
  await page.getByRole('button', { name: 'Revoke E2E assistant' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Revoke agent' }).click();
  await expect.poll(async () => (await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/list' })).status()).toBe(401);
  const after = await mcp({ jsonrpc: '2.0', id: 4, method: 'tools/list' });
  expect(after.headers()['www-authenticate']).toContain('resource_metadata=');
  await expect(page.getByRole('listitem').filter({ hasText: 'E2E assistant' }).getByText('Revoked')).toBeVisible();
  for (const width of [375, 1440]) { await page.setViewportSize({ width, height: 900 }); await shot(page, `settings-approved-agents-after-revoke-${width}`); }
  await agent.dispose();
});

test('a link an app sent that cannot go on shows a page, never a redirect', async ({ page }) => {
  test.skip(!process.env.E2E_OPERATOR_FILE, 'Requires a private operator file and isolated Worker');
  test.setTimeout(60_000);
  const origin = new URL(process.env.E2E_BASE_URL!).origin;
  await signIn(page);
  const base = { response_type: 'code', scope: 'ready-set-mail', resource: `${origin}/mcp`, state: 's', code_challenge: 'A'.repeat(43), code_challenge_method: 'S256' };
  const registered = await page.request.post('/oauth/register', { data: { client_name: 'Page checker', redirect_uris: ['https://client.example/callback'], token_endpoint_auth_method: 'none' } });
  const { client_id } = await registered.json();
  const cases: Array<[string, Record<string, string>, RegExp]> = [
    ['unknown-app', { client_id: 'no-such-app', redirect_uri: 'https://client.example/callback' }, /doesn't recognise this app/],
    ['wrong-address', { client_id, redirect_uri: 'https://evil.example/steal' }, /did not register/],
    ['incomplete-link', { client_id, redirect_uri: 'https://client.example/callback', code_challenge: '' }, /incomplete/],
  ];
  for (const [name, params, title] of cases) {
    const response = await page.goto('/oauth/authorize?' + new URLSearchParams({ ...base, ...params }));
    expect(response!.status()).toBe(400);
    expect(new URL(page.url()).origin).toBe(origin);
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open Agents' })).toHaveAttribute('href', '/#/agents');
    for (const width of [375, 1440]) { await page.setViewportSize({ width, height: 700 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await shot(page, `error-page-${name}-${width}`); }
  }
  await page.getByRole('link', { name: 'Open Agents' }).click();
  await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible();
});

test('the Agents page says what works on this instance', async ({ page }) => {
  test.skip(!process.env.E2E_OPERATOR_FILE, 'Requires a private operator file and isolated Worker');
  test.setTimeout(90_000);
  await signIn(page);
  const status = await (await page.request.get('/api/agents/status')).json();
  expect(status).toMatchObject({ available: true, dynamic_registration: true });
  // Registration is on in this harness. The other states are the same page with the server's answer changed.
  const views: Array<[string, { dynamic_registration: boolean }, { role?: string; instance_owner?: boolean }]> = [
    ['dcr-on-owner', { dynamic_registration: true }, {}],
    ['dcr-off-owner', { dynamic_registration: false }, {}],
    ['dcr-off-admin', { dynamic_registration: false }, { role: 'admin', instance_owner: false }],
    ['dcr-off-member', { dynamic_registration: false }, { role: 'member', instance_owner: false }],
    ['dcr-on-member', { dynamic_registration: true }, { role: 'member', instance_owner: false }],
  ];
  for (const [name, caps, me] of views) {
    await page.route('**/api/agents/status', route => route.fulfill({ json: { ...status, ...caps } }));
    await page.route('**/api/me', async route => { const real = await (await route.fetch()).json(); await route.fulfill({ json: { ...real, ...me } }); });
    await page.goto('/#/agents');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Steps for your assistant' })).toBeVisible();
    const text = await page.locator('main').innerText();
    if (!caps.dynamic_registration) {
      expect(text).toContain("Cursor can't yet");
      expect(text.includes('MCP_DCR_ENABLED')).toBe(me.instance_owner !== false);
    } else expect(text).toContain('Every assistant below can connect to this instance.');
    await page.getByRole('button', { name: /^Claude/ }).click();
    await expect(page.getByText('Add custom connector')).toBeVisible();
    for (const width of [375, 1440]) { await page.setViewportSize({ width, height: 900 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await shot(page, `agents-page-${name}-${width}`); }
    await page.unroute('**/api/agents/status'); await page.unroute('**/api/me');
  }
});
