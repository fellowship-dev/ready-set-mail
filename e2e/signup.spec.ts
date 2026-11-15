// Hosted sign-up, the three screens, in a real browser against throwaway hosted instances (e2e/support/dev-instance.mjs: MODE=saas, fresh
// local D1, Cloudflare's always-pass Turnstile test keys, the local send_email simulation that logs each code's subject):
//   S1 email and password → S2 "Tell us about yourself" → S3 "Check your inbox" → the app.
// The URL holds the step and the server's pending attempt says which screen is right (reload, revisit, back). Phone width first (375), then 1440.
// Hosted sign-up asks Cloudflare's Turnstile test endpoint (challenges.cloudflare.com) to check a dummy token: this spec needs that network access.
// Ports 8830-8833. Needs `npm run build:dashboard`. Run alone: bash scripts/e2e-devbox.sh e2e/signup.spec.ts
import { expect, test, type Page } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { enterMailedCode, fillAbout, fillSignUp, mailedCodes, s4Heading, type HostedInstance } from './support/signup';

interface Instance extends HostedInstance { stop(): Promise<void>; d1(sql: string): Array<Record<string, unknown>> }
const nativeImport = new Function('u', 'return import(u)') as (u: string) => Promise<{ startInstance(o: Record<string, unknown>): Promise<Instance> }>;
const startInstance = async (o: Record<string, unknown>) => (await nativeImport(pathToFileURL(resolve(__dirname, 'support/dev-instance.mjs')).href)).startInstance(o);

test.setTimeout(240_000);

const hash = (page: Page) => new URL(page.url()).hash;
/** Nothing sticks out sideways: the page is no wider than the window. */
const fitsTheWindow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

for (const [width, height, port] of [[375, 812, 8830], [1440, 900, 8831]] as const) {
	test(`hosted sign-up at ${width}px: S1, S2, S3, then the app; the URL holds the step and a reload lands on the right screen`, async ({ browser }) => {
		const inst = await startInstance({ mode: 'hosted', port, tokenKey: true });
		const ctx = await browser.newContext({ viewport: { width, height } });
		const page = await ctx.newPage();
		try {
			// S1
			const before = mailedCodes(inst).length;
			await page.goto(`${inst.url}/#/signup?domain=harbor-lane.org`);
			await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
			expect(hash(page)).toBe('#/signup');
			await expect(page.getByText('harbor-lane.org')).toHaveCount(0); // the checker's domain waits for S4
			await expect(page.getByRole('button', { name: 'Continue' })).toHaveCount(1);
			await fitsTheWindow(page);
			await fillSignUp(page, inst, 'dana@brightwave-mail.com');

			// S2: the code email is already on its way
			expect(hash(page)).toBe('#/signup/about');
			await expect(page.getByText('dana@brightwave-mail.com')).toBeVisible();
			await expect.poll(() => mailedCodes(inst).length).toBeGreaterThan(before);
			await fitsTheWindow(page);
			// A reload comes back to S2; so does asking for S1 while the attempt waits
			await page.reload();
			await expect(page.getByRole('heading', { name: 'Tell us about yourself' })).toBeVisible();
			await page.goto(`${inst.url}/#/signup`);
			await expect(page.getByRole('heading', { name: 'Tell us about yourself' })).toBeVisible();
			// Asking for S3 before S2 is saved comes back to S2
			await page.goto(`${inst.url}/#/signup/code`);
			await expect(page.getByRole('heading', { name: 'Tell us about yourself' })).toBeVisible();
			expect(hash(page)).toBe('#/signup/about');
			await fillAbout(page, { name: 'Dana Whitfield', organization: 'Brightwave Studio', whose: "My company's" });

			// S3
			expect(hash(page)).toBe('#/signup/code');
			await expect(page.getByText(/It's valid for 10 minutes\./)).toBeVisible();
			const code = page.getByLabel('6-digit code');
			await expect(code).toBeFocused();
			await expect(code).toHaveAttribute('autocomplete', 'one-time-code');
			await expect(code).toHaveAttribute('inputmode', 'numeric');
			await expect(page.getByTestId('human-check')).toHaveCount(0); // no bot check on this screen before "Not seeing it?"
			await fitsTheWindow(page);
			await page.reload();
			await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible(); // the server's state, not the page's
			await page.goto(`${inst.url}/#/signup`);
			await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();
			await expect(page.getByLabel('6-digit code')).toBeVisible();

			// A wrong code, then the right one (pasted with a space, as people do)
			const right = mailedCodes(inst).at(-1)!;
			const wrong = String((Number(right) + 1) % 1_000_000).padStart(6, '0');
			await page.getByLabel('6-digit code').pressSequentially(wrong);
			await expect(page.getByText("That code isn't right. Check the latest email.")).toBeVisible();
			await page.getByLabel('6-digit code').fill(`${right.slice(0, 3)} ${right.slice(3)}`);
			await expect(s4Heading(page)).toBeVisible({ timeout: 30_000 });

			// The account and the first workspace took the answers
			const me = (await (await page.request.get(`${inst.url}/api/me`)).json()) as { user: { name: string; email: string }; whose_email: string; agency_name?: string };
			expect(me.user).toMatchObject({ name: 'Dana Whitfield', email: 'dana@brightwave-mail.com' });
			expect(me.whose_email).toBe('company');
			expect(me.agency_name).toBeUndefined();
			const { workspaces } = (await (await page.request.get(`${inst.url}/api/workspaces`)).json()) as { workspaces: Array<{ name: string }> };
			expect(workspaces.map((w) => w.name)).toEqual(['Brightwave Studio']);
		} finally {
			await ctx.close();
			await inst.stop();
		}
	});
}

test('"Not seeing it?" sends a new code that replaces the old one; "Start over" drops the attempt and its answers', async ({ browser }) => {
	const inst = await startInstance({ mode: 'hosted', port: 8832, tokenKey: true });
	const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
	const page = await ctx.newPage();
	try {
		await fillSignUp(page, inst, 'dana@brightwave-mail.com');
		await fillAbout(page);
		const first = mailedCodes(inst).at(-1)!;
		await expect(page.getByRole('button', { name: 'Send a new code' })).toHaveCount(0);
		await page.getByRole('button', { name: 'Not seeing it?' }).click();
		await expect(page.getByText('Emails can take a few minutes. Check your spam folder.')).toBeVisible();
		const count = mailedCodes(inst).length;
		await page.getByRole('button', { name: 'Send a new code' }).click();
		await expect(page.getByText('A new code is on its way. The previous one no longer works.')).toBeVisible({ timeout: 30_000 });
		await expect.poll(() => mailedCodes(inst).length).toBeGreaterThan(count);
		const second = mailedCodes(inst).at(-1)!;
		if (second !== first) {
			await page.getByLabel('6-digit code').pressSequentially(first);
			await expect(page.getByText("That code isn't right. Check the latest email.")).toBeVisible();
		}
		// Wrong address? Start over: S1 with nothing in it, and no attempt left on the server
		await page.getByRole('button', { name: 'Start over' }).click();
		await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
		await expect(page.getByLabel('Work email')).toHaveValue('');
		expect(hash(page)).toBe('#/signup');
		await page.reload();
		await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
		expect(inst.d1("SELECT 1 FROM verifications WHERE identifier LIKE 'signin-code:%'")).toHaveLength(0);
		expect(inst.d1('SELECT 1 FROM users')).toHaveLength(0); // no account existed at any point
	} finally {
		await ctx.close();
		await inst.stop();
	}
});

test('an agency: the organization name is the agency (not a workspace), the first workspace waits for its first client domain', async ({ browser }) => {
	const inst = await startInstance({ mode: 'hosted', port: 8833, tokenKey: true });
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	const page = await ctx.newPage();
	try {
		const before = mailedCodes(inst).length;
		await fillSignUp(page, inst, 'sam@northside-it.com');
		await fillAbout(page, { name: 'Sam Ortiz', organization: 'Northside IT', whose: "My clients' (I'm an agency or IT provider)" });
		await enterMailedCode(page, inst, before);
		await expect(s4Heading(page)).toBeVisible({ timeout: 30_000 });
		const me = (await (await page.request.get(`${inst.url}/api/me`)).json()) as { agency_name?: string; whose_email?: string };
		expect(me).toMatchObject({ whose_email: 'clients', agency_name: 'Northside IT' });
		const { workspaces } = (await (await page.request.get(`${inst.url}/api/workspaces`)).json()) as { workspaces: Array<{ name: string }> };
		expect(workspaces.map((w) => w.name)).toEqual(['New client']);
	} finally {
		await ctx.close();
		await inst.stop();
	}
});
