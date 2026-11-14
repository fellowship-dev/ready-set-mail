// Operator values stay in a private local JSON file, never in CLI arguments or browser storage.
import { expect, test, type Page } from '@playwright/test';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';

interface Operator { email: string; password: string; proof: string }
export function operatorCredentials(): Operator {
 const path = process.env.E2E_OPERATOR_FILE;
 if (!path) throw new Error('Set E2E_OPERATOR_FILE to a private JSON file containing email, password and proof');
 const stat = statSync(path);
 if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error('E2E_OPERATOR_FILE must be owned by this user and inaccessible to group/others');
 let value: Partial<Operator>;
 try { value = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('E2E_OPERATOR_FILE must contain valid JSON'); }
 if (!value || typeof value !== 'object' || typeof value.email !== 'string' || !value.email || typeof value.password !== 'string' || value.password.length < 8 || typeof value.proof !== 'string' || value.proof.length < 32) throw new Error('E2E_OPERATOR_FILE requires email, password (8+ characters), proof (32+ characters)');
 return value as Operator;
}

/**
 * E2E_SESSION_FILE (set by scripts/e2e-devbox.sh to a private 0600 file): the cookies of the first sign-in are
 * saved there and reused by later tests, so a full run signs in once instead of once per test and never meets
 * the product's per-IP sign-in limit. Unset, every call signs in as before.
 */
async function reuseSavedSession(page: Page): Promise<boolean> {
 const file = process.env.E2E_SESSION_FILE;
 if (!file || !existsSync(file)) return false;
 const { cookies } = JSON.parse(readFileSync(file, 'utf8')) as { cookies: Parameters<ReturnType<Page['context']>['addCookies']>[0] };
 await page.context().addCookies(cookies);
 // 401 means signed out; anything else (200, or 403 for a workspace this user cannot open) is a live session.
 if ((await page.request.get('/api/me')).status() !== 401) return true;
 await page.context().clearCookies();
 return false;
}

/** Cookie-authenticated operator login/setup. The human password never enters a browser field or agent tool argument. */
export async function signIn(page: Page) {
 const trace = test.info().project.use.trace;
 if (trace && (typeof trace === 'string' ? trace !== 'off' : trace.mode !== 'off')) throw new Error('Operator E2E authentication requires Playwright tracing off');
 if (await reuseSavedSession(page)) {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Main' }).or(page.getByRole('heading', { name: "What's your main domain?" }))).toBeVisible();
  return;
 }
 const operator = operatorCredentials();
 await page.goto('/');
 const origin = new URL(page.url()).origin;
 const status = await page.request.get('/api/auth/status');
 expect(status.status()).toBe(200);
 const { configured } = await status.json() as { configured: boolean };
 const response = await page.request.post(configured ? '/api/auth/login' : '/api/auth/setup', {
  headers: { Origin: origin, ...(!configured ? { 'X-Ready-Set-Mail-Bootstrap': operator.proof } : {}) },
  data: { email: operator.email, password: operator.password, ...(!configured ? { name: 'E2E Owner' } : {}) },
 });
 // Assert status only: response bodies can contain private account diagnostics.
 expect(response.status()).toBe(configured ? 200 : 201);
 const file = process.env.E2E_SESSION_FILE;
 if (file) writeFileSync(file, JSON.stringify({ cookies: (await page.context().storageState()).cookies }), { mode: 0o600 });
 await page.goto('/');
 await expect(page.getByRole('navigation', { name: 'Main' }).or(page.getByRole('heading', { name: "What's your main domain?" }))).toBeVisible();
}
