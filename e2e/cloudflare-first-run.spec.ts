// Cloudflare first run on the hosted service, end to end, against throwaway instances: connect, every active zone is added and verified
// through the connection, nothing is written to DNS, and the person lands on the dashboard.
//
// Each test starts its own hosted instance with e2e/support/dev-instance.mjs (MODE=saas, fresh local D1, the in-memory fake Cloudflare
// of e2e/support/fake-cloudflare.mjs which also answers DNS-over-HTTPS), so api.cloudflare.com is never contacted. The fake has no OAuth
// screen, so the connection is made with a pasted token: everything after it is the same code as after the OAuth return.
// Hosted sign-up asks Cloudflare's Turnstile test endpoint (challenges.cloudflare.com) to check a dummy token: this spec needs that network access.
// Ports 8815-8817. Needs `npm run build:dashboard`. Run alone: npx playwright test e2e/cloudflare-first-run.spec.ts
import { expect, test, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

interface Instance { url: string; logFile: string; fake: { url: string }; stop(): Promise<void>; verificationLinks(): string[]; d1(sql: string): Array<Record<string, unknown>> }
const nativeImport = new Function('u', 'return import(u)') as (u: string) => Promise<{ startInstance(o: Record<string, unknown>): Promise<Instance> }>;
const startInstance = async (o: Record<string, unknown>) => (await nativeImport(pathToFileURL(resolve(__dirname, 'support/dev-instance.mjs')).href)).startInstance(o);

test.setTimeout(240_000);

const ZONES = ['brightwave-mail.com', 'harbor-lane.org', 'quietfield.net'];
type FakeState = { records: Record<string, Array<{ type: string; name: string; content: string }>> };
const dnsRecords = async (inst: Instance) => {
	const s = (await (await fetch(`${inst.fake.url}/__state`)).json()) as FakeState;
	return Object.values(s.records).flat().map((r) => `${r.type} ${r.name} ${r.content}`).sort();
};

/** The 6-digit codes the Worker mailed (the local send_email simulation logs each message's subject in the Worker's log). */
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

async function connectWithToken(page: Page) {
	await page.getByLabel('Cloudflare API token').fill('e2e-fake-token-not-a-real-secret-0000');
	await page.getByRole('button', { name: 'Connect', exact: true }).click();
}

test('hosted: connect, every zone is added and verified, nothing is written to DNS, and the dashboard shows them', async ({ page }) => {
	const inst = await startInstance({ mode: 'hosted', port: 8815, tokenKey: true });
	try {
		await signUp(page, inst, 'owner@harbor-lane.org');
		const before = await dnsRecords(inst);

		await page.getByRole('button', { name: 'Connect Cloudflare' }).click();
		await connectWithToken(page);

		// No zone list to tick and no DNS plan: the dashboard, with the domains and the status line.
		await expect(page.getByRole('heading', { name: 'Domains', exact: true })).toBeVisible({ timeout: 60_000 });
		await expect(page.getByText('Added 3 domains from Example Co. Nothing in DNS was changed.').first()).toBeVisible();
		for (const z of ZONES) await expect(page.getByRole('link', { name: z, exact: true })).toBeVisible();
		await expect(page.getByText('Waiting for verification')).toHaveCount(0);

		expect(inst.d1('SELECT domain, verified_via, cf_zone_id IS NOT NULL AS zone, cf_account_id IS NOT NULL AS account FROM domains ORDER BY domain')).toEqual(
			ZONES.map((domain) => ({ domain, verified_via: 'cloudflare', zone: 1, account: 1 })),
		);
		expect(inst.d1("SELECT resource_name FROM audit_log WHERE action = 'domain.proof' ORDER BY resource_name").map((r) => r.resource_name)).toEqual(ZONES);
		expect(await dnsRecords(inst)).toEqual(before); // importing reads public DNS and writes none
	} finally {
		await inst.stop();
	}
});

test('hosted, a plan that covers fewer domains than there are zones: the list, then only the chosen ones', async ({ page }) => {
	const inst = await startInstance({ mode: 'hosted', port: 8816, tokenKey: true, vars: { MAX_DOMAINS_PER_WORKSPACE: '2' } });
	try {
		await signUp(page, inst, 'owner@harbor-lane.org');
		await page.getByRole('button', { name: 'Connect Cloudflare' }).click();
		await connectWithToken(page);

		await expect(page.getByText('Your plan covers 2 domains. Choose which to add.')).toBeVisible({ timeout: 60_000 });
		expect(inst.d1('SELECT domain FROM domains')).toEqual([]); // nothing was added before they chose
		await page.getByRole('checkbox', { name: 'brightwave-mail.com' }).check();
		await page.getByRole('checkbox', { name: 'quietfield.net' }).check();
		await page.getByRole('checkbox', { name: 'harbor-lane.org' }).check();
		await expect(page.getByText('3 of 2 chosen')).toBeVisible();
		await expect(page.getByRole('button', { name: 'Add 3 domains' })).toBeDisabled();
		await page.getByRole('checkbox', { name: 'harbor-lane.org' }).uncheck();
		await page.getByRole('button', { name: 'Add 2 domains' }).click();

		await expect(page.getByRole('heading', { name: 'Domains', exact: true })).toBeVisible({ timeout: 60_000 });
		await expect(page.getByRole('link', { name: 'brightwave-mail.com', exact: true })).toBeVisible();
		await expect(page.getByRole('link', { name: 'quietfield.net', exact: true })).toBeVisible();
		expect(inst.d1('SELECT domain, verified_via FROM domains ORDER BY domain')).toEqual([
			{ domain: 'brightwave-mail.com', verified_via: 'cloudflare' },
			{ domain: 'quietfield.net', verified_via: 'cloudflare' },
		]);
	} finally {
		await inst.stop();
	}
});

test('hosted, a domain waiting for proof is first on the overview, and connecting Cloudflare verifies it with no click', async ({ page }) => {
	const inst = await startInstance({ mode: 'hosted', port: 8817, tokenKey: true });
	try {
		await signUp(page, inst, 'owner@harbor-lane.org');
		const claimed = await page.evaluate(async () => (await fetch('/api/domains', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ domain: 'harbor-lane.org' }) })).status);
		expect(claimed).toBe(202);
		await page.goto(`${inst.url}/#/`);
		await page.reload();

		const waiting = page.getByRole('heading', { name: 'Waiting for verification' });
		const firstAnswer = page.getByRole('heading', { name: 'Get to your first answer' });
		await expect(waiting).toBeVisible();
		await expect(firstAnswer).toBeVisible();
		expect((await waiting.boundingBox())!.y).toBeLessThan((await firstAnswer.boundingBox())!.y);

		await page.getByRole('button', { name: 'Connect Cloudflare' }).first().click();
		await expect(page).toHaveURL(/setup\/cloudflare/);
		await connectWithToken(page);

		await expect(page.getByRole('link', { name: 'harbor-lane.org', exact: true })).toBeVisible({ timeout: 60_000 });
		await expect(page.getByText('Waiting for verification')).toHaveCount(0);
		expect(inst.d1('SELECT domain, verified_via FROM domains WHERE domain = \'harbor-lane.org\'')).toEqual([{ domain: 'harbor-lane.org', verified_via: 'cloudflare' }]);
		expect(inst.d1('SELECT settled_at IS NOT NULL AS settled FROM domain_claims')).toEqual([{ settled: 1 }]);
	} finally {
		await inst.stop();
	}
});
