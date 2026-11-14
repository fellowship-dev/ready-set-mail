// Operator values stay in a private local JSON file, never in CLI arguments or browser storage.
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { existsSync, readFileSync, statSync } from 'node:fs';

/**
 * Sign-in codes (src/auth/codes.ts) are on whenever the instance can send mail. Against a local `wrangler dev`, mail goes to the
 * send_email simulation, which logs each message's subject ("<code> is your Ready Set Mail code"); point E2E_MAIL_LOG at that
 * log (e.g. `npm run dev > /tmp/wrangler.log`) and the code is read from it. Without it, run wrangler dev with SIGNIN_CODES=off.
 */
function codeSubjects(): string[] {
 const path = process.env.E2E_MAIL_LOG;
 if (!path || !existsSync(path)) return [];
 return [...readFileSync(path, 'utf8').replace(/\x1b\[[0-9;]*m/g, '').matchAll(/(\d{6}) is your Ready Set Mail code/g)].map(m => m[1]!);
}
async function newestCode(before: number): Promise<string> {
 for (let i = 0; i < 80; i++) {
  const all = codeSubjects();
  if (all.length > before) return all.at(-1)!;
  await new Promise(r => setTimeout(r, 250));
 }
 throw new Error('Sign-in asked for the emailed code: set E2E_MAIL_LOG to the wrangler dev log, or run wrangler dev with SIGNIN_CODES=off');
}

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

/** Cookie-authenticated operator login/setup. The human password never enters a browser field or agent tool argument. */
/**
 * The session cookies of the last sign-in in this worker. A sign-in is two auth POSTs now (password, then the emailed code)
 * and the local AUTH_LIMITER allows 10 a minute per IP, so later tests reuse the session while it still works.
 */
let signedInCookies: Awaited<ReturnType<BrowserContext['cookies']>> | null = null;

export async function signIn(page: Page) {
 const trace = test.info().project.use.trace;
 if (trace && (typeof trace === 'string' ? trace !== 'off' : trace.mode !== 'off')) throw new Error('Operator E2E authentication requires Playwright tracing off');
 const operator = operatorCredentials();
 await page.goto('/');
 const origin = new URL(page.url()).origin;
 if (signedInCookies) {
  await page.context().addCookies(signedInCookies);
  if ((await page.request.get('/api/me')).status() === 200) {
   await page.goto('/');
   await expect(page.getByRole('navigation', { name: 'Main' }).or(page.getByRole('heading', { name: "What's your main domain?" }))).toBeVisible();
   return;
  }
  signedInCookies = null;
 }
 const status = await page.request.get('/api/auth/status');
 expect(status.status()).toBe(200);
 const { configured } = await status.json() as { configured: boolean };
 const before = codeSubjects().length;
 const response = await page.request.post(configured ? '/api/auth/login' : '/api/auth/setup', {
  headers: { Origin: origin, ...(!configured ? { 'X-Ready-Set-Mail-Bootstrap': operator.proof } : {}) },
  data: { email: operator.email, password: operator.password, ...(!configured ? { name: 'E2E Owner' } : {}) },
 });
 // Assert status only: response bodies can contain private account diagnostics.
 expect(response.status()).toBe(configured ? 200 : 201);
 if (configured && (await response.json() as { code_required?: boolean }).code_required) {
  // The pending-attempt cookie is in page.request's (and the page's) cookie jar; the code completes the sign-in.
  const done = await page.request.post('/api/auth/code', { headers: { Origin: origin }, data: { code: await newestCode(before) } });
  expect(done.status()).toBe(200);
 }
 signedInCookies = await page.context().cookies();
 await page.goto('/');
 await expect(page.getByRole('navigation', { name: 'Main' }).or(page.getByRole('heading', { name: "What's your main domain?" }))).toBeVisible();
}
