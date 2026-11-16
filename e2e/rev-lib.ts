import { expect, type Page } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { signUp } from './support/signup';

export interface Instance { url: string; fake: { url: string }; logFile: string; d1(sql: string): any[]; stop(): Promise<void>; persistDir: string }
const nativeImport = new Function('u', 'return import(u)') as (u: string) => Promise<any>;
export const startInstance = async (o: Record<string, unknown>): Promise<Instance> => (await nativeImport(pathToFileURL(resolve(__dirname, 'support/dev-instance.mjs')).href)).startInstance(o);

export const INTAKE = 'rua.readysetmail.com';
export const ADDRESS = `rua@${INTAKE}`;
export const TOKEN = 'e2e-fake-token-not-a-real-secret-0000';
export const SIZES = [{ width: 375, height: 812 }, { width: 1440, height: 900 }];
export const SHOTS = '/tmp/walk/shots';
export const save = (name: string, data: unknown) => writeFileSync(`/tmp/walk/results/${name}.json`, JSON.stringify(data, null, 1));

export const fakeCf = async (inst: Instance, method: string, path: string, body?: unknown) => {
 const r = await fetch(`${inst.fake.url}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: body ? JSON.stringify(body) : undefined });
 return r.json() as Promise<any>;
};
export const dmarcOf = async (inst: Instance, domain: string) => {
 const s = await fakeCf(inst, 'GET', '/__state');
 return (Object.values(s.records).flat() as any[]).filter((r) => r.name === `_dmarc.${domain}`).map((r) => r.content as string);
};
export const zoneId = async (inst: Instance, name: string) => (await fakeCf(inst, 'GET', '/__state')).zones.find((z: any) => z.name === name).id as string;
export async function setDmarc(inst: Instance, domain: string, zone: string, contents: string[]) {
 const zid = await zoneId(inst, zone);
 const list = await fakeCf(inst, 'GET', `/client/v4/zones/${zid}/dns_records?per_page=500`);
 for (const r of list.result.filter((r: any) => r.name === `_dmarc.${domain}`)) await fakeCf(inst, 'DELETE', `/client/v4/zones/${zid}/dns_records/${r.id}`);
 for (const c of contents) await fakeCf(inst, 'POST', `/client/v4/zones/${zid}/dns_records`, { type: 'TXT', name: `_dmarc.${domain}`, content: c });
}

export const apiFor = (page: Page, inst: Instance) => async (method: string, path: string, data?: unknown, headers: Record<string, string> = { origin: inst.url }) => {
 const r = await page.request.fetch(`${inst.url}${path}`, { method, data, headers: { 'content-type': 'application/json', ...headers } });
 let body: any; const t = await r.text(); try { body = JSON.parse(t); } catch { body = t.slice(0, 300); }
 return { status: r.status(), body };
};

/** Sign up, a Cloudflare connection allowing the given zones, import them. Returns {domain -> id}. */
export async function ownerWithZones(page: Page, inst: Instance, email: string, zones: string[], seed: Record<string, string[]> = {}) {
 for (const z of zones) await fakeCf(inst, 'POST', '/__zones', { name: z });
 for (const z of zones) { const id = await zoneId(inst, z); for (const c of seed[z] ?? []) await fakeCf(inst, 'POST', `/client/v4/zones/${id}/dns_records`, { type: 'TXT', name: `_dmarc.${z}`, content: c }); }
 await signUp(page, inst, email);
 const api = apiFor(page, inst);
 const ids = await Promise.all(zones.map((z) => zoneId(inst, z)));
 const { body: { connection } } = await api('POST', '/api/cloudflare/connections', { token: TOKEN, label: 'e2e' });
 await api('PUT', `/api/cloudflare/connections/${connection.id}/zones`, { zone_ids: ids });
 const imp = await api('POST', `/api/cloudflare/connections/${connection.id}/import`, { zone_ids: ids });
 const list = (await api('GET', '/api/domains')).body;
 const out: Record<string, number> = {};
 for (const d of (list.domains ?? list)) out[d.domain] = d.id;
 return { ids: out, connectionId: connection.id as number, imp, api };
}

/** A snapshot of the domain page: screenshots, panel text, words before the primary action, action bottom / viewport height. */
export async function snap(page: Page, state: string, step: string, w: number, n: { v: number }) {
 const tag = `${SHOTS}/${String(n.v).padStart(2, '0')}-${state}-${step}-${w}`;
 await page.waitForTimeout(400);
 await page.screenshot({ path: `${tag}-viewport.png` });
 await page.screenshot({ path: `${tag}-full.png`, fullPage: true });
 const info = await page.evaluate(() => {
  const panel = document.querySelector('[data-testid=connect-reports]') as HTMLElement | null;
  const main = document.querySelector('main') as HTMLElement | null;
  const vh = window.innerHeight;
  const btns = [...document.querySelectorAll('main button')].filter((b) => /^(Connect reports|Apply|Applying…|Connecting…)$/.test((b as HTMLElement).innerText.trim())) as HTMLElement[];
  const btn = btns.find((b) => b.getBoundingClientRect().height > 0) ?? null;
  let words: number | null = null; let bottomOverVh: number | null = null; let bottomAbsolute: number | null = null; let label: string | null = null;
  if (btn && main) {
   words = 0;
   const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
   let node: Node | null;
   while ((node = walker.nextNode())) {
    if (btn.contains(node) || (btn.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) { if (!btn.contains(node)) break; else continue; }
    const el = node.parentElement; if (!el || !el.checkVisibility()) continue;
    words += (node.textContent ?? '').trim().split(/\s+/).filter(Boolean).length;
   }
   const r = btn.getBoundingClientRect(); bottomOverVh = +(r.bottom / vh).toFixed(3); bottomAbsolute = Math.round(r.bottom + window.scrollY); label = btn.innerText.trim();
  }
  return { panelText: panel ? panel.innerText : null, words, bottomOverVh, label, vh, scrollHeight: document.documentElement.scrollHeight, mainWords: main ? main.innerText.split(/\s+/).filter(Boolean).length : null, mainText: main?.innerText.slice(0, 600) ?? null };
 });
 n.v++;
 return { step, ...info, shot: tag };
}

export async function gotoDomain(page: Page, inst: Instance, id: number, size: { width: number; height: number }) {
 await page.setViewportSize(size);
 await page.goto(`${inst.url}/#/domains/${id}`);
 await page.reload();
 await page.getByTestId('connect-reports').waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {});
 await page.waitForFunction(() => { const p = document.querySelector('[data-testid=connect-reports]') as HTMLElement | null; return !!p && p.innerText.trim().length > 0 && !/Loading the report address/.test(p.innerText); }, null, { timeout: 30_000 }).catch(() => {});
 await page.waitForTimeout(1500);
}

/** Generic walk: page -> Connect reports -> review -> (choose first option if any) -> Apply -> settled -> reload. */
export async function walk(page: Page, inst: Instance, o: { state: string; num: number; id: number; domain: string; zone: string; restore: () => Promise<void>; choose?: (w: number) => number; midHook?: () => Promise<void> }) {
 const out: any[] = [];
 for (const size of SIZES) {
  const n = { v: o.num * 10 };
  await o.restore();
  const before = await dmarcOf(inst, o.domain);
  await gotoDomain(page, inst, o.id, size);
  const steps: any[] = []; let clicks = 0; const typed: string[] = []; const errs: string[] = [];
  steps.push(await snap(page, o.state, 'page', size.width, n));
  const panel = page.getByTestId('connect-reports');
  const connect = panel.getByRole('button', { name: 'Connect reports' });
  let reviewDone = false;
  if (await connect.count() && await connect.first().isVisible()) {
   await connect.first().click(); clicks++;
   await page.waitForTimeout(1500);
   steps.push(await snap(page, o.state, 'review', size.width, n)); reviewDone = true;
  }
  if (o.choose) {
   const radios = panel.getByRole('radio');
   if (await radios.count()) { await radios.nth(o.choose(size.width)).check({ force: true }); clicks++; await page.waitForTimeout(500); steps.push(await snap(page, o.state, 'chosen', size.width, n)); }
  }
  if (o.midHook) await o.midHook();
  const apply = panel.getByRole('button', { name: 'Apply', exact: true });
  let after: string[] | null = null;
  if (await apply.count() && await apply.first().isVisible() && await apply.first().isEnabled()) {
   await apply.first().click(); clicks++;
   await page.waitForFunction(() => { const p = document.querySelector('[data-testid=connect-reports]') as HTMLElement | null; return !!p && !/Applying…/.test(p.innerText); }, null, { timeout: 30_000 }).catch((e) => errs.push(String(e)));
   steps.push(await snap(page, o.state, 'applied', size.width, n));
   after = await dmarcOf(inst, o.domain);
   await page.reload(); await page.waitForTimeout(3500);
   steps.push(await snap(page, o.state, 'reload', size.width, n));
  } else { after = await dmarcOf(inst, o.domain); }
  out.push({ size: size.width, clicks, typed, scrolls: 'none needed unless bottomOverVh > 1', before, after, steps, errs, reviewDone });
 }
 save(o.state, out);
 return out;
}
