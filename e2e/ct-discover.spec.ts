// Playwright smoke test — CT Log Subdomain Discovery
//
// Requires a running local dashboard and private E2E_OPERATOR_FILE credentials.
//
// Run: npm run dev (wrangler dev), then npm run test:e2e  (override target with E2E_BASE_URL).
// Pre-condition: local dashboard reachable; operator file contains email, password and installer proof.
//
// The search itself goes to crt.sh, a public service that is often slow or down. The result tests answer
// GET /api/domains/ct-discover with page.route (this proves the dashboard flow: results, select-all, import); the empty
// result runs against the real Worker with a name crt.sh has no entries for.

import { test, expect, type Page } from '@playwright/test';
import { signIn } from './support/session';

test.beforeEach(async ({ page }) => { await signIn(page); });

const ROOT = 'ct-e2e-example.com';
const SUBS = ['www.ct-e2e-example.com', 'mail.ct-e2e-example.com', 'shop.ct-e2e-example.com'];

async function answerWith(page: Page, subdomains: string[]) {
  await page.route('**/api/domains/ct-discover?**', (r) => r.fulfill({ json: { domain: ROOT, subdomains } }));
}
async function search(page: Page, root: string) {
  await page.goto(`/#/ct-discover`);
  await page.getByLabel('Root domain').fill(root);
  await page.getByRole('button', { name: 'Discover' }).click();
}

test.describe('CT log subdomain discovery', () => {
  test('navigates to /ct-discover and shows the form', async ({ page }) => {
    await page.goto(`/#/ct-discover`);
    await expect(page.getByRole('heading', { name: 'Discover subdomains', level: 1 })).toBeVisible();
    await expect(page).toHaveURL(/#\/w\/[^/]+\/ct-discover$/);
    await expect(page.getByLabel('Root domain')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Discover' })).toBeDisabled(); // nothing typed yet
  });

  test('lists the subdomains found, all selected', async ({ page }) => {
    await answerWith(page, SUBS);
    await search(page, ROOT);
    const found = page.getByRole('region', { name: 'Discovered subdomains' });
    await expect(found.getByText('3 subdomains found')).toBeVisible();
    for (const s of SUBS) await expect(found.getByRole('checkbox', { name: s })).toBeChecked();
    await expect(found.getByText('3 selected', { exact: true })).toBeVisible();
    await expect(found.getByRole('button', { name: 'Import 3 selected' })).toBeEnabled();
  });

  test('select-all clears and selects every subdomain', async ({ page }) => {
    await answerWith(page, SUBS);
    await search(page, ROOT);
    const found = page.getByRole('region', { name: 'Discovered subdomains' });
    const all = found.getByRole('checkbox', { name: '3 subdomains found' });
    await all.click();
    await expect(found.getByText('0 selected', { exact: true })).toBeVisible();
    await expect(found.getByRole('button', { name: 'Import 0 selected' })).toBeDisabled();
    await all.click();
    await expect(found.getByText('3 selected', { exact: true })).toBeVisible();
    for (const s of SUBS) await expect(found.getByRole('checkbox', { name: s })).toBeChecked();
  });

  test('a name with no certificate history says so, or names the failure', async ({ page }) => {
    await search(page, 'no-ct-history-xyz-12345.invalid');
    // crt.sh answers an empty list, or it fails (it is often down): either is said plainly, never a silent nothing.
    await expect(
      page.getByText('No subdomains found for no-ct-history-xyz-12345.invalid').or(page.getByRole('alert').filter({ hasText: 'Search failed' })),
    ).toBeVisible({ timeout: 30_000 });
  });
});
