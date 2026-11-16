// PR 177 first-time-user walk. Runs on a devbox from the ready-set-mail checkout root: node walk.mjs [flow ...]
// Throwaway local hosted instances (e2e/support/dev-instance.mjs: fresh D1, fake Cloudflare + DoH, Turnstile test keys).
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { startInstance } from './e2e/support/dev-instance.mjs';
import { pageMetrics } from './fcmeasure.mjs';

const OUT = process.env.OUT || `${process.env.HOME}/walk-out`;
mkdirSync(OUT, { recursive: true });
const VIEWS = [[375, 812], [1440, 900]];
const PW = 'correct-horse-battery';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const INTAKE = 'rua.intake.example.net';
let port = Number(process.env.PORT0 || 8850);

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const codes = (inst) => (existsSync(inst.logFile) ? [...strip(readFileSync(inst.logFile, 'utf8')).matchAll(/(\d{6}) is your Ready Set Mail code/g)].map((m) => m[1]) : []);
const mailFiles = (inst) => (existsSync(inst.logFile) ? [...strip(readFileSync(inst.logFile, 'utf8')).matchAll(/^(Text|HTML): (\S+)$/gm)].map((m) => ({ kind: m[1], file: m[2] })) : []);
const subjects = (inst) => (existsSync(inst.logFile) ? [...strip(readFileSync(inst.logFile, 'utf8')).matchAll(/Subject: (.*)$/gm)].map((m) => m[1]) : []);

async function waitCode(inst, before, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const c = codes(inst); if (c.length > before) return c.at(-1); await sleep(250); }
  return null;
}

/** Page facts beyond FlowChad's measure: headings, buttons and their look, alerts, badges, the bot check, main text. */
function extras() {
  const vis = (e) => { const r = e.getBoundingClientRect(); if (!r.width && !r.height) return false; const cs = getComputedStyle(e); return cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity !== 0; };
  const vh = innerHeight;
  const root = document.querySelector('main') || document.body;
  const box = (e) => { const r = e.getBoundingClientRect(); return { top: +((r.top + scrollY) / vh).toFixed(2), bottom: +((r.bottom + scrollY) / vh).toFixed(2) }; };
  const txt = (e) => (e.getAttribute('aria-label') || e.innerText || e.value || '').trim().replace(/\s+/g, ' ').slice(0, 90);
  const buttons = [...document.querySelectorAll('button, a[href], [role=button]')].filter(vis).map((e) => {
    const cs = getComputedStyle(e);
    return { tag: e.tagName.toLowerCase(), text: txt(e), bg: cs.backgroundColor, color: cs.color, inMain: root.contains(e), ...box(e) };
  });
  const inputs = [...root.querySelectorAll('input:not([type=hidden]), select, textarea, [role=combobox], [role=radio]')].filter(vis).map((e) => ({ id: e.id || e.name || e.getAttribute('role'), type: e.type || e.tagName.toLowerCase(), label: (e.labels?.[0]?.innerText || e.getAttribute('aria-label') || e.placeholder || '').trim().slice(0, 80), ...box(e) }));
  const alerts = [...document.querySelectorAll('[role=alert], [role=status], [data-slot=alert], .alert')].filter(vis).map((e) => txt(e));
  const badges = [...document.querySelectorAll('[data-slot=badge], .badge, [class*="badge"]')].filter(vis).map((e) => txt(e));
  const headings = [...document.querySelectorAll('h1, h2, h3')].filter(vis).map((e) => `${e.tagName}:${txt(e)}`);
  const turnstile = [...document.querySelectorAll('iframe')].filter((f) => /challenges\.cloudflare\.com/.test(f.src) && vis(f)).map(box);
  return { url: location.hash || location.pathname, title: document.title, headings, buttons, inputs, alerts, badges, turnstile, pageVh: +(document.documentElement.scrollHeight / vh).toFixed(2), mainText: (root.innerText || '').trim() };
}

function flow(name, inst, page) {
  const dir = path.join(OUT, name);
  mkdirSync(dir, { recursive: true });
  const rec = { flow: name, started: new Date().toISOString(), steps: [], notes: [], errors: [], emails: [] };
  const c = { clicks: 0, keys: 0, fields: new Set(), log: [] };
  let mark = { clicks: 0, keys: 0, fields: 0, log: 0, t: Date.now() };
  const save = () => writeFileSync(path.join(dir, 'raw.json'), JSON.stringify(rec, null, 1));
  const api = {
    rec, c, dir, save,
    async click(loc, note) { await loc.click(); c.clicks++; c.log.push(`click:${note}`); },
    async fill(loc, text, note) { await loc.fill(text); c.keys += text.length; c.fields.add(note); c.log.push(`type:${note}(${text.length})`); },
    async seq(loc, text, note) { await loc.pressSequentially(text); c.keys += text.length; c.fields.add(note); c.log.push(`type:${note}(${text.length})`); },
    note(s) { rec.notes.push(s); console.log(`  note: ${s}`); save(); },
    /** Capture the current state at both widths and both themes; attribute the actions spent since the previous capture to the previous step. */
    async cap(step, { primary = null, action = null, wait = null, full = true } = {}) {
      const prev = rec.steps.at(-1);
      if (prev) { prev.clicks = c.clicks - mark.clicks; prev.keystrokes = c.keys - mark.keys; prev.actions = c.log.slice(mark.log); prev.fields_typed = c.fields.size - mark.fields; prev.wall_ms = Date.now() - mark.t; }
      mark = { clicks: c.clicks, keys: c.keys, fields: c.fields.size, log: c.log.length, t: Date.now() };
      await sleep(600);
      const idx = String(rec.steps.length + 1).padStart(2, '0');
      const s = { index: rec.steps.length + 1, step, primary, action, wait, screenshots: {}, measures: {}, extras: {} };
      const orig = page.viewportSize();
      for (const [w, h] of VIEWS) {
        await page.setViewportSize({ width: w, height: h });
        for (const theme of ['light', 'dark']) {
          await page.emulateMedia({ colorScheme: theme });
          await sleep(350);
          await page.evaluate(() => window.scrollTo(0, 0));
          const f = `${idx}-${step}@${w}-${theme}.png`;
          await page.screenshot({ path: path.join(dir, f) });
          s.screenshots[`${w}-${theme}`] = f;
          if (theme === 'light') {
            if (full) { const ff = `${idx}-${step}@${w}-full.png`; await page.screenshot({ path: path.join(dir, ff), fullPage: true }); s.screenshots[`${w}-full`] = ff; }
            s.measures[w] = await page.evaluate(pageMetrics, primary);
            s.extras[w] = await page.evaluate(extras);
          }
        }
      }
      await page.emulateMedia({ colorScheme: 'light' });
      if (orig) await page.setViewportSize(orig);
      rec.steps.push(s);
      const m = s.measures;
      console.log(`  [${idx}] ${step}: words ${m[1440]?.words} | primary ${m[375]?.primary_source} scroll 375=${m[375]?.scroll_before_primary_vh} 1440=${m[1440]?.scroll_before_primary_vh} | overflow375=${m[375]?.horizontal_overflow_px} | ${s.extras[1440]?.url}`);
      save();
      return s;
    },
    finish() { const prev = rec.steps.at(-1); if (prev && prev.clicks === undefined) { prev.clicks = c.clicks - mark.clicks; prev.keystrokes = c.keys - mark.keys; prev.actions = c.log.slice(mark.log); prev.fields_typed = c.fields.size - mark.fields; } rec.totals = { clicks: c.clicks, keystrokes: c.keys, fields: [...c.fields] }; rec.finished = new Date().toISOString(); save(); },
  };
  return api;
}

async function newInstance(extra = {}) {
  const inst = await startInstance({
    mode: 'hosted', port: port++, tokenKey: true,
    dohNs: { 'brightwave-mail.com': ['ns1.ns.cloudflare.com'], 'quietfield.net': ['ns1.ns.cloudflare.com'], 'harbor-lane.org': ['ns1.domaincontrol.com'] },
    vars: { INTAKE_DOMAIN: INTAKE, HOSTED_CONNECT_REPORTS: 'all', MAIL_REPLY_TO: 'hello@readysetmail.example' },
    ...extra,
  });
  return inst;
}

async function signupS1(W, page, inst, email, { query = '' } = {}) {
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
async function signupS2(W, page, { name = 'Dana Whitfield', org = 'Brightwave Studio', whose = "My company's" } = {}, waitMs) {
  await W.cap('S2-about', { primary: '#name', wait: { ms: waitMs, after: 'S1 Continue (bot check + code send)' } });
  await W.fill(page.getByLabel('Your name'), name, 'name');
  await W.fill(page.getByLabel('Organization name'), org, 'organization');
  await W.click(page.getByLabel(whose), `fork:${whose}`);
  await W.click(page.getByRole('button', { name: 'Continue' }), 'Continue');
  await page.getByRole('heading', { name: 'Check your inbox' }).waitFor({ timeout: 30000 });
}
async function signupS3(W, page, inst, before) {
  await W.cap('S3-code', { primary: '#code' });
  const code = await waitCode(inst, before);
  if (!code) throw new Error('no code mailed');
  await W.seq(page.getByLabel('6-digit code'), code, 'code');
  return code;
}

async function emailShots(W, browser, inst, label) {
  // Render each mailed HTML part in a mail-client-like frame, images off (there are none to load), at 375 and 1440.
  const files = mailFiles(inst);
  const out = [];
  for (const [i, f] of files.entries()) {
    let body = '';
    try { body = readFileSync(f.file, 'utf8'); } catch { continue; }
    out.push({ i, kind: f.kind, file: f.file, size: body.length, head: body.slice(0, 4000) });
    if (f.kind !== 'HTML') continue;
    const ctx = await browser.newContext({ javaScriptEnabled: false });
    const p = await ctx.newPage();
    await p.route('**/*', (r) => (r.request().resourceType() === 'image' ? r.abort() : r.continue()));
    for (const [w, h] of [[375, 812], [1440, 900]]) {
      await p.setViewportSize({ width: w, height: h });
      await p.setContent(`<div style="font:13px Arial;padding:8px 12px;border-bottom:1px solid #ccc;background:#f6f6f6">From: Ready Set Mail &lt;noreply@...&gt;<br>Subject: (see log)</div>${body}`);
      const fn = `email-${label}-${i}@${w}.png`;
      await p.screenshot({ path: path.join(W.dir, fn), fullPage: true });
      out.at(-1)[`shot${w}`] = fn;
      if (w === 375) out.at(-1).codeTopPx = await p.evaluate(() => { const el = [...document.querySelectorAll('span,td,p,div')].find((e) => /^\s*\d{6}\s*$/.test(e.textContent || '')); return el ? Math.round(el.getBoundingClientRect().top) : null; });
    }
    await ctx.close();
  }
  W.rec.emails.push({ label, subjects: subjects(inst), parts: out });
  W.save();
}

// ── Flows ─────────────────────────────────────────────────────────

async function f1(browser) {
  const inst = await newInstance();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const W = flow('f1-cold-cloudflare', inst, page);
  const t0 = Date.now();
  try {
    const before = codes(inst).length;
    const w1 = await signupS1(W, page, inst, 'dana@brightwave-mail.com');
    await signupS2(W, page, {}, w1);
    await signupS3(W, page, inst, before);
    await page.getByRole('heading', { name: 'Which domain do you send email from?' }).waitFor({ timeout: 30000 });
    await W.cap('S4-domain-empty', { primary: '#s4-domain' });
    await W.fill(page.getByLabel('Domain'), 'brightwave-mail.com', 'domain');
    const tc = Date.now();
    await W.click(page.getByRole('button', { name: 'Check brightwave-mail.com' }), 'Check');
    await page.getByRole('button', { name: 'Connect Cloudflare' }).waitFor({ timeout: 60000 });
    await W.cap('S4-result-cloudflare', { primary: null, wait: { ms: Date.now() - tc, after: 'Check' } });
    await W.click(page.getByRole('button', { name: 'Connect Cloudflare' }), 'Connect Cloudflare');
    await page.getByLabel('Cloudflare API token').waitFor({ timeout: 30000 });
    await W.cap('CF-connect-token-screen', { primary: null });
    W.note('Cloudflare OAuth consent cannot be walked: the fake has no OAuth screen; the token-paste path stands in (same code after the return).');
    await W.fill(page.getByLabel('Cloudflare API token'), 'e2e-fake-token-not-a-real-secret-0000', 'token(paste)');
    const ta = Date.now();
    await W.click(page.getByRole('button', { name: 'Connect', exact: true }), 'Connect');
    await page.getByRole('heading', { name: /change to brightwave-mail\.com/ }).waitFor({ timeout: 60000 });
    await W.cap('C2-review', { primary: null, wait: { ms: Date.now() - ta, after: 'Connect (import)' } });
    const tp = Date.now();
    await W.click(page.getByRole('button', { name: /^Apply \d+ changes?$/ }), 'Apply');
    await page.getByRole('heading', { name: 'Domains', exact: true }).waitFor({ timeout: 60000 });
    await sleep(1500);
    await W.cap('D1-after-apply', { primary: null, wait: { ms: Date.now() - tp, after: 'Apply' } });
    W.rec.time_to_value_ms = Date.now() - t0;
    const st = await (await fetch(`${inst.fake.url}/__state`)).json();
    W.rec.dmarc_after = Object.values(st.records).flat().filter((r) => r.name === '_dmarc.brightwave-mail.com').map((r) => r.content);
    // Reload on the dashboard
    await page.reload(); await sleep(2500);
    await W.cap('D1-reload', { primary: null });
    // The workspace switcher
    try { await page.getByRole('button', { name: /Brightwave Studio/ }).first().click(); await sleep(500); await W.cap('switcher-open', { full: false }); await page.keyboard.press('Escape'); } catch (e) { W.note(`switcher: ${e.message.split('\n')[0]}`); }
    await emailShots(W, browser, inst, 'f1');
  } catch (e) { W.rec.errors.push(String(e.stack || e)); W.note(`STOPPED: ${e.message.split('\n')[0]}`); try { await W.cap('stopped', {}); } catch {} }
  W.finish(); await ctx.close(); await inst.stop();
}

async function f2(browser) {
  const inst = await newInstance();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const W = flow('f2-checker-domain', inst, page);
  const t0 = Date.now();
  try {
    const before = codes(inst).length;
    const w1 = await signupS1(W, page, inst, 'dana@brightwave-mail.com', { query: '?domain=brightwave-mail.com' });
    await signupS2(W, page, {}, w1);
    await signupS3(W, page, inst, before);
    await page.getByRole('button', { name: 'Check brightwave-mail.com' }).waitFor({ timeout: 30000 });
    await W.cap('S4-checker-prefilled', { primary: null });
    const tc = Date.now();
    await W.click(page.getByRole('button', { name: 'Check brightwave-mail.com' }), 'Check');
    await page.getByRole('button', { name: 'Connect Cloudflare' }).waitFor({ timeout: 60000 });
    await W.cap('S4-result-cloudflare', { primary: null, wait: { ms: Date.now() - tc, after: 'Check' } });
    await W.click(page.getByRole('button', { name: 'Connect Cloudflare' }), 'Connect Cloudflare');
    await page.getByLabel('Cloudflare API token').waitFor({ timeout: 30000 });
    await W.cap('CF-connect-token-screen', { primary: null });
    await W.fill(page.getByLabel('Cloudflare API token'), 'e2e-fake-token-not-a-real-secret-0000', 'token(paste)');
    await W.click(page.getByRole('button', { name: 'Connect', exact: true }), 'Connect');
    await page.getByRole('heading', { name: /change to brightwave-mail\.com/ }).waitFor({ timeout: 60000 });
    await W.cap('C2-review', { primary: null });
    // Back from C2, then forward again
    await page.goBack(); await sleep(2000); await W.cap('C2-back', { full: false });
    await page.goForward(); await sleep(2000);
    await page.reload(); await sleep(3000); await W.cap('C2-reload', { full: false });
    await page.getByRole('button', { name: /^Apply \d+ changes?$/ }).waitFor({ timeout: 30000 });
    await W.click(page.getByRole('button', { name: /^Apply \d+ changes?$/ }), 'Apply');
    await page.getByRole('heading', { name: 'Domains', exact: true }).waitFor({ timeout: 60000 });
    await sleep(1500);
    await W.cap('D1-after-apply', { primary: null });
    W.rec.time_to_value_ms = Date.now() - t0;
  } catch (e) { W.rec.errors.push(String(e.stack || e)); W.note(`STOPPED: ${e.message.split('\n')[0]}`); try { await W.cap('stopped', {}); } catch {} }
  W.finish(); await ctx.close(); await inst.stop();
}

async function f3(browser) {
  const inst = await newInstance();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const W = flow('f3-manual-godaddy', inst, page);
  const t0 = Date.now();
  try {
    const before = codes(inst).length;
    const w1 = await signupS1(W, page, inst, 'owner@harbor-lane.org');
    await signupS2(W, page, { name: 'Owen Hart', org: 'Harbor Lane' }, w1);
    await signupS3(W, page, inst, before);
    await page.getByLabel('Domain').waitFor({ timeout: 30000 });
    await W.fill(page.getByLabel('Domain'), 'harbor-lane.org', 'domain');
    await W.click(page.getByRole('button', { name: 'Check harbor-lane.org' }), 'Check');
    await page.getByRole('heading', { name: /harbor-lane\.org uses GoDaddy/ }).waitFor({ timeout: 60000 });
    await sleep(1500);
    await W.cap('S4-result-godaddy-records', { primary: null });
    // Read the record the screen asks for, then add it at "GoDaddy" (the fake's DNS) as a person would.
    const txt = await page.evaluate(() => document.body.innerText);
    const token = (txt.match(/readysetmail-verify=[A-Za-z0-9_-]+|ia-verify=[A-Za-z0-9_-]+|[a-z-]+-verification=[A-Za-z0-9_-]+/) || [])[0];
    W.note(`ownership value seen: ${token ? token.slice(0, 22) + '…' : 'none found in text'}`);
    W.rec.s4_text = txt.slice(0, 3000);
    // Copy buttons
    const copies = await page.getByRole('button', { name: /Copy/ }).count();
    W.note(`Copy buttons on S4 manual: ${copies}`);
    if (token) {
      const zones = (await (await fetch(`${inst.fake.url}/client/v4/zones?name=harbor-lane.org`, { headers: { authorization: 'Bearer walker' } })).json()).result;
      const nameMatch = txt.match(/_[a-z0-9-]*readysetmail[a-z0-9-]*|_ia-verify|_[a-z0-9-]+verify/);
      const recName = `${nameMatch ? nameMatch[0] : '_readysetmail'}.harbor-lane.org`;
      const r = await fetch(`${inst.fake.url}/client/v4/zones/${zones[0].id}/dns_records`, { method: 'POST', headers: { authorization: 'Bearer walker', 'content-type': 'application/json' }, body: JSON.stringify({ type: 'TXT', name: recName, content: token, ttl: 1 }) });
      W.note(`added ${recName} at the fake: ${r.status}`);
      W.c.clicks += 2; W.c.log.push('outside:paste record at DNS host (2 copies + 2 pastes)');
      const tv = Date.now();
      // Wait for the page to notice by itself (no click), up to 90 s, else press the visible check/verify button
      let auto = false;
      for (let i = 0; i < 90; i++) { if (!(await page.url()).includes('setup') || (await page.getByText(/Found|verified|is yours|live/i).count()) > 0) { auto = true; break; } await sleep(1000); }
      W.note(`page noticed the record on its own: ${auto} after ${Math.round((Date.now() - tv) / 1000)} s`);
      await W.cap('S4-after-record-added', { primary: null, wait: { ms: Date.now() - tv, after: 'record added outside' } });
      if (!auto) {
        const btn = page.getByRole('button', { name: /Verify|Check now|Check again/ }).first();
        if (await btn.count()) { await W.click(btn, 'Verify/Check'); await sleep(4000); await W.cap('S4-after-verify-click', { primary: null }); }
      }
    }
    W.rec.time_to_value_ms = Date.now() - t0;
    await page.goto(`${inst.url}/#/`); await sleep(3000);
    await W.cap('D1-dashboard', { primary: null });
  } catch (e) { W.rec.errors.push(String(e.stack || e)); W.note(`STOPPED: ${e.message.split('\n')[0]}`); try { await W.cap('stopped', {}); } catch {} }
  W.finish(); await ctx.close(); await inst.stop();
}

async function f4(browser) {
  const inst = await newInstance();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const W = flow('f4-agency', inst, page);
  try {
    const before = codes(inst).length;
    const w1 = await signupS1(W, page, inst, 'sam@northside-it.com');
    await signupS2(W, page, { name: 'Sam Ortiz', org: 'Northside IT', whose: "My clients' (I'm an agency or IT provider)" }, w1);
    await signupS3(W, page, inst, before);
    await page.getByRole('heading', { name: "Add your first client's domain" }).waitFor({ timeout: 30000 });
    await W.cap('S4-agency-empty', { primary: '#s4-domain' });
    W.rec.workspace_before = inst.d1('SELECT name FROM workspaces');
    await W.fill(page.getByLabel("Client's domain"), 'brightwave-mail.com', 'domain');
    await W.click(page.getByRole('button', { name: 'Check brightwave-mail.com' }), 'Check');
    await page.getByRole('button', { name: 'Connect Cloudflare' }).waitFor({ timeout: 60000 });
    await W.cap('S4-agency-result', { primary: null });
    W.rec.workspace_after = inst.d1('SELECT name FROM workspaces');
    await W.click(page.getByRole('button', { name: 'Connect Cloudflare' }), 'Connect Cloudflare');
    await page.getByLabel('Cloudflare API token').waitFor({ timeout: 30000 });
    await W.fill(page.getByLabel('Cloudflare API token'), 'e2e-fake-token-not-a-real-secret-0000', 'token(paste)');
    await W.click(page.getByRole('button', { name: 'Connect', exact: true }), 'Connect');
    await page.getByRole('heading', { name: /change to brightwave-mail\.com/ }).waitFor({ timeout: 60000 });
    await W.cap('C2-agency-review', { primary: null });
    W.rec.domains_after_connect = inst.d1('SELECT d.domain, w.name AS ws FROM domains d JOIN workspaces w ON w.id = d.workspace_id');
    await W.click(page.getByRole('button', { name: /^Apply \d+ changes?$/ }), 'Apply');
    await page.getByRole('heading', { name: 'Domains', exact: true }).waitFor({ timeout: 60000 });
    await sleep(1500);
    await W.cap('D1-agency', { primary: null });
    const sw = page.locator('header button, aside button').filter({ hasText: /brightwave|client|Northside/i }).first();
    try { await sw.click(); await sleep(500); await W.cap('agency-switcher-open', { full: false }); await page.keyboard.press('Escape'); } catch (e) { W.note(`switcher: ${e.message.split('\n')[0]}`); }
  } catch (e) { W.rec.errors.push(String(e.stack || e)); W.note(`STOPPED: ${e.message.split('\n')[0]}`); try { await W.cap('stopped', {}); } catch {} }
  W.finish(); await ctx.close(); await inst.stop();
}

async function f5(browser) {
  const inst = await newInstance();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const W = flow('f5-handoff', inst, page);
  try {
    const before = codes(inst).length;
    const w1 = await signupS1(W, page, inst, 'dana@brightwave-mail.com');
    await signupS2(W, page, {}, w1);
    await signupS3(W, page, inst, before);
    await page.getByLabel('Domain').waitFor({ timeout: 30000 });
    await W.fill(page.getByLabel('Domain'), 'brightwave-mail.com', 'domain');
    await W.click(page.getByRole('button', { name: 'Check brightwave-mail.com' }), 'Check');
    await page.getByRole('button', { name: 'Connect Cloudflare' }).waitFor({ timeout: 60000 });
    await W.click(page.getByRole('link', { name: 'Hand setup to a teammate →' }), 'Hand setup');
    await page.getByLabel('Their work email').waitFor({ timeout: 30000 });
    await W.cap('H1-handoff', { primary: '#handoff-email' });
    await W.fill(page.getByLabel('Their work email'), 'sam@brightwave-mail.com', 'teammate email');
    const mailsBefore = mailFiles(inst).length;
    await W.click(page.getByRole('button', { name: 'Send invitation' }), 'Send invitation');
    await page.getByRole('heading', { name: 'Invitation sent' }).waitFor({ timeout: 30000 });
    await W.cap('H1-sent', { primary: null });
    await W.click(page.getByRole('button', { name: 'Go to the dashboard' }), 'Go to dashboard');
    await sleep(3000);
    await W.cap('H2-inviter-dashboard', { primary: null });
    await emailShots(W, browser, inst, 'f5-owner');
    // The teammate
    const log = strip(readFileSync(inst.logFile, 'utf8'));
    let link = null;
    for (const m of mailFiles(inst).slice(mailsBefore)) { try { const b = readFileSync(m.file, 'utf8'); const x = b.match(/https?:\/\/127\.0\.0\.1:\d+\/#\/invite\/[A-Za-z0-9-]+/); if (x) { link = x[0]; break; } } catch {} }
    W.note(`invite link found in hand-off email: ${!!link}`);
    if (!link) throw new Error('no invite link in the hand-off email');
    const sctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const sam = await sctx.newPage();
    const S = flow('f5b-teammate', inst, sam);
    try {
      await sam.goto(link);
      await sam.getByLabel('Choose a password').waitFor({ timeout: 30000 });
      await S.cap('I1-invite', { primary: null });
      await S.fill(sam.getByLabel('Choose a password'), PW, 'password');
      const b2 = codes(inst).length;
      await S.click(sam.getByRole('button', { name: 'Accept invite' }), 'Accept invite');
      await sam.getByLabel('6-digit code').waitFor({ timeout: 30000 });
      await S.cap('I1-code', { primary: '#code' });
      const code = await waitCode(inst, b2);
      await S.seq(sam.getByLabel('6-digit code'), code, 'code');
      await sam.getByRole('heading', { name: /brightwave-mail\.com/ }).first().waitFor({ timeout: 60000 });
      await sleep(1500);
      await S.cap('I1-landing-S4', { primary: null });
    } catch (e) { S.rec.errors.push(String(e.stack || e)); S.note(`STOPPED: ${e.message.split('\n')[0]}`); try { await S.cap('stopped', {}); } catch {} }
    S.finish(); await sctx.close();
    await page.goto(`${inst.url}/#/`); await sleep(3000);
    await W.cap('H2-after-join', { primary: null });
  } catch (e) { W.rec.errors.push(String(e.stack || e)); W.note(`STOPPED: ${e.message.split('\n')[0]}`); try { await W.cap('stopped', {}); } catch {} }
  W.finish(); await ctx.close(); await inst.stop();
}

/** Unhappy paths, each on its own fresh browser, one instance. */
async function f6(browser) {
  const inst = await newInstance();
  const out = [];
  const run = async (label, fn) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const W = flow(`f6-${label}`, inst, page);
    try { await fn(W, page, ctx); } catch (e) { W.rec.errors.push(String(e.stack || e)); W.note(`STOPPED: ${e.message.split('\n')[0]}`); try { await W.cap('stopped', {}); } catch {} }
    W.finish(); await ctx.close();
  };
  const toS3 = async (W, page, email) => { const b = codes(inst).length; const w1 = await signupS1(W, page, inst, email); await signupS2(W, page, {}, w1); await W.cap('S3', { primary: '#code' }); return b; };

  await run('wrong-code', async (W, page) => {
    const b = await toS3(W, page, 'u1@brightwave-mail.com');
    const code = await waitCode(inst, b);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 1; i <= 6; i++) { await W.seq(page.getByLabel('6-digit code'), wrong, 'code'); await sleep(1500); if (i === 1 || i >= 5) await W.cap(`wrong-${i}`, { primary: '#code', full: false }); }
    await W.seq(page.getByLabel('6-digit code'), code, 'code'); await sleep(2500); await W.cap('right-after-wrongs', { full: false });
  });
  await run('expired-code', async (W, page) => {
    const b = await toS3(W, page, 'u2@brightwave-mail.com');
    const code = await waitCode(inst, b);
    inst.d1("UPDATE verifications SET expires_at = strftime('%s','now') - 5 WHERE identifier LIKE 'signin-code:%' AND json_extract(value,'$.e') = 'u2@brightwave-mail.com'");
    await W.seq(page.getByLabel('6-digit code'), code, 'code'); await sleep(2500); await W.cap('expired-typed', { full: false });
    await page.getByRole('button', { name: 'Not seeing it?' }).click().catch(() => {}); await sleep(500);
    await page.getByRole('button', { name: 'Send a new code' }).click().catch((e) => W.note(`resend click: ${e.message.split('\n')[0]}`)); await sleep(4000);
    await W.cap('expired-resend', { full: false });
  });
  await run('resend', async (W, page) => {
    const b = await toS3(W, page, 'u3@brightwave-mail.com');
    const first = await waitCode(inst, b);
    await W.click(page.getByRole('button', { name: 'Not seeing it?' }), 'Not seeing it?'); await sleep(800);
    await W.cap('not-seeing-it-open', { full: false });
    const b2 = codes(inst).length;
    await W.click(page.getByRole('button', { name: 'Send a new code' }), 'Send a new code'); await sleep(4000);
    await W.cap('resent', { full: false });
    const second = await waitCode(inst, b2);
    W.note(`new code mailed: ${!!second}; differs: ${second !== first}`);
    await W.seq(page.getByLabel('6-digit code'), first, 'code'); await sleep(2000); await W.cap('old-code-after-resend', { full: false });
    await W.seq(page.getByLabel('6-digit code'), second, 'code'); await sleep(3000); await W.cap('new-code', { full: false });
  });
  await run('start-over', async (W, page) => {
    await toS3(W, page, 'typo@brightwave-mial.com');
    await W.click(page.getByRole('button', { name: 'Start over' }), 'Start over'); await sleep(2000);
    await W.cap('after-start-over', { primary: '#email', full: false });
    W.rec.email_value_after = await page.getByLabel('Work email').inputValue().catch(() => null);
  });
  await run('reload-back', async (W, page) => {
    const b = codes(inst).length;
    await page.goto(`${inst.url}/#/signup`); await page.getByLabel('Work email').waitFor();
    await W.fill(page.getByLabel('Work email'), 'u5@brightwave-mail.com', 'email');
    await W.fill(page.getByLabel('Password', { exact: true }), PW, 'password');
    await page.reload(); await sleep(2000); await W.cap('S1-reload-typed', { full: false });
    W.rec.s1_after_reload = await page.getByLabel('Work email').inputValue();
    await W.fill(page.getByLabel('Work email'), 'u5@brightwave-mail.com', 'email');
    await W.fill(page.getByLabel('Password', { exact: true }), PW, 'password');
    await W.click(page.getByRole('button', { name: 'Continue' }), 'Continue');
    await page.getByRole('heading', { name: 'Tell us about yourself' }).waitFor({ timeout: 30000 });
    await W.fill(page.getByLabel('Your name'), 'Half Typed', 'name');
    await page.reload(); await sleep(2500); await W.cap('S2-reload-unsaved', { full: false });
    W.rec.s2_name_after_reload = await page.getByLabel('Your name').inputValue().catch(() => null);
    await page.goBack(); await sleep(2500); await W.cap('S2-back', { full: false });
    W.rec.s2_back_url = page.url();
    await page.goto(`${inst.url}/#/signup/about`); await sleep(2000);
    await W.fill(page.getByLabel('Your name'), 'Dana Whitfield', 'name');
    await W.fill(page.getByLabel('Organization name'), 'Brightwave Studio', 'organization');
    await page.getByLabel("My company's").click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('heading', { name: 'Check your inbox' }).waitFor({ timeout: 30000 });
    await page.reload(); await sleep(2500); await W.cap('S3-reload', { full: false });
    await page.goBack(); await sleep(2500); await W.cap('S3-back', { full: false });
    W.rec.s3_back_url = page.url();
    W.rec.s2_after_back_values = { name: await page.getByLabel('Your name').inputValue().catch(() => null), org: await page.getByLabel('Organization name').inputValue().catch(() => null) };
    await page.goForward(); await sleep(2000);
    const code = await waitCode(inst, b);
    await page.getByLabel('6-digit code').pressSequentially(code); await sleep(4000);
    await page.getByLabel('Domain').waitFor({ timeout: 30000 });
    await W.fill(page.getByLabel('Domain'), 'brightwave-mail.com', 'domain');
    await page.reload(); await sleep(3000); await W.cap('S4-reload-typed', { full: false });
    await W.fill(page.getByLabel('Domain'), 'brightwave-mail.com', 'domain');
    await page.getByRole('button', { name: 'Check brightwave-mail.com' }).click();
    await page.getByRole('button', { name: 'Connect Cloudflare' }).waitFor({ timeout: 60000 });
    await page.reload(); await sleep(3500); await W.cap('S4-reload-checked', { full: false });
    await page.goBack(); await sleep(2500); await W.cap('S4-back', { full: false });
    W.rec.s4_back_url = page.url();
  });
  await run('close-tab-at-S2', async (W, page, ctx) => {
    const b = codes(inst).length;
    await signupS1(W, page, inst, 'u6@brightwave-mail.com');
    await page.close();
    const p2 = await ctx.newPage();
    await p2.goto(`${inst.url}/#/signup`); await sleep(2500);
    const W2 = flow('f6-close-tab-at-S2-return', inst, p2);
    await W2.cap('return-new-tab', { full: false }); W2.finish();
    // and via the plain app address
    await p2.goto(`${inst.url}/#/`); await sleep(2500);
    const W3 = flow('f6-close-tab-at-S2-root', inst, p2);
    await W3.cap('return-root', { full: false }); W3.finish();
    W.rec.codes = codes(inst).length - b;
  });
  await run('already-registered', async (W, page) => {
    // u1 exists from wrong-code (verified). Sign up again with it.
    const b = codes(inst).length;
    const subjBefore = subjects(inst).length;
    const w1 = await signupS1(W, page, inst, 'u1@brightwave-mail.com');
    await signupS2(W, page, {}, w1);
    await W.cap('S3-existing', { primary: '#code' });
    await sleep(3000);
    W.rec.codes_mailed = codes(inst).length - b;
    W.rec.subjects_new = subjects(inst).slice(subjBefore);
    const pend = await page.evaluate(async () => (await fetch('/api/auth/signup/pending')).json());
    W.rec.pending_existing = pend;
  });
  await run('typo-domain', async (W, page) => {
    const b = await toS3(W, page, 'u7@brightwave-mail.com');
    const code = await waitCode(inst, b);
    await page.getByLabel('6-digit code').pressSequentially(code);
    await page.getByLabel('Domain').waitFor({ timeout: 30000 });
    for (const [i, d] of ['brightwave-mail.con', 'https://www.brightwave-mail.com/', 'not a domain', 'gmail.com'].entries()) {
      await page.getByLabel('Domain').fill(d);
      const btn = page.getByRole('button', { name: /^Check/ });
      await btn.click().catch(() => {});
      await sleep(5000);
      await W.cap(`typo-${i}`, { full: false });
      W.rec[`typo_${i}`] = { input: d, text: (await page.locator('main').innerText().catch(() => '')).slice(0, 600) };
      const not = page.getByRole('button', { name: /Not this domain\?|Use a different domain/ }).first();
      if (await not.count()) { await not.click(); await sleep(1500); }
    }
  });
  await run('not-in-connected-account', async (W, page) => {
    const b = await toS3(W, page, 'u8@brightwave-mail.com');
    const code = await waitCode(inst, b);
    await page.getByLabel('6-digit code').pressSequentially(code);
    await page.getByLabel('Domain').waitFor({ timeout: 30000 });
    await page.getByLabel('Domain').fill('brightwave-mail.com');
    await page.getByRole('button', { name: 'Check brightwave-mail.com' }).click();
    await page.getByRole('button', { name: 'Connect Cloudflare' }).click({ timeout: 60000 });
    await page.getByLabel('Cloudflare API token').fill('e2e-fake-token-not-a-real-secret-0000');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByRole('heading', { name: /change to/ }).waitFor({ timeout: 60000 });
    // A zone that appears in Cloudflare only after the connection was made (so the connection does not hold it).
    await fetch(`${inst.fake.url}/__zones`, { method: 'POST', body: JSON.stringify({ name: 'lateco.io', account: { id: 'acc2', name: 'Other Account' } }) });
    await fetch(`${inst.fake.url}/__ns`, { method: 'POST', body: JSON.stringify({ name: 'lateco.io', ns: ['ns1.ns.cloudflare.com'] }) });
    await page.goto(`${inst.url}/#/setup`); await sleep(2500);
    await W.cap('setup-with-existing', { full: false });
    await page.goto(`${inst.url}/#/domains/new`).catch(() => {}); await sleep(2000);
    await W.cap('add-domain-route', { full: false });
  });
  await run('bad-token', async (W, page) => {
    const b = await toS3(W, page, 'u9@brightwave-mail.com');
    const code = await waitCode(inst, b);
    await page.getByLabel('6-digit code').pressSequentially(code);
    await page.getByLabel('Domain').waitFor({ timeout: 30000 });
    await page.getByLabel('Domain').fill('brightwave-mail.com');
    await page.getByRole('button', { name: 'Check brightwave-mail.com' }).click();
    await page.getByRole('button', { name: 'Connect Cloudflare' }).click({ timeout: 60000 });
    await page.getByLabel('Cloudflare API token').fill('bad-token-revoked');
    await page.getByRole('button', { name: 'Connect', exact: true }).click(); await sleep(4000);
    await W.cap('bad-token', { full: false });
    // cancel: back out of the connect screen
    await page.goBack(); await sleep(2500); await W.cap('connect-back', { full: false });
    W.rec.connect_back_url = page.url();
  });
  await emailShots(flow('f6-emails', inst, null), browser, inst, 'f6');
  await inst.stop();
}

async function selfhost(browser) {
  const inst = await startInstance({ mode: 'selfhost', port: port++, tokenKey: true, dohNs: { 'brightwave-mail.com': ['ns1.ns.cloudflare.com'] } });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const W = flow('f7-selfhost', inst, page);
  try {
    await page.goto(inst.setupLink()); await sleep(3000);
    await W.cap('owner-form', { primary: null });
    const name = page.getByLabel(/Your name|Name/).first();
    if (await name.count()) await W.fill(name, 'Max Owner', 'name');
    await W.fill(page.getByLabel(/^Email/).first(), 'owner@brightwave-mail.com', 'email');
    await W.fill(page.getByLabel('Password', { exact: true }), PW, 'password');
    const confirm = page.getByLabel(/Confirm/);
    if (await confirm.count()) await W.fill(confirm, PW, 'confirm');
    await W.click(page.getByRole('button', { name: /Create account|Continue/ }).first(), 'Create account');
    await sleep(5000);
    await W.cap('after-owner', { primary: null });
    const dom = page.getByLabel(/domain/i).first();
    if (await dom.count()) { await W.fill(dom, 'brightwave-mail.com', 'domain'); await W.click(page.getByRole('button', { name: /Continue|Check|Add/ }).first(), 'Continue'); await sleep(5000); await W.cap('after-domain', { primary: null }); }
  } catch (e) { W.rec.errors.push(String(e.stack || e)); W.note(`STOPPED: ${e.message.split('\n')[0]}`); try { await W.cap('stopped', {}); } catch {} }
  W.finish(); await ctx.close(); await inst.stop();
}


async function f8(browser) {
  // Hosted with Cloudflare OAuth configured (as production is): the screen between S4 and Cloudflare, and a cancelled consent.
  const inst = await newInstance({ vars: { INTAKE_DOMAIN: INTAKE, HOSTED_CONNECT_REPORTS: 'all', CF_OAUTH_CLIENT_ID: 'walk-client', CF_OAUTH_AUTHORIZE_URL: 'https://dash.cloudflare.com/oauth2/auth', CF_OAUTH_TOKEN_URL: 'https://dash.cloudflare.com/oauth2/token', CF_OAUTH_SCOPES: 'zone:read dns_records:edit' } });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  let authorize = null;
  await page.route('https://dash.cloudflare.com/**', (r) => { authorize = r.request().url(); return r.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Cloudflare consent (stub)</h1>' }); });
  const W = flow('f8-oauth-consent-cancel', inst, page);
  try {
    const before = codes(inst).length;
    const w1 = await signupS1(W, page, inst, 'dana@brightwave-mail.com');
    await signupS2(W, page, {}, w1);
    await signupS3(W, page, inst, before);
    await page.getByLabel('Domain').waitFor({ timeout: 30000 });
    await W.fill(page.getByLabel('Domain'), 'brightwave-mail.com', 'domain');
    await W.click(page.getByRole('button', { name: 'Check brightwave-mail.com' }), 'Check');
    await page.getByRole('button', { name: 'Connect Cloudflare' }).waitFor({ timeout: 60000 });
    await W.cap('S4-result-oauth', { primary: null });
    await W.click(page.getByRole('button', { name: 'Connect Cloudflare' }), 'Connect Cloudflare');
    await sleep(2500);
    await W.cap('CF-connect-oauth-screen', { primary: null });
    const cont = page.getByRole('button', { name: 'Continue to Cloudflare' });
    if (await cont.count()) {
      await W.click(cont, 'Continue to Cloudflare'); await sleep(3000);
      W.note(`authorize URL reached: ${authorize ? authorize.split('?')[0] : 'no'}`);
      const state = authorize ? new URL(authorize).searchParams.get('state') : null;
      const redirect = authorize ? new URL(authorize).searchParams.get('redirect_uri') : null;
      W.rec.redirect_uri = redirect;
      if (state && redirect) {
        await page.goto(`${redirect}?error=access_denied&error_description=user%20denied&state=${encodeURIComponent(state)}`); await sleep(4000);
        await W.cap('after-consent-cancelled', { primary: null });
      }
    } else W.note('no Continue to Cloudflare button');
  } catch (e) { W.rec.errors.push(String(e.stack || e)); W.note(`STOPPED: ${e.message.split('\n')[0]}`); try { await W.cap('stopped', {}); } catch {} }
  W.finish(); await ctx.close(); await inst.stop();
}

async function f9(browser) {
  // Redo on a fresh instance: an expired code, and an address that already has an account; then self-host's first domain.
  const inst = await newInstance();
  const mk = async (label) => { const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const page = await ctx.newPage(); return { ctx, page, W: flow(`f9-${label}`, inst, page) }; };
  // A verified account first.
  { const { ctx, page, W } = await mk('make-account'); try { const b = codes(inst).length; const w1 = await signupS1(W, page, inst, 'known@brightwave-mail.com'); await signupS2(W, page, {}, w1); await signupS3(W, page, inst, b); await page.getByLabel('Domain').waitFor({ timeout: 30000 }); } catch (e) { W.note(`STOPPED: ${e.message.split('\n')[0]}`); } W.finish(); await ctx.close(); }
  { const { ctx, page, W } = await mk('already-registered'); try {
      const b = codes(inst).length; const subj = subjects(inst).length;
      const t0 = Date.now(); const w1 = await signupS1(W, page, inst, 'known@brightwave-mail.com'); W.rec.s1_ms_known = w1;
      await signupS2(W, page, {}, w1); await W.cap('S3-existing', { primary: '#code' }); await sleep(3000);
      W.rec.codes_mailed = codes(inst).length - b; W.rec.subjects_new = subjects(inst).slice(subj);
      await page.getByRole('button', { name: 'Not seeing it?' }).click(); await page.getByRole('button', { name: 'Send a new code' }).click(); await sleep(4000);
      await W.cap('S3-existing-resend', { full: false }); W.rec.subjects_after_resend = subjects(inst).slice(subj);
    } catch (e) { W.note(`STOPPED: ${e.message.split('\n')[0]}`); } W.finish(); await ctx.close(); }
  { const { ctx, page, W } = await mk('new-timing'); try { const w1 = await signupS1(W, page, inst, 'fresh@brightwave-mail.com'); W.rec.s1_ms_new = w1; } catch (e) { W.note(`STOPPED: ${e.message.split('\n')[0]}`); } W.finish(); await ctx.close(); }
  { const { ctx, page, W } = await mk('expired-code'); try {
      const b = codes(inst).length; const w1 = await signupS1(W, page, inst, 'late@brightwave-mail.com'); await signupS2(W, page, {}, w1); await W.cap('S3', { primary: '#code' });
      const code = await waitCode(inst, b);
      inst.d1("UPDATE verifications SET expires_at = strftime('%s','now') - 5 WHERE identifier LIKE 'signin-code:%' AND json_extract(value,'$.e') = 'late@brightwave-mail.com'");
      await W.seq(page.getByLabel('6-digit code'), code, 'code'); await sleep(2500); await W.cap('expired-typed', { full: false });
      await W.click(page.getByRole('button', { name: 'Not seeing it?' }), 'Not seeing it?'); await sleep(400);
      await W.click(page.getByRole('button', { name: 'Send a new code' }), 'Send a new code'); await sleep(4000);
      await W.cap('expired-resend', { full: false });
    } catch (e) { W.note(`STOPPED: ${e.message.split('\n')[0]}`); try { await W.cap('stopped', {}); } catch {} } W.finish(); await ctx.close(); }
  { const { ctx, page, W } = await mk('s2-expired'); try {
      const b = codes(inst).length; await signupS1(W, page, inst, 'slow@brightwave-mail.com');
      inst.d1("UPDATE verifications SET expires_at = strftime('%s','now') - 5 WHERE identifier LIKE 'signin-code:%' AND json_extract(value,'$.e') = 'slow@brightwave-mail.com'");
      await W.fill(page.getByLabel('Your name'), 'Slow Typer', 'name'); await W.fill(page.getByLabel('Organization name'), 'Slow Co', 'organization'); await page.getByLabel("My company's").click();
      await W.click(page.getByRole('button', { name: 'Continue' }), 'Continue'); await sleep(3000);
      await W.cap('s2-after-expiry', { full: false });
    } catch (e) { W.note(`STOPPED: ${e.message.split('\n')[0]}`); } W.finish(); await ctx.close(); }
  await inst.stop();
  // Self-host: setup link -> owner -> first domain (manual path).
  const sh = await startInstance({ mode: 'selfhost', port: port++, tokenKey: true, dohNs: { 'brightwave-mail.com': ['ns1.ns.cloudflare.com'] } });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const page = await ctx.newPage(); const W = flow('f9-selfhost-domain', sh, page);
  try {
    await page.goto(sh.setupLink()); await page.getByLabel(/^Email/).first().waitFor({ timeout: 30000 });
    await page.getByLabel(/^Email/).first().fill('owner@brightwave-mail.com'); await page.getByLabel('Password', { exact: true }).fill(PW); await page.getByLabel(/Confirm/).fill(PW);
    await page.getByRole('button', { name: /Create account/ }).click(); await page.getByRole('heading', { name: /set up Ready Set Mail/ }).waitFor({ timeout: 30000 });
    await W.click(page.getByRole('button', { name: /add DNS records myself/ }), 'records myself'); await sleep(2500);
    await W.cap('selfhost-domain-step', { primary: null });
    const dom = page.getByLabel(/domain/i).first();
    await W.fill(dom, 'brightwave-mail.com', 'domain'); await W.click(page.getByRole('button', { name: /Continue|Check|Add|Next/ }).last(), 'Continue'); await sleep(5000);
    await W.cap('selfhost-after-domain', { primary: null });
  } catch (e) { W.note(`STOPPED: ${e.message.split('\n')[0]}`); try { await W.cap('stopped', {}); } catch {} }
  W.finish(); await ctx.close(); await sh.stop();
}

async function f10(browser) {
  // Manual path past the ownership record: does S4 notice it by itself, what Verify does, and what comes next.
  const inst = await newInstance();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const W = flow('f10-manual-continued', inst, page);
  try {
    const b = codes(inst).length; const w1 = await signupS1(W, page, inst, 'owner@harbor-lane.org'); await signupS2(W, page, { name: 'Owen Hart', org: 'Harbor Lane' }, w1); await signupS3(W, page, inst, b);
    await page.getByLabel('Domain').waitFor({ timeout: 30000 });
    await W.fill(page.getByLabel('Domain'), 'harbor-lane.org', 'domain'); await W.click(page.getByRole('button', { name: 'Check harbor-lane.org' }), 'Check');
    await page.getByRole('heading', { name: /uses GoDaddy/ }).waitFor({ timeout: 60000 }); await sleep(1500);
    await W.cap('S4-godaddy', { primary: null });
    const txt = await page.evaluate(() => document.body.innerText);
    const token = txt.match(/readysetmail-verify=[A-Za-z0-9_-]+/)[0];
    const zones = (await (await fetch(`${inst.fake.url}/client/v4/zones?name=harbor-lane.org`, { headers: { authorization: 'Bearer walker' } })).json()).result;
    await fetch(`${inst.fake.url}/client/v4/zones/${zones[0].id}/dns_records`, { method: 'POST', headers: { authorization: 'Bearer walker', 'content-type': 'application/json' }, body: JSON.stringify({ type: 'TXT', name: '_readysetmail.harbor-lane.org', content: token, ttl: 1 }) });
    W.c.log.push('outside: copy name + value, paste both at the DNS host');
    const t0 = Date.now(); let auto = false;
    for (let i = 0; i < 75; i++) { const t = await page.evaluate(() => document.body.innerText); if (!/Waiting for verification/.test(t)) { auto = true; break; } await sleep(1000); }
    W.note(`S4 noticed the ownership record without a click: ${auto} (waited ${Math.round((Date.now() - t0) / 1000)} s)`);
    await W.cap('S4-after-record', { primary: null, wait: { ms: Date.now() - t0, after: 'record added outside' } });
    if (!auto) { await W.click(page.getByRole('button', { name: 'Verify' }).first(), 'Verify'); await sleep(5000); await W.cap('after-verify', { primary: null }); }
    for (let k = 0; k < 6; k++) {
      const next = page.getByRole('button', { name: /^(Continue|Next|Skip|Done|Go to the dashboard|Check now)/ }).first();
      if (!(await next.count())) break;
      await W.click(next, `next:${(await next.innerText()).slice(0, 20)}`); await sleep(3500);
      await W.cap(`next-${k + 1}`, { primary: null, full: false });
    }
  } catch (e) { W.rec.errors.push(String(e.stack || e)); W.note(`STOPPED: ${e.message.split('\n')[0]}`); try { await W.cap('stopped', {}); } catch {} }
  W.finish(); await ctx.close(); await inst.stop();
}

const FLOWS = { f1, f2, f3, f4, f5, f6, selfhost, f8, f9, f10 };
const want = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(FLOWS);
const browser = await chromium.launch();
for (const n of want) { console.log(`== ${n}`); try { await FLOWS[n](browser); } catch (e) { console.log(`flow ${n} crashed: ${e.stack}`); } }
await browser.close();
console.log('WALK DONE');
