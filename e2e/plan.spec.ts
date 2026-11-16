// The hosted plan in a real browser, end to end (docs/billing.md, "Pay as you go"), against a throwaway hosted instance with HOSTED_PLAN=free_one_domain
// (e2e/support/dev-instance.mjs: fresh local D1, the fake Cloudflare that proves zones) and the in-repo fake Stripe run as a local HTTP server
// (e2e/support/fake-stripe.mjs; the Worker reaches it through the test-only STRIPE_API_BASE and it delivers signed webhooks like Stripe).
// api.stripe.com is never contacted. Hosted sign-up asks Cloudflare's Turnstile test endpoint to check a dummy token: this spec needs that network access.
//
//   1. a second domain with no card: confirm -> Add a card -> Stripe -> back to the SAME confirm showing the card -> one click -> added and billed
//      (the first invoice is charged now); a third with the card on file: one click, nothing charged at the click; removing one lowers the bill
//   2. creating a second workspace: not eligible -> "Add a card to create more workspaces" -> Stripe -> the workspace exists and the person is in it;
//      eligible (already paying) -> created at once
//   3. a renewal that fails: the plan says so on every page, adding is paused, the card button is the way out; a retry that works brings it back
//   4. a card that needs the bank at the first payment: the domain is visibly pending until the bank has confirmed it
//   5. a member cannot start the plan or add a paid domain
// Ports 8851-8855. Needs `npm run build:dashboard`. Run alone: npx playwright test e2e/plan.spec.ts
import { expect, test, type Browser, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

interface Instance { url: string; logFile: string; stop(): Promise<void>; d1(sql: string): Array<Record<string, unknown>> }
interface Fake {
	state: { subscriptions: Map<string, any>; subscriptionItems: Map<string, any>; invoices: Map<string, any>; customers: Map<string, any> };
	calls: Array<{ method: string; path: string }>;
	setCardBehavior(customerId: string, kind: 'ok' | 'decline' | 'requires_action'): void;
	advancePeriod(subscriptionId: string, opts?: { card?: string }): unknown;
	retryPayment(subscriptionId: string, opts?: { card?: string }): unknown;
	completeInvoiceAction(invoiceId: string, action: 'succeed' | 'fail'): unknown;
}
interface FakeStripe { url: string; close(): Promise<void>; fake: Fake }
const nativeImport = new Function('u', 'return import(u)') as (u: string) => Promise<any>;
const here = (f: string) => pathToFileURL(resolve(__dirname, f)).href;
const startInstance = async (o: Record<string, unknown>): Promise<Instance> => (await nativeImport(here('support/dev-instance.mjs'))).startInstance(o);
const startFakeStripe = async (o: Record<string, unknown>): Promise<FakeStripe> => (await nativeImport(here('support/fake-stripe.mjs'))).startFakeStripe(o);

test.setTimeout(300_000);
const WHSEC = 'whsec_e2eplansecret0123456789';
const OWNER = 'owner@harbor-lane.org';

const mailedCodes = (inst: Instance) =>
	existsSync(inst.logFile) ? [...readFileSync(inst.logFile, 'utf8').replace(/\x1b\[[0-9;]*m/g, '').matchAll(/(\d{6}) is your Ready Set Mail code/g)].map((m) => m[1]!) : [];

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
const workspaceOf = (inst: Instance, email: string) => inst.d1(`SELECT m.workspace_id AS w FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = '${email}' AND m.role = 'owner' ORDER BY m.created_at LIMIT 1`)[0]!.w as string;

/** An instance with the plan on, an owner who already holds their free domain, and a Cloudflare account whose other zones can be proven on the spot. */
async function world(port: number, extra: Record<string, unknown> = {}) {
	const stripe = await startFakeStripe({ port: 0, webhookUrl: `http://127.0.0.1:${port}/api/stripe/webhook`, webhookSecret: WHSEC });
	const inst = await startInstance({
		mode: 'hosted', port, tokenKey: true,
		vars: { STRIPE_SECRET_KEY: 'rk_test_e2eplankey0123456789', STRIPE_WEBHOOK_SECRET: WHSEC, STRIPE_API_BASE: stripe.url, OWNER_EMAIL: 'operator@harbor-lane.org', HOSTED_PLAN: 'free_one_domain', BOOKING_URL: 'https://cal.example.com/max', ...extra },
	});
	return { stripe, inst, stop: async () => { await inst.stop(); await stripe.close(); } };
}
async function ownerWithFreeDomain(page: Page, inst: Instance) {
	await signUp(page, inst, OWNER);
	const ws = workspaceOf(inst, OWNER);
	inst.d1(`INSERT INTO domains (workspace_id, domain, rua_address, verified_via, org_domain) VALUES ('${ws}', 'free-one.example', '', 'txt', 'free-one.example')`);
	const h = { 'X-Workspace-Id': ws, Origin: inst.url };
	const c = ((await (await page.request.post(`${inst.url}/api/cloudflare/connections`, { headers: h, data: { token: 'e2e-fake-token-not-a-real-secret-0000', label: 'Example Co' } })).json()) as any).connection;
	await page.request.post(`${inst.url}/api/cloudflare/connections/${c.id}/import`, { headers: h, data: {} }); // the zones that do not fit the free domain are returned, not added
	await page.goto(`${inst.url}/#/w/${ws}/add`);
	await page.reload();
	return ws;
}
const quantities = (s: FakeStripe) => [...s.fake.state.subscriptionItems.values()].map((i) => i.quantity);
const addCardOnStripe = async (page: Page) => {
	await expect(page.getByText('Save a card (session')).toBeVisible({ timeout: 30_000 });
	await page.getByRole('link', { name: 'Use test card 4242' }).click();
};

test('a second domain: confirm, add a card, back to the same confirm, one click; a third with the card on file; removing one lowers the bill', async ({ page }) => {
	const { stripe, inst, stop } = await world(8851);
	try {
		const ws = await ownerWithFreeDomain(page, inst);
		// The free first domain never shows a price anywhere.
		await page.goto(`${inst.url}/#/w/${ws}/settings`);
		await expect(page.getByRole('region', { name: 'Billing' }).getByText('Free: one domain with all its subdomains.')).toBeVisible({ timeout: 30_000 });
		await page.goto(`${inst.url}/#/w/${ws}/add`);

		// The other zones of the Cloudflare account: pick one; the confirm without a card.
		await page.getByRole('checkbox', { name: 'quietfield.net' }).click();
		await page.getByRole('button', { name: 'Add', exact: true }).click();
		await expect(page.getByRole('heading', { name: 'Add quietfield.net' })).toBeVisible();
		await expect(page.getByText('$5 a month for this domain. Subdomains included. Cancel any time.')).toBeVisible({ timeout: 30_000 });
		await expect(page.getByRole('button', { name: /^Add for/ })).toHaveCount(0);
		await page.getByRole('button', { name: 'Add a card to continue' }).click();
		await addCardOnStripe(page);

		// Back on the SAME confirm, now with the card and Stripe's own first invoice; one click.
		await expect(page.getByText(/^\$5 now, then \$5 a month from [A-Z][a-z]{2} \d{1,2}\. Card Visa ···4242\.$/)).toBeVisible({ timeout: 30_000 });
		expect(stripe.fake.state.subscriptions.size).toBe(0); // looking charged nothing and made nothing
		await page.getByRole('button', { name: 'Pay $5 and add' }).dblclick();
		await expect(page.getByText('Added. $5 paid now, then $5 a month.')).toBeVisible({ timeout: 60_000 });
		await expect(page).toHaveURL(new RegExp(`#/w/${ws}$`)); // the domain list, no detour
		expect(quantities(stripe)).toEqual([1]);
		expect([...stripe.fake.state.invoices.values()].filter((i) => i.billing_reason === 'subscription_create' && i.amount_paid === 500)).toHaveLength(1);
		expect(inst.d1('SELECT plan FROM workspaces WHERE id = ?'.replace('?', `'${ws}'`))).toEqual([{ plan: 'payg' }]);
		expect(inst.d1("SELECT domain, verified_via FROM domains WHERE domain = 'quietfield.net'")).toEqual([{ domain: 'quietfield.net', verified_via: 'cloudflare' }]);

		// A third domain with the card on file: Stripe's next invoice is stated, one click, nothing charged at the click.
		await page.goto(`${inst.url}/#/w/${ws}/add`);
		await page.getByRole('checkbox', { name: 'harbor-lane.org' }).click();
		await page.getByRole('button', { name: 'Add', exact: true }).click();
		await expect(page.getByText('$5 a month for this domain, from today.')).toBeVisible({ timeout: 30_000 });
		await expect(page.getByText(/^Your next invoice on [A-Z][a-z]{2} \d{1,2} to Visa ···4242: \$\d+\.\d{2} \(this month's part plus the next\)\.$/)).toBeVisible();
		const paidBefore = [...stripe.fake.state.invoices.values()].filter((i) => i.amount_paid > 0).length;
		await page.getByRole('button', { name: 'Add for $5 a month' }).click();
		await expect(page.getByText('Added. $5 a month from today.')).toBeVisible({ timeout: 60_000 });
		expect(quantities(stripe)).toEqual([2]);
		expect([...stripe.fake.state.invoices.values()].filter((i) => i.amount_paid > 0).length).toBe(paidBefore);

		// Settings -> Billing: the plan, the amount, the billable domains.
		await page.goto(`${inst.url}/#/w/${ws}/settings`);
		const billing = page.getByRole('region', { name: 'Billing' });
		await expect(billing.getByRole('heading', { name: 'Pay as you go' })).toBeVisible({ timeout: 30_000 });
		await expect(billing.getByText('Your first domain is free. Each domain beyond it is $5 a month. Subdomains are included.')).toBeVisible();
		await expect(billing.getByText('quietfield.net')).toBeVisible();

		// Removing a paid domain says what happens to the bill; removing the free one says nothing about money.
		const id = inst.d1("SELECT id FROM domains WHERE domain = 'harbor-lane.org'")[0]!.id;
		await page.goto(`${inst.url}/#/w/${ws}/domains/${id}/settings`);
		await page.getByRole('button', { name: 'Remove domain' }).click();
		await expect(page.getByRole('dialog').getByText(/Your bill goes down by \$5 a month; the unused part comes off your next invoice\./)).toBeVisible({ timeout: 30_000 });
		await page.getByRole('dialog').getByRole('button', { name: 'Yes, remove' }).click();
		await expect.poll(() => quantities(stripe)[0], { timeout: 30_000 }).toBe(1);
		const freeId = inst.d1("SELECT id FROM domains WHERE domain = 'free-one.example'")[0]!.id;
		await page.goto(`${inst.url}/#/w/${ws}/domains/${freeId}/settings`);
		await page.getByRole('button', { name: 'Remove domain' }).click();
		await expect(page.getByRole('dialog').getByText(/bill/i)).toHaveCount(0);
	} finally {
		await stop();
	}
});

test('a second workspace: a person who holds their free domain adds a card first; one who already pays creates it at once', async ({ page }) => {
	const { stripe, inst, stop } = await world(8852);
	try {
		await signUp(page, inst, OWNER);
		const ws = workspaceOf(inst, OWNER);
		await page.goto(`${inst.url}/#/w/${ws}/`);
		await page.getByRole('button', { name: /^Workspace: .*Switch workspace$/ }).click();
		await page.getByRole('menuitem', { name: 'Create workspace' }).click();
		await page.getByLabel('Workspace name').fill('Client A');
		await page.getByRole('button', { name: 'Create workspace' }).click();
		await expect(page.getByText('Add a card to create more workspaces')).toBeVisible({ timeout: 30_000 });
		await expect(page.getByText('Each domain in it is $5 a month. Cancel any time.')).toBeVisible();
		expect(inst.d1("SELECT COUNT(*) AS n FROM workspaces WHERE name = 'Client A'")).toEqual([{ n: 0 }]); // nothing exists before the card
		await page.getByRole('button', { name: 'Add a card to continue' }).click();
		await addCardOnStripe(page);
		await expect(page.getByText('Workspace created', { exact: true })).toBeVisible({ timeout: 30_000 });
		const created = inst.d1("SELECT id, plan, free_owner_user_id AS f FROM workspaces WHERE name = 'Client A'");
		expect(created).toEqual([expect.objectContaining({ plan: 'payg', f: null })]);
		await expect(page).toHaveURL(new RegExp(`#/w/${created[0]!.id}`));
		expect(quantities(stripe)).toEqual([0]); // a subscription at quantity 0: nothing to pay yet

		// Already paying: the next one is created at once, without a card, and holds no free domain.
		await page.getByRole('button', { name: /^Workspace: .*Switch workspace$/ }).click();
		await page.getByRole('menuitem', { name: 'Create workspace' }).click();
		await page.getByLabel('Workspace name').fill('Client B');
		await page.getByRole('button', { name: 'Create workspace' }).click();
		await expect.poll(() => inst.d1("SELECT COUNT(*) AS n FROM workspaces WHERE name = 'Client B'")[0]!.n, { timeout: 30_000 }).toBe(1);
		expect(inst.d1("SELECT free_owner_user_id AS f FROM workspaces WHERE name = 'Client B'")).toEqual([{ f: null }]);
	} finally {
		await stop();
	}
});

test('a renewal that fails: the plan says so, adding is paused, the card is the way out, and a retry that works brings it back', async ({ page }) => {
	const { stripe, inst, stop } = await world(8853);
	try {
		const ws = await ownerWithFreeDomain(page, inst);
		await page.getByRole('checkbox', { name: 'quietfield.net' }).click();
		await page.getByRole('button', { name: 'Add', exact: true }).click();
		await page.getByRole('button', { name: 'Add a card to continue' }).click();
		await addCardOnStripe(page);
		await page.getByRole('button', { name: 'Pay $5 and add' }).click();
		await expect(page.getByText('Added. $5 paid now, then $5 a month.')).toBeVisible({ timeout: 60_000 });
		const sub = [...stripe.fake.state.subscriptions.values()][0]!;
		stripe.fake.setCardBehavior(sub.customer, 'decline');
		stripe.fake.advancePeriod(sub.id);
		await page.reload();
		await expect(page.getByText('Your last payment did not go through')).toBeVisible({ timeout: 30_000 });
		await expect(page.getByRole('button', { name: 'Update your card' })).toBeVisible();
		// Domains keep working; adding more is paused with the plain sentence.
		await page.goto(`${inst.url}/#/w/${ws}/add`);
		await page.getByRole('checkbox', { name: 'harbor-lane.org' }).click();
		await page.getByRole('button', { name: 'Add', exact: true }).click();
		await expect(page.getByText('Your last payment did not go through. Update your card to add more domains.')).toBeVisible({ timeout: 30_000 });
		stripe.fake.retryPayment(sub.id, { card: 'ok' });
		await page.goto(`${inst.url}/#/w/${ws}/`);
		await page.reload();
		await expect(page.getByText('Your last payment did not go through')).toHaveCount(0, { timeout: 30_000 });
	} finally {
		await stop();
	}
});

test('a card that needs the bank at the first payment: the domain is pending until the bank has confirmed it', async ({ page, context }) => {
	const { stripe, inst, stop } = await world(8854);
	try {
		const ws = await ownerWithFreeDomain(page, inst);
		await page.getByRole('checkbox', { name: 'quietfield.net' }).click();
		await page.getByRole('button', { name: 'Add', exact: true }).click();
		await page.getByRole('button', { name: 'Add a card to continue' }).click();
		await expect(page.getByText('Save a card (session')).toBeVisible({ timeout: 30_000 });
		await page.getByRole('link', { name: 'Card that needs authentication' }).click();
		const popup = context.waitForEvent('page', { timeout: 30_000 }).catch(() => null);
		await page.getByRole('button', { name: 'Pay $5 and add' }).click({ timeout: 30_000 });
		await expect(page.getByText("Waiting for your bank's confirmation")).toBeVisible({ timeout: 60_000 });
		await popup;
		expect(inst.d1("SELECT COUNT(*) AS n FROM domains WHERE payment_pending_at IS NOT NULL")).toEqual([{ n: 1 }]);
		expect(inst.d1('SELECT status FROM workspace_subscriptions')).toEqual([{ status: 'incomplete' }]);
		const invoice = [...stripe.fake.state.invoices.values()][0]!;
		// ONE alert for the wait, with the way back to the bank's page and the way out
		await expect(page.getByText("Waiting for your bank's confirmation")).toHaveCount(1);
		await expect(page.getByRole('link', { name: /Try again/ })).toHaveCount(1);
		await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
		stripe.fake.completeInvoiceAction(invoice.id, 'succeed');
		await expect(page.getByText('Added. $5 paid now, then $5 a month.')).toBeVisible({ timeout: 60_000 });
		await expect.poll(() => inst.d1("SELECT COUNT(*) AS n FROM domains WHERE payment_pending_at IS NOT NULL")[0]!.n, { timeout: 30_000 }).toBe(0);
		expect(inst.d1('SELECT status FROM workspace_subscriptions')).toEqual([{ status: 'active' }]);
		void ws;
	} finally {
		await stop();
	}
});

async function member(browser: Browser, inst: Instance, workspaceId: string, email: string) {
	const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
	const page = await ctx.newPage();
	await signUp(page, inst, email);
	inst.d1(`INSERT INTO memberships (workspace_id, user_id, role) SELECT '${workspaceId}', id, 'member' FROM users WHERE email = '${email}'`);
	return { ctx, page };
}

test('a member cannot start the plan or add a paid domain', async ({ page, browser }) => {
	const { stripe, inst, stop } = await world(8855);
	try {
		const ws = await ownerWithFreeDomain(page, inst);
		const m = await member(browser, inst, ws, 'member@harbor-lane.org');
		try {
			await m.page.goto(`${inst.url}/#/w/${ws}/settings`);
			const billing = m.page.getByRole('region', { name: 'Billing' });
			await expect(billing.getByText('Ask the workspace owner to add more domains.')).toBeVisible({ timeout: 30_000 });
			await expect(billing.getByRole('button', { name: /Start pay as you go/ })).toHaveCount(0);
			const r = await m.page.request.post(`${inst.url}/api/billing/domains`, { headers: { 'X-Workspace-Id': ws, Origin: inst.url }, data: { domain: 'quietfield.net', expected_amount: 500, expected_currency: 'usd', expected_charge: 500 } });
			expect(r.status()).toBe(403);
			expect(stripe.fake.state.subscriptions.size).toBe(0);
		} finally {
			await m.ctx.close();
		}
	} finally {
		await stop();
	}
});
