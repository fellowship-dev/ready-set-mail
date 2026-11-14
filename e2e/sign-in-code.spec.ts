// Sign-in codes on a self-hosted instance (src/auth/codes.ts), through the real dashboard.
// A fresh e2e instance cannot send mail (no sender address), so sign-in is the password alone; once the instance has a
// sender address, every sign-in asks for the 6-digit code emailed to the address. The local send_email simulation logs
// each message's subject, which E2E_MAIL_LOG names (scripts/e2e-devbox.sh sets it).
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
});

test('with a sender address: password, then the emailed code; a wrong code is refused; the right one signs in', async ({ page }) => {
	await signIn(page);
	runSql("INSERT OR REPLACE INTO settings (workspace_id, key, value) VALUES ('ws_default', 'from_email', 'noreply@reports.e2e.test');");
	expect(await status(page)).toMatchObject({ signin_codes: true, signin_codes_reason: 'mail' });
	await page.goto('/#/settings');
	await page.reload(); // the dashboard read the status before the instance had a sender address
	await expect(page.getByText('Password, then a 6-digit code emailed at every sign-in.')).toBeVisible();

	await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }));
	await page.context().clearCookies();
	const operator = operatorCredentials();
	await page.goto('/');
	await page.getByLabel('Email', { exact: true }).fill(operator.email);
	await page.getByLabel('Password', { exact: true }).fill(operator.password);
	const before = mailedCodes().length;
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('heading', { name: `Enter the 6-digit code we sent to ${operator.email}` })).toBeVisible();
	await expect(page.getByText('Your password was right. Enter the code from the email to finish signing in.', { exact: false })).toBeVisible();
	const code = await nextMailedCode(before);

	const input = page.getByLabel('6-digit code');
	await expect(input).toHaveAttribute('autocomplete', 'one-time-code');
	await input.pressSequentially(String((Number(code) + 1) % 1_000_000).padStart(6, '0'));
	await expect(page.getByText('That code is not right. 4 tries left.')).toBeVisible();
	await input.pressSequentially(code);
	await expect(page.getByRole('navigation', { name: 'Main' }).or(page.getByRole('heading', { name: "What's your main domain?" }))).toBeVisible();
	expect((await page.request.get('/api/me')).status()).toBe(200);
});
