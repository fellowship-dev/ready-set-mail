// The whole happy path of the new sign-up and first run on the hosted service, at phone width first and then wide, against a throwaway
// hosted instance and the in-memory fake Cloudflare (e2e/support/dev-instance.mjs; api.cloudflare.com is never contacted):
//   sign up → tell us about yourself → the code → the domain (S4) → Connect Cloudflare → review (C2) → Apply → the dashboard's first-day card.
// Hosted sign-up asks Cloudflare's Turnstile test endpoint (challenges.cloudflare.com) to check a dummy token: this spec needs that network access.
// Ports 8836-8837. Needs `npm run build:dashboard`. Run alone: bash scripts/e2e-devbox.sh e2e/first-run.spec.ts
import { expect, test, type Page } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { connectWithToken, enterDomain, enterMailedCode, fillAbout, fillSignUp, mailedCodes, s4Heading, type HostedInstance } from './support/signup';

interface Instance extends HostedInstance { stop(): Promise<void>; fake: { url: string }; d1(sql: string): Array<Record<string, unknown>> }
const nativeImport = new Function('u', 'return import(u)') as (u: string) => Promise<{ startInstance(o: Record<string, unknown>): Promise<Instance> }>;
const startInstance = async (o: Record<string, unknown>) => (await nativeImport(pathToFileURL(resolve(__dirname, 'support/dev-instance.mjs')).href)).startInstance(o);

test.setTimeout(300_000);

const DOMAIN = 'brightwave-mail.com';
const INTAKE = 'rua.intake.example.net';
const fits = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

for (const [width, height, port] of [[375, 812, 8836], [1440, 900, 8837]] as const) {
	test(`first run at ${width}px: sign up, about you, code, domain, connect, review, Apply, first-day card`, async ({ browser }) => {
		const inst = await startInstance({ mode: 'hosted', port, tokenKey: true, dohNs: { [DOMAIN]: ['ns1.ns.cloudflare.com'] }, vars: { INTAKE_DOMAIN: INTAKE, HOSTED_CONNECT_REPORTS: 'all' } });
		const ctx = await browser.newContext({ viewport: { width, height } });
		const page = await ctx.newPage();
		try {
			const before = mailedCodes(inst).length;
			await fillSignUp(page, inst, `dana@${DOMAIN}`);
			await fits(page);
			await fillAbout(page, { name: 'Dana Whitfield', organization: 'Brightwave Studio', whose: "My company's" });
			await enterMailedCode(page, inst, before);

			// S4: the domain, one line of public DNS, Cloudflare as the one primary
			await expect(s4Heading(page)).toBeVisible({ timeout: 30_000 });
			await fits(page);
			await enterDomain(page, DOMAIN);
			await expect(page.getByRole('heading', { name: `${DOMAIN} uses Cloudflare for DNS` })).toBeVisible();
			await expect(page.getByTestId('dns-result')).toContainText(`${DOMAIN}:`);
			await expect(page.getByRole('button', { name: "I'll add the records myself" })).toBeVisible();
			await expect(page.getByText(/can't be connected/i)).toHaveCount(0);
			await expect(page.getByText('Hand setup to a teammate')).toHaveCount(0);
			await fits(page);
			await page.getByRole('button', { name: 'Connect Cloudflare' }).click();
			await connectWithToken(page);

			// C2: what will be written, with the report address; nothing is written until Apply
			await expect(page.getByRole('heading', { name: new RegExp(`^1 change to ${DOMAIN.replace('.', '\\.')}$`) })).toBeVisible({ timeout: 60_000 });
			await expect(page.getByText('Step 3 of 3')).toBeVisible();
			await expect(page.locator('[data-testid^="change-dmarc:"]')).toContainText(`rua=mailto:rua@${INTAKE}`);
			await expect(page.getByText('Not changed: SPF and DKIM.', { exact: false })).toBeVisible();
			await fits(page);
			const state = async () => ((await (await fetch(`${inst.fake.url}/__state`)).json()) as { records: Record<string, Array<{ name: string; content: string }>> }).records;
			expect(Object.values(await state()).flat().filter((r) => r.name === `_dmarc.${DOMAIN}`).map((r) => r.content)).toEqual(['v=DMARC1; p=quarantine; pct=50']);
			await page.getByRole('button', { name: 'Apply 1 change' }).click();

			// D1: straight to the dashboard, with the first-day card
			await expect(page.getByRole('heading', { name: 'Domains', exact: true })).toBeVisible({ timeout: 60_000 });
			expect(Object.values(await state()).flat().filter((r) => r.name === `_dmarc.${DOMAIN}`).map((r) => r.content)).toEqual([`v=DMARC1; p=quarantine; pct=50; rua=mailto:rua@${INTAKE}`]); // the policy stays as it was
			// Public DNS (not the fake) does not show the record, and the card says exactly that rather than promising reports.
			await expect(page.getByRole('heading', { name: `Written to Cloudflare: waiting for public DNS to show ${DOMAIN}'s new record` })).toBeVisible({ timeout: 60_000 });
			await expect(page.getByText('first reports are on their way', { exact: false })).toHaveCount(0);
			await expect(page.getByRole('region', { name: 'Get to your first answer' })).toHaveCount(0);
			await fits(page);
			// A reload stays on the dashboard: the review is done, so it does not come back.
			await page.reload();
			await expect(page.getByRole('heading', { name: 'Domains', exact: true })).toBeVisible({ timeout: 60_000 });
			expect(new URL(page.url()).hash).not.toMatch(/setup/);
		} finally {
			await ctx.close();
			await inst.stop();
		}
	});
}
