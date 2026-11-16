// Product analytics on a real local hosted instance (docs/analytics.md): `wrangler dev` with POSTHOG_KEY and POSTHOG_HOST pointed at a
// fake PostHog (a local HTTP server that keeps every request), the fake Cloudflare (which also answers DNS-over-HTTPS) and the fake
// Stripe. A person arrives from the website's checker (`src=checker`, its domain carried over; a stray `vid` the server must ignore),
// signs up in the browser, adds a domain, connects Cloudflare with a pasted token, applies the DMARC step, sees the records live, and
// buys the fix; the operator marks it done. The fake PostHog must have received the funnel's steps in order, under the workspace's
// server-minted id, with no forwarded client address or browser identity, and nothing forbidden; with the keys unset it must receive nothing.
// E2E_ANALYTICS_OUT=<file> writes the captured event sequence there. Hosted sign-up asks Cloudflare's Turnstile test endpoint
// (challenges.cloudflare.com) to check a dummy token: this spec needs that network access.
// Ports 8833-8834. Needs `npm run build:dashboard`. Run alone: npx playwright test e2e/product-analytics.spec.ts
import { expect, test, type Page } from '@playwright/test';
import http from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

interface Instance { url: string; logFile: string; fake: { url: string }; stop(): Promise<void>; d1(sql: string): Array<Record<string, unknown>> }
interface FakeStripe { url: string; close(): Promise<void>; fake: { completeCheckout(id: string, o: { card: string }): string } }
const nativeImport = new Function('u', 'return import(u)') as (u: string) => Promise<any>;
const here = (f: string) => pathToFileURL(resolve(__dirname, f)).href;
const startInstance = async (o: Record<string, unknown>): Promise<Instance> => (await nativeImport(here('support/dev-instance.mjs'))).startInstance(o);
const startFakeStripe = async (o: Record<string, unknown>): Promise<FakeStripe> => (await nativeImport(here('support/fake-stripe.mjs'))).startFakeStripe(o);

test.setTimeout(300_000);

const PORT = 8833;
const OFF_PORT = 8834;
const VID = '6c1f0b2e-8a4d-4c3b-9e2f-1a0b9c8d7e6f';
const OWNER = 'owner@harbor-lane.org';
const DOMAIN = 'harbor-lane.org';
const WHSEC = 'whsec_e2eanalytics0123456789';
const KEY = 'phc_e2eprojectkey0123456789';

interface Sent { method: string; path: string; headers: Record<string, string | string[] | undefined>; body: string }

/** A fake PostHog: answers 200 to everything and keeps each request. */
async function fakePostHog() {
	const sent: Sent[] = [];
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => chunks.push(c));
		req.on('end', () => {
			sent.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
			res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"Ok"}');
		});
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
	const port = (server.address() as { port: number }).port;
	return { url: `http://127.0.0.1:${port}`, sent, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const events = (sent: Sent[]) => sent.flatMap((r) => (JSON.parse(r.body) as { batch: { event: string; distinct_id: string; timestamp: string; properties: Record<string, unknown> }[] }).batch);

const mailedCodes = (inst: Instance) =>
	existsSync(inst.logFile) ? [...readFileSync(inst.logFile, 'utf8').replace(/\x1b\[[0-9;]*m/g, '').matchAll(/(\d{6}) is your Ready Set Mail code/g)].map((m) => m[1]!) : [];

/** Sign up through the screen, arriving by the website's sign-up link (checker result). */
async function signUp(page: Page, inst: Instance, link: string) {
	await page.goto(`${inst.url}/${link}`);
	await page.locator('#email').fill(OWNER);
	await page.getByLabel('Password', { exact: true }).fill('correct-horse-battery');
	await page.waitForTimeout(2500); // the Turnstile test widget
	const before = mailedCodes(inst).length;
	await page.getByRole('button', { name: /Create account|Sign up|Continue|Send/ }).first().click();
	await expect.poll(() => mailedCodes(inst).length, { timeout: 30_000 }).toBeGreaterThan(before);
	await page.getByLabel('6-digit code').pressSequentially(mailedCodes(inst).at(-1)!);
	await expect(page.getByRole('heading', { name: "Let's set up Ready Set Mail" })).toBeVisible({ timeout: 30_000 });
}

/** The page's own session (cookie), as the dashboard would call the API. */
const call = (page: Page, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
	page.evaluate(async ({ method, path, body, headers }) => {
		const r = await fetch(path, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
		return { status: r.status, json: await r.json().catch(() => null) as any };
	}, { method, path, body, headers });

const FORBIDDEN: RegExp[] = [/[^\s@"]+@[^\s@"]+/, /[a-z0-9-]+\.[a-z]{2,}/i, /\b\d{1,3}(?:\.\d{1,3}){3}\b/, /v=spf1/i, /v=DMARC1/i, /readysetmail-verify=|_readysetmail/i, /\b(?:cus|in|pi|ch|pm|seti|cs|evt)_[A-Za-z0-9]{6,}/, /\b(?:ws|ord)_[0-9a-f]{8,}/, /\b[0-9a-f]{32,}\b/i];

test('hosted with PostHog configured: the walk from sign-up to a delivered order sends the funnel, under the visitor id, and nothing forbidden', async ({ page }) => {
	const ph = await fakePostHog();
	const stripe = await startFakeStripe({ port: 0, webhookUrl: `http://127.0.0.1:${PORT}/api/stripe/webhook`, webhookSecret: WHSEC });
	const intake = 'rua.intake.example.net';
	const inst = await startInstance({
		mode: 'hosted', port: PORT, tokenKey: true, dohNs: { [DOMAIN]: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'] },
		vars: { POSTHOG_KEY: KEY, POSTHOG_HOST: ph.url, INTAKE_DOMAIN: intake, HOSTED_CONNECT_REPORTS: 'all', STRIPE_SECRET_KEY: 'rk_test_e2eanalytics0123456789', STRIPE_WEBHOOK_SECRET: WHSEC, STRIPE_API_BASE: stripe.url, OWNER_EMAIL: OWNER },
	});
	try {
		await signUp(page, inst, `#/signup?domain=${DOMAIN}&src=checker&vid=${VID}`);
		const ws = inst.d1(`SELECT m.workspace_id AS w FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = '${OWNER}'`)[0]!.w as string;
		const id = inst.d1(`SELECT value FROM settings WHERE workspace_id = '${ws}' AND key = 'analytics_id'`)[0]!.value as string;
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(id).not.toBe(VID); // minted by the server; nothing in the link chooses it
		const browserUA = await page.evaluate(() => navigator.userAgent);

		// The domain typed, then Cloudflare connected (a pasted token: the same code as after the OAuth return) and its zone imported.
		expect((await call(page, 'POST', '/api/domains', { domain: DOMAIN })).status).toBe(202);
		const conn = await call(page, 'POST', '/api/cloudflare/connections', { token: 'e2e-fake-token-not-a-real-secret-0000' });
		expect(conn.status).toBe(201);
		const zones = (await call(page, 'GET', `/api/cloudflare/connections/${conn.json.connection.id}/zones`)).json.zones as { id: string; name: string }[];
		expect((await call(page, 'POST', `/api/cloudflare/connections/${conn.json.connection.id}/import`, { zone_ids: zones.filter((z) => z.name === DOMAIN).map((z) => z.id) })).status).toBe(200);
		const domainId = inst.d1(`SELECT id FROM domains WHERE domain = '${DOMAIN}'`)[0]!.id as number;

		// The plan's DMARC step, then the first DNS read (through the fake's DNS-over-HTTPS): the record carries the report address.
		const plan = (await call(page, 'POST', '/api/onboarding/dns-plan', { domain_ids: [domainId] })).json;
		const applied = await call(page, 'POST', '/api/onboarding/dns-apply', { domain_ids: [domainId], step: 'dmarc', plan_id: plan.plan_id });
		expect(applied.json.results[0]).toMatchObject({ ok: true, reports: 'connected' });
		expect((await call(page, 'POST', '/api/onboarding/first-check', { domain_ids: [domainId] })).json.results).toEqual([{ domain_id: domainId, stored: true }]);
		expect(inst.d1(`SELECT dmarc_rua FROM domains WHERE id = ${domainId}`)).toEqual([{ dmarc_rua: 1 }]);

		// The fix: the offer, a card through the fake Checkout, the order, paid by the fake's signed webhook; then started and done.
		const h = { 'x-workspace-id': ws };
		expect((await call(page, 'GET', `/api/billing/domains/${domainId}`, undefined, h)).status).toBe(200);
		const card = (await call(page, 'POST', '/api/billing/card-session', { return_path: '/settings' }, h)).json;
		const back = stripe.fake.completeCheckout(card.url.split('/pay/')[1], { card: 'ok' });
		await page.goto(back);
		const order = await call(page, 'POST', '/api/billing/orders', { domain_id: domainId, offer: 'fix-one-domain', expected_amount: 14900, expected_currency: 'usd' }, h);
		expect(order.status).toBeLessThan(300);
		await expect.poll(() => inst.d1('SELECT status FROM billing_orders')[0]?.status, { timeout: 60_000 }).toBe('paid');
		for (const step of ['started', 'done']) expect((await call(page, 'POST', `/api/operator/orders/${order.json.order.id}/${step}`)).status).toBe(200);

		const want = ['Signup Started', 'Signup Code Sent', 'Code Verified', 'Workspace Created', 'Dashboard First Viewed', 'Domain Added', 'Cloudflare Connect Started', 'Cloudflare Connect Returned', 'Ownership Verified', 'Apply Clicked', 'Apply Done', 'Records Live', 'Fix Offer Viewed', 'Card Setup Started', 'Card Setup Completed', 'Fix Order Created', 'Fix Order Paid', 'Fix Order Delivered'];
		await expect.poll(() => events(ph.sent).map((e) => e.event), { timeout: 30_000 }).toEqual(expect.arrayContaining(want));
		const all = events(ph.sent);
		if (process.env.E2E_ANALYTICS_OUT) writeFileSync(process.env.E2E_ANALYTICS_OUT, JSON.stringify({ source: 'e2e/product-analytics.spec.ts (wrangler dev, fake PostHog, fake Cloudflare, fake Stripe)', requests: ph.sent.length, events: all.map(({ event, distinct_id, timestamp, properties }) => ({ timestamp, event, distinct_id, properties })) }, null, 2));

		// In funnel order by timestamp (equal seconds count, as in PostHog's ordered funnels), under the workspace's id.
		expect(new Set(all.map((e) => e.distinct_id))).toEqual(new Set([id]));
		let t = '';
		for (const step of want) {
			const hit = all.filter((e) => e.event === step && e.timestamp >= t).sort((a, b) => a.timestamp.localeCompare(b.timestamp))[0];
			expect(hit, `${step} after ${t} in ${all.map((e) => `${e.timestamp.slice(11)} ${e.event}`).join(' > ')}`).toBeTruthy();
			t = hit!.timestamp;
		}
		expect(all.find((e) => e.event === 'Code Verified')!.properties).toMatchObject({ from_checker: true, entry: 'checker', purpose: 'signup' });
		expect(all.find((e) => e.event === 'Signup Started')!.properties).toMatchObject({ method: 'email_code', entry: 'checker', from_checker: true });
		expect(all.filter((e) => e.event === 'Cloudflare Connect Started').map((e) => e.properties.method)).toEqual(['token']);

		// Every request: the batch endpoint, the project key, personless, no forwarded client address or browser identity, nothing forbidden.
		for (const r of ph.sent) {
			expect([r.method, r.path]).toEqual(['POST', '/batch/']);
			for (const name of ['cf-connecting-ip', 'x-forwarded-for', 'x-real-ip', 'forwarded', 'true-client-ip', 'cookie', 'authorization', 'referer', 'origin']) expect(r.headers[name], name).toBeUndefined();
			expect(r.headers['user-agent'], 'the browser\'s user agent').not.toBe(browserUA);
			const body = JSON.parse(r.body) as { api_key: string; batch: { distinct_id: string; timestamp: string; properties: Record<string, unknown> }[] };
			expect(body.api_key).toBe(KEY);
			for (const e of body.batch) {
				expect(e.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/); // whole seconds
				expect(e.properties).toMatchObject({ surface: 'app', $process_person_profile: false, $geoip_disable: true });
				expect(Object.keys(e.properties)).not.toContain('$ip');
				for (const v of Object.values(e.properties)) for (const re of FORBIDDEN) expect(String(v), `${re}`).not.toMatch(re);
			}
			for (const s of [OWNER, DOMAIN, ws, VID, order.json.order.id, 'correct-horse-battery', 'Example Co']) expect(r.body.toLowerCase(), s).not.toContain(s.toLowerCase());
		}
	} finally {
		await inst.stop();
		await stripe.close();
		await ph.close();
	}
});

test('hosted without POSTHOG_KEY / POSTHOG_HOST: the same sign-up sends nothing and stores no analytics id', async ({ page }) => {
	const ph = await fakePostHog();
	// The host alone (no key): still off.
	const inst = await startInstance({ mode: 'hosted', port: OFF_PORT, tokenKey: true, vars: { POSTHOG_HOST: ph.url } });
	try {
		await signUp(page, inst, `#/signup?domain=${DOMAIN}&src=checker`);
		expect((await call(page, 'POST', '/api/domains', { domain: DOMAIN })).status).toBe(202);
		expect((await call(page, 'GET', '/api/auth/status')).json.product_analytics).toBe(false);
		await page.waitForTimeout(1500);
		expect(ph.sent).toEqual([]);
		expect(inst.d1("SELECT COUNT(*) AS n FROM settings WHERE key = 'analytics_id' OR key LIKE 'analytics:%'")).toEqual([{ n: 0 }]);
	} finally {
		await inst.stop();
		await ph.close();
	}
});
