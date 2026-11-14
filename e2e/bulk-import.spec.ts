// Playwright smoke test — Bulk Domain Import
//
// Requires a running local dashboard and private E2E_OPERATOR_FILE credentials.
//
// Run: npm run dev (wrangler dev), then npm run test:e2e  (override target with E2E_BASE_URL).
// Pre-condition: local dashboard reachable; operator file contains email, password and installer proof.
// Self-host imports need a reports domain (the setup wizard stores it): the test stores one in the local D1 first.

import { test, expect, type Page } from '@playwright/test';
import { signIn } from './support/session';
import { ensureDomain, runSql } from './support/db';

test.beforeEach(async ({ page }) => {
  await signIn(page);
  runSql("INSERT OR IGNORE INTO settings (workspace_id, key, value) VALUES ('ws_default', 'reports_domain', 'reports.bulk-e2e.example.com');");
});

// Names under example.com: valid syntax, never anyone's real domain.
const NAMES = ['bulk-e2e-1.example.com', 'bulk-e2e-2.example.com', 'bulk-e2e-3.example.com'];

async function importList(page: Page, text: string) {
  await page.goto(`/#/bulk-import`);
  await page.getByRole('textbox', { name: 'Domains' }).fill(text);
  await page.getByRole('button', { name: 'Import domains' }).click();
  const results = page.getByTestId('import-results');
  await expect(results).toBeVisible({ timeout: 15_000 });
  return results;
}
const rowOf = (results: ReturnType<Page['getByTestId']>, domain: string) => results.getByRole('row').filter({ has: results.page().getByRole('cell', { name: domain, exact: true }) });

test.describe('Bulk domain import', () => {
  test('navigates to /bulk-import and shows the form', async ({ page }) => {
    await page.goto(`/#/bulk-import`);
    await expect(page).toHaveURL(/#\/w\/[^/]+\/bulk-import$/);
    await expect(page.getByRole('heading', { name: 'Import domains', level: 1 })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Domains' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Import domains' })).toBeDisabled(); // nothing typed yet
  });

  test('imports valid domains and shows per-row results', async ({ page }) => {
    const results = await importList(page, NAMES.join('\n'));
    await expect(results.getByText(/of 3 domains imported/)).toBeVisible();
    const table = results.getByRole('region', { name: 'Import results' }).getByRole('table');
    await expect(table.getByRole('row')).toHaveCount(1 + 3);
    for (const d of NAMES) await expect(rowOf(results, d)).toContainText(/Imported|Already added/);
  });

  test('reports duplicates without failing the whole batch', async ({ page }) => {
    await ensureDomain(page, NAMES[0]!);
    const results = await importList(page, `${NAMES[0]}\nbulk-e2e-unique.example.com`);
    await expect(rowOf(results, NAMES[0]!)).toContainText('Already added');
    await expect(rowOf(results, 'bulk-e2e-unique.example.com')).toContainText(/Imported|Already added/);
  });

  test('shows invalid status for a malformed entry', async ({ page }) => {
    const results = await importList(page, 'not_a_domain');
    await expect(rowOf(results, 'not_a_domain')).toContainText('Invalid');
    await expect(results.getByText(/0 of 1 domain imported/)).toBeVisible();
  });
});
