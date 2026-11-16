// The shared setup of the plan's browser specs (e2e/plan.spec.ts, e2e/ux-walk.spec.ts): a hosted instance with HOSTED_PLAN=free_one_domain, the in-repo fake Stripe
// run as a local HTTP server (the Worker reaches it through the test-only STRIPE_API_BASE; it delivers signed webhooks like Stripe), a signed-up owner who holds
// their free domain, and a Cloudflare account whose other zones can be proven on the spot. api.stripe.com is never contacted.
import { expect, type Browser, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export interface Instance { url: string; logFile: string; stop(): Promise<void>; d1(sql: string): Array<Record<string, unknown>> }
export interface Fake {
	state: { subscriptions: Map<string, any>; subscriptionItems: Map<string, any>; invoices: Map<string, any>; customers: Map<string, any> };
	calls: Array<{ method: string; path: string }>;
	setCardBehavior(customerId: string, kind: 'ok' | 'decline' | 'requires_action'): void;
	advancePeriod(subscriptionId: string, opts?: { card?: string }): unknown;
	retryPayment(subscriptionId: string, opts?: { card?: string }): unknown;
	completeInvoiceAction(invoiceId: string, action: 'succeed' | 'fail'): unknown;
}
export interface FakeStripe { url: string; close(): Promise<void>; fake: Fake }
const nativeImport = new Function('u', 'return import(u)') as (u: string) => Promise<any>;
const here = (f: string) => pathToFileURL(resolve(__dirname, '..', f)).href;
const startInstance = async (o: Record<string, unknown>): Promise<Instance> => (await nativeImport(here('support/dev-instance.mjs'))).startInstance(o);
const startFakeStripe = async (o: Record<string, unknown>): Promise<FakeStripe> => (await nativeImport(here('support/fake-stripe.mjs'))).startFakeStripe(o);


export const WHSEC = 'whsec_e2eplansecret0123456789';
export const OWNER = 'owner@harbor-lane.org';

export const mailedCodes = (inst: Instance) =>
	existsSync(inst.logFile) ? [...readFileSync(inst.logFile, 'utf8').replace(/\x1b\[[0-9;]*m/g, '').matchAll(/(\d{6}) is your Ready Set Mail code/g)].map((m) => m[1]!) : [];

export async function signUp(page: Page, inst: Instance, email: string) {
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
export const workspaceOf = (inst: Instance, email: string) => inst.d1(`SELECT m.workspace_id AS w FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = '${email}' AND m.role = 'owner' ORDER BY m.created_at LIMIT 1`)[0]!.w as string;

/** An instance with the plan on, an owner who already holds their free domain, and a Cloudflare account whose other zones can be proven on the spot. */
export async function world(port: number, extra: Record<string, unknown> = {}) {
	const stripe = await startFakeStripe({ port: 0, webhookUrl: `http://127.0.0.1:${port}/api/stripe/webhook`, webhookSecret: WHSEC });
	const inst = await startInstance({
		mode: 'hosted', port, tokenKey: true,
		vars: { STRIPE_SECRET_KEY: 'rk_test_e2eplankey0123456789', STRIPE_WEBHOOK_SECRET: WHSEC, STRIPE_API_BASE: stripe.url, OWNER_EMAIL: 'operator@harbor-lane.org', HOSTED_PLAN: 'free_one_domain', BOOKING_URL: 'https://cal.example.com/max', ...extra },
	});
	return { stripe, inst, stop: async () => { await inst.stop(); await stripe.close(); } };
}
export async function ownerWithFreeDomain(page: Page, inst: Instance) {
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
export const quantities = (s: FakeStripe) => [...s.fake.state.subscriptionItems.values()].map((i) => i.quantity);
export const addCardOnStripe = async (page: Page) => {
	await expect(page.getByText('Save a card (session')).toBeVisible({ timeout: 30_000 });
	await page.getByRole('link', { name: 'Use test card 4242' }).click();
};


/** Another person, signed up on their own (their own free workspace), made a member of `workspaceId` behind the API's back. */
export async function member(browser: Browser, inst: Instance, workspaceId: string, email: string, role: 'member' | 'admin' = 'member') {
	const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
	const page = await ctx.newPage();
	await signUp(page, inst, email);
	inst.d1(`INSERT INTO memberships (workspace_id, user_id, role) SELECT '${workspaceId}', id, '${role}' FROM users WHERE email = '${email}'`);
	return { ctx, page };
}
