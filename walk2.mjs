// PR 177 round-2 independent walk. Run from the ready-set-mail checkout root on a devbox: node walk2.mjs <flow> [...]
// Throwaway hosted instances (e2e/support/dev-instance.mjs). Cloudflare consent: a local stand-in (Allow / Cancel) plus a stub token endpoint.
import { chromium } from '@playwright/test';
import http from 'node:http';
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { startInstance } from './e2e/support/dev-instance.mjs';
import { pageMetrics } from './fcmeasure.mjs';

const OUT = process.env.OUT || `${process.env.HOME}/walk-out`;
mkdirSync(OUT, { recursive: true });
const VIEWS = [[375, 812], [1440, 900]];
const PW = 'correct-horse-battery';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let port = Number(process.env.PORT0 || 8850);
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const logOf = (inst) => (existsSync(inst.logFile) ? strip(readFileSync(inst.logFile, 'utf8')) : '');
const codes = (inst) => [...logOf(inst).matchAll(/(\d{6}) is your Ready Set Mail code/g)].map((m) => m[1]);
const mailFiles = (inst) => [...logOf(inst).matchAll(/^(Text|HTML): (\S+)$/gm)].map((m) => ({ kind: m[1], file: m[2] }));
const subjects = (inst) => [...logOf(inst).matchAll(/Subject: (.*)$/gm)].map((m) => m[1]);
const GLOBAL = path.join(OUT, 'global.log');
const glog = (s) => { console.log(s); appendFileSync(GLOBAL, `${new Date().toISOString()} ${s}\n`); };

async function waitCode(inst, before, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const c = codes(inst); if (c.length > before) return c.at(-1); await sleep(250); }
  return null;
}

// ── Cloudflare consent stand-in + fake PostHog ──
function startAux() {
  const posthog = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (u.pathname === '/authorize') {
        const ru = u.searchParams.get('redirect_uri'); const st = u.searchParams.get('state');
        const allow = `${ru}?code=stand-in-code-${Date.now()}&state=${encodeURIComponent(st)}`;
        const cancel = `${ru}?error=access_denied&state=${encodeURIComponent(st)}`;
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<!doctype html><meta name=viewport content="width=device-width"><title>Cloudflare (stand-in)</title><main style="font:16px system-ui;max-width:28rem;margin:2rem auto;padding:0 16px"><h1>Allow Ready Set Mail to access your Cloudflare account?</h1><p>STAND-IN for dash.cloudflare.com consent (local walk). Account: Example Co. Scopes: ${u.searchParams.get('scope') || ''}</p><a id=allow href="${allow}" style="display:inline-block;padding:10px 16px;background:#f38020;color:#fff">Allow</a> <a id=cancel href="${cancel}">Cancel</a></main>`);
        return;
      }
      if (u.pathname === '/token') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: `stand-in-access-${Date.now()}`, refresh_token: `stand-in-refresh-${Date.now()}`, expires_in: 3600, token_type: 'bearer', scope: 'account:read zone:read dns:edit dns:read' }));
        return;
      }
      if (u.pathname.startsWith('/batch') || u.pathname.startsWith('/i/') || u.pathname.startsWith('/capture')) {
        try { posthog.push(JSON.parse(body)); } catch { posthog.push({ raw: body }); }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":1}'); return;
      }
      res.writeHead(404); res.end();
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${srv.address().port}`, posthog, close: () => srv.close() })));
}

async function newInstance({ oauth = true, analytics = true, vars = {} } = {}) {
  const aux = await startAux();
  const inst = await startInstance({
    mode: 'hosted', port: port++, tokenKey: true,
    dohNs: { 'brightwave-mail.com': ['ns1.ns.cloudflare.com'], 'quietfield.net': ['ns1.ns.cloudflare.com'], 'harbor-lane.org': ['ns1.domaincontrol.com'] },
    vars: {
      INTAKE_DOMAIN: 'rua.intake.example.net', HOSTED_CONNECT_REPORTS: 'all', MAIL_REPLY_TO: 'hello@readysetmail.example',
      ...(oauth ? { CF_OAUTH_CLIENT_ID: 'stand-in-client', CF_OAUTH_AUTHORIZE_URL: `${aux.url}/authorize`, CF_OAUTH_TOKEN_URL: `${aux.url}/token`, CF_OAUTH_SCOPES: 'account:read zone:read dns:edit dns:read' } : {}),
      ...(analytics ? { POSTHOG_KEY: 'phc_standinkey000000000000000000000000000000', POSTHOG_HOST: 'https://us.i.posthog.com', POSTHOG_API_BASE: aux.url } : {}),
      ...vars,
    },
  });
  inst.aux = aux;
  const stop = inst.stop; inst.stop = async () => { await stop(); aux.close(); };
  return inst;
}

/** Page facts beyond FlowChad's measure. */
function extras() {
  const vis = (e) => { const r = e.getBoundingClientRect(); if (!r.width && !r.height) return false; const cs = getComputedStyle(e); return cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity !== 0; };
  const vh = innerHeight;
  const root = document.querySelector('main') || document.body;
  const box = (e) => { const r = e.getBoundingClientRect(); return { top: +((r.top + scrollY) / vh).toFixed(2), bottom: +((r.bottom + scrollY) / vh).toFixed(2) }; };
  const txt = (e) => (e.getAttribute('aria-label') || e.innerText || e.value || '').trim().replace(/\s+/g, ' ').slice(0, 90);
  const buttons = [...document.querySelectorAll('button, a[href], [role=button]')].filter(vis).map((e) => { const cs = getComputedStyle(e); return { text: txt(e), bg: cs.backgroundColor, inMain: root.contains(e), ...box(e) }; });
  const inputs = [...root.querySelectorAll('input:not([type=hidden]), select, textarea, [role=combobox], [role=radio]')].filter(vis).map((e) => ({ id: e.id || e.name || e.getAttribute('role'), label: (e.labels?.[0]?.innerText || e.getAttribute('aria-label') || e.placeholder || '').trim().slice(0, 80), ...box(e) }));
  const alerts = [...document.querySelectorAll('[role=alert], [role=status], [data-slot=alert]')].filter(vis).map((e) => txt(e));
  const headings = [...document.querySelectorAll('h1, h2, h3')].filter(vis).map((e) => `${e.tagName}:${txt(e)}`);
  const turnstile = [...document.querySelectorAll('iframe')].filter((f) => /challenges\.cloudflare\.com/.test(f.src) && vis(f)).map(box);
  return { url: location.hash || location.pathname, headings, buttons, inputs, alerts, turnstile, pageVh: +(document.documentElement.scrollHeight / vh).toFixed(2), mainText: (root.innerText || '').trim().slice(0, 4000) };
}

function flow(name, page) {
  const dir = path.join(OUT, name);
  mkdirSync(dir, { recursive: true });
  const rec = { flow: name, started: new Date().toISOString(), steps: [], notes: [], errors: [], emails: [] };
  const c = { clicks: 0, keys: 0, fields: new Set(), log: [] };
  let mark = { clicks: 0, keys: 0, fields: 0, log: 0, t: Date.now() };
  const save = () => writeFileSync(path.join(dir, 'raw.json'), JSON.stringify(rec, null, 1));
  const api = {
    rec, c, dir, save, page,
    async click(loc, note) { await loc.click(); c.clicks++; c.log.push(`click:${note}`); },
    async fill(loc, text, note) { await loc.fill(text); c.keys += text.length; c.fields.add(note); c.log.push(`type:${note}(${text.length})`); },
    async seq(loc, text, note) { await loc.pressSequentially(text); c.keys += text.length; c.fields.add(note); c.log.push(`type:${note}(${text.length})`); },
    note(s) { rec.notes.push(s); glog(`  [${name}] note: ${s}`); save(); },
    async cap(step, { primary = null, wait = null, full = true, themes = ['light', 'dark'], views = VIEWS } = {}) {
      const prev = rec.steps.at(-1);
      if (prev && prev.clicks === undefined) { prev.clicks = c.clicks - mark.clicks; prev.keystrokes = c.keys - mark.keys; prev.actions = c.log.slice(mark.log); prev.fields_typed = c.fields.size - mark.fields; prev.wall_ms = Date.now() - mark.t; }
      mark = { clicks: c.clicks, keys: c.keys, fields: c.fields.size, log: c.log.length, t: Date.now() };
      await sleep(600);
      const idx = String(rec.steps.length + 1).padStart(2, '0');
      const s = { index: rec.steps.length + 1, step, primary, wait, at: new Date().toISOString(), screenshots: {}, measures: {}, extras: {} };
      const orig = page.viewportSize();
      for (const [w, h] of views) {
        await page.setViewportSize({ width: w, height: h });
        for (const theme of themes) {
          await page.emulateMedia({ colorScheme: theme });
          await sleep(300);
          await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
          const f = `${idx}-${step}@${w}-${theme}.png`;
          await page.screenshot({ path: path.join(dir, f) });
          s.screenshots[`${w}-${theme}`] = f;
          if (theme === 'light') {
            if (full) { const ff = `${idx}-${step}@${w}-full.png`; await page.screenshot({ path: path.join(dir, ff), fullPage: true }); s.screenshots[`${w}-full`] = ff; }
            s.measures[w] = await page.evaluate(pageMetrics, primary).catch((e) => ({ error: String(e) }));
            s.extras[w] = await page.evaluate(extras).catch((e) => ({ error: String(e) }));
          }
        }
      }
      await page.emulateMedia({ colorScheme: 'light' });
      if (orig) await page.setViewportSize(orig);
      rec.steps.push(s);
      const m = s.measures;
      glog(`  [${name}] ${idx} ${step}: words ${m[1440]?.words}/${m[375]?.words} | primary ${m[375]?.primary_source} 375=${m[375]?.scroll_before_primary_vh} | ${s.extras[1440]?.url} | ${JSON.stringify(s.extras[1440]?.headings?.slice(0, 2))}`);
      save();
      return s;
    },
    finish() { const prev = rec.steps.at(-1); if (prev && prev.clicks === undefined) { prev.clicks = c.clicks - mark.clicks; prev.keystrokes = c.keys - mark.keys; prev.actions = c.log.slice(mark.log); prev.fields_typed = c.fields.size - mark.fields; } rec.totals = { clicks: c.clicks, keystrokes: c.keys, fields: [...c.fields] }; rec.finished = new Date().toISOString(); save(); },
  };
  return api;
}

async function S1(W, page, inst, email, { query = '' } = {}) {
  await page.goto(`${inst.url}/#/signup${query}`);
  await page.getByLabel('Work email').waitFor({ timeout: 30000 });
  await W.cap('S1-signup', { primary: '#email' });
  await W.fill(page.getByLabel('Work email'), email, 'email');
  await W.fill(page.getByLabel('Password', { exact: true }), PW, 'password');
  const t0 = Date.now();
  await W.click(page.getByRole('button', { name: 'Continue' }), 'Continue');
  await page.getByRole('heading', { name: 'Tell us about yourself' }).waitFor({ timeout: 30000 });
  return Date.now() - t0;
}
async function S2(W, page, { name = 'Dana Whitfield', org = 'Brightwave Studio', whose = "My company's" } = {}, waitMs) {
  await W.cap('S2-about', { primary: '#name', wait: { ms: waitMs, after: 'S1 Continue' } });
  await W.fill(page.getByLabel('Your name'), name, 'name');
  await W.fill(page.getByLabel('Organization name'), org, 'organization');
  await W.click(page.getByLabel(whose), `fork:${whose}`);
  await W.click(page.getByRole('button', { name: 'Continue' }), 'Continue');
  await page.getByRole('heading', { name: 'Check your inbox' }).waitFor({ timeout: 30000 });
}
async function S3(W, page, inst, before) {
  await W.cap('S3-code', { primary: '#code' });
  const code = await waitCode(inst, before);
  if (!code) throw new Error('no code mailed');
  await W.seq(page.getByLabel('6-digit code'), code, 'code');
  return code;
}
const s4Heading = (page) => page.getByRole('heading', { name: /^(Which domain do you send email from\?|Add your first client's domain)$/ });

async function consentAllow(W, page, { cancel = false } = {}) {
  await page.waitForURL(/\/authorize/, { timeout: 30000 });
  await page.locator('#allow').waitFor();
  await W.cap('CF-consent-STANDIN', { primary: null, themes: ['light'], full: false });
  await W.click(page.locator(cancel ? '#cancel' : '#allow'), cancel ? 'Cancel (consent)' : 'Allow (consent)');
}
const applyBtn = (page) => page.getByRole('button', { name: /^Apply \d+ changes?$/ });

async function emailShots(W, browser, inst, label, fromIdx = 0) {
  const files = mailFiles(inst).slice(fromIdx);
  const out = [];
  for (const [i, f] of files.entries()) {
    let body = ''; try { body = readFileSync(f.file, 'utf8'); } catch { continue; }
    out.push({ i, kind: f.kind, size: body.length, text: f.kind === 'Text' ? body.slice(0, 3000) : undefined });
    if (f.kind !== 'HTML') continue;
    const ctx = await browser.newContext({ javaScriptEnabled: false });
    const p = await ctx.newPage();
    await p.setViewportSize({ width: 375, height: 812 });
    await p.setContent(body);
    const fn = `email-${label}-${i}@375.png`;
    await p.screenshot({ path: path.join(W.dir, fn), fullPage: true });
    out.at(-1).shot = fn;
    await ctx.close();
  }
  W.rec.emails.push({ label, subjects: subjects(inst), parts: out });
  W.save();
}

async function run(browser, name, fn, instOpts = {}) {
  const inst = await newInstance(instOpts);
  glog(`== ${name} on ${inst.url}`);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const W = flow(name, page);
  const t0 = Date.now();
  try { await fn({ W, page, ctx, inst, browser, t0 }); }
  catch (e) { W.rec.errors.push(String(e.stack || e)); W.note(`STOPPED: ${String(e.message).split('\n')[0]}`); try { await W.cap('stopped', { themes: ['light'] }); } catch {} }
  W.rec.posthog = inst.aux.posthog;
  W.finish(); await ctx.close(); await inst.stop();
}

// ── Flows ──
const F = {};

// (a)+(c) cold, company, Cloudflare via OAuth stand-in
F.cold = (b) => run(b, 'a-cold-cloudflare', async ({ W, page, inst, browser, t0 }) => {
  const before = codes(inst).length;
  const w1 = await S1(W, page, inst, 'dana@brightwave-mail.com');
  await S2(W, page, {}, w1);
  await S3(W, page, inst, before);
  await s4Heading(page).waitFor({ timeout: 30000 });
  await W.cap('S4-domain', { primary: '#s4-domain' });
  await W.fill(page.getByLabel('Domain'), 'brightwave-mail.com', 'domain');
  const tc = Date.now();
  await W.click(page.getByRole('button', { name: 'Check brightwave-mail.com' }), 'Check');
  await page.getByRole('button', { name: 'Connect Cloudflare' }).waitFor({ timeout: 60000 });
  await W.cap('S4-result', { primary: null, wait: { ms: Date.now() - tc, after: 'Check' } });
  await W.click(page.getByRole('button', { name: 'Connect Cloudflare' }), 'Connect Cloudflare');
  await consentAllow(W, page);
  const ta = Date.now();
  await applyBtn(page).waitFor({ timeout: 60000 });
  await W.cap('C2-review', { primary: null, wait: { ms: Date.now() - ta, after: 'consent Allow → import' } });
  const tp = Date.now();
  await W.click(applyBtn(page), 'Apply');
  await page.waitForURL((u) => !u.hash.includes('setup'), { timeout: 60000 });
  await sleep(2500);
  await W.cap('D1-after-apply', { primary: null, wait: { ms: Date.now() - tp, after: 'Apply' } });
  W.rec.time_to_value_ms = Date.now() - t0;
  const st = await (await fetch(`${inst.fake.url}/__state`)).json();
  W.rec.dmarc_after = Object.values(st.records).flat().filter((r) => r.name.startsWith('_dmarc.')).map((r) => `${r.name} ${r.content}`);
  W.rec.domains = inst.d1('SELECT d.domain, w.name AS ws FROM domains d JOIN workspaces w ON w.id = d.workspace_id');
  // wait for the card to flip (first public DNS read reused ~1 min)
  for (let i = 0; i < 24; i++) { if (await page.getByText('Your first reports are on their way').count()) break; await sleep(5000); }
  await W.cap('D1-later', { primary: null, wait: { ms: Date.now() - tp, after: 'Apply (card flip)' } });
  await page.reload(); await sleep(3000);
  await W.cap('D1-reload', { primary: null, themes: ['light'], full: false });
  await emailShots(W, browser, inst, 'a');
});

// (b) from the website checker
F.checker = (b) => run(b, 'b-checker', async ({ W, page, inst, t0 }) => {
  const before = codes(inst).length;
  const w1 = await S1(W, page, inst, 'dana@brightwave-mail.com', { query: '?domain=brightwave-mail.com&src=checker' });
  await S2(W, page, {}, w1);
  await S3(W, page, inst, before);
  await page.getByRole('button', { name: 'Connect Cloudflare' }).waitFor({ timeout: 60000 });
  await W.cap('S4-checker-result', { primary: null });
  await W.click(page.getByRole('button', { name: 'Connect Cloudflare' }), 'Connect Cloudflare');
  await consentAllow(W, page);
  await applyBtn(page).waitFor({ timeout: 60000 });
  await W.cap('C2-review', { primary: null });
  await W.click(applyBtn(page), 'Apply');
  await page.waitForURL((u) => !u.hash.includes('setup'), { timeout: 60000 });
  await sleep(2500);
  await W.cap('D1-after-apply', { primary: null });
  W.rec.time_to_value_ms = Date.now() - t0;
  W.rec.signup_started = inst.aux.posthog.flatMap((x) => x.batch || []).filter((e) => /Signup Started/.test(e.event));
});

// (c-cancel) consent cancelled, then add records path visible
F.cancel = (b) => run(b, 'c-consent-cancelled', async ({ W, page, inst }) => {
  const before = codes(inst).length;
  const w1 = await S1(W, page, inst, 'dana@brightwave-mail.com');
  await S2(W, page, {}, w1);
  await S3(W, page, inst, before);
  await s4Heading(page).waitFor({ timeout: 30000 });
  await W.fill(page.getByLabel('Domain'), 'brightwave-mail.com', 'domain');
  await W.click(page.getByRole('button', { name: 'Check brightwave-mail.com' }), 'Check');
  await page.getByRole('button', { name: 'Connect Cloudflare' }).waitFor({ timeout: 60000 });
  await W.click(page.getByRole('button', { name: 'Connect Cloudflare' }), 'Connect Cloudflare');
  await consentAllow(W, page, { cancel: true });
  await sleep(5000);
  await W.cap('back-from-cancel', { primary: null });
});

// (d) manual DNS (GoDaddy)
F.manual = (b) => run(b, 'd-manual-godaddy', async ({ W, page, inst, t0 }) => {
  const before = codes(inst).length;
  const w1 = await S1(W, page, inst, 'owen@harbor-lane.org');
  await S2(W, page, { name: 'Owen Hart', org: 'Harbor Lane' }, w1);
  await S3(W, page, inst, before);
  await s4Heading(page).waitFor({ timeout: 30000 });
  await W.fill(page.getByLabel('Domain'), 'harbor-lane.org', 'domain');
  await W.click(page.getByRole('button', { name: 'Check harbor-lane.org' }), 'Check');
  await page.getByRole('heading', { name: /harbor-lane\.org uses GoDaddy/ }).waitFor({ timeout: 60000 });
  await sleep(1500);
  await W.cap('S4-records', { primary: null });
  const txt = await page.evaluate(() => document.querySelector('main')?.innerText || document.body.innerText);
  const token = (txt.match(/readysetmail-verify=[A-Za-z0-9_-]+/) || [])[0];
  const nm = (txt.match(/_readysetmail[a-z0-9._-]*/) || ['_readysetmail'])[0];
  W.note(`record shown: ${nm} = ${token ? token.slice(0, 24) + '…' : 'none'}`);
  const zones = (await (await fetch(`${inst.fake.url}/client/v4/zones?name=harbor-lane.org`, { headers: { authorization: 'Bearer walker' } })).json()).result;
  const zid = zones[0].id;
  const add = async (name, content) => (await fetch(`${inst.fake.url}/client/v4/zones/${zid}/dns_records`, { method: 'POST', headers: { authorization: 'Bearer walker', 'content-type': 'application/json' }, body: JSON.stringify({ type: 'TXT', name, content, ttl: 1 }) })).status;
  const rn = nm.endsWith('harbor-lane.org') ? nm : `${nm}.harbor-lane.org`;
  W.note(`added ${rn}: ${await add(rn, token)}`);
  W.c.clicks += 2; W.c.log.push('outside: copy+paste name and value at DNS host');
  const tv = Date.now(); let auto = false;
  for (let i = 0; i < 120; i++) { if (!page.url().includes('setup') || (await page.getByText(/Found|is yours|on their way|Waiting for the report/i).count()) > 0) { auto = true; break; } await sleep(1000); }
  W.note(`page noticed ownership record on its own: ${auto} after ${Math.round((Date.now() - tv) / 1000)} s`);
  await sleep(2000);
  await W.cap('after-proof', { primary: null, wait: { ms: Date.now() - tv, after: 'record added at DNS host' } });
  if (page.url().includes('setup')) { await page.goto(`${inst.url}/#/`); await sleep(3000); W.c.clicks++; await W.cap('D1-dashboard', { primary: null }); }
  const main = await page.evaluate(() => document.querySelector('main')?.innerText || '');
  W.rec.d1_text = main.slice(0, 3000);
  const rua = (main.match(/rua=mailto:[^\s;"]+/) || [])[0];
  W.note(`rua shown on D1: ${rua || 'none'}`);
  // add DMARC as the person would (with the report address the product names)
  const ruaAddr = rua || 'rua=mailto:rua@rua.intake.example.net';
  W.note(`added _dmarc: ${await add('_dmarc.harbor-lane.org', `v=DMARC1; p=none; ${ruaAddr}`)}`);
  const td = Date.now(); let flipped = false;
  for (let i = 0; i < 40; i++) { if (await page.getByText('Your first reports are on their way').count()) { flipped = true; break; } await sleep(5000); }
  W.note(`card flipped to reports on their way: ${flipped} after ${Math.round((Date.now() - td) / 1000)} s`);
  await W.cap('D1-value', { primary: null, wait: { ms: Date.now() - td, after: 'DMARC added' } });
  W.rec.time_to_value_ms = Date.now() - t0;
});

// (e) agency
F.agency = (b) => run(b, 'e-agency', async ({ W, page, inst, t0 }) => {
  const before = codes(inst).length;
  const w1 = await S1(W, page, inst, 'sam@northside-it.com');
  await S2(W, page, { name: 'Sam Ortiz', org: 'Northside IT', whose: "My clients' (I'm an agency or IT provider)" }, w1);
  await S3(W, page, inst, before);
  await s4Heading(page).waitFor({ timeout: 30000 });
  await W.cap('S4-agency', { primary: '#s4-domain' });
  W.rec.ws_before = inst.d1('SELECT name FROM workspaces');
  await W.fill(page.getByLabel("Client's domain"), 'brightwave-mail.com', 'domain');
  await W.click(page.getByRole('button', { name: 'Check brightwave-mail.com' }), 'Check');
  await page.getByRole('button', { name: 'Connect Cloudflare' }).waitFor({ timeout: 60000 });
  await W.cap('S4-agency-result', { primary: null });
  await W.click(page.getByRole('button', { name: 'Connect Cloudflare' }), 'Connect Cloudflare');
  await consentAllow(W, page);
  await applyBtn(page).waitFor({ timeout: 60000 });
  await W.cap('C2-agency', { primary: null });
  W.rec.domains_after_connect = inst.d1('SELECT d.domain, w.name AS ws FROM domains d JOIN workspaces w ON w.id = d.workspace_id');
  await W.click(applyBtn(page), 'Apply');
  await page.waitForURL((u) => !u.hash.includes('setup'), { timeout: 60000 });
  await sleep(2500);
  await W.cap('D1-agency', { primary: null });
  W.rec.time_to_value_ms = Date.now() - t0;
  W.rec.ws_after = inst.d1('SELECT name FROM workspaces');
  // "N new domains in your Cloudflare account: Add" — try it
  const addLink = page.getByRole('button', { name: /^Add$/ }).or(page.getByRole('link', { name: /^Add$/ }));
  if (await addLink.count()) { await W.click(addLink.first(), 'Add (other zones)'); await sleep(3000); await W.cap('agency-add-others', { primary: null }); W.rec.domains_after_add = inst.d1('SELECT d.domain, w.name AS ws FROM domains d JOIN workspaces w ON w.id = d.workspace_id'); }
});

// (f) hand-off: to a developer at another company (brand-new account), then to a same-domain teammate who joins
F.handoff = (b) => run(b, 'f-handoff', async ({ W, page, inst, browser }) => {
  const before = codes(inst).length;
  const w1 = await S1(W, page, inst, 'dana@brightwave-mail.com');
  await S2(W, page, {}, w1);
  await S3(W, page, inst, before);
  await s4Heading(page).waitFor({ timeout: 30000 });
  await W.fill(page.getByLabel('Domain'), 'brightwave-mail.com', 'domain');
  await W.click(page.getByRole('button', { name: 'Check brightwave-mail.com' }), 'Check');
  await page.getByRole('button', { name: 'Connect Cloudflare' }).waitFor({ timeout: 60000 });
  await W.click(page.getByRole('link', { name: 'Hand setup to a teammate →' }), 'Hand setup');
  await page.getByLabel('Their work email').waitFor({ timeout: 30000 });
  await W.cap('H1', { primary: '#handoff-email' });
  // the developer at another company
  await W.fill(page.getByLabel('Their work email'), 'dev@pixelforge.dev', 'dev email');
  await W.click(page.getByRole('button', { name: 'Send invitation' }), 'Send invitation');
  await sleep(3000);
  await W.cap('H1-other-company', { primary: null });
  W.rec.invites_after_other = inst.d1('SELECT email, role FROM invites');
  // same-domain teammate
  await W.fill(page.getByLabel('Their work email'), 'sam@brightwave-mail.com', 'teammate email');
  const mb = mailFiles(inst).length;
  await W.click(page.getByRole('button', { name: 'Send invitation' }), 'Send invitation');
  await page.getByRole('heading', { name: 'Invitation sent' }).waitFor({ timeout: 30000 });
  await W.cap('H1-sent', { primary: null });
  await W.click(page.getByRole('button', { name: 'Go to the dashboard' }), 'Go to dashboard');
  await sleep(3000);
  await W.cap('H2', { primary: null });
  await emailShots(W, browser, inst, 'handoff', mb);
  const token = inst.d1("SELECT token FROM invites WHERE email='sam@brightwave-mail.com'")[0]?.token;
  const sctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const sam = await sctx.newPage();
  const S = flow('f2-handoff-teammate', sam);
  try {
    await sam.goto(`${inst.url}/#/invite/${token}`);
    await sam.getByLabel('Choose a password').waitFor({ timeout: 30000 });
    await S.cap('I1', { primary: null });
    await S.fill(sam.getByLabel('Choose a password'), PW, 'password');
    const b2 = codes(inst).length;
    await S.click(sam.getByRole('button', { name: 'Accept invite' }), 'Accept invite');
    await sam.getByLabel('6-digit code').waitFor({ timeout: 30000 });
    await S.cap('I1-code', { primary: '#code' });
    await S.seq(sam.getByLabel('6-digit code'), await waitCode(inst, b2), 'code');
    await sam.getByRole('heading', { name: /brightwave-mail\.com/ }).first().waitFor({ timeout: 60000 });
    await sleep(2000);
    await S.cap('I1-landing', { primary: null });
    // reuse of the same invite link (single use?)
    const rctx = await browser.newContext(); const rp = await rctx.newPage();
    await rp.goto(`${inst.url}/#/invite/${token}`); await sleep(4000);
    S.rec.reuse_text = (await rp.evaluate(() => document.body.innerText)).slice(0, 600);
    await rp.screenshot({ path: path.join(S.dir, 'invite-reuse@1440.png') }); await rctx.close();
  } catch (e) { S.rec.errors.push(String(e.stack || e)); S.note(`STOPPED: ${String(e.message).split('\n')[0]}`); }
  S.finish(); await sctx.close();
  await page.goto(`${inst.url}/#/`); await sleep(3000);
  await W.cap('H2-after-join', { primary: null, themes: ['light'] });
});

// (f-gmail) free-mail hand-off with free text in the display name
F.gmail = (b) => run(b, 'f3-handoff-freemail', async ({ W, page, inst, browser }) => {
  const before = codes(inst).length;
  const w1 = await S1(W, page, inst, 'promo.offer@gmail.com');
  await S2(W, page, { name: 'Pay at evil.example/pay', org: 'Account Security Team' }, w1);
  await S3(W, page, inst, before);
  await s4Heading(page).waitFor({ timeout: 30000 });
  await W.fill(page.getByLabel('Domain'), 'brightwave-mail.com', 'domain');
  await W.click(page.getByRole('button', { name: 'Check brightwave-mail.com' }), 'Check');
  await page.getByRole('button', { name: 'Connect Cloudflare' }).waitFor({ timeout: 60000 });
  await W.click(page.getByRole('link', { name: 'Hand setup to a teammate →' }), 'Hand setup');
  await page.getByLabel('Their work email').waitFor({ timeout: 30000 });
  const mb = mailFiles(inst).length;
  await W.fill(page.getByLabel('Their work email'), 'victim.person@gmail.com', 'email');
  await W.click(page.getByRole('button', { name: 'Send invitation' }), 'Send invitation');
  await sleep(3000);
  await W.cap('H1-freemail-result', { primary: null, themes: ['light'] });
  W.rec.invites = inst.d1('SELECT email, role FROM invites');
  await emailShots(W, browser, inst, 'freemail', mb);
});

// (g) ordinary invite of a member after a finished Cloudflare setup
F.invite = (b) => run(b, 'g-invited-member', async ({ W, page, inst, browser }) => {
  const before = codes(inst).length;
  const w1 = await S1(W, page, inst, 'dana@brightwave-mail.com');
  await S2(W, page, {}, w1);
  await S3(W, page, inst, before);
  await s4Heading(page).waitFor({ timeout: 30000 });
  await W.fill(page.getByLabel('Domain'), 'brightwave-mail.com', 'domain');
  await W.click(page.getByRole('button', { name: 'Check brightwave-mail.com' }), 'Check');
  await page.getByRole('button', { name: 'Connect Cloudflare' }).waitFor({ timeout: 60000 });
  await W.click(page.getByRole('button', { name: 'Connect Cloudflare' }), 'Connect Cloudflare');
  await consentAllow(W, page);
  await applyBtn(page).waitFor({ timeout: 60000 });
  await W.click(applyBtn(page), 'Apply');
  await page.waitForURL((u) => !u.hash.includes('setup'), { timeout: 60000 });
  await sleep(2000);
  const r = await page.evaluate(async () => { const x = await fetch('/api/team/invite', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'lee@brightwave-mail.com', role: 'member' }) }); return { s: x.status, b: await x.text() }; });
  W.note(`member invite: ${r.s} ${r.b.slice(0, 200)}`);
  const token = inst.d1("SELECT token FROM invites WHERE email='lee@brightwave-mail.com'")[0]?.token;
  const mctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const m = await mctx.newPage();
  const M = flow('g2-member-joins', m);
  try {
    await m.goto(`${inst.url}/#/invite/${token}`);
    await m.getByLabel('Choose a password').waitFor({ timeout: 30000 });
    await M.cap('I1-member', { primary: null });
    await M.fill(m.getByLabel('Choose a password'), PW, 'password');
    const b2 = codes(inst).length;
    await M.click(m.getByRole('button', { name: 'Accept invite' }), 'Accept invite');
    await m.getByLabel('6-digit code').waitFor({ timeout: 30000 });
    await M.cap('I1-code', { primary: '#code' });
    await M.seq(m.getByLabel('6-digit code'), await waitCode(inst, b2), 'code');
    await sleep(5000);
    await M.cap('member-landing', { primary: null });
  } catch (e) { M.rec.errors.push(String(e.stack || e)); M.note(`STOPPED: ${String(e.message).split('\n')[0]}`); }
  M.finish(); await mctx.close();
});

// (h) returning mid-way
F.returning = (b) => run(b, 'h-returning', async ({ W, page, ctx, inst, browser }) => {
  // at S2: close the tab, open the app root in the same browser
  let before = codes(inst).length;
  const w1 = await S1(W, page, inst, 'ret1@brightwave-mail.com');
  await page.close();
  let p = await ctx.newPage(); W.page = p;
  await p.goto(`${inst.url}/`); await sleep(3000);
  const W2 = flow('h1-return-at-S2', p); await W2.cap('reopen-root-at-S2', { themes: ['light'] }); W2.finish();
  // fill S2 then close at S3; reopen root
  await p.getByLabel('Your name').fill('Ret One').catch(() => {});
  await p.getByLabel('Organization name').fill('Brightwave Studio').catch(() => {});
  await p.getByLabel("My company's").click().catch(() => {});
  await p.getByRole('button', { name: 'Continue' }).click().catch(() => {});
  await p.getByRole('heading', { name: 'Check your inbox' }).waitFor({ timeout: 30000 }).catch(() => {});
  await p.close(); p = await ctx.newPage();
  await p.goto(`${inst.url}/`); await sleep(3000);
  const W3 = flow('h2-return-at-S3', p); await W3.cap('reopen-root-at-S3', { themes: ['light'] });
  // a second browser during S3: nothing pending there
  const c2 = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const q = await c2.newPage();
  await q.goto(`${inst.url}/`); await sleep(3000); const W3b = flow('h3-second-browser-at-S3', q); await W3b.cap('second-browser-root', { themes: ['light'] }); W3b.finish(); await c2.close();
  // finish code, reach S4, close; reopen root
  await p.getByLabel('6-digit code').pressSequentially(await waitCode(inst, before)).catch((e) => W3.note(String(e)));
  await s4Heading(p).waitFor({ timeout: 30000 });
  await p.getByLabel('Domain').fill('brightwave-mail.com');
  await p.getByRole('button', { name: 'Check brightwave-mail.com' }).click();
  await p.getByRole('button', { name: 'Connect Cloudflare' }).waitFor({ timeout: 60000 });
  W3.finish();
  await p.close(); p = await ctx.newPage();
  await p.goto(`${inst.url}/`); await sleep(4000);
  const W4 = flow('h4-return-at-S4', p); await W4.cap('reopen-root-at-S4', { themes: ['light'] });
  // second browser, sign in again at S4 stage
  const c3 = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const r = await c3.newPage();
  const W5 = flow('h5-signin-second-browser-at-S4', r);
  await r.goto(`${inst.url}/#/signin`); await sleep(2500); await W5.cap('signin', { themes: ['light'] });
  await r.getByLabel(/email/i).first().fill('ret1@brightwave-mail.com');
  await r.getByLabel('Password', { exact: true }).fill(PW);
  before = codes(inst).length;
  await r.getByRole('button', { name: /Sign in|Continue/ }).first().click();
  await sleep(3000); await W5.cap('signin-code', { themes: ['light'] });
  const sc = await waitCode(inst, before); if (sc) { await r.getByLabel(/code/i).first().pressSequentially(sc); }
  await sleep(5000); await W5.cap('after-signin', { themes: ['light'] }); W5.finish();
  // in the first browser: connect, then close at C2 and reopen
  await p.getByRole('button', { name: 'Connect Cloudflare' }).click();
  await p.waitForURL(/\/authorize/); await p.locator('#allow').click();
  await applyBtn(p).waitFor({ timeout: 60000 });
  await p.close(); p = await ctx.newPage();
  await p.goto(`${inst.url}/`); await sleep(5000);
  await W4.cap('reopen-root-at-C2', { themes: ['light'] }); W4.finish();
  // second browser (already signed in) at C2 stage
  await r.goto(`${inst.url}/`); await sleep(5000);
  const W6 = flow('h6-second-browser-at-C2', r); await W6.cap('second-browser-root-at-C2', { themes: ['light'] }); W6.finish();
  await c3.close();
  W.page = page;
});

// (i) unhappy paths: one instance per group, spaced to respect per-IP limits
F.unhappy = async (b) => {
  await run(b, 'i1-wrong-code', async ({ W, page, inst }) => {
    const before = codes(inst).length;
    const w1 = await S1(W, page, inst, 'u1@brightwave-mail.com'); await S2(W, page, {}, w1); await W.cap('S3', { primary: '#code', themes: ['light'] });
    const code = await waitCode(inst, before); const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 1; i <= 6; i++) { await page.getByLabel('6-digit code').fill(''); await W.seq(page.getByLabel('6-digit code'), wrong, 'code'); await sleep(1500); if (i === 1 || i >= 5) await W.cap(`wrong-${i}`, { primary: '#code', full: false, themes: ['light'] }); }
    await page.getByLabel('6-digit code').fill(''); await W.seq(page.getByLabel('6-digit code'), code, 'code'); await sleep(2500); await W.cap('right-after-wrongs', { full: false, themes: ['light'] });
  });
  await run(b, 'i2-expired-resend-startover', async ({ W, page, inst }) => {
    let before = codes(inst).length;
    const w1 = await S1(W, page, inst, 'u2@brightwave-mail.com'); await S2(W, page, {}, w1); await W.cap('S3', { primary: '#code', themes: ['light'] });
    const code = await waitCode(inst, before);
    inst.d1("UPDATE verifications SET expires_at = strftime('%s','now') - 5 WHERE identifier LIKE 'signin-code:%'");
    await W.seq(page.getByLabel('6-digit code'), code, 'code'); await sleep(2500); await W.cap('expired-typed', { full: false, themes: ['light'] });
    await page.reload(); await sleep(3000); await W.cap('expired-after-reload', { full: false, themes: ['light'] });
    W.rec.mails_so_far = codes(inst).length;
    // start again same address (2nd code mail), then resend (3rd), then start over (4th?)
    before = codes(inst).length;
    if (await page.getByLabel('Work email').count()) { await page.getByLabel('Password', { exact: true }).fill(PW); await page.getByRole('button', { name: 'Continue' }).click(); await sleep(3000); W.c.keys += PW.length; }
    await W.cap('restart-after-expiry', { full: false, themes: ['light'] });
    if (await page.getByLabel('Your name').count()) { await S2(W, page, {}, 0).catch((e) => W.note(String(e))); }
    await page.getByRole('button', { name: 'Not seeing it?' }).click().catch(() => {}); await sleep(500);
    await W.cap('not-seeing-it', { full: false, themes: ['light'] });
    await page.getByRole('button', { name: 'Send a new code' }).click().catch((e) => W.note(`resend: ${e.message.split('\n')[0]}`)); await sleep(4000);
    await W.cap('resend', { full: false, themes: ['light'] });
    await page.getByRole('button', { name: /Start over/ }).or(page.getByRole('link', { name: /Start over/ })).first().click().catch((e) => W.note(`start over: ${e.message.split('\n')[0]}`)); await sleep(2500);
    await W.cap('start-over', { full: false, themes: ['light'] });
    await page.getByLabel('Work email').fill('u2@brightwave-mail.com'); await page.getByLabel('Password', { exact: true }).fill(PW);
    await page.getByRole('button', { name: 'Continue' }).click(); await sleep(4000);
    await W.cap('start-over-same-address', { full: false, themes: ['light'] });
    W.rec.code_mails = codes(inst).length;
  });
  await run(b, 'i3-already-registered-and-typo', async ({ W, page, ctx, inst, browser }) => {
    // register real owner first
    let before = codes(inst).length;
    const w1 = await S1(W, page, inst, 'owner@brightwave-mail.com'); await S2(W, page, {}, w1); await S3(W, page, inst, before);
    await s4Heading(page).waitFor({ timeout: 30000 });
    const c2 = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const p = await c2.newPage();
    const A = flow('i3b-already-registered', p);
    const mb = mailFiles(inst).length; before = codes(inst).length;
    const w = await S1(A, p, inst, 'owner@brightwave-mail.com'); await S2(A, p, {}, w); await A.cap('S3-decoy', { primary: '#code' });
    await sleep(3000); A.rec.codes_mailed_for_decoy = codes(inst).length - before; A.rec.decoy_subjects = subjects(inst).slice(-2);
    await emailShots(A, browser, inst, 'notice', mb);
    await p.getByRole('button', { name: /Start over/ }).or(p.getByRole('link', { name: /Start over/ })).first().click().catch(() => {}); await sleep(2500);
    await A.cap('decoy-start-over', { full: false, themes: ['light'] });
    A.finish(); await c2.close();
    // mistyped email, corrected via start over
    const c3 = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const q = await c3.newPage();
    const T = flow('i3c-mistyped-email', q);
    const wt = await S1(T, q, inst, 'dana@brigthwave-mail.com'); await S2(T, q, {}, wt); await T.cap('S3-typo', { primary: '#code', themes: ['light'] });
    await T.click(q.getByRole('button', { name: /Start over/ }).or(q.getByRole('link', { name: /Start over/ })).first(), 'Start over');
    await sleep(2000); await T.cap('after-start-over', { primary: '#email', themes: ['light'] });
    before = codes(inst).length;
    await T.fill(q.getByLabel('Work email'), 'dana@brightwave-mail.com', 'email'); await T.fill(q.getByLabel('Password', { exact: true }), PW, 'password');
    await T.click(q.getByRole('button', { name: 'Continue' }), 'Continue'); await sleep(3000);
    await T.cap('after-corrected-S1', { themes: ['light'] });
    T.finish(); await c3.close();
  });
};

// ── security probes (HTTP) ──
F.probes = (b) => run(b, 'p-probes', async ({ W, inst, browser, page }) => {
  const P = {}; const u = inst.url;
  const jpost = async (pth, body, { cookie = '', ip = '', origin = u, ctype = 'application/json', headers = {} } = {}) => {
    const t = performance.now();
    const r = await fetch(u + pth, { method: 'POST', headers: { 'content-type': ctype, origin, ...(cookie ? { cookie } : {}), ...(ip ? { 'CF-Connecting-IP': ip } : {}), ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body), redirect: 'manual' });
    const txt = await r.text();
    return { status: r.status, body: txt.slice(0, 300), setCookie: r.headers.getSetCookie?.() || [], ms: Math.round(performance.now() - t) };
  };
  const tsToken = 'XXXX.DUMMY.TOKEN.XXXX';
  // register a verified owner via the UI
  const before = codes(inst).length;
  const w1 = await S1(W, page, inst, 'known@brightwave-mail.com'); await S2(W, page, {}, w1); await S3(W, page, inst, before);
  await s4Heading(page).waitFor({ timeout: 30000 });
  // signup body shape
  P.signup_known = await jpost('/api/auth/signup', { email: 'known@brightwave-mail.com', password: PW, cf_turnstile_token: tsToken }, { ip: '10.0.0.1' });
  P.signup_new = await jpost('/api/auth/signup', { email: 'fresh1@brightwave-mail.com', password: PW, cf_turnstile_token: tsToken }, { ip: '10.0.0.2' });
  P.signup_no_turnstile = await jpost('/api/auth/signup', { email: 'fresh2@brightwave-mail.com', password: PW }, { ip: '10.0.0.3' });
  P.signup_evil_origin = await jpost('/api/auth/signup', { email: 'fresh3@brightwave-mail.com', password: PW, cf_turnstile_token: tsToken }, { ip: '10.0.0.4', origin: 'https://evil.example' });
  P.signup_text_plain = await jpost('/api/auth/signup', JSON.stringify({ email: 'fresh4@brightwave-mail.com', password: PW, cf_turnstile_token: tsToken }), { ip: '10.0.0.5', ctype: 'text/plain' });
  // timing: known vs new, alternating, distinct IPs and addresses
  const tk = [], tn = [];
  for (let i = 0; i < 12; i++) {
    const a = await jpost('/api/auth/signup', { email: 'known@brightwave-mail.com', password: PW, cf_turnstile_token: tsToken }, { ip: `10.1.${i}.1` }); tk.push(a.ms);
    const n = await jpost('/api/auth/signup', { email: `t${i}@brightwave-mail.com`, password: PW, cf_turnstile_token: tsToken }, { ip: `10.1.${i}.2` }); tn.push(n.ms);
    if (i === 0) { P.timing_sample_known = a; P.timing_sample_new = n; }
  }
  const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  P.timing = { known_ms: tk, new_ms: tn, median_known: med(tk), median_new: med(tn) };
  // pending endpoints with a decoy vs real cookie
  const ck = (r) => r.setCookie.map((c) => c.split(';')[0]).join('; ');
  const dec = await jpost('/api/auth/signup', { email: 'known@brightwave-mail.com', password: PW, cf_turnstile_token: tsToken }, { ip: '10.2.0.1' });
  const fre = await jpost('/api/auth/signup', { email: 'fresh9@brightwave-mail.com', password: PW, cf_turnstile_token: tsToken }, { ip: '10.2.0.2' });
  P.cookie_flags = fre.setCookie;
  for (const [k, r] of [['decoy', dec], ['fresh', fre]]) {
    const c = ck(r);
    P[`pending_${k}`] = await (await fetch(`${u}/api/auth/signup/pending`, { headers: { cookie: c, 'CF-Connecting-IP': '10.2.1.1' } })).text();
    P[`profile_${k}`] = await jpost('/api/auth/signup/profile', { name: 'X', organization: 'Y', whose_email: 'company' }, { cookie: c, ip: '10.2.1.2' });
    P[`resend_noturnstile_${k}`] = await jpost('/api/auth/signup/resend', {}, { cookie: c, ip: '10.2.1.3' });
    P[`cancel_evil_${k}`] = await jpost('/api/auth/signup/cancel', {}, { cookie: c, ip: '10.2.1.4', origin: 'https://evil.example' });
  }
  P.profile_no_cookie = await jpost('/api/auth/signup/profile', { name: 'X', organization: 'Y', whose_email: 'company' }, { ip: '10.2.1.5' });
  // brute force: wrong codes across attempts for one address
  const bf = [];
  for (let round = 0; round < 4; round++) {
    const s = await jpost('/api/auth/signup', { email: 'brute@brightwave-mail.com', password: PW, cf_turnstile_token: tsToken }, { ip: `10.3.${round}.1` });
    bf.push({ round, signup: s.status, body: s.body.slice(0, 120) });
    const c = ck(s);
    for (let i = 0; i < 6; i++) { const r = await jpost('/api/auth/code', { code: String(100000 + round * 10 + i) }, { cookie: c, ip: `10.3.${round}.${10 + i}` }); bf.push({ round, i, status: r.status, body: r.body.slice(0, 120) }); }
    await jpost('/api/auth/signup/cancel', {}, { cookie: c, ip: `10.3.${round}.9` });
  }
  P.bruteforce = bf;
  // same IP limits (no header spoofing): how fast does one IP get refused?
  const ipl = [];
  for (let i = 0; i < 14; i++) { const r = await jpost('/api/auth/signup', { email: `ip${i}@quietfield.net`, password: PW, cf_turnstile_token: tsToken }, { ip: '10.9.9.9' }); ipl.push(`${r.status}:${r.body.slice(0, 80)}`); }
  P.per_ip = ipl;
  // pre-registration of a victim: attacker attempt (pw A), then victim signs up (pw B) and confirms; attacker's code later
  const att = await jpost('/api/auth/signup', { email: 'victim@harbor-lane.org', password: 'attacker-password-1', cf_turnstile_token: tsToken }, { ip: '10.4.0.1' });
  await sleep(1500); const attCode = codes(inst).at(-1);
  const vic = await jpost('/api/auth/signup', { email: 'victim@harbor-lane.org', password: 'victim-password-22', cf_turnstile_token: tsToken }, { ip: '10.4.0.2' });
  await sleep(1500); const vicCode = codes(inst).at(-1);
  P.prereg = { att: att.status, attBody: att.body.slice(0, 120), vic: vic.status, vicBody: vic.body.slice(0, 160), distinct_codes: attCode !== vicCode };
  P.prereg.victim_confirm = await jpost('/api/auth/code', { code: vicCode }, { cookie: ck(vic), ip: '10.4.0.3' });
  P.prereg.attacker_confirm_after = await jpost('/api/auth/code', { code: attCode }, { cookie: ck(att), ip: '10.4.0.4' });
  P.prereg.signin_attacker_pw = await jpost('/api/auth/login', { email: 'victim@harbor-lane.org', password: 'attacker-password-1', cf_turnstile_token: tsToken }, { ip: '10.4.0.5' });
  P.prereg.signin_victim_pw = await jpost('/api/auth/login', { email: 'victim@harbor-lane.org', password: 'victim-password-22', cf_turnstile_token: tsToken }, { ip: '10.4.0.6' });
  P.prereg.users = inst.d1("SELECT email, email_verified FROM users WHERE email='victim@harbor-lane.org'");
  // mail-cap DoS: attacker starts 2 sign-ups for a victim address; can the victim still get a code?
  for (let i = 0; i < 2; i++) await jpost('/api/auth/signup', { email: 'blocked@harbor-lane.org', password: 'whatever-attacker', cf_turnstile_token: tsToken }, { ip: `10.5.0.${i}` });
  P.mailcap_victim_signup = await jpost('/api/auth/signup', { email: 'blocked@harbor-lane.org', password: 'victim-password-22', cf_turnstile_token: tsToken }, { ip: '10.5.1.1' });
  // open redirect / injection params in the browser
  const ctx = await browser.newContext(); const p2 = await ctx.newPage();
  const reds = [];
  for (const q of ['?next=https://evil.example', '?next=//evil.example', '?src=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E', '?domain=javascript:alert(1)', '?domain=evil.example%22%3E%3Cimg%3E', '?return_to=https://evil.example']) {
    await p2.goto(`${u}/#/signup${q}`); await sleep(1500);
    reds.push({ q, url: p2.url(), ls: await p2.evaluate(() => JSON.stringify(Object.fromEntries(Object.entries(localStorage)))) });
  }
  P.params = reds;
  const os = await page.evaluate(async () => { const x = await fetch('/api/cloudflare/oauth/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ return_to: 'https://evil.example/' }) }); return { s: x.status, b: (await x.text()).slice(0, 300) }; });
  P.oauth_start_evil_return = os;
  await ctx.close();
  // CSRF on tenant POST
  P.setup_path_evil_origin = await (async () => { const r = await page.evaluate(async () => { const x = await fetch('/api/onboarding/setup-path', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'records' }) }); return x.status; }); return r; })();
  const cookies = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  P.setup_path_cross_origin = await jpost('/api/onboarding/setup-path', { path: 'records' }, { cookie: cookies, origin: 'https://evil.example' });
  P.team_invite_cross_origin = await jpost('/api/team/invite', { email: 'x@brightwave-mail.com', role: 'admin', handoff_domain: 'brightwave-mail.com' }, { cookie: cookies, origin: 'https://evil.example' });
  P.session_cookies = (await page.context().cookies()).map((c) => ({ name: c.name, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite, path: c.path, expires: c.expires }));
  P.posthog = inst.aux.posthog;
  writeFileSync(path.join(W.dir, 'probes.json'), JSON.stringify(P, null, 1));
  glog(`probes written: ${Object.keys(P).join(',')}`);
});

const browser = await chromium.launch();
try { for (const f of process.argv.slice(2)) { try { await F[f](browser); } catch (e) { glog(`FLOW ${f} crashed: ${e.stack}`); } } }
finally { await browser.close(); }
glog('WALK DONE');
