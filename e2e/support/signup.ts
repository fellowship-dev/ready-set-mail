// Hosted sign-up through the three screens, for specs that need a signed-in owner on a throwaway hosted instance
// (e2e/support/dev-instance.mjs). S1 email and password, S2 "Tell us about yourself", S3 the emailed code.
import { expect, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';

export interface HostedInstance { url: string; logFile: string }

/** The 6-digit codes the Worker mailed (the local send_email simulation logs each message's subject in the Worker's log). */
export const mailedCodes = (inst: HostedInstance): string[] =>
	existsSync(inst.logFile) ? [...readFileSync(inst.logFile, 'utf8').replace(/\x1b\[[0-9;]*m/g, '').matchAll(/(\d{6}) is your Ready Set Mail code/g)].map((m) => m[1]!) : [];

export interface AboutYou {
	name?: string;
	organization?: string;
	/** The radio card's label. */
	whose?: "My company's" | "My clients' (I'm an agency or IT provider)" | 'Just looking around';
}

/** S1: email and password, Continue. Lands on S2. */
export async function fillSignUp(page: Page, inst: HostedInstance, email: string, password = 'correct-horse-battery') {
	await page.goto(`${inst.url}/#/signup`);
	await page.getByLabel('Work email').fill(email);
	await page.getByLabel('Password', { exact: true }).fill(password);
	await page.getByRole('button', { name: 'Continue' }).click();
	await expect(page.getByRole('heading', { name: 'Tell us about yourself' })).toBeVisible({ timeout: 30_000 });
}

/** S2: the answers, Continue. Lands on S3. */
export async function fillAbout(page: Page, about: AboutYou = {}) {
	await page.getByLabel('Your name').fill(about.name ?? 'Dana Whitfield');
	await page.getByLabel('Organization name').fill(about.organization ?? 'Brightwave Studio');
	await page.getByLabel(about.whose ?? "My company's").check();
	await page.getByRole('button', { name: 'Continue' }).click();
	await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible({ timeout: 30_000 });
}

/** S3: the newest mailed code; the sixth digit submits. */
export async function enterMailedCode(page: Page, inst: HostedInstance, before: number) {
	await expect.poll(() => mailedCodes(inst).length, { timeout: 30_000 }).toBeGreaterThan(before);
	await page.getByLabel('6-digit code').pressSequentially(mailedCodes(inst).at(-1)!);
}

/** Sign up on a hosted instance through the screens and land in the app (the setup screen, a workspace with no domain yet). */
export async function signUp(page: Page, inst: HostedInstance, email: string, about: AboutYou = {}) {
	const before = mailedCodes(inst).length;
	await fillSignUp(page, inst, email);
	await fillAbout(page, about);
	await enterMailedCode(page, inst, before);
	await expect(page.getByRole('heading', { name: "Let's set up Ready Set Mail" })).toBeVisible({ timeout: 30_000 });
}
