// SPF flattening end to end against a throwaway self-hosted instance: turn on (over the limit), a provider changes its addresses in the fake DNS,
// the daily job runs (wrangler dev's scheduled endpoint), the record changes in the fake Cloudflare, a quiet run writes nothing, an edit made in
// Cloudflare is not overwritten, and turning off puts the original back.
//
// The fake Cloudflare (e2e/support/fake-cloudflare.mjs) holds the customer's zone and a "provider" zone, and answers DNS-over-HTTPS from the same records.
// Run alone: npx playwright test e2e/spf-flattening.spec.ts (after npm run build:dashboard); the suite: bash scripts/e2e-devbox.sh
import { expect, test, type Page } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

interface Instance { setupLink(ttl?: number): string; url: string; fake: { url: string }; stop(): Promise<void>; d1(sql: string): Array<Record<string, unknown>> }
interface FakeState { zones: { id: string; name: string }[]; records: Record<string, { id: string; type: string; name: string; content: string }[]> }

const nativeImport = new Function('u', 'return import(u)') as (u: string) => Promise<{ startInstance(o: Record<string, unknown>): Promise<Instance> }>;
const startInstance = async (o: Record<string, unknown>) => (await nativeImport(pathToFileURL(resolve(__dirname, 'support/dev-instance.mjs')).href)).startInstance(o);

test.setTimeout(240_000);

const DOMAIN = 'brightwave-mail.com';
const PROVIDER = 'mailprovider-test.net';
const INCLUDES = Array.from({ length: 11 }, (_, i) => `_spf${i + 1}.${PROVIDER}`);
const ORIGINAL = `v=spf1 ${INCLUDES.map((n) => `include:${n}`).join(' ')} -all`;
const BEARER = { Authorization: 'Bearer e2e-fake-token-not-a-real-secret-0000', 'Content-Type': 'application/json' };

const state = async (inst: Instance): Promise<FakeState> => (await fetch(`${inst.fake.url}/__state`)).json() as Promise<FakeState>;
const zoneId = async (inst: Instance, name: string) => (await state(inst)).zones.find((z) => z.name === name)!.id;
const apex = async (inst: Instance) => (await state(inst)).records[await zoneId(inst, DOMAIN)]!.find((r) => r.type === 'TXT' && r.name === DOMAIN && r.content.startsWith('v=spf1'))!;

async function cf(inst: Instance, method: string, path: string, body?: unknown) {
  const res = await fetch(`${inst.fake.url}/client/v4${path}`, { method, headers: BEARER, body: body ? JSON.stringify(body) : undefined });
  expect(res.ok, `${method} ${path}`).toBe(true);
  return ((await res.json()) as { result: any }).result;
}

/** The provider's zone and records, and the customer's SPF record at the apex of a seeded zone. */
async function seedDns(inst: Instance) {
  await fetch(`${inst.fake.url}/__zones`, { method: 'POST', body: JSON.stringify({ name: PROVIDER }) });
  const pz = await zoneId(inst, PROVIDER);
  const ids: string[] = [];
  for (const [i, name] of INCLUDES.entries()) ids.push((await cf(inst, 'POST', `/zones/${pz}/dns_records`, { type: 'TXT', name, content: `v=spf1 ip4:198.51.100.${i + 1} -all` })).id);
  await cf(inst, 'POST', `/zones/${await zoneId(inst, DOMAIN)}/dns_records`, { type: 'TXT', name: DOMAIN, content: ORIGINAL });
  return { providerZone: pz, ids };
}

async function createOwnerAndAddDomain(page: Page, inst: Instance) {
  await page.goto(inst.setupLink());
  await expect(page.getByRole('heading', { name: 'Create the owner account' })).toBeVisible();
  await page.locator('#email').fill('owner@example.com');
  await page.locator('#password').fill('correct horse battery staple');
  await page.locator('#confirm').fill('correct horse battery staple');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: "Let's set up Ready Set Mail" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Connect Cloudflare' }).click();
  await page.getByLabel('Cloudflare API token').fill('e2e-fake-token-not-a-real-secret-0000');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Choose zones' })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('heading', { name: 'Choose domains' })).toBeVisible();
  await page.getByRole('checkbox', { name: DOMAIN }).check();
  const reports = page.getByLabel('Reports go to');
  if (await reports.isVisible()) { await reports.click(); await page.getByRole('option', { name: DOMAIN }).click(); }
  await page.getByRole('button', { name: /^Add \d+ domains?$/ }).click();
  await expect(page.getByText(/DMARC/).first()).toBeVisible({ timeout: 30_000 });
  const domains = (await (await page.request.get(`${inst.url}/api/domains`)).json()) as { domains?: Array<{ id: number; domain: string }> } | Array<{ id: number; domain: string }>;
  const list = Array.isArray(domains) ? domains : domains.domains ?? [];
  const id = list.find((d) => d.domain === DOMAIN)!.id;
  // The wizard links a domain to the connection when it writes its records; this spec does not go that far, so link it as Settings does.
  const link = await page.request.put(`${inst.url}/api/domains/${id}/connection`, { data: { connection_id: String(sql(inst, 'SELECT id FROM cloudflare_connections')[0]!.id) }, headers: { Origin: new URL(inst.url).origin } });
  expect(link.status(), await link.text()).toBe(200);
  return id;
}

/** Opens the "DNS tools" section of the domain page (it is already open when the page was not reloaded). */
const openTools = async (page: Page) => {
  const b = page.getByRole('button', { name: /DNS tools/ });
  await expect(b).toBeVisible({ timeout: 30_000 });
  if ((await b.getAttribute('aria-expanded')) !== 'true') await b.click();
};

/** The local D1 is a SQLite file the Worker also writes: a read or write from here can meet SQLITE_BUSY, so try again a few times. */
const sql = (inst: Instance, q: string) => {
  for (let i = 0; ; i++) {
    try { return inst.d1(q); } catch (e) {
      if (i >= 8 || !/locked|BUSY/.test(String(e))) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
    }
  }
};

const runDailyJob = async (inst: Instance) => {
  // Not due until 20 hours after the last look: make every row due, as the next day would.
  sql(inst, 'UPDATE spf_flatten_config SET last_attempt_at = NULL');
  const res = await fetch(`${inst.url}/cdn-cgi/handler/scheduled?cron=0+11+*+*+*`);
  expect(res.ok).toBe(true);
  await new Promise((r) => setTimeout(r, 4000));
};
const audits = (inst: Instance, action: string) => Number(sql(inst, `SELECT COUNT(*) AS n FROM audit_log WHERE action = '${action}'`)[0]!.n);

test('turn on, a provider changes its addresses, the job follows it, an outside edit is kept, turn off restores the original', async ({ page }) => {
  const inst: Instance = await startInstance({ mode: 'selfhost', port: 8821, tokenKey: true });
  try {
    const { providerZone, ids } = await seedDns(inst);
    const id = await createOwnerAndAddDomain(page, inst);

    // The domain page offers it, says why, and the wizard writes it.
    await page.goto(`${inst.url}/#/domains/${id}`);
    await openTools(page);
    await expect(page.getByRole('heading', { name: 'SPF flattening', level: 3 })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('link', { name: 'Open SPF flattening' }).click();
    await expect(page.getByText(/Your SPF record needs 11 lookups\. Receivers stop at 10/)).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText('This changes your live DNS')).toBeVisible();
    await page.getByRole('button', { name: 'Turn on flattening' }).click();
    await expect(page.getByRole('heading', { name: 'SPF flattening is on' })).toBeVisible({ timeout: 30_000 });
    expect(await page.getByText(/Checked again every day around 11:00 UTC/).count()).toBeGreaterThan(0);

    // Written: within 10 lookups and 450 bytes, with the original kept in the database.
    const first = (await apex(inst)).content;
    expect(first.length).toBeLessThanOrEqual(450);
    expect(first.match(/include:/g)!.length).toBeLessThan(11);
    expect(first).toContain('ip4:198.51.100.1');
    expect(sql(inst, 'SELECT canonical_record AS c FROM spf_flatten_config')[0]!.c).toBe(ORIGINAL);
    expect(audits(inst, 'spf_flatten.enable')).toBe(1);

    // The provider changes the address of the include we inlined (same size, so the choice of which include to inline does not move): the job rewrites the record, once, with an audit entry.
    await cf(inst, 'PATCH', `/zones/${providerZone}/dns_records/${ids[0]}`, { content: 'v=spf1 ip4:203.0.113.77 -all' });
    await runDailyJob(inst);
    const second = (await apex(inst)).content;
    expect(second).not.toBe(first);
    expect(second).toContain('ip4:203.0.113.77');
    expect(second).not.toContain('ip4:198.51.100.1 ');
    expect(audits(inst, 'spf_flatten.update')).toBe(1);
    expect(sql(inst, 'SELECT previous_record AS p FROM spf_flatten_config')[0]!.p).toBe(first);

    // A quiet day: nothing written, nothing audited.
    const changedAt = sql(inst, 'SELECT last_flattened_at AS t FROM spf_flatten_config')[0]!.t;
    await runDailyJob(inst);
    expect((await apex(inst)).content).toBe(second);
    expect(audits(inst, 'spf_flatten.update')).toBe(1);
    expect(sql(inst, 'SELECT last_flattened_at AS t FROM spf_flatten_config')[0]!.t).toBe(changedAt);

    // The page says what it did: when it looked, and what changed (the previous record is one line below).
    const wizardUrl = `${inst.url}/#/domains/${id}/spf-flatten`;
    await page.goto(wizardUrl);
    await page.reload();
    await expect(page.getByText(/^On: \d+ address(?:es)? in your record.*changed on /)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Before the last change')).toBeVisible();

    // Someone edits the record in Cloudflare: the next run leaves it alone and the page needs attention.
    const edited = 'v=spf1 include:someone-else.example -all';
    await cf(inst, 'PATCH', `/zones/${await zoneId(inst, DOMAIN)}/dns_records/${(await apex(inst)).id}`, { content: edited });
    await cf(inst, 'PATCH', `/zones/${providerZone}/dns_records/${ids[0]}`, { content: 'v=spf1 ip4:192.0.2.5 -all' });
    await runDailyJob(inst);
    expect((await apex(inst)).content).toBe(edited);
    expect(sql(inst, 'SELECT problem_kind AS k FROM spf_flatten_config')[0]!.k).toBe('edited_outside');
    await page.goto(`${wizardUrl}?review=1`);
    await page.reload();
    await expect(page.getByText(/someone changed it there/).first()).toBeVisible({ timeout: 30_000 });

    // Replace puts the fresh record back, then turning off restores the original.
    await expect(page.getByText('In Cloudflare now')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Replace with the flattened record' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Replace' }).click();
    await expect(page.getByRole('heading', { name: 'SPF flattening is on' })).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => (await apex(inst)).content).toContain('ip4:192.0.2.5');
    await page.getByRole('button', { name: 'Turn off' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Turn off' }).click();
    await expect.poll(async () => (await apex(inst)).content, { timeout: 30_000 }).toBe(ORIGINAL);
    expect(sql(inst, 'SELECT COUNT(*) AS n FROM spf_flatten_config')[0]!.n).toBe(0);
  } finally {
    await inst.stop();
  }
});

test('a provider that cannot be read keeps the last good record and the card says so', async ({ page }) => {
  const inst: Instance = await startInstance({ mode: 'selfhost', port: 8822, tokenKey: true });
  try {
    const { providerZone, ids } = await seedDns(inst);
    const id = await createOwnerAndAddDomain(page, inst);
    const on = await page.request.post(`${inst.url}/api/domains/${id}/spf-flatten`, { data: {}, headers: { Origin: new URL(inst.url).origin } });
    expect(on.status(), await on.text()).toBe(201);
    const good = (await apex(inst)).content;
    await cf(inst, 'DELETE', `/zones/${providerZone}/dns_records/${ids[0]}`);
    await runDailyJob(inst);
    expect((await apex(inst)).content).toBe(good);
    expect(sql(inst, 'SELECT problem_kind AS k FROM spf_flatten_config')[0]!.k).toBe('include_unresolved');
    await page.goto(`${inst.url}/#/domains/${id}`);
    await openTools(page);
    await expect(page.getByText(/We could not read the SPF record of _spf1\.mailprovider-test\.net/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  } finally {
    await inst.stop();
  }
});
