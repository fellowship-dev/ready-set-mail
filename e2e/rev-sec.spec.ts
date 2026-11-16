import { test, expect } from '@playwright/test';
import { ADDRESS, INTAKE, apiFor, dmarcOf, fakeCf, ownerWithZones, save, setDmarc, snap, startInstance, zoneId, gotoDomain, SIZES, SHOTS } from './rev-lib';
import { mailedCodes } from './support/signup';
test.setTimeout(1_500_000);

const REC = `v=DMARC1; p=reject; rua=mailto:${ADDRESS}`;
const D = 'sec-linked.net';

test('security, S6, S9, S12, hiding (hosted)', async ({ page, browser }) => {
 const inst = await startInstance({ mode: 'hosted', port: Number(process.env.PORT ?? 8852), tokenKey: true, vars: { INTAKE_DOMAIN: INTAKE, HOSTED_CONNECT_REPORTS: 'all' } });
 const run = async (name: string, f: () => Promise<unknown>) => { if (!(process.env.ONLY ?? '').split(',').includes(name)) return; try { await f(); } catch (e) { save(`${name}-ERROR`, String(e)); } };
 try {
  const { ids, api } = await ownerWithZones(page, inst, 'owner@harbor-lane.org', [D], { [D]: ['v=DMARC1; p=reject;'] });
  const id = ids[D];
  const ws = inst.d1('SELECT id FROM workspaces')[0].id as string;
  save('sec-setup', { ids, ws, ownerDomains: (await api('GET', '/api/domains')).body });

  // CSRF
  await run('CSRF', async () => {
   const out: any = {};
   for (const [k, h] of Object.entries({ evil: { origin: 'https://evil.example' }, none: {}, same: { origin: inst.url } })) {
    out[`apply-${k}`] = await api('POST', `/api/domains/${id}/apply-dmarc`, { record: REC }, h as any);
    out[`connect-${k}`] = await api('POST', `/api/domains/${id}/report-address`, {}, h as any);
    out[`disconnect-${k}`] = await api('DELETE', `/api/domains/${id}/report-address`, undefined, h as any);
    out[`dmarc-after-${k}`] = await dmarcOf(inst, D);
    if (k !== 'same') { /* reset state to compare fairly */ }
   }
   save('CSRF', out);
   await api('DELETE', `/api/domains/${id}/report-address`); await setDmarc(inst, D, D, ['v=DMARC1; p=reject;']);
  });

  // H4 routes
  await run('H4', async () => {
   const out: any = {};
   const r = (m: string, p: string, d?: unknown) => api(m, p, d);
   out.setDefault = await r('PUT', `/api/domains/${id}/set-default`);
   out.spfGet = await r('GET', `/api/domains/${id}/spf-flatten`);
   out.spfPost = await r('POST', `/api/domains/${id}/spf-flatten`, {});
   out.spfPreview = await r('POST', `/api/domains/${id}/spf-flatten/preview`, {});
   out.alerts = await r('PATCH', `/api/domains/${id}/alerts`, { alerts_enabled: false });
   out.monitorSubs = await r('GET', `/api/domains/${id}/monitor-subs`);
   out.monitorSubPatch = await r('PATCH', '/api/monitor-subs/1', { active: false });
   out.mtaGet = await r('GET', `/api/domains/${id}/mta-sts`);
   out.mtaPost = await r('POST', `/api/domains/${id}/mta-sts`, { mx_hosts: ['mx.example.com'] });
   out.mtaPatch = await r('PATCH', `/api/domains/${id}/mta-sts`, { mode: 'enforce' });
   out.mtaDelete = await r('DELETE', `/api/domains/${id}/mta-sts`);
   out.fakeAllRecordsAfter = Object.values((await fakeCf(inst, 'GET', '/__state')).records).flat().map((x: any) => `${x.type} ${x.name} ${x.content}`);
   save('H4', out);
  });

  // H1-H3 pages
  await run('H-pages', async () => {
   const out: any[] = [];
   for (const size of SIZES) {
    const n = { v: 200 + (size.width === 375 ? 0 : 50) };
    await page.setViewportSize(size);
    const w = size.width;
    // H1
    await page.goto(`${inst.url}/#/domains/${id}/settings`); await page.reload(); await page.waitForTimeout(4000);
    const h1 = await snap(page, 'H1', 'settings', w, n);
    const headings = await page.locator('main h1, main h2, main h3').allInnerTexts();
    const bodyText = await page.locator('main').innerText();
    const csv = await page.evaluate(async (i) => { const r = await fetch(`/api/domains/${i}/export`, { credentials: 'include' }); return { status: r.status, type: r.headers.get('content-type'), head: (await r.text()).slice(0, 200) }; }, id);
    // click Download CSV in UI
    let download: any = null;
    try { const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }), page.getByRole('button', { name: 'Download CSV' }).click()]); download = dl.suggestedFilename(); } catch (e) { download = 'NO DOWNLOAD: ' + String(e).slice(0, 100); }
    // danger zone
    let danger: any = null;
    try { await page.getByRole('button', { name: 'Remove domain' }).click(); await page.waitForTimeout(800); danger = await snap(page, 'H2', 'remove-dialog', w, n); await page.keyboard.press('Escape'); } catch (e) { danger = String(e).slice(0, 100); }
    out.push({ w, h1: { ...h1, headings, hasInfra: /Infrastructure|Set as default/.test(bodyText), hasAlerts: /Monitoring alerts/.test(bodyText) }, csv, download, danger });
    // H2 domain page
    await gotoDomain(page, inst, id, size);
    const dp = await snap(page, 'H2', 'domain-page', w, n);
    const mainText = await page.locator('main').innerText();
    const discl = await page.locator('main summary, main button[aria-expanded]').allInnerTexts();
    const opened: any = {};
    for (const t of ['DKIM', 'DNS records', 'Email health report']) {
     try {
      const el = page.locator('main').getByText(new RegExp(`^${t}`)).first();
      await el.scrollIntoViewIfNeeded(); await el.click({ timeout: 5000 }); await page.waitForTimeout(3500);
      opened[t] = await snap(page, 'H2', `open-${t.replace(/\W/g, '')}`, w, n);
     } catch (e) { opened[t] = 'ERR ' + String(e).slice(0, 120); }
    }
    out.push({ w, domainPage: { disclosures: discl, hasDnsTools: /DNS tools|SPF flattening|MTA-STS/.test(mainText), mainText: mainText.slice(0, 2500) }, opened: Object.fromEntries(Object.entries(opened).map(([k, v]: any) => [k, typeof v === 'string' ? v : { text: v.mainText, shot: v.shot }])) });
    // H3
    for (const path of ['spf-flatten', 'mta-sts']) {
     await page.goto(`${inst.url}/#/domains/${id}/${path}`); await page.reload(); await page.waitForTimeout(4000);
     const s = await snap(page, 'H3', path, w, n);
     const txt = await page.locator('main').innerText();
     const btns = await page.locator('main button').allInnerTexts();
     let afterClick: any = null;
     if (path === 'mta-sts') {
      const b = page.locator('main').getByRole('button', { name: /enable/i }).first();
      if (await b.count()) { await b.click(); await page.waitForTimeout(4000); afterClick = { text: await page.locator('main').innerText(), shot: (await snap(page, 'H3', 'mta-sts-clicked', w, n)).shot }; }
      else afterClick = 'no Enable button; buttons: ' + btns.join(' | ');
     }
     out.push({ w, path, text: txt, btns, shot: s.shot, afterClick });
    }
   }
   out.push({ fakeAfter: Object.values((await fakeCf(inst, 'GET', '/__state')).records).flat().map((x: any) => `${x.type} ${x.name} ${x.content}`) });
   save('H-pages', out);
  });

  // S12: unproven / lost
  await run('S12', async () => {
   const out: any = {};
   const mk = (name: string, cols: string) => inst.d1(`INSERT INTO domains (workspace_id, domain, rua_address, ${cols.split('|')[0]}) VALUES ('${ws}', '${name}', 'rua@x.test', ${cols.split('|')[1]})`);
   mk('s12-legacy.net', "verified_via|'legacy'");
   mk('s12-lost.net', "verified_via, proof_lost_at|'txt', unixepoch()");
   mk('s12-parentorphan.net', "verified_via|'parent'");
   const all = (await api('GET', '/api/domains')).body; const list = all.domains ?? all;
   out.list = list.map((d: any) => ({ d: d.domain, id: d.id }));
   for (const name of ['s12-legacy.net', 's12-lost.net', 's12-parentorphan.net']) {
    const did = list.find((d: any) => d.domain === name)?.id;
    if (!did) { out[name] = 'not in /api/domains'; continue; }
    out[name] = { id: did, get: await api('GET', `/api/domains/${did}/report-address`), post: await api('POST', `/api/domains/${did}/report-address`, {}), apply: await api('POST', `/api/domains/${did}/apply-dmarc`, { record: REC }) };
    for (const size of SIZES) { const n = { v: 300 + (size.width === 375 ? 0 : 5) }; await gotoDomain(page, inst, did, size); out[name][`page${size.width}`] = await snap(page, 'S12-' + name, 'page', size.width, n); }
   }
   save('S12', out);
  });

  // S6: manual, unlinked
  await run('S6', async () => {
   const out: any[] = [];
   const cases = [{ name: 's6a-nocf.net', ns: ['ns1.example-dns.net', 'ns2.example-dns.net'] }, { name: 's6b-cf.net', ns: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'] }];
   for (const c of cases) {
    await fakeCf(inst, 'POST', '/__zones', { name: c.name });
    await fakeCf(inst, 'POST', '/__ns', { name: c.name, ns: c.ns });
    inst.d1(`INSERT INTO domains (workspace_id, domain, rua_address, verified_via, verified_at) VALUES ('${ws}', '${c.name}', 'rua@x.test', 'txt', unixepoch())`);
   }
   const all = (await api('GET', '/api/domains')).body; const list = all.domains ?? all;
   for (const c of cases) {
    save('S6-list', { list: list.map((d: any) => d.domain), rows: inst.d1('SELECT id, domain, workspace_id, verified_via, evicted_at FROM domains') });
    const did = list.find((d: any) => d.domain === c.name).id as number;
    for (const size of SIZES) {
     const n = { v: (c.name.startsWith('s6a') ? 400 : 420) + (size.width === 375 ? 0 : 5) }; const w = size.width;
     await api('DELETE', `/api/domains/${did}/report-address`);
     const zid = await zoneId(inst, c.name);
     const list2 = await fakeCf(inst, 'GET', `/client/v4/zones/${zid}/dns_records?per_page=500`);
     for (const r of list2.result.filter((r: any) => r.name.startsWith('_dmarc'))) await fakeCf(inst, 'DELETE', `/client/v4/zones/${zid}/dns_records/${r.id}`);
     const steps: any[] = []; let clicks = 0;
     await gotoDomain(page, inst, did, size);
     steps.push(await snap(page, 'S6-' + c.name, 'page', w, n));
     const panel = page.getByTestId('connect-reports');
     const connect = panel.getByRole('button', { name: 'Connect reports' });
     if (await connect.count()) { await connect.first().click(); clicks++; await page.waitForTimeout(3500); steps.push(await snap(page, 'S6-' + c.name, 'connected', w, n)); }
     const status = await api('GET', `/api/domains/${did}/report-address`);
     const before = await dmarcOf(inst, c.name);
     // publish by hand
     await fakeCf(inst, 'POST', `/client/v4/zones/${zid}/dns_records`, { type: 'TXT', name: `_dmarc.${c.name}`, content: `v=DMARC1; p=none; rua=mailto:${ADDRESS}` });
     const again = panel.getByRole('button', { name: /Check again/ });
     let checkText: any = 'no Check again button';
     if (await again.count()) { await again.first().click(); clicks++; await page.waitForTimeout(3500); steps.push(await snap(page, 'S6-' + c.name, 'checked', w, n)); }
     await page.reload(); await page.waitForTimeout(3500); steps.push(await snap(page, 'S6-' + c.name, 'reload', w, n));
     out.push({ c: c.name, ns: c.ns, w, clicks, status: status.body, before, afterHandPublish: await dmarcOf(inst, c.name), steps });
    }
   }
   save('S6', out);
  });

  // S9: member
  await run('S9', async () => {
   const out: any = {};
   const inv = await api('POST', '/api/team/invite', { email: 'member@harbor-lane.org', role: 'member' });
   out.invite = inv;
   const token = inst.d1('SELECT token FROM invites')[0].token as string;
   const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, ignoreHTTPSErrors: true });
   const mp = await ctx.newPage();
   try {
    await mp.goto(`${inst.url}/#/invite/${token}`);
    const before = mailedCodes(inst).length;
    await mp.getByLabel('Choose a password').fill('correct-horse-battery');
    await mp.getByRole('button', { name: 'Accept invite' }).click();
    await expect.poll(() => mailedCodes(inst).length, { timeout: 30000 }).toBeGreaterThan(before);
    await mp.getByLabel('6-digit code').pressSequentially(mailedCodes(inst).at(-1)!);
    await mp.waitForTimeout(6000);
    out.afterAcceptUrl = mp.url();
    const mapi = apiFor(mp, inst);
    out.me = await mapi('GET', '/api/me');
    const all = (await mapi('GET', '/api/domains')).body; const list = all.domains ?? all;
    const did = list.find((d: any) => d.domain === D)?.id;
    out.did = did;
    await setDmarc(inst, D, D, ['v=DMARC1; p=reject;']);
    out.get = await mapi('GET', `/api/domains/${did}/report-address`);
    out.post = await mapi('POST', `/api/domains/${did}/report-address`, {});
    out.apply = await mapi('POST', `/api/domains/${did}/apply-dmarc`, { record: REC });
    out.del = await mapi('DELETE', `/api/domains/${did}/report-address`);
    out.fakeAfter = await dmarcOf(inst, D);
    const pg: any[] = [];
    for (const size of SIZES) { const n = { v: 500 + (size.width === 375 ? 0 : 5) }; await mp.setViewportSize(size); await mp.goto(`${inst.url}/#/domains/${did}`); await mp.reload(); await mp.waitForTimeout(5000);
     const s = await snap(mp, 'S9', 'member-page', size.width, n);
     const dis = await mp.getByTestId('connect-reports').getByRole('button').evaluateAll((bs) => bs.map((b: any) => ({ t: b.innerText, disabled: b.disabled, aria: b.getAttribute('aria-disabled'), title: b.title })));
     pg.push({ w: size.width, ...s, buttons: dis }); }
    out.pages = pg;
   } finally { await ctx.close(); }
   save('S9', out);
  });
 } finally { await inst.stop(); }
});
