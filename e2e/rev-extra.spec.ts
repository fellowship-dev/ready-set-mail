import { test, expect } from '@playwright/test';
import { ADDRESS, INTAKE, TOKEN, apiFor, dmarcOf, fakeCf, ownerWithZones, save, setDmarc, snap, startInstance, zoneId, gotoDomain, SIZES } from './rev-lib';
test.setTimeout(900_000);
const REC = `v=DMARC1; p=reject; rua=mailto:${ADDRESS}`;

test('S8 owner-only, non-operator', async ({ page }) => {
 const inst = await startInstance({ mode: 'hosted', port: 8853, tokenKey: true, vars: { INTAKE_DOMAIN: INTAKE, HOSTED_CONNECT_REPORTS: 'owner', OWNER_EMAIL: 'someone-else@operator.example' } });
 try {
  const D = 's8-nonop.net';
  const { ids, api } = await ownerWithZones(page, inst, 'owner@harbor-lane.org', [D], { [D]: ['v=DMARC1; p=reject;'] });
  const id = ids[D]; const out: any = { pages: [] };
  for (const size of SIZES) {
   const n = { v: 800 + (size.width === 375 ? 0 : 5) };
   await gotoDomain(page, inst, id, size);
   const s = await snap(page, 'S8', 'page', size.width, n);
   const btns = await page.locator('main button').allInnerTexts();
   out.pages.push({ w: size.width, ...s, buttons: btns });
   await page.goto(`${inst.url}/#/domains/${id}/settings`); await page.reload(); await page.waitForTimeout(4000);
   out.pages.push({ w: size.width, settings: await snap(page, 'S8', 'settings', size.width, n) });
  }
  out.get = await api('GET', `/api/domains/${id}/report-address`);
  out.dmarcBefore = await dmarcOf(inst, D);
  out.post = await api('POST', `/api/domains/${id}/report-address`, {});
  out.apply = await api('POST', `/api/domains/${id}/apply-dmarc`, { record: REC });
  out.dmarcAfterApply = await dmarcOf(inst, D);
  out.getAfter = await api('GET', `/api/domains/${id}/report-address`);
  out.applyNoAddr = await api('POST', `/api/domains/${id}/apply-dmarc`, { record: 'v=DMARC1; p=quarantine;' });
  out.dmarcAfterApply2 = await dmarcOf(inst, D);
  save('S8', out);
 } finally { await inst.stop(); }
});

test('H5 selfhost', async ({ page }) => {
 const inst = await startInstance({ mode: 'selfhost', port: 8854, tokenKey: true });
 try {
  await page.goto(inst.setupLink());
  await page.locator('#email').fill('owner@example.com'); await page.locator('#password').fill('correct horse battery staple'); await page.locator('#confirm').fill('correct horse battery staple');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: "Let's set up Ready Set Mail" })).toBeVisible({ timeout: 30000 });
  const api = apiFor(page, inst);
  const D = 'harbor-lane.org'; const zid = await zoneId(inst, D);
  const { body: { connection } } = await api('POST', '/api/cloudflare/connections', { token: TOKEN, label: 'e2e' });
  await api('PUT', `/api/cloudflare/connections/${connection.id}/zones`, { zone_ids: [zid] });
  const imp = await api('POST', `/api/cloudflare/connections/${connection.id}/import`, { zone_ids: [zid] });
  const list = (await api('GET', '/api/domains')).body; const id = (list.domains ?? list).find((d: any) => d.domain === D)?.id;
  const out: any = { id, imp: JSON.stringify(imp.body).slice(0, 300), routes: {}, pages: [] };
  const r = api;
  out.routes.setDefault = await r('PUT', `/api/domains/${id}/set-default`);
  out.routes.spfGet = await r('GET', `/api/domains/${id}/spf-flatten`);
  out.routes.spfPost = await r('POST', `/api/domains/${id}/spf-flatten`, {});
  out.routes.spfPreview = await r('POST', `/api/domains/${id}/spf-flatten/preview`, {});
  out.routes.alerts = await r('PATCH', `/api/domains/${id}/alerts`, { alerts_enabled: false });
  out.routes.monitorSubs = await r('GET', `/api/domains/${id}/monitor-subs`);
  out.routes.monitorSubPatch = await r('PATCH', '/api/monitor-subs/1', { active: false });
  out.routes.mtaGet = await r('GET', `/api/domains/${id}/mta-sts`);
  out.routes.reportAddress = await r('GET', `/api/domains/${id}/report-address`);
  for (const size of SIZES) {
   const n = { v: 900 + (size.width === 375 ? 0 : 20) }; const w = size.width; await page.setViewportSize(size);
   await page.goto(`${inst.url}/#/domains/${id}/settings`); await page.reload(); await page.waitForTimeout(4500);
   const s = await snap(page, 'H5', 'settings', w, n); const t = await page.locator('main').innerText();
   await page.goto(`${inst.url}/#/domains/${id}`); await page.reload(); await page.waitForTimeout(5000);
   const d = await snap(page, 'H5', 'domain-page', w, n); const dt = await page.locator('main').innerText();
   const disc = await page.locator('main summary, main button[aria-expanded]').allInnerTexts();
   let toolsOpen: any = null;
   try { const el = page.locator('main').getByText(/^DNS tools/).first(); await el.scrollIntoViewIfNeeded(); await el.click({ timeout: 4000 }); await page.waitForTimeout(3000); toolsOpen = await snap(page, 'H5', 'dns-tools-open', w, n); } catch (e) { toolsOpen = String(e).slice(0, 100); }
   out.pages.push({ w, settingsText: t, settingsShot: s.shot, hasInfra: /Infrastructure/.test(t), hasSetDefault: /Set as default/.test(t), hasAlerts: /Monitoring alerts/.test(t), domainHasDnsTools: /DNS tools/.test(dt), disc, toolsOpenText: typeof toolsOpen === 'string' ? toolsOpen : toolsOpen.mainText, domShot: d.shot });
  }
  save('H5', out);
 } finally { await inst.stop(); }
});
