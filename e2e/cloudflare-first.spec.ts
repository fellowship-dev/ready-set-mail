// Cloudflare-first onboarding, end to end, against throwaway instances.
//
// Each test starts its own instance with e2e/support/dev-instance.mjs: a fresh local D1 (migrated into a temp persist dir),
// the in-memory fake Cloudflare (e2e/support/fake-cloudflare.mjs, which also answers DNS-over-HTTPS) and `wrangler dev --local`
// with CLOUDFLARE_API_BASE_URL / DOH_BASE_URL pointing at the fake (the Worker honours only http://127.0.0.1:<port>), so
// api.cloudflare.com is never contacted. Ports 8811-8813 are used so these do not collide with `npm run dev` on 8787.
// It needs `npm run build:dashboard` done first. The setup link is minted with
// `node scripts/setup-link.mjs --local --persist-to <that instance's persist dir> --url <instance url>`.
// Run alone: npx playwright test e2e/cloudflare-first.spec.ts
import { expect, test, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

interface Instance { url: string; fake: { url: string }; stop(): Promise<void>; persistDir: string }
type FakeRecord = { type: string; name: string; content: string; priority?: number };
interface FakeState { zones: { id: string; name: string }[]; records: Record<string, FakeRecord[]>; routing: Record<string, { enabled: boolean; catchAll: unknown }> }

// Playwright loads specs as CommonJS; a real dynamic import() reaches the ESM helper.
const nativeImport = new Function('u', 'return import(u)') as (u: string) => Promise<{ startInstance(o: Record<string, unknown>): Promise<Instance> }>;
const startInstance = async (o: Record<string, unknown>) => (await nativeImport(pathToFileURL(resolve(__dirname, 'support/dev-instance.mjs')).href)).startInstance(o);

test.setTimeout(180_000);

async function state(inst: Instance): Promise<FakeState> {
 return (await fetch(`${inst.fake.url}/__state`)).json() as Promise<FakeState>;
}
const flat = (s: FakeState) => Object.values(s.records).flat().map((r) => `${r.type} ${r.name} ${r.priority ?? ''} ${r.content}`.trim()).sort();

function mintLink(inst: Instance): string {
 const r = spawnSync('node', ['scripts/setup-link.mjs', '--local', '--persist-to', inst.persistDir, '--url', inst.url], { encoding: 'utf8' });
 expect(r.status, 'setup-link exits 0').toBe(0);
 const m = /https?:\/\/\S+#\/claim\/\S+/.exec(r.stdout);
 expect(m, 'setup link printed').not.toBeNull();
 return m![0];
}

async function createOwner(page: Page, inst: Instance) {
 await page.goto(mintLink(inst));
 await expect(page.getByRole('heading', { name: 'Create the owner account' })).toBeVisible();
 await page.locator('#email').fill('owner@example.com');
 await page.locator('#password').fill('correct horse battery staple');
 await page.locator('#confirm').fill('correct horse battery staple');
 await page.getByRole('button', { name: 'Create account' }).click();
 await expect(page.getByRole('heading', { name: "Let's set up Ready Set Mail" })).toBeVisible({ timeout: 30_000 });
}

async function manualToRecords(page: Page) {
 await page.getByLabel(/domain/i).first().fill('example.net');
 await page.getByRole('button', { name: /next|continue|add/i }).first().click();
 await expect(page.getByRole('heading', { name: "Let's verify your email security for example.net" })).toBeVisible({ timeout: 30_000 });
 await expect(page.getByRole('region', { name: 'SPF record' })).toBeVisible();
 // Skip SPF and DKIM; the DMARC step is today's copy-and-paste record.
 for (let i = 0; i < 2; i++) await page.getByRole('button', { name: 'Skip for now' }).click();
 await expect(page.getByRole('heading', { name: /DMARC/ }).first()).toBeVisible();
 await expect(page.getByText('v=DMARC1').first()).toBeVisible({ timeout: 30_000 });
 await expect(page.getByRole('button', { name: /copy/i }).first()).toBeVisible();
}

test('connect Cloudflare with a token, review and write the records, land on the overview', async ({ page }) => {
 const inst: Instance = await startInstance({ mode: 'selfhost', port: 8811, tokenKey: true });
 try {
  await createOwner(page, inst);
  const before = await state(inst);

  await page.getByRole('button', { name: 'Connect Cloudflare' }).click();
  await page.getByLabel('Cloudflare API token').fill('e2e-fake-token-not-a-real-secret-0000');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Choose zones' })).toBeVisible();
  for (const z of ['brightwave-mail.com', 'harbor-lane.org', 'quietfield.net']) await expect(page.getByRole('checkbox', { name: z })).toBeChecked();
  await page.getByRole('button', { name: 'Next' }).click();

  await expect(page.getByRole('heading', { name: 'Choose domains' })).toBeVisible();
  for (const z of ['brightwave-mail.com', 'harbor-lane.org', 'quietfield.net']) await page.getByRole('checkbox', { name: z }).check();
  const reports = page.getByLabel('Reports go to');
  if (await reports.isVisible()) { await reports.click(); await page.getByRole('option', { name: 'harbor-lane.org' }).click(); }
  await page.getByRole('button', { name: /^Add 3 domains$/ }).click();
  // Adding a domain writes nothing to DNS.
  await expect(page.getByRole('heading', { name: 'DMARC' }).or(page.getByText(/DMARC/).first())).toBeVisible({ timeout: 30_000 });
  expect(flat(await state(inst))).toEqual(flat(before));

  // DMARC step: shows the plan, one primary button writes it.
  const write = page.getByRole('button', { name: /^Write \d+ records?$/ });
  await expect(write).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('v=DMARC1', { exact: false }).first()).toBeVisible();
  await write.click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  // Reports mailbox step.
  await expect(page.getByText(/Email Routing is off/)).toBeVisible({ timeout: 30_000 });
  const mailboxWrite = page.getByRole('button', { name: /^Write \d+ (records?|changes?)$/ });
  await expect(mailboxWrite).toBeVisible();
  await mailboxWrite.click();
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  await expect(page.getByRole('button', { name: 'Go to overview' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Go to overview' }).click();
  await expect(page).toHaveURL(/#\/(w\/[^/]+\/)?$/);
  for (const z of ['brightwave-mail.com', 'harbor-lane.org', 'quietfield.net']) await expect(page.getByText(z).first()).toBeVisible({ timeout: 30_000 });

  // What the fake received: only the planned writes, nothing at a zone apex, nothing existing removed except what the plan said.
  const after = await state(inst);
  const b = new Set(flat(before));
  const added = flat(after).filter((l) => !b.has(l));
  const removed = [...b].filter((l) => !flat(after).includes(l));
  console.log('fake added:', JSON.stringify(added), 'removed:', JSON.stringify(removed));
  expect(added.some((l) => l.includes('v=DMARC1'))).toBe(true);
  expect(removed.every((l) => l.startsWith('TXT _dmarc.brightwave-mail.com'))).toBe(true);
  expect(Object.values(after.records).flat().find((r) => r.type === 'MX' && r.name === 'quietfield.net')?.content).toBe('mail.quietfield.net');
  const zoneNames = new Set(after.zones.map((z) => z.name));
  for (const l of added) {
   const [type, name] = l.split(' ');
   // An apex record would be named exactly like a zone. The reports mailbox lives on a subdomain, never on the apex.
   expect(zoneNames.has(name), `${type} ${name} is a zone apex`).toBe(false);
  }
 } finally {
  await inst.stop();
 }
});

test('"I\'ll add DNS records myself" reaches the copy-and-paste records', async ({ page }) => {
 const inst: Instance = await startInstance({ mode: 'selfhost', port: 8812, tokenKey: true });
 try {
  await createOwner(page, inst);
  const before = flat(await state(inst));
  await expect(page.getByRole('region', { name: 'Connect Cloudflare' })).toBeVisible();
  await expect(page.getByRole('heading', { name: "I'll add DNS records myself" })).toBeVisible();
  await manualToRecords(page);
  expect(flat(await state(inst))).toEqual(before);
 } finally {
  await inst.stop();
 }
});

test('without TOKEN_ENCRYPTION_KEY the first screen says Cloudflare cannot be connected, and the manual path works', async ({ page }) => {
 const inst: Instance = await startInstance({ mode: 'selfhost', port: 8813, tokenKey: false });
 try {
  await createOwner(page, inst);
  await expect(page.getByRole('region', { name: "Cloudflare can't be connected yet" })).toBeVisible();
  await expect(page.getByText('TOKEN_ENCRYPTION_KEY').first()).toBeVisible();
  await expect(page.getByText(/wrangler secret put TOKEN_ENCRYPTION_KEY/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect Cloudflare' })).toHaveCount(0);
  await page.getByLabel(/domain/i).first().fill('example.net');
  await page.getByRole('button', { name: /next|continue|add/i }).first().click();
  await expect(page.getByRole('button', { name: /copy/i }).first()).toBeVisible({ timeout: 30_000 });
 } finally {
  await inst.stop();
 }
});
