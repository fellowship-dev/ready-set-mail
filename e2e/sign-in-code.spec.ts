// Sign-in codes on a self-hosted instance (src/auth/codes.ts), through the real dashboard.
// A fresh e2e instance cannot send mail (no sender address), so sign-in is the password alone. Once the instance has a sender
// address, a person's sign-in asks for a code only after a code has reached them (a test code from Settings): a configured
// sender does not mean Cloudflare delivers to their address. The local send_email simulation logs each message's subject,
// which E2E_MAIL_LOG names (scripts/e2e-devbox.sh sets it).
// Run: bash scripts/e2e-devbox.sh e2e/sign-in-code.spec.ts
import { expect, test } from '@playwright/test';
import { runSql } from './support/db';
import { mailedCodes, nextMailedCode, operatorCredentials, signIn } from './support/session';

test.skip(!process.env.E2E_OPERATOR_FILE || !process.env.E2E_MAIL_LOG, 'Requires scripts/e2e-devbox.sh (operator file and the Worker log)');

const status = async (page: import('@playwright/test').Page) => (await (await page.request.get('/api/auth/status')).json()) as { signin_codes: boolean; signin_codes_reason: string };

test('without a sender address: password only, and Settings says so', async ({ page }) => {
	await signIn(page); // first-owner setup
	expect(await status(page)).toMatchObject({ signin_codes: false, signin_codes_reason: 'no_mail' });
	await page.goto('/#/settings');
	await expect(page.getByText("Password only. This instance can't send email, so sign-in codes are off.", { exact: false })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Send me a test code' })).toHaveCount(0);
});

test('with a sender address: password alone until a test code arrives; then password and the emailed code', async ({ page }) => {
	await signIn(page);
	runSql("INSERT OR REPLACE INTO settings (workspace_id, key, value) VALUES ('ws_default', 'from_email', 'noreply@reports.e2e.test');");
	expect(await status(page)).toMatchObject({ signin_codes: true, signin_codes_reason: 'mail' });
	await page.goto('/#/settings');
	await page.reload(); // the dashboard read the status before the instance had a sender address
	await expect(page.getByText('Password, then a 6-digit code emailed at every sign-in, for each person once a test code has reached them.')).toBeVisible();
	await expect(page.getByText('Off for you so far: you sign in with your password alone.', { exact: false })).toBeVisible();

	// The test code: proof that this instance's mail reaches the owner.
	let before = mailedCodes().length;
	await page.getByRole('button', { name: 'Send me a test code' }).click();
	await expect(page.getByText('Enter the code we just emailed you. Once it is in, every sign-in here ends with a code like this one.', { exact: false })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Turn on sign-in codes' })).toBeVisible();
	await page.getByLabel('6-digit code').pressSequentially(await nextMailedCode(before)); // the sixth digit submits
	await expect(page.getByText('Sign-in codes are on for you. From now on, every sign-in ends with a code emailed to you.')).toBeVisible();

	await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }));
	await page.context().clearCookies();
	const operator = operatorCredentials();
	await page.goto('/');
	await expect(page.getByText('If you turned on sign-in codes in Settings, a 6-digit code is emailed to your address after your password, from an address at reports.e2e.test.')).toBeVisible();
	await page.getByLabel('Email', { exact: true }).fill(operator.email);
	await page.getByLabel('Password', { exact: true }).fill(operator.password);
	before = mailedCodes().length;
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('heading', { name: `Enter the 6-digit code we sent to ${operator.email}` })).toBeVisible();
	await expect(page.getByText('Your password was right. Enter the code from the email to finish signing in.', { exact: false })).toBeVisible();
	await expect(page.getByRole('link', { name: 'self-hosting guide' })).toHaveAttribute('href', /docs\/self-hosting\.md#sign-in-codes$/);
	const code = await nextMailedCode(before);

	const input = page.getByLabel('6-digit code');
	await expect(input).toHaveAttribute('autocomplete', 'one-time-code');
	await input.pressSequentially(String((Number(code) + 1) % 1_000_000).padStart(6, '0'));
	await expect(page.getByText('That code is not right. 4 tries left.')).toBeVisible();
	await input.pressSequentially(code);
	await expect(page.getByRole('navigation', { name: 'Main' }).or(page.getByRole('heading', { name: "What's your main domain?" })).or(page.getByRole('heading', { name: "Let's set up Ready Set Mail" }))).toBeVisible();
	expect((await page.request.get('/api/me')).status()).toBe(200);
});
