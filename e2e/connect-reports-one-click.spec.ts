// Hosted, the owner's exact case: a verified domain linked to a Cloudflare zone whose live record is `v=DMARC1; p=reject;`, no report address.
// Domain page -> "Connect reports" in the first screen (375x812 and 1440x900) -> review: the record now and after -> Apply -> the fake's
// record carries only our rua= added, the reports are connected, and the page waits for the first report.
//
// Each test starts its own instance (e2e/support/dev-instance.mjs): fresh D1, the fake Cloudflare (which also answers DNS-over-HTTPS from
// its records, so the Worker reads the same record the fake holds), `wrangler dev --local`, MODE=saas. Needs `npm run build:dashboard`.
// Run alone: npx playwright test e2e/connect-reports-one-click.spec.ts
import { expect, test, type Page } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { signUp } from './support/signup';

interface Instance { url: string; fake: { url: string }; logFile: string; stop(): Promise<void> }
const nativeImport = new Function('u', 'return import(u)') as (u: string) => Promise<{ startInstance(o: Record<string, unknown>): Promise<Instance> }>;
const startInstance = async (o: Record<string, unknown>) => (await nativeImport(pathToFileURL(resolve(__dirname, 'support/dev-instance.mjs')).href)).startInstance(o);

test.setTimeout(240_000);

const INTAKE = 'rua.readysetmail.com';
const ADDRESS = `rua@${INTAKE}`;
const DOMAIN = 'quickreports.net';
const EMAIL = 'owner@harbor-lane.org';
const TOKEN = 'e2e-fake-token-not-a-real-secret-0000';
const VIEWPORTS = [{ width: 375, height: 812 }, { width: 1440, height: 900 }];

const fakeCf = async (inst: Instance, method: string, path: string, body?: unknown) =>
 (await fetch(`${inst.fake.url}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: body ? JSON.stringify(body) : undefined })).json() as Promise<any>;
const liveRecords = async (inst: Instance) => {
 const s = await fakeCf(inst, 'GET', '/__state');
 return (Object.values(s.records).flat() as Array<{ name: string; content: string }>).filter((r) => r.name === `_dmarc.${DOMAIN}`).map((r) => r.content);
};

/** A Cloudflare connection (pasted token) allowing the one zone, imported: the domain is verified by the zone and linked to the connection. */
async function ownerWithLinkedDomain(page: Page, inst: Instance): Promise<number> {
 await fakeCf(inst, 'POST', '/__zones', { name: DOMAIN });
 const zoneId = (await fakeCf(inst, 'GET', '/__state')).zones.find((z: any) => z.name === DOMAIN).id as string;
 for (const r of [{ type: 'TXT', name: `_dmarc.${DOMAIN}`, content: 'v=DMARC1; p=reject;' }, { type: 'TXT', name: DOMAIN, content: 'v=spf1 ip4:203.0.113.5 -all' }]) await fakeCf(inst, 'POST', `/client/v4/zones/${zoneId}/dns_records`, r);
 await signUp(page, inst, EMAIL);
 const api = async (method: string, path: string, data?: unknown) => (await page.request.fetch(`${inst.url}${path}`, { method, data, headers: { 'content-type': 'application/json', origin: inst.url } })).json() as Promise<any>;
 const { connection } = await api('POST', '/api/cloudflare/connections', { token: TOKEN, label: 'e2e' });
 await api('PUT', `/api/cloudflare/connections/${connection.id}/zones`, { zone_ids: [zoneId] });
 await api('POST', `/api/cloudflare/connections/${connection.id}/import`, { zone_ids: [zoneId] });
 const list = await api('GET', '/api/domains');
 return (list.domains ?? list).find((d: any) => d.domain === DOMAIN).id as number;
}

/** The statement and the action are in the first screen: the whole button is inside the viewport, without scrolling. */
async function expectActionInFirstScreen(page: Page, inst: Instance, id: number, size: { width: number; height: number }) {
 await page.setViewportSize(size);
 await page.goto(`${inst.url}/#/domains/${id}`);
 await page.reload();
 const panel = page.getByTestId('connect-reports');
 await expect(panel.getByText('Reports not connected yet')).toBeVisible({ timeout: 30_000 });
 const button = panel.getByRole('button', { name: 'Connect reports' });
 await expect(button).toBeVisible();
 await expect.poll(async () => { const b = await button.boundingBox(); return !!b && b.y >= 0 && b.y + b.height <= size.height; }, { timeout: 10_000, message: `Connect reports fits ${size.width}x${size.height}` }).toBe(true);
 const statement = await panel.getByText('Reports not connected yet').boundingBox();
 expect(statement && statement.y >= 0).toBe(true);
}

test('Connect reports in the first screen, review the change, Apply: the record gains only our rua=, and the page waits for the first report', async ({ page }) => {
 const inst = await startInstance({ mode: 'hosted', port: 8815, tokenKey: true, vars: { INTAKE_DOMAIN: INTAKE, HOSTED_CONNECT_REPORTS: 'all' } });
 try {
  const id = await ownerWithLinkedDomain(page, inst);
  for (const size of VIEWPORTS) await expectActionInFirstScreen(page, inst, id, size);

  const panel = page.getByTestId('connect-reports');
  await panel.getByRole('button', { name: 'Connect reports' }).click();
  await expect(panel.getByText(`Review the change to _dmarc.${DOMAIN}`)).toBeVisible();
  const change = panel.getByTestId('change-dmarc');
  await expect(change).toContainText('Now: v=DMARC1; p=reject;');
  await expect(change).toContainText(`After Apply: v=DMARC1; p=reject; rua=mailto:${ADDRESS}`);
  await expect(panel.getByText(/Only rua= changes: the policy and every other tag stay as they are/)).toBeVisible();
  expect(await liveRecords(inst)).toEqual(['v=DMARC1; p=reject;']); // the review writes nothing

  await panel.getByRole('button', { name: 'Apply' }).click();
  await expect(panel.getByText('Report address added.')).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByText('Published, waiting for the first report')).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByText(/Receivers send reports about once a day, so the first one can take a day or two/)).toBeVisible();
  expect(await liveRecords(inst)).toEqual([`v=DMARC1; p=reject; rua=mailto:${ADDRESS}`]);

  // Connected on the server too: the status says waiting, and a reload shows the same.
  const status = await page.request.get(`${inst.url}/api/domains/${id}/report-address`);
  expect(await status.json()).toMatchObject({ state: 'waiting', address: ADDRESS, apply_via_cloudflare: true });
  await page.reload();
  await expect(page.getByTestId('connect-reports').getByText('Published, waiting for the first report')).toBeVisible({ timeout: 30_000 });
 } finally { await inst.stop(); }
});

test('the operator, who also sees the settings banner above every page, still has the statement and the action in the first screen', async ({ page }) => {
 const inst = await startInstance({ mode: 'hosted', port: 8816, tokenKey: true, vars: { INTAKE_DOMAIN: INTAKE, HOSTED_CONNECT_REPORTS: 'owner', OWNER_EMAIL: EMAIL } });
 try {
  const id = await ownerWithLinkedDomain(page, inst);
  for (const size of VIEWPORTS) await expectActionInFirstScreen(page, inst, id, size);
 } finally { await inst.stop(); }
});
