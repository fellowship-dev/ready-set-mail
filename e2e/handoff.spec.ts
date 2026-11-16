// Hand setup to a teammate, end to end on a throwaway hosted instance (e2e/support/dev-instance.mjs): the owner signs up, enters the domain on S4,
// hands setup to a teammate (H1), the teammate opens the invitation, chooses a password, confirms the code and lands on that domain's S4 (I1),
// and the owner's dashboard says who is finishing setup (H2).
// Hosted sign-up asks Cloudflare's Turnstile test endpoint (challenges.cloudflare.com) to check a dummy token: this spec needs that network access.
// Port 8838. Needs `npm run build:dashboard`. Run alone: bash scripts/e2e-devbox.sh e2e/handoff.spec.ts
import { expect, test } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { enterDomain, mailedCodes, signUp, type HostedInstance } from './support/signup';

interface Instance extends HostedInstance { stop(): Promise<void>; d1(sql: string): Array<Record<string, unknown>> }
const nativeImport = new Function('u', 'return import(u)') as (u: string) => Promise<{ startInstance(o: Record<string, unknown>): Promise<Instance> }>;
const startInstance = async (o: Record<string, unknown>) => (await nativeImport(pathToFileURL(resolve(__dirname, 'support/dev-instance.mjs')).href)).startInstance(o);

test.setTimeout(240_000);

test('hand setup to a teammate: invitation, I1 to that domain\'s S4, and the owner\'s H2 card', async ({ browser }) => {
	const inst = await startInstance({ mode: 'hosted', port: 8838, tokenKey: true, dohNs: { 'harbor-lane.org': ['ns1.domaincontrol.com'] } });
	const ownerCtx = await browser.newContext({ viewport: { width: 375, height: 812 } });
	const owner = await ownerCtx.newPage();
	try {
		await signUp(owner, inst, 'dana@harbor-lane.org', { name: 'Dana Whitfield', organization: 'Harbor Lane' });
		await enterDomain(owner, 'harbor-lane.org');

		// H1, from S4
		await owner.getByRole('link', { name: 'Hand setup to a teammate →' }).click();
		await expect(owner.getByRole('heading', { name: 'Hand setup to a teammate' })).toBeVisible();
		await expect(owner.getByText(/They join Harbor Lane as an admin and pick up where you are: harbor-lane\.org/)).toBeVisible();
		await owner.getByLabel('Their work email').fill('sam@harbor-lane.org');
		await owner.getByRole('button', { name: 'Send invitation' }).click();
		await expect(owner.getByRole('heading', { name: 'Invitation sent' })).toBeVisible({ timeout: 30_000 });
		expect(inst.d1("SELECT email, role FROM invites")).toEqual([{ email: 'sam@harbor-lane.org', role: 'admin' }]);
		const token = inst.d1('SELECT token FROM invites')[0]!.token as string;

		// H2, before they join
		await owner.getByRole('button', { name: 'Go to the dashboard' }).click();
		await expect(owner.getByRole('heading', { name: 'sam@harbor-lane.org is finishing setup' })).toBeVisible({ timeout: 30_000 });
		await expect(owner.getByText(/Not yet; the link works until /)).toBeVisible();
		await expect(owner.getByRole('button', { name: 'Resend invitation' })).toBeVisible();

		// I1: the teammate, in their own browser
		const samCtx = await browser.newContext({ viewport: { width: 375, height: 812 } });
		const sam = await samCtx.newPage();
		try {
			await sam.goto(`${inst.url}/#/invite/${token}`);
			await expect(sam.getByRole('heading', { name: 'Join Harbor Lane on Ready Set Mail' })).toBeVisible();
			await expect(sam.getByText("Dana Whitfield asked you to finish setting up email authentication for harbor-lane.org. You'll join as an admin.")).toBeVisible();
			const before = mailedCodes(inst).length;
			await sam.getByLabel('Choose a password').fill('correct-horse-battery');
			await sam.getByRole('button', { name: 'Accept invite' }).click();
			await expect.poll(() => mailedCodes(inst).length, { timeout: 30_000 }).toBeGreaterThan(before);
			await sam.getByLabel('6-digit code').pressSequentially(mailedCodes(inst).at(-1)!);
			// no profile questions; straight to S4 of that domain, with its own choice (GoDaddy: the record path)
			await expect(sam.getByRole('heading', { name: 'harbor-lane.org uses GoDaddy for DNS' })).toBeVisible({ timeout: 60_000 });
			await expect(sam.getByLabel('Your name')).toHaveCount(0);
			expect(inst.d1("SELECT m.role AS role FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = 'sam@harbor-lane.org'")).toEqual([{ role: 'admin' }]);
		} finally {
			await samCtx.close();
		}

		// H2, after they join
		await owner.goto(`${inst.url}/#/`);
		await owner.reload();
		await expect(owner.getByRole('heading', { name: 'sam@harbor-lane.org is finishing setup' })).toBeVisible({ timeout: 30_000 });
		await expect(owner.getByText('sam@harbor-lane.org joined')).toBeVisible();
		await expect(owner.getByRole('button', { name: 'Resend invitation' })).toHaveCount(0);
		await expect(owner.getByRole('link', { name: 'Finish it myself' })).toBeVisible();
	} finally {
		await ownerCtx.close();
		await inst.stop();
	}
});
