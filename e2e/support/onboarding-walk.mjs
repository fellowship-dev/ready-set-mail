// Real-browser walk of the onboarding screens (Playwright chromium) with layout assertions and screenshots.
//   node e2e/support/onboarding-walk.mjs [--only selfhost|hosted|claims|before|count]
// Needs `npm run build:dashboard` (and for `before`: ~/work/main-wt with its dashboard built). Shots: ~/work/shots/<mode>-<width>-<nn>-<step>.png
// (before: before-hosted-<width>-claim.png). One line per shot: `OK|FAIL <file> scrollW/innerW clipped=<n>`.
// Counts (fields typed, clicks) are kept per flow and printed as `COUNT ...`. Only fictitious names from the fake are used.
import { chromium } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startInstance } from './dev-instance.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WT = path.join(os.homedir(), 'work/main-wt');
const SHOTS = path.join(os.homedir(), 'work/shots');
mkdirSync(SHOTS, { recursive: true });
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
let failures = 0;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Page wrapper that counts typed fields and clicks. */
function driver(page) {
  const c = { fields: 0, clicks: 0, log: [] };
  return {
    c,
    async type(loc, v) { await loc.fill(v); c.fields++; c.log.push(`type ${v.length > 0 ? '(field)' : ''}`); },
    async click(loc, note = '') { await loc.click(); c.clicks++; c.log.push(`click ${note}`); },
    reset() { c.fields = 0; c.clicks = 0; c.log = []; },
  };
}

async function measure(page) {
  return page.evaluate(() => {
    const clipped = [...document.querySelectorAll('code, input[readonly], .font-mono, [data-record-value]')]
      .filter((e) => e.clientWidth > 1 && e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).display !== 'inline').length;
    return { scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth, clipped };
  });
}

async function snap(page, name, { fullPage = true } = {}) {
  await wait(250);
  const m = await measure(page);
  const file = `${name}.png`;
  await page.screenshot({ path: path.join(SHOTS, file), fullPage });
  const ok = m.scrollW <= m.innerW && m.clipped === 0;
  if (!ok) failures++;
  console.log(`${ok ? 'OK' : 'FAIL'} ${file} ${m.scrollW}/${m.innerW} clipped=${m.clipped}`);
  return m;
}

function shooter(page, mode, width) {
  let n = 0;
  return (step, opts) => snap(page, `${mode}-${width}-${String(++n).padStart(2, '0')}-${step}`, opts);
}

async function newPage(browser, width, height) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  return { ctx, page: await ctx.newPage() };
}

const btn = (page, name, o = {}) => page.getByRole('button', { name, ...o });

async function createOwner(page, d, inst) {
  const link = inst.setupLink();
  await page.goto(link);
  return link;
}

// ---------------------------------------------------------------- self-host
async function selfhostWalk(browser, width, height, port) {
  const inst = await startInstance({ mode: 'selfhost', port });
  const { ctx, page } = await newPage(browser, width, height);
  const d = driver(page);
  const shot = shooter(page, 'selfhost', width);
  try {
    await createOwner(page, d, inst);
    await page.locator('#email').waitFor();
    await shot('owner-form');
    // Opening the link is the start of the count: fields typed and clicks from here.
    d.reset();
    await d.type(page.locator('#email'), 'owner@harbor-lane.org');
    await d.type(page.locator('#password'), 'correct-horse-battery');
    await d.type(page.locator('#confirm'), 'correct-horse-battery');
    await d.click(btn(page, 'Create account'), 'Create account');
    await btn(page, 'Connect Cloudflare').first().waitFor({ timeout: 20000 });
    await shot('first-screen');
    await d.click(btn(page, 'Connect Cloudflare').first(), 'Connect Cloudflare');
    await page.getByLabel('Cloudflare API token').waitFor();
    await shot('connect-token');
    await d.type(page.getByLabel('Cloudflare API token'), 'fake-token-for-local-walk');
    await d.click(btn(page, 'Connect', { exact: true }), 'Connect');
    await btn(page, 'Next').waitFor({ timeout: 20000 });
    await page.getByRole('checkbox').first().waitFor();
    await shot('zones');
    await d.click(btn(page, 'Select all'), 'Select all');
    await d.click(btn(page, 'Next'), 'Next (zones)');
    await btn(page, /^Add \d+ domains?/).waitFor({ timeout: 20000 });
    await page.getByText(/DMARC (p=|missing|inherited)/).first().waitFor({ timeout: 20000 });
    await shot('domains');
    // Domains arrive ticked? If not, tick all.
    if (await btn(page, /^Add \d+ domains?/).isDisabled()) { for (const cb of await page.getByRole('checkbox').all()) { await d.click(cb, 'tick'); } }
    await d.click(btn(page, /^Add \d+ domains?/), 'Add domains');
    // Plan steps: each has one primary button that writes (or "Next" when already in place).
    let i = 0;
    for (; i < 12; i++) {
      await wait(1200);
      const done = page.getByRole('button', { name: 'Go to overview' });
      if (await done.count()) break;
      const write = page.getByRole('button', { name: /^Write \d+ (record|change)/ });
      const next = page.getByRole('button', { name: 'Next', exact: true });
      if (await write.count()) {
        if (i < 3) await shot(`plan-before-write-${i + 1}`);
        await d.click(write.first(), 'Write');
        await next.waitFor({ timeout: 20000 });
        if (i < 3) await shot(`plan-after-write-${i + 1}`);
        await d.click(next, 'Next');
      } else if (await next.count() && await next.first().isEnabled()) { await d.click(next.first(), 'Next'); }
    }
    await btn(page, 'Go to overview').waitFor({ timeout: 30000 });
    await shot('done');
    await d.click(btn(page, 'Go to overview'), 'Go to overview');
    await page.getByRole('heading', { level: 1 }).first().waitFor();
    await wait(1500);
    await shot('overview');
    console.log(`COUNT selfhost-${width} setup link -> overview (token path): fields=${d.c.fields} clicks=${d.c.clicks} [${d.c.log.join(', ')}]`);
    // Existing-domain wizard step (wider layout).
    const doms = await page.evaluate(async () => (await (await fetch('/api/domains')).json()));
    const list = Array.isArray(doms) ? doms : doms.domains ?? [];
    if (list[0]) {
      for (const step of ['spf', 'dmarc']) { await page.goto(`${inst.url}/#/domains/${list[0].id}/setup/${step}`); await page.getByRole('heading', { level: 1 }).first().waitFor(); await wait(800); await shot(`wizard-${step}`); }
    }
  } catch (e) { failures++; console.log(`FAIL selfhost-${width} walk: ${String(e.message).split('\n')[0]}`); await page.screenshot({ path: path.join(SHOTS, `selfhost-${width}-error.png`) }).catch(() => {}); }
  await ctx.close(); await inst.stop();
}

async function selfhostSpecial(browser, port) {
  // Manual path + "can't be connected yet" (no TOKEN_ENCRYPTION_KEY), at 375 and 1440.
  const inst = await startInstance({ mode: 'selfhost', port, tokenKey: false });
  for (const [w, h] of [[375, 812], [1440, 900]]) {
    const { ctx, page } = await newPage(browser, w, h);
    const d = driver(page); const shot = shooter(page, 'selfhost-nokey', w);
    try {
      if (w === 375) await createOwner(page, d, inst); else await createOwner(page, d, inst).catch(() => {});
      if (w === 375) {
        await page.locator('#email').waitFor();
        await page.locator('#email').fill('owner@harbor-lane.org'); await page.locator('#password').fill('correct-horse-battery'); await page.locator('#confirm').fill('correct-horse-battery');
        await btn(page, 'Create account').click();
      } else {
        await page.goto(`${inst.url}/#/login`);
        await page.locator('#email').waitFor({ timeout: 20000 });
        await page.locator('#email').fill('owner@harbor-lane.org'); await page.locator('#password').fill('correct-horse-battery'); await btn(page, /Sign in/).click();
        await page.getByRole('navigation').first().waitFor({ timeout: 20000 }).catch(() => {});
        await page.goto(`${inst.url}/#/setup`);
      }
      await page.getByText(/can't be connected yet/).first().waitFor({ timeout: 20000 });
      await shot('cant-connect');
      const manual = page.getByText(/add (my|your) (own )?(DNS )?records|add DNS records myself|add your records yourself/i).first();
      if (await manual.count()) { await manual.click(); await wait(1000); await shot('manual-path'); }
    } catch (e) { failures++; console.log(`FAIL selfhost-nokey-${w}: ${String(e.message).split('\n')[0]}`); await page.screenshot({ path: path.join(SHOTS, `selfhost-nokey-${w}-error.png`) }).catch(() => {}); }
    await ctx.close();
  }
  await inst.stop();
}

// ---------------------------------------------------------------- hosted
async function hostedSignUp(page, d, inst, email) {
  await page.goto(`${inst.url}/#/signup`);
  await page.locator('#email').waitFor();
  await d.type(page.locator('#email'), email);
  const pw = page.locator('#password');
  if (await pw.count()) { await d.type(pw, 'correct-horse-battery'); const cf = page.locator('#confirm'); if (await cf.count()) await d.type(cf, 'correct-horse-battery'); }
  const before = inst.verificationLinks().length;
  await wait(2500); // Turnstile test widget
  await d.click(btn(page, /Create account|Sign up|Continue|Send/), 'sign up');
  for (let i = 0; i < 40; i++) { await wait(500); if (inst.verificationLinks().length > before) break; }
  const links = inst.verificationLinks();
  if (links.length <= before) throw new Error('no verification link found in dev logs');
  await page.goto(links[links.length - 1]);
  await page.locator('#password').waitFor();
  await d.type(page.locator('#password'), 'correct-horse-battery');
  await d.type(page.locator('#confirm'), 'correct-horse-battery');
  await d.click(btn(page, /./).filter({ hasText: /continue|create|sign|finish|start|confirm/i }).last(), 'welcome submit');
}

const DNS = { 'harbor-lane.org': ['ns1.domaincontrol.com'], 'quietfield.net': ['ns1.ns.cloudflare.com'] };

async function hostedWalk(browser, width, height, port, tokenKey, { cwd = REPO, tag = '' } = {}) {
  const inst = await startInstance({ mode: 'hosted', port, tokenKey, cwd, dohNs: { 'harbor-lane.org': ['ns1.domaincontrol.com'], 'brightwave-mail.com': ['ns1.ns.cloudflare.com'] } });
  const { ctx, page } = await newPage(browser, width, height);
  const d = driver(page);
  const shot = shooter(page, tag || (tokenKey ? 'hosted' : 'hosted-nokey'), width);
  try {
    await hostedSignUp(page, d, inst, `owner-${width}@harbor-lane.org`);
    await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 20000 });
    await wait(1000);
    await shot('first-screen');
    const dom = page.getByRole('textbox').first();
    await dom.waitFor();
    await d.type(dom, 'harbor-lane.org');
    await d.click(btn(page, /^(Continue|Add domain)/).first(), 'Add domain');
    await page.getByRole('group', { name: 'DNS record to add' }).or(page.getByText(/_readysetmail/).first()).first().waitFor({ timeout: 20000 });
    await shot('domain-added');
    console.log(`COUNT hosted${tokenKey ? '' : '-nokey'}-${width} sign-up -> domain added (pending claim): fields=${d.c.fields} clicks=${d.c.clicks} [${d.c.log.join(', ')}]`);
    if (tokenKey) {
      // Token path against the fake, all the way to the overview (hosted: zone allow-list proves ownership; DMARC has no rua).
      d.reset();
      await page.goto(`${inst.url}/#/setup/cloudflare`);
      const tok = page.getByLabel('Cloudflare API token');
      await tok.waitFor({ timeout: 20000 });
      await d.type(tok, 'fake-token-for-local-walk');
      await d.click(btn(page, 'Connect', { exact: true }), 'Connect');
      await btn(page, 'Next').waitFor({ timeout: 20000 });
      await d.click(btn(page, 'Select all'), 'Select all');
      await d.click(btn(page, 'Next'), 'Next (zones)');
      await btn(page, /^Add \d+ domains?/).waitFor({ timeout: 20000 });
      await page.getByText(/DMARC (p=|missing|inherited)/).first().waitFor({ timeout: 20000 });
      await shot('token-domains');
      await d.click(btn(page, /^Add \d+ domains?/), 'Add domains');
      for (let i = 0; i < 12; i++) {
        await wait(1200);
        if (await page.getByRole('button', { name: 'Go to overview' }).count()) break;
        const write = page.getByRole('button', { name: /^Write \d+ (record|change)/ });
        const next = page.getByRole('button', { name: 'Next', exact: true });
        if (await write.count()) { await d.click(write.first(), 'Write'); await next.waitFor({ timeout: 20000 }); await shot(`token-plan-written-${i + 1}`); await d.click(next, 'Next'); }
        else if (await next.count() && await next.first().isEnabled()) await d.click(next.first(), 'Next');
      }
      await btn(page, 'Go to overview').waitFor({ timeout: 30000 });
      await shot('token-done');
      await d.click(btn(page, 'Go to overview'), 'Go to overview');
      await page.getByRole('heading', { level: 1 }).first().waitFor();
      await wait(1500);
      await shot('token-overview');
      console.log(`COUNT hosted-${width} token path: connect -> overview: fields=${d.c.fields} clicks=${d.c.clicks} [${d.c.log.join(', ')}]`);
    }
  } catch (e) { failures++; console.log(`FAIL hosted-${tokenKey ? 'key' : 'nokey'}-${width} walk: ${String(e.message).split('\n')[0]}`); await page.screenshot({ path: path.join(SHOTS, `hosted-${tokenKey ? 'key' : 'nokey'}-${width}-error.png`) }).catch(() => {}); }
  await ctx.close(); await inst.stop();
}

/** The ownership step in three states, at 375x667 and 1440x900, with above-the-fold assertions. */
async function claimStates(browser, port, { cwd = REPO, prefix = 'hosted', fold = true, tokenKey = false, only: onlyState = null } = {}) {
  const inst = await startInstance({ mode: 'hosted', port, tokenKey, cwd, dohNs: { 'harbor-lane.org': ['ns1.domaincontrol.com'], 'brightwave-mail.com': ['ns1.ns.cloudflare.com'] } });
  const states = [['cloudflare', 'brightwave-mail.com'], ['other-provider', 'harbor-lane.org'], ['unknown', 'quietfield.net']];
  for (const [w, h] of [[375, 667], [1440, 900]]) {
    const { ctx, page } = await newPage(browser, w, h);
    const d = driver(page);
    try {
      await hostedSignUp(page, d, inst, `claim-${w}@harbor-lane.org`);
      await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 20000 });
      for (const [state, domain] of states) {
        if (prefix === 'before' && state !== 'other-provider') continue;
        if (onlyState && state !== onlyState) continue;
        await page.goto(`${inst.url}/#/add`);
        await wait(1500);
        const dom = page.getByRole('textbox').first(); await dom.waitFor(); await dom.fill(domain); await wait(300); if ((await dom.inputValue()) !== domain) { await dom.fill(domain); }
        await btn(page, /^(Continue|Add domain)/).first().click();
        const rec = page.getByRole('group', { name: 'DNS record to add' });
        if (tokenKey) {
          // Connect offered and DNS at Cloudflare: the first screen must show the primary "Connect Cloudflare" (no record needed).
          const connectBtn = btn(page, 'Connect Cloudflare').first();
          await connectBtn.waitFor({ timeout: 20000 }); await wait(1500);
          const name = `${prefix}-${w}-claim-${state}`;
          await snap(page, name, { fullPage: false });
          const bb = await connectBtn.boundingBox(); const okC = !!bb && bb.y + bb.height <= h;
          if (!okC) failures++;
          console.log(`${okC ? 'OK' : 'FAIL'} fold ${name} connect.bottom=${bb && Math.round(bb.y + bb.height)} viewportH=${h}`);
          continue;
        }
        await (prefix === 'before' ? page.getByText(/_readysetmail/).first() : rec).waitFor({ timeout: 20000 });
        await wait(1500);
        const name = prefix === 'before' ? `before-hosted-${w}-claim` : `hosted-${w}-claim-${state}`;
        await snap(page, name, { fullPage: false });
        if (fold && prefix !== 'before') {
          const val = await rec.locator('code').last().boundingBox();
          const verify = await btn(page, /^Verify/).first().boundingBox();
          const okFold = val && verify && val.y + val.height <= h && verify.y + verify.height <= h;
          if (!okFold) failures++;
          console.log(`${okFold ? 'OK' : 'FAIL'} fold ${name} value.bottom=${val && Math.round(val.y + val.height)} verify.bottom=${verify && Math.round(verify.y + verify.height)} viewportH=${h}`);
        }
        await page.evaluate(() => document.querySelectorAll('[aria-label^="Remove "]').forEach(() => {}));
        const rm = btn(page, /^Remove /).first(); if (await rm.count()) { await rm.click(); await wait(500); const c = page.getByRole('button', { name: /remove|confirm/i }).last(); if (await page.getByRole('dialog').count()) await c.click(); await wait(500); }
      }
    } catch (e) { failures++; console.log(`FAIL claim-${prefix}-${w}: ${String(e.message).split('\n')[0]}`); await page.screenshot({ path: path.join(SHOTS, `${prefix}-claim-${w}-error.png`) }).catch(() => {}); }
    await ctx.close();
  }
  await inst.stop();
}

// Headless chromium needs its system libraries; if they are not installed, put them on LD_LIBRARY_PATH (see header).
const browser = await chromium.launch();
try {
  if (!only || only === 'selfhost') {
    await selfhostWalk(browser, 375, 812, 8811); await selfhostWalk(browser, 1440, 900, 8812); await selfhostWalk(browser, 1920, 1080, 8813);
    await selfhostSpecial(browser, 8814);
  }
  if (only === 'count') { await hostedWalk(browser, 375, 812, 8841, false, { cwd: WT, tag: 'before-hosted-count' }); await hostedWalk(browser, 375, 812, 8842, false); }
  if (only === 'claims') { await claimStates(browser, 8824); await claimStates(browser, 8825, { prefix: 'hosted-connect', tokenKey: true, only: 'cloudflare' }); }
  if (!only || only === 'hosted') {
    await hostedWalk(browser, 375, 812, 8821, true); await hostedWalk(browser, 375, 812, 8822, false); await hostedWalk(browser, 1440, 900, 8823, true);
    await claimStates(browser, 8824);
  }
  if (!only || only === 'before') await claimStates(browser, 8831, { cwd: WT, prefix: 'before', fold: false });
} finally { await browser.close(); }
console.log(failures ? `${failures} FAIL` : 'ALL OK');
process.exit(failures ? 1 : 0);
