// Hosted billing in a real browser, end to end, against a throwaway hosted instance (e2e/support/dev-instance.mjs: MODE=saas, fresh local D1)
// and the in-repo fake Stripe (e2e/support/fake-stripe.mjs) run as a local HTTP server. api.stripe.com is never contacted: the Worker reaches the fake
// through the test-only STRIPE_API_BASE (honoured for 127.0.0.1 only), and the fake delivers signed webhooks to the Worker like Stripe would.
//
// Owner with no card -> a domain with something to fix -> the quiet offer -> confirm -> "Add a card to continue" -> the fake Checkout -> back on the SAME
// confirm step with the card shown -> Pay (double-clicked: one charge) -> the signed webhook marks it paid -> shown on the domain and in Settings;
// a member can see the offer but not buy; the instance owner moves the order to started.
// Hosted sign-up asks Cloudflare's Turnstile test endpoint (challenges.cloudflare.com) to check a dummy token: this spec needs that network access.
// Port 8821. Needs `npm run build:dashboard`. Run alone: npx playwright test e2e/billing.spec.ts
import { expect, test, type Browser, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

interface Instance { url: string; logFile: string; stop(): Promise<void>; d1(sql: string): Array<Record<string, unknown>> }
interface FakeStripe { url: string; close(): Promise<void>; fake: { calls: Array<{ method: string; path: string }>; state: { invoices: Map<string, unknown>; charges: Map<string, unknown> } } }
const nativeImport = new Function('u', 'return import(u)') as (u: string) => Promise<any>;
const here = (f: string) => pathToFileURL(resolve(__dirname, f)).href;
const startInstance = async (o: Record<string, unknown>): Promise<Instance> => (await nativeImport(here('support/dev-instance.mjs'))).startInstance(o);
const startFakeStripe = async (o: Record<string, unknown>): Promise<FakeStripe> => (await nativeImport(here('support/fake-stripe.mjs'))).startFakeStripe(o);

test.setTimeout(300_000);

const PORT = 8821;
const WHSEC = 'whsec_e2etestsecret0123456789';
const OWNER = 'owner@harbor-lane.org';
const MEMBER = 'member@harbor-lane.org';
const DOMAIN = 'acme-fix.example';

const mailedCodes = (inst: Instance) =>
	existsSync(inst.logFile) ? [...readFileSync(inst.logFile, 'utf8').replace(/\x1b\[[0-9;]*m/g, '').matchAll(/(\d{6}) is your Ready Set Mail code/g)].map((m) => m[1]!) : [];

/** Sign up on a hosted instance through the screen: email and password, the code emailed to confirm the address, and the app. */
async function signUp(page: Page, inst: Instance, email: string) {
	await page.goto(`${inst.url}/#/signup`);
	await page.locator('#email').fill(email);
	await page.getByLabel('Password', { exact: true }).fill('correct-horse-battery');
	await page.waitForTimeout(2500); // the Turnstile test widget
	const before = mailedCodes(inst).length;
	await page.getByRole('button', { name: /Create account|Sign up|Continue|Send/ }).first().click();
	await expect.poll(() => mailedCodes(inst).length, { timeout: 30_000 }).toBeGreaterThan(before);
	await page.getByLabel('6-digit code').pressSequentially(mailedCodes(inst).at(-1)!); // the sixth digit submits
	await expect(page.getByRole('heading', { name: "Let's set up Ready Set Mail" })).toBeVisible({ timeout: 30_000 });
}

/** Public DNS is not reachable for made-up names: answer as if the name resolved with no SPF and no DMARC record (something to fix). */
async function somethingToFix(page: Page) {
	// The stored check of a made-up name says it did not resolve: show it as read fine, so there is something to fix and not a spelling to check.
	await page.route('**/api/domains/*/check-summary', async (route) => {
		const res = await route.fetch();
		const b = await res.json();
		await route.fulfill({ response: res, json: { ...b, dns_check_status: 'ok', dns_last_good_status: 'ok', dns_checked_at: Math.floor(Date.now() / 1000), dns_check_attempted_at: Math.floor(Date.now() / 1000) } });
	});
	await page.route('**/api/domains/*/onboarding-status', async (route) => {
		const res = await route.fetch();
		const b = await res.json();
		b.nxdomain = false;
		delete b.dns_errors;
		b.dmarc = { ...b.dmarc, found: false, has_our_rua: false, current_record: null, effective: { policy: null, inherited_from: null, issue: null, record: null } };
		b.spf = { record: null, lookup_count: null, flattening_active: false };
		await route.fulfill({ response: res, json: b });
	});
}

async function member(browser: Browser, inst: Instance, workspaceId: string, domainId: number) {
	const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
	const page = await ctx.newPage();
	await signUp(page, inst, MEMBER);
	inst.d1(`INSERT INTO memberships (workspace_id, user_id, role) SELECT '${workspaceId}', id, 'member' FROM users WHERE email = '${MEMBER}'`);
	await somethingToFix(page);
	await page.goto(`${inst.url}/#/w/${workspaceId}/domains/${domainId}`);
	return { ctx, page };
}

test('owner adds a card through Stripe, pays once, and the webhook marks the order paid; a member cannot buy', async ({ page, browser }) => {
	const stripe = await startFakeStripe({ port: 0, webhookUrl: `http://127.0.0.1:${PORT}/api/stripe/webhook`, webhookSecret: WHSEC });
	const inst = await startInstance({
		mode: 'hosted', port: PORT, tokenKey: true,
		vars: { STRIPE_SECRET_KEY: 'rk_test_e2etestkey0123456789', STRIPE_WEBHOOK_SECRET: WHSEC, STRIPE_API_BASE: stripe.url, OWNER_EMAIL: OWNER },
	});
	try {
		await signUp(page, inst, OWNER);
		const workspaceId = inst.d1(`SELECT m.workspace_id AS w FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = '${OWNER}'`)[0]!.w as string;
		inst.d1(`INSERT INTO domains (workspace_id, domain, rua_address, verified_via) VALUES ('${workspaceId}', '${DOMAIN}', '', 'txt')`);
		const domainId = inst.d1(`SELECT id FROM domains WHERE domain = '${DOMAIN}'`)[0]!.id as number;
		await somethingToFix(page);

		// The quiet offer, below "Do this next".
		await page.goto(`${inst.url}/#/w/${workspaceId}/domains/${domainId}`);
		const offer = page.getByRole('button', { name: 'Have us fix this domain: $149 USD' });
		await expect(offer).toBeVisible({ timeout: 60_000 });
		await offer.click();

		// The confirm step, with no card: the one action is "Add a card to continue".
		let dialog = page.getByRole('dialog');
		await expect(dialog.getByRole('heading', { name: 'Fix one domain' })).toBeVisible();
		await expect(dialog.getByText(DOMAIN)).toBeVisible();
		await expect(dialog.getByText('No card on file yet.')).toBeVisible();
		await expect(dialog.getByText('Until we send the written note that the domain is done, you can ask for the full fee back.')).toBeVisible();
		await expect(dialog.getByRole('button', { name: /^Pay/ })).toHaveCount(0);
		await dialog.getByRole('button', { name: 'Add a card to continue' }).click();

		// Stripe's page (the fake): save the test card; it sends the browser back to the same confirm step.
		await expect(page.getByText('Save a card (session')).toBeVisible({ timeout: 30_000 });
		await page.getByRole('link', { name: 'Use test card 4242' }).click();
		dialog = page.getByRole('dialog');
		await expect(dialog.getByText(/^Visa ending 4242, expires/)).toBeVisible({ timeout: 30_000 });
		await expect(dialog.getByText(OWNER)).toBeVisible();
		await expect(page).toHaveURL(new RegExp(`#/w/${workspaceId}/domains/${domainId}$`)); // the return parameters are gone from the address

		// Pay, double-clicked: one request, one invoice, one charge.
		await dialog.getByRole('button', { name: 'Pay $149 USD' }).dblclick();
		await expect(dialog.getByText('Paid', { exact: true })).toBeVisible({ timeout: 60_000 }); // the signed webhook marked it paid
		const pays = stripe.fake.calls.filter((c) => c.method === 'POST' && /\/v1\/invoices\/[^/]+\/pay$/.test(c.path));
		expect(pays).toHaveLength(1);
		expect(stripe.fake.state.invoices.size).toBe(1);
		expect(stripe.fake.state.charges.size).toBe(1);
		expect(inst.d1('SELECT status, amount FROM billing_orders')).toEqual([{ status: 'paid', amount: 14900 }]);
		await dialog.getByText('Close', { exact: true }).click();

		// On the domain, and in Settings -> Billing.
		await expect(page.getByText(/^Fix ordered on .*We will write to you about the access the work needs\. The work starts when you have given it, and ends with our written note that the domain is done\.$/)).toBeVisible();
		await expect(page.getByRole('button', { name: /Have us fix this domain/ })).toHaveCount(0);
		await page.goto(`${inst.url}/#/w/${workspaceId}/settings`);
		const billing = page.getByRole('region', { name: 'Billing' });
		await expect(billing.getByText(/^Visa ending 4242/)).toBeVisible({ timeout: 30_000 });
		await expect(billing.getByRole('row', { name: new RegExp(`${DOMAIN}.*Fix one domain.*\\$149 USD.*Paid`) })).toBeVisible();
		await expect(billing.getByRole('button', { name: 'Change card or see invoices' })).toBeVisible();

		// A member sees the offer, is told only the owner can buy, and has no way to pay.
		const m = await member(browser, inst, workspaceId, domainId);
		try {
			await expect(m.page.getByText(/^Fix ordered on /)).toBeVisible({ timeout: 60_000 }); // the order is visible to every role
			expect(await m.page.getByRole('button', { name: /Have us fix this domain/ }).count()).toBe(0);
			const settings = await m.page.goto(`${inst.url}/#/w/${workspaceId}/settings`).then(() => m.page.getByRole('region', { name: 'Billing' }));
			await expect(settings.getByText('Only the workspace owner can add a card or buy.')).toBeVisible({ timeout: 30_000 });
			await expect(settings.getByRole('button')).toHaveCount(0);
			expect((await m.page.request.post(`${inst.url}/api/billing/orders`, { headers: { 'X-Workspace-Id': workspaceId, Origin: inst.url }, data: { domain_id: domainId, offer: 'fix-one-domain' } })).status()).toBe(403);
		} finally {
			await m.ctx.close();
		}

		// The instance owner (OWNER_EMAIL) sees the order and marks it started; the domain says so.
		await page.goto(`${inst.url}/#/w/${workspaceId}/orders`);
		const row = page.getByRole('row', { name: new RegExp(DOMAIN) });
		await expect(row).toContainText(OWNER);
		await row.getByRole('button', { name: 'Mark started' }).click();
		await page.getByRole('dialog').getByRole('button', { name: 'Mark started' }).click();
		await expect(row.getByRole('button', { name: 'Mark done' })).toBeVisible();
		await page.goto(`${inst.url}/#/w/${workspaceId}/domains/${domainId}`);
		await expect(page.getByText(/^Work started on .*It ends with our written note that the domain is done\.$/)).toBeVisible({ timeout: 30_000 });
		expect(inst.d1('SELECT status FROM billing_orders')).toEqual([{ status: 'started' }]);
	} finally {
		await inst.stop();
		await stripe.close();
	}
});
