// Cloudflare first run on the hosted service, end to end, against throwaway instances: connect, every active zone is added and verified
// through the connection, nothing is written to DNS, and the person lands on the dashboard.
//
// Each test starts its own hosted instance with e2e/support/dev-instance.mjs (MODE=saas, fresh local D1, the in-memory fake Cloudflare
// of e2e/support/fake-cloudflare.mjs which also answers DNS-over-HTTPS), so api.cloudflare.com is never contacted. The fake has no OAuth
// screen, so the connection is made with a pasted token: everything after it is the same code as after the OAuth return.
// Hosted sign-up asks Cloudflare's Turnstile test endpoint (challenges.cloudflare.com) to check a dummy token: this spec needs that network access.
// Ports 8815-8820. Needs `npm run build:dashboard`. Run alone: npx playwright test e2e/cloudflare-first-run.spec.ts
import { expect, test, type Page } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { connectWithToken, enterDomain, signUp } from './support/signup';

interface Instance { url: string; logFile: string; fake: { url: string }; stop(): Promise<void>; verificationLinks(): string[]; d1(sql: string): Array<Record<string, unknown>> }
const nativeImport = new Function('u', 'return import(u)') as (u: string) => Promise<{ startInstance(o: Record<string, unknown>): Promise<Instance> }>;
const startInstance = async (o: Record<string, unknown>) => (await nativeImport(pathToFileURL(resolve(__dirname, 'support/dev-instance.mjs')).href)).startInstance(o);

test.setTimeout(240_000);

const ZONES = ['brightwave-mail.com', 'harbor-lane.org', 'quietfield.net'];
/** Public name servers of the fake zones: Cloudflare's, so S4 offers Connect Cloudflare. */
const CF_NS = Object.fromEntries(ZONES.map((z) => [z, ['ns1.ns.cloudflare.com']]));
type FakeState = { records: Record<string, Array<{ type: string; name: string; content: string }>> };
const dnsRecords = async (inst: Instance) => {
	const s = (await (await fetch(`${inst.fake.url}/__state`)).json()) as FakeState;
	return Object.values(s.records).flat().map((r) => `${r.type} ${r.name} ${r.content}`).sort();
};

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

test('hosted: connect, every zone is added and verified, nothing is written to DNS, and the dashboard shows them', async ({ page }) => {
	const inst = await startInstance({ mode: 'hosted', port: 8815, tokenKey: true, dohNs: CF_NS });
	try {
		await signUp(page, inst, 'owner@harbor-lane.org');
		const before = await dnsRecords(inst);

		await enterDomain(page, 'harbor-lane.org');
		await expect(page.getByRole('heading', { name: 'harbor-lane.org uses Cloudflare for DNS' })).toBeVisible();
		await page.getByRole('button', { name: 'Connect Cloudflare' }).click();
		await connectWithToken(page);

		// Every zone is added and verified; the review (C2) comes next, and nothing has been written yet.
		await expect(page.getByRole('heading', { name: /^1 change to harbor-lane\.org$/ })).toBeVisible({ timeout: 60_000 });
		await expect(page.getByText('Also in Example Co: 2 more domains, added and watched. Nothing was written to them.')).toBeVisible();
		expect(await dnsRecords(inst)).toEqual(before);
		await page.getByRole('button', { name: 'Skip for now' }).click();

		// The dashboard, with the domains.
		await expect(page.getByRole('heading', { name: 'Domains', exact: true })).toBeVisible({ timeout: 60_000 });
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
	const inst = await startInstance({ mode: 'hosted', port: 8816, tokenKey: true, dohNs: CF_NS, vars: { MAX_DOMAINS_PER_WORKSPACE: '2' } });
	try {
		await signUp(page, inst, 'owner@harbor-lane.org');
		await enterDomain(page, 'harbor-lane.org');
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

		await expect(page.getByRole('heading', { name: /change to / })).toBeVisible({ timeout: 60_000 }); // the review of the first of them
		await page.getByRole('button', { name: 'Skip for now' }).click();
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

test('hosted, a domain waiting for proof is on the overview (after the first-day card), and connecting Cloudflare verifies it with no click', async ({ page }) => {
	const inst = await startInstance({ mode: 'hosted', port: 8817, tokenKey: true, dohNs: CF_NS });
	try {
		await signUp(page, inst, 'owner@harbor-lane.org');
		const claimed = await page.evaluate(async () => (await fetch('/api/domains', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ domain: 'harbor-lane.org' }) })).status);
		expect(claimed).toBe(202);
		await page.goto(`${inst.url}/#/`);
		await page.reload();

		const waiting = page.getByRole('heading', { name: 'Waiting for verification' });
		const firstDay = page.getByRole('heading', { name: 'Waiting for the DNS record that proves harbor-lane.org' });
		await expect(waiting).toBeVisible();
		await expect(firstDay).toBeVisible();
		// the first-day card is the first thing on the page; the proof block follows it
		expect((await firstDay.boundingBox())!.y).toBeLessThan((await waiting.boundingBox())!.y);

		await page.getByRole('button', { name: 'Connect Cloudflare' }).first().click();
		await expect(page).toHaveURL(/setup\/cloudflare/);
		await connectWithToken(page);

		// Connecting verified it with no click; the review of it comes next.
		await expect(page.getByRole('heading', { name: /^\d+ changes? to / })).toBeVisible({ timeout: 60_000 });
		await page.getByRole('button', { name: 'Skip for now' }).click();
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
	const inst = await startInstance({ mode: 'hosted', port: 8820, tokenKey: true, dohNs: CF_NS, vars: { INTAKE_DOMAIN: intake, HOSTED_CONNECT_REPORTS: 'all' } });
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

		// This is the state from before the review existed: the dashboard itself does the one live check, so the review must not take the page over.
		await page.evaluate((w) => localStorage.setItem(`rsm_review_done:${w}`, '1'), ws);
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
	const inst = await startInstance({ mode: 'hosted', port: 8818, tokenKey: true, dohNs: CF_NS, vars: { INTAKE_DOMAIN: intake, HOSTED_CONNECT_REPORTS: 'all' } });
	try {
		await signUp(page, inst, 'owner@harbor-lane.org');
		await enterDomain(page, 'harbor-lane.org');
		await page.getByRole('button', { name: 'Connect Cloudflare' }).click();
		await connectWithToken(page);
		await page.getByRole('button', { name: 'Skip for now' }).click(); // C2 has its own tests below; this one is about the domain page's Apply
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
	const inst = await startInstance({ mode: 'hosted', port: 8819, tokenKey: true, dohNs: CF_NS, vars: { INTAKE_DOMAIN: 'rua.intake.example.net', HOSTED_CONNECT_REPORTS: 'owner' } });
	try {
		await signUp(page, inst, 'owner@harbor-lane.org');
		await enterDomain(page, 'harbor-lane.org');
		await page.getByRole('button', { name: 'Connect Cloudflare' }).click();
		await connectWithToken(page);
		await page.getByRole('button', { name: 'Skip for now' }).click(); // C2 has its own tests below; this one is about the domain page's Apply
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

test('hosted C2: connect, review the one change with the report address, Apply, and the dashboard says it is waiting for public DNS', async ({ page }) => {
	const intake = 'rua.intake.example.net';
	const inst = await startInstance({ mode: 'hosted', port: 8834, tokenKey: true, dohNs: CF_NS, vars: { INTAKE_DOMAIN: intake, HOSTED_CONNECT_REPORTS: 'all' } });
	try {
		await signUp(page, inst, 'owner@harbor-lane.org');
		await enterDomain(page, 'harbor-lane.org');
		await page.getByRole('button', { name: 'Connect Cloudflare' }).click();
		await connectWithToken(page);

		await expect(page.getByRole('heading', { name: '1 change to harbor-lane.org' })).toBeVisible({ timeout: 60_000 });
		await expect(page.getByText(/Step \d of \d/)).toHaveCount(0); // one counter or none: none
		await expect(page.locator('[data-testid^="change-dmarc:"]')).toContainText(`rua=mailto:rua@${intake}`);
		await expect(page.getByText('Not changed: SPF and DKIM.', { exact: false })).toBeVisible();
		await expect(page.getByRole('button', { name: /copy/i })).toHaveCount(0);
		await expect(page.getByText('only the operator', { exact: false })).toHaveCount(0);
		await page.getByRole('button', { name: 'Apply 1 change' }).click();

		await expect(page.getByRole('heading', { name: 'Domains', exact: true })).toBeVisible({ timeout: 60_000 });
		const records = ((await (await fetch(`${inst.fake.url}/__state`)).json()) as FakeState).records;
		expect(Object.values(records).flat().filter((r) => r.name === '_dmarc.harbor-lane.org').map((r) => r.content)).toEqual([`v=DMARC1; p=none; rua=mailto:rua@${intake}`]);
		expect(inst.d1("SELECT rua_address, reports_connected_at IS NOT NULL AS connected FROM domains WHERE domain = 'harbor-lane.org'")).toEqual([{ rua_address: `rua@${intake}`, connected: 1 }]);
		// D1: no red, no stepper; the card says what happens next.
		await expect(page.getByRole('region', { name: 'Get to your first answer' })).toHaveCount(0);
		// The record is written and read back from Cloudflare; public DNS (not the fake) does not show it, and the card says exactly that.
		await expect(page.getByRole('heading', { name: "Written to Cloudflare: waiting for public DNS to show harbor-lane.org's new record" })).toBeVisible({ timeout: 60_000 });
	} finally {
		await inst.stop();
	}
});

test('hosted C2 where reports are not admitted (HOSTED_CONNECT_REPORTS=owner): the review says the record has no report address, and the dashboard does not promise reports', async ({ page }) => {
	const inst = await startInstance({ mode: 'hosted', port: 8835, tokenKey: true, dohNs: CF_NS, vars: { INTAKE_DOMAIN: 'rua.intake.example.net', HOSTED_CONNECT_REPORTS: 'owner' } });
	try {
		await signUp(page, inst, 'owner@harbor-lane.org');
		await enterDomain(page, 'harbor-lane.org');
		await page.getByRole('button', { name: 'Connect Cloudflare' }).click();
		await connectWithToken(page);

		await expect(page.getByRole('heading', { name: '1 change to harbor-lane.org' })).toBeVisible({ timeout: 60_000 });
		await expect(page.getByTestId('reports-note')).toContainText('Reports are not connected for this workspace.');
		await expect(page.locator('[data-testid^="change-dmarc:"]')).not.toContainText('rua=');
		await page.getByRole('button', { name: 'Apply 1 change' }).click();

		await expect(page.getByRole('heading', { name: 'Domains', exact: true })).toBeVisible({ timeout: 60_000 });
		const records = ((await (await fetch(`${inst.fake.url}/__state`)).json()) as FakeState).records;
		expect(Object.values(records).flat().filter((r) => r.name === '_dmarc.harbor-lane.org').map((r) => r.content)).toEqual(['v=DMARC1; p=none']);
		await expect(page.getByTestId('first-day')).toBeVisible({ timeout: 60_000 });
		await expect(page.getByText('first reports are on their way', { exact: false })).toHaveCount(0);
		await expect(page.getByText("DMARC reports can't reach this workspace yet", { exact: false })).toBeVisible();
	} finally {
		await inst.stop();
	}
});
