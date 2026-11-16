import { test } from '@playwright/test';
import { ADDRESS, apiFor, dmarcOf, fakeCf, ownerWithZones, save, setDmarc, snap, startInstance, walk, zoneId, gotoDomain, SIZES } from './rev-lib';
test.setTimeout(1_500_000);

const Z = { s1: 's1-none.net', s2: 's2-nourua.net', s3: 's3-thirdparty.net', s4: 's4-ours.net', s4b: 's4b-ours.net', s5: 's5-two.net', s7: 's7-parent.net', s10: 's10-fail.net', s11: 's11-race.net' };
const SEED: Record<string, string[]> = {
 [Z.s2]: ['v=DMARC1; p=none'], [Z.s3]: ['v=DMARC1; p=reject; rua=mailto:dmarc@thirdparty.example'],
 [Z.s4]: [`v=DMARC1; p=reject; rua=mailto:${ADDRESS}`], [Z.s4b]: [`v=DMARC1; p=reject; rua=mailto:${ADDRESS}`],
 [Z.s5]: ['v=DMARC1; p=quarantine; rua=mailto:a@x.example,mailto:b@y.example'], [Z.s7]: ['v=DMARC1; p=reject'], [Z.s10]: [], [Z.s11]: ['v=DMARC1; p=reject;'],
};

test('states', async ({ page }) => {
 const inst = await startInstance({ mode: 'hosted', port: 8851, tokenKey: true, vars: { INTAKE_DOMAIN: 'rua.readysetmail.com', HOSTED_CONNECT_REPORTS: 'all' } });
 try {
  const { ids, api, imp } = await ownerWithZones(page, inst, 'owner@harbor-lane.org', Object.values(Z), SEED);
  save('setup', { ids, imp: typeof imp.body === 'string' ? imp.body : JSON.stringify(imp.body).slice(0, 500) });
  // S7: subdomain as its own domain
  const sub = await api('POST', '/api/domains', { domain: `mail.${Z.s7}` });
  save('s7-add', sub);
  const list = (await api('GET', '/api/domains')).body; for (const d of (list.domains ?? list)) ids[d.domain] = d.id;
  const restoreFor = (domain: string, zone: string, seed: string[], preConnect = false) => async () => {
   await api('DELETE', `/api/domains/${ids[domain]}/report-address`);
   await setDmarc(inst, domain, zone, seed);
   if (preConnect) await api('POST', `/api/domains/${ids[domain]}/report-address`);
  };
  const run = async (name: string, f: () => Promise<unknown>) => { try { await f(); } catch (e) { save(`${name}-ERROR`, String(e)); } };
  const std = (state: string, num: number, key: keyof typeof Z, extra: Record<string, unknown> = {}, domain = Z[key], preConnect = false) =>
   run(state, () => walk(page, inst, { state, num, id: ids[domain], domain, zone: Z[key], restore: restoreFor(domain, Z[key], SEED[Z[key]] ?? [], preConnect), ...extra } as any));
  await std('S1', 1, 's1');
  await std('S2', 2, 's2');
  await std('S3', 3, 's3');
  await std('S4', 4, 's4');
  await std('S4b', 41, 's4b', {}, Z.s4b, true);
  await std('S5', 5, 's5', { choose: (w: number) => (w === 375 ? 0 : 1) });
  await run('S7', async () => { const d = `mail.${Z.s7}`; await walk(page, inst, { state: 'S7', num: 7, id: ids[d], domain: d, zone: Z.s7, restore: async () => { await api('DELETE', `/api/domains/${ids[d]}/report-address`); await setDmarc(inst, Z.s7, Z.s7, ['v=DMARC1; p=reject']); } } as any); save('S7-parent-after', await dmarcOf(inst, Z.s7)); save('S7-sub-after', await dmarcOf(inst, d)); });
  await std('S11', 11, 's11', { midHook: async () => {
    const zid = await zoneId(inst, Z.s11);
    const list = await fakeCf(inst, 'GET', `/client/v4/zones/${zid}/dns_records?per_page=500`);
    const r = list.result.find((x: any) => x.name === `_dmarc.${Z.s11}`);
    await fakeCf(inst, 'PATCH', `/client/v4/zones/${zid}/dns_records/${r.id}`, { content: 'v=DMARC1; p=quarantine; rua=mailto:dmarc@thirdparty.example' });
    save('S11-hook', await dmarcOf(inst, Z.s11));
  } });
  // S10: failure mid-apply
  await run('S10', async () => {
   const d = Z.s10, out: any[] = [];
   for (const size of SIZES) {
    const n = { v: 100 }; const w = size.width;
    await api('DELETE', `/api/domains/${ids[d]}/report-address`); await setDmarc(inst, d, d, []);
    await fakeCf(inst, 'POST', '/__rules', { zone: d, rules: [], failPosts: ['TXT'] });
    const before = await dmarcOf(inst, d);
    await gotoDomain(page, inst, ids[d], size);
    const panel = page.getByTestId('connect-reports'); const steps: any[] = [];
    steps.push(await snap(page, 'S10', 'page', w, n));
    await panel.getByRole('button', { name: 'Connect reports' }).click(); await page.waitForTimeout(1500);
    steps.push(await snap(page, 'S10', 'review', w, n));
    await panel.getByRole('button', { name: 'Apply', exact: true }).click();
    await page.waitForFunction(() => !/Applying…/.test((document.querySelector('[data-testid=connect-reports]') as HTMLElement).innerText), null, { timeout: 30000 }).catch(() => {});
    steps.push(await snap(page, 'S10', 'failed', w, n));
    const status = await api('GET', `/api/domains/${ids[d]}/report-address`);
    const afterFail = await dmarcOf(inst, d);
    await page.reload(); await page.waitForTimeout(3500);
    steps.push(await snap(page, 'S10', 'failed-reload', w, n));
    const applyAgain = await panel.getByRole('button', { name: 'Apply', exact: true }).count();
    const connectAgain = await panel.getByRole('button', { name: 'Connect reports' }).count();
    await fakeCf(inst, 'POST', '/__rules', { zone: d, rules: [], failPosts: [] });
    let retry = null;
    if (applyAgain) { await panel.getByRole('button', { name: 'Apply', exact: true }).click(); await page.waitForFunction(() => !/Applying…/.test((document.querySelector('[data-testid=connect-reports]') as HTMLElement).innerText), null, { timeout: 30000 }).catch(() => {}); steps.push(await snap(page, 'S10', 'retry-applied', w, n)); retry = await dmarcOf(inst, d); await page.reload(); await page.waitForTimeout(3500); steps.push(await snap(page, 'S10', 'retry-reload', w, n)); }
    out.push({ size: w, before, afterFail, status, applyAgain, connectAgain, retry, steps });
   }
   save('S10', out);
  });
 } finally { await inst.stop(); }
});
