// Cloudflare first run on the hosted service, end to end, against throwaway instances: connect, every active zone is added and verified
// through the connection, nothing is written to DNS, and the person lands on the dashboard.
//
// Each test starts its own hosted instance with e2e/support/dev-instance.mjs (MODE=saas, fresh local D1, the in-memory fake Cloudflare
// of e2e/support/fake-cloudflare.mjs which also answers DNS-over-HTTPS), so api.cloudflare.com is never contacted. The fake has no OAuth
// screen, so the connection is made with a pasted token: everything after it is the same code as after the OAuth return.
// Hosted sign-up asks Cloudflare's Turnstile test endpoint (challenges.cloudflare.com) to check a dummy token: this spec needs that network access.
// Ports 8815-8820. Needs `npm run build:dashboard`. Run alone: npx playwright test e2e/cloudflare-first-run.spec.ts
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

/**
 * The setup status reads public DNS for the domain page itself (not through the fake), and the fake's made-up names do not exist there:
 * answer as if the name resolved and has no DMARC record yet, which is what the fake zone holds.
 */
async function publicDnsHasNoDmarc(page: Page) {
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
		await expect(page.getByText('Added 3 domains from Example Co. Nothing in your DNS was changed.').first()).toBeVisible();
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

test('hosted, the owner\'s state before this release (a claim from sign-up, then a connection whose saved zone list has that zone): the next overview verifies and links it with one live check, and Apply keeps p=reject and adds the report address', async ({ page }) => {
	const intake = 'rua.intake.example.net';
	const inst = await startInstance({ mode: 'hosted', port: 8820, tokenKey: true, vars: { INTAKE_DOMAIN: intake, HOSTED_CONNECT_REPORTS: 'all' } });
	try {
		await signUp(page, inst, 'owner@harbor-lane.org');
		const state = async () => (await (await fetch(`${inst.fake.url}/__state`)).json()) as FakeState & { zones: Array<{ id: string; name: string; account: { id: string } }>; zoneReads: Record<string, number> };
		const zone = (await state()).zones.find((z) => z.name === 'harbor-lane.org')!;
		// The live record: a policy, no report address.
		const seeded = await fetch(`${inst.fake.url}/client/v4/zones/${zone.id}/dns_records`, { method: 'POST', headers: { authorization: 'Bearer e2e-seed', 'content-type': 'application/json' }, body: JSON.stringify({ type: 'TXT', name: '_dmarc.harbor-lane.org', content: 'v=DMARC1; p=reject;', ttl: 1 }) });
		expect(seeded.status).toBe(200);
		// The claim first, then the connection (made through the API: no import ran), then its saved zone list, as the release before this left them.
		const made = await page.evaluate(async () => {
			const post = (path: string, body: unknown) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
			const claim = (await post('/api/domains', { domain: 'harbor-lane.org' })).status;
			const conn = await post('/api/cloudflare/connections', { token: 'e2e-fake-token-not-a-real-secret-0000' });
			return { claim, conn: conn.status, id: ((await conn.json()) as { connection: { id: string } }).connection.id };
		});
		expect([made.claim, made.conn]).toEqual([202, 201]);
		const ws = inst.d1("SELECT workspace_id FROM domain_claims WHERE domain = 'harbor-lane.org'")[0]!.workspace_id;
		inst.d1(`INSERT INTO cloudflare_connection_zones (connection_id, workspace_id, zone_id, zone_name, cf_account_id) VALUES ('${made.id}', '${ws}', '${zone.id}', 'harbor-lane.org', '${zone.account.id}')`);
		expect(inst.d1('SELECT domain FROM domains')).toEqual([]);
		const readsBefore = (await state()).zoneReads['harbor-lane.org'] ?? 0;

		const list = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/domains' && r.request().method() === 'GET');
		await page.goto(`${inst.url}/#/`);
		await page.reload();
		await list;
		expect(((await state()).zoneReads['harbor-lane.org'] ?? 0) - readsBefore).toBe(1); // exactly one live check
		await expect(page.getByRole('link', { name: 'harbor-lane.org', exact: true })).toBeVisible({ timeout: 60_000 });
		await expect(page.getByText('Waiting for verification')).toHaveCount(0);
		expect(inst.d1('SELECT domain, verified_via, cf_connection_id FROM domains')).toEqual([{ domain: 'harbor-lane.org', verified_via: 'cloudflare', cf_connection_id: made.id }]);
		expect(inst.d1('SELECT settled_at IS NOT NULL AS settled FROM domain_claims')).toEqual([{ settled: 1 }]);

		const id = inst.d1("SELECT id FROM domains WHERE domain = 'harbor-lane.org'")[0]!.id;
		const applied = await page.evaluate(async (domainId) => (await fetch(`/api/domains/${domainId}/apply-dmarc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ record: 'v=DMARC1; p=reject;' }) })).status, id);
		expect(applied).toBe(200);
		const written = Object.values((await state()).records).flat().filter((r) => r.name === '_dmarc.harbor-lane.org').map((r) => r.content);
		expect(written).toHaveLength(1);
		expect(written[0]).toMatch(/\bp=reject\b/);
		expect(written[0]).toContain(`rua=mailto:rua@${intake}`);
	} finally {
		await inst.stop();
	}
});

test('hosted with report intake: Apply writes the DMARC record with the report address, connects reports, and says "live" only after public DNS shows it', async ({ page }) => {
	const intake = 'rua.intake.example.net'; // configuration, not a product constant
	const inst = await startInstance({ mode: 'hosted', port: 8818, tokenKey: true, vars: { INTAKE_DOMAIN: intake, HOSTED_CONNECT_REPORTS: 'all' } });
	try {
		await signUp(page, inst, 'owner@harbor-lane.org');
		await page.getByRole('button', { name: 'Connect Cloudflare' }).click();
		await connectWithToken(page);
		await expect(page.getByRole('heading', { name: 'Domains', exact: true })).toBeVisible({ timeout: 60_000 });
		const id = inst.d1("SELECT id FROM domains WHERE domain = 'harbor-lane.org'")[0]!.id;

		await publicDnsHasNoDmarc(page);
		await page.goto(`${inst.url}/#/domains/${id}/setup/4`);
		await expect(page.getByText('The record Ready Set Mail will write')).toBeVisible({ timeout: 30_000 });
		await expect(page.getByText(`rua=mailto:rua@${intake}`).first()).toBeVisible();
		await expect(page.getByRole('button', { name: /^Copy/ })).toHaveCount(0); // Apply writes it: nothing to paste
		await page.getByRole('button', { name: 'Apply via Cloudflare' }).click();

		await expect(page.getByText('Reports are connected: nothing is left to set up.', { exact: false })).toBeVisible({ timeout: 30_000 });
		const records = ((await (await fetch(`${inst.fake.url}/__state`)).json()) as FakeState).records;
		expect(Object.values(records).flat().filter((r) => r.name === '_dmarc.harbor-lane.org').map((r) => r.content)).toEqual([`v=DMARC1; p=none; rua=mailto:rua@${intake}`]);
		expect(inst.d1(`SELECT rua_address, reports_connected_at IS NOT NULL AS connected FROM domains WHERE id = ${id}`)).toEqual([{ rua_address: `rua@${intake}`, connected: 1 }]);
		// "Live" only once public DNS (the fake's DNS-over-HTTPS) shows it: until the re-read it was written and waiting.
		await expect(page.getByText('Live in public DNS.')).toBeVisible({ timeout: 60_000 });
	} finally {
		await inst.stop();
	}
});

test('hosted where reports are not admitted (HOSTED_CONNECT_REPORTS=owner): the record is written without the address and the page says why', async ({ page }) => {
	const inst = await startInstance({ mode: 'hosted', port: 8819, tokenKey: true, vars: { INTAKE_DOMAIN: 'rua.intake.example.net', HOSTED_CONNECT_REPORTS: 'owner' } });
	try {
		await signUp(page, inst, 'owner@harbor-lane.org');
		await page.getByRole('button', { name: 'Connect Cloudflare' }).click();
		await connectWithToken(page);
		await expect(page.getByRole('heading', { name: 'Domains', exact: true })).toBeVisible({ timeout: 60_000 });
		const id = inst.d1("SELECT id FROM domains WHERE domain = 'harbor-lane.org'")[0]!.id;
		await publicDnsHasNoDmarc(page);
		await page.goto(`${inst.url}/#/domains/${id}/setup/4`);
		await expect(page.getByText('only the operator', { exact: false }).first()).toBeVisible({ timeout: 30_000 });
		await page.getByRole('button', { name: 'Apply via Cloudflare' }).click();
		await expect(page.getByText('Written to Cloudflare.', { exact: false }).first()).toBeVisible({ timeout: 30_000 });
		const records = ((await (await fetch(`${inst.fake.url}/__state`)).json()) as FakeState).records;
		expect(Object.values(records).flat().filter((r) => r.name === '_dmarc.harbor-lane.org').map((r) => r.content)).toEqual(['v=DMARC1; p=none']);
		expect(inst.d1(`SELECT rua_address FROM domains WHERE id = ${id}`)).toEqual([{ rua_address: '' }]);
	} finally {
		await inst.stop();
	}
});
