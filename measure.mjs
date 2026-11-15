// Flows-to-value measuring walk. Read-only on the product: local throwaway instances (e2e/support/dev-instance.mjs) for the app,
// public pages only for the website. Usage: node measure.mjs app|web [flowLetters]
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { startInstance } from './e2e/support/dev-instance.mjs';

const OUT = process.env.OUT || '/tmp/flows-out';
const SHOTS = path.join(OUT, 'shots');
mkdirSync(SHOTS, { recursive: true });
const MODE = process.argv[2] || 'app';
const ONLY = (process.argv[3] || '').toUpperCase();
const VIEWS = [[375, 812], [1440, 900]];
const records = [];
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PW = 'correct-horse-battery';
let portSeq = 8840;

function save() {
  writeFileSync(path.join(OUT, `measures-${MODE}.json`), JSON.stringify({ generated: new Date().toISOString(), mode: MODE, commit: process.env.COMMIT || null, views: VIEWS, records, errors }, null, 1));
}

/** Counts clicks and keystrokes; fill() counts each character as a keystroke (what a person would type). */
function driver(page) {
  const c = { clicks: 0, keys: 0, log: [] };
  return {
    c,
    async click(loc, note) { await loc.click(); c.clicks++; c.log.push(`click:${note}`); },
    async fill(loc, text, note) { await loc.fill(text); c.keys += text.length; c.log.push(`type:${note}(${text.length})`); },
    async seq(loc, text, note) { await loc.pressSequentially(text); c.keys += text.length; c.log.push(`type:${note}(${text.length})`); },
    async press(loc, key, note) { await loc.press(key); c.keys++; c.log.push(`key:${key}${note ? ':' + note : ''}`); },
  };
}

async function mark(loc, attr) {
  if (!loc) return false;
  try {
    const n = await loc.count();
    for (let i = 0; i < n; i++) {
      const l = loc.nth(i);
      if (await l.isVisible()) { await l.evaluate((el, a) => el.setAttribute(a, '1'), attr); return true; }
    }
  } catch { /* none */ }
  return false;
}

/** One flow at one width: records each step's measures and attributes the clicks/keys spent on it. */
function flowRecorder(page, d, flow, width, height) {
  const t0 = Date.now();
  let prev = null;
  let mark0 = { clicks: 0, keys: 0, log: 0 };
  const close = () => {
    if (!prev) return;
    prev.clicks = d.c.clicks - mark0.clicks;
    prev.keystrokes = d.c.keys - mark0.keys;
    prev.actions = d.c.log.slice(mark0.log);
    prev.leftAtMs = Date.now() - t0;
    prev.stepWallMs = prev.leftAtMs - prev.arrivedAtMs;
  };
  const rec = {
    t0,
    async step(step, { primary, input, heading, between = false, waits = {}, notes = [], full = true, scrub = false } = {}) {
      close();
      await sleep(500);
      await page.evaluate(() => document.querySelectorAll('[data-m-primary],[data-m-input],[data-m-heading]').forEach((e) => { e.removeAttribute('data-m-primary'); e.removeAttribute('data-m-input'); e.removeAttribute('data-m-heading'); }));
      await page.evaluate(() => window.scrollTo(0, 0));
      const hasP = await mark(primary, 'data-m-primary');
      const hasI = await mark(input, 'data-m-input');
      const hasH = await mark(heading ?? page.locator('main h1, h1').first(), 'data-m-heading');
      const m = await page.evaluate(({ between }) => {
        const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); if (r.width === 0 && r.height === 0) return false; return e.checkVisibility ? e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : true; };
        const words = (s) => (s || '').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
        const vh = innerHeight;
        const docTop = (e) => e.getBoundingClientRect().top + scrollY;
        const P = document.querySelector('[data-m-primary]');
        const I = document.querySelector('[data-m-input]');
        const H = document.querySelector('[data-m-heading]');
        const desc = (e) => e ? { tag: e.tagName.toLowerCase(), id: e.id || null, role: e.getAttribute('role'), name: (e.getAttribute('aria-label') || e.innerText || e.getAttribute('placeholder') || e.value || '').trim().replace(/\s+/g, ' ').slice(0, 80) } : null;
        const geo = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); const top = r.top + scrollY; return { ...desc(e), top: Math.round(top), height: Math.round(r.height), bottom: Math.round(top + r.height), topVh: +(top / vh).toFixed(3), bottomVh: +((top + r.height) / vh).toFixed(3), aboveFold: top + r.height <= vh }; };
        // words above a Y (document coordinates): visible text nodes whose box ends above it
        const wordsAbove = (y) => {
          if (y == null) return null;
          let n = 0;
          const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          const range = document.createRange();
          for (let t = w.nextNode(); t; t = w.nextNode()) {
            if (!t.nodeValue.trim() || !t.parentElement || !vis(t.parentElement)) continue;
            const tag = t.parentElement.tagName; if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') continue;
            range.selectNodeContents(t); const r = range.getBoundingClientRect();
            if (r.height === 0) continue;
            if (r.bottom + scrollY <= y + 1) n += words(t.nodeValue);
          }
          return n;
        };
        const all = (sel) => [...document.querySelectorAll(sel)].filter(vis);
        const navRoots = all('header, nav, aside, [role=navigation]');
        const inNav = (e) => navRoots.some((r) => r.contains(e));
        const isButton = (e) => e.matches('button, [role=button], [data-slot=button], input[type=submit]');
        const buttons = all('button, [role=button], a[data-slot=button], input[type=submit]');
        const secondary = buttons.filter((e) => e !== P && !inNav(e));
        const links = all('a[href]').filter((e) => !isButton(e));
        const navItems = all('header a[href], header button, nav a[href], nav button, aside a[href], aside button, [role=navigation] a[href], [role=navigation] button');
        const fields = all('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]), textarea, select, [role=combobox]');
        const checks = all('input[type=checkbox], input[type=radio], [role=checkbox], [role=radio], [role=switch]');
        const badges = all('span.rounded-full.border, [data-status], [class*="badge" i]');
        const alerts = all('[role=alert], [role=status], [data-slot=alert]').filter((e) => (e.innerText || '').trim().length > 0 && !e.getAttribute('aria-busy'));
        const target = I || P;
        const out = {
          url: location.href.replace(/\/r\/[^/?#]+/, '/r/<id>').replace(/#\/invite\/[^/?#]+/, '#/invite/<token>').replace(/t=[^&#]+/, 't=<sig>'),
          viewport: { w: innerWidth, h: vh },
          words: { body: words(document.body.innerText), main: document.querySelector('main') ? words(document.querySelector('main').innerText) : null, header: document.querySelector('header') ? words(document.querySelector('header').innerText) : null },
          heading: geo(H),
          primaryAction: geo(P),
          input: geo(I),
          wordsAbovePrimary: wordsAbove(target ? docTop(target) : null),
          wordsAboveAction: P ? wordsAbove(docTop(P)) : null,
          wordsAboveInput: I ? wordsAbove(docTop(I)) : null,
          scrollHeight: document.documentElement.scrollHeight,
          scrollHeightVh: +(document.documentElement.scrollHeight / vh).toFixed(2),
          horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
          counts: {
            badges: badges.length, alerts: alerts.length, secondaryButtons: secondary.length, links: links.length, linksOutsideNav: links.filter((e) => !inNav(e)).length,
            navItems: navItems.length, fields: fields.length, checkboxes: checks.length,
          },
          lists: {
            badges: badges.map((e) => e.innerText.trim().slice(0, 40)).slice(0, 20),
            alerts: alerts.map((e) => e.innerText.trim().replace(/\s+/g, ' ').slice(0, 100)).slice(0, 10),
            secondaryButtons: secondary.map((e) => (e.innerText || e.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 50)).slice(0, 30),
            navItems: navItems.map((e) => (e.innerText || e.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 40)).slice(0, 40),
            fields: fields.map((e) => e.id || e.getAttribute('aria-label') || e.getAttribute('name') || e.tagName),
          },
        };
        // Between the page heading and the only input (or the primary action): maximal visible blocks, with their heights.
        if (between && H && target) {
          const hb = H.getBoundingClientRect().bottom + scrollY;
          const tt = docTop(target);
          out.headingToTargetPx = Math.round(tt - hb);
          const cands = all('body *').filter((e) => {
            const r = e.getBoundingClientRect(); const top = r.top + scrollY; const bot = top + r.height;
            return r.height > 0 && top >= hb - 1 && bot <= tt + 1 && !e.contains(H) && !e.contains(target) && !H.contains(e);
          });
          const set = new Set(cands);
          const maximal = cands.filter((e) => !set.has(e.parentElement));
          out.between = maximal.map((e) => ({ tag: e.tagName.toLowerCase(), role: e.getAttribute('role'), label: e.getAttribute('aria-label'), text: (e.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 120), words: words(e.innerText), height: Math.round(e.getBoundingClientRect().height), top: Math.round(e.getBoundingClientRect().top + scrollY) }));
          out.betweenHeightSum = out.between.reduce((s, b) => s + b.height, 0);
        }
        return out;
      }, { between });
      const base = `${flow}-${step}-${width}`;
      await page.screenshot({ path: path.join(SHOTS, `${base}.png`) });
      if (full) await page.screenshot({ path: path.join(SHOTS, `${base}-full.png`), fullPage: true });
      const r = { flow, step, width, height, shots: [`${base}.png`, ...(full ? [`${base}-full.png`] : [])], arrivedAtMs: Date.now() - t0, marked: { primary: hasP, input: hasI, heading: hasH }, waits, notes, ...m };
      records.push(r); prev = r; mark0 = { clicks: d.c.clicks, keys: d.c.keys, log: d.c.log.length };
      save();
      console.log(`STEP ${base} words=${m.words.body} above=${m.wordsAbovePrimary} P=${m.primaryAction?.topVh} I=${m.input?.topVh} scroll=${m.scrollHeightVh}`);
      return r;
    },
    finish(extra = {}) { close(); if (prev) Object.assign(prev, extra); save(); return Date.now() - t0; },
  };
  return rec;
}

const btn = (page, name, o = {}) => page.getByRole('button', { name, ...o });
const mailedCodes = (inst) => existsSync(inst.logFile) ? [...readFileSync(inst.logFile, 'utf8').replace(/\x1b\[[0-9;]*m/g, '').matchAll(/(\d{6}) is your Ready Set Mail code/g)].map((m) => m[1]) : [];
async function nextCode(inst, before, ms = 30000) {
  const t = Date.now();
  while (Date.now() - t < ms) { const c = mailedCodes(inst); if (c.length > before) return { code: c.at(-1), waitedMs: Date.now() - t }; await sleep(100); }
  throw new Error('no code in mail log');
}
const LANDED = (page) => page.getByRole('navigation', { name: 'Main' }).or(page.getByRole('heading', { name: "Let's set up Ready Set Mail" })).or(page.getByRole('heading', { name: "What's your main domain?" })).or(page.locator('main h1')).first();
const brandPrimary = (page) => page.locator('main .bg-brand:is(button, a)');

async function publicDnsHasNoDmarc(page) {
  await page.route('**/api/domains/*/onboarding-status', async (route) => {
    const res = await route.fetch(); const b = await res.json();
    b.nxdomain = false; delete b.dns_errors;
    b.dmarc = { ...b.dmarc, found: false, has_our_rua: false, current_record: null, effective: { policy: null, inherited_from: null, issue: null, record: null } };
    b.spf = { record: null, lookup_count: null, flattening_active: false };
    await route.fulfill({ response: res, json: b });
  });
}

/** Sign-up screen -> code screen -> landing. Returns after landing is visible (not measured). */
async function signUpSteps(page, d, R, inst, email, entry) {
  await page.goto(`${inst.url}/${entry}`);
  await page.locator('#email').waitFor();
  const submit = btn(page, /Create account|Sign up/).first();
  const tTs = Date.now();
  await submit.waitFor(); for (let i = 0; i < 100 && !(await submit.isEnabled()); i++) await sleep(100);
  const turnstileMs = Date.now() - tTs;
  await R.step('signup', { primary: submit, input: page.locator('#email'), between: true, waits: { turnstileReadyMs: turnstileMs } });
  await d.fill(page.locator('#email'), email, 'email');
  await d.fill(page.getByLabel('Password', { exact: true }), PW, 'password');
  const before = mailedCodes(inst).length;
  const tSub = Date.now();
  await d.click(submit, 'Create account');
  const { code, waitedMs } = await nextCode(inst, before);
  const codeInput = page.getByLabel('6-digit code');
  await codeInput.waitFor({ timeout: 30000 });
  const screenMs = Date.now() - tSub;
  await R.step('code', { primary: codeInput, input: codeInput, between: true, waits: { codeInMailLogMs: waitedMs + (Date.now() - tSub - waitedMs > 0 ? 0 : 0), submitToCodeScreenMs: screenMs, codeArrivalAfterSubmitMs: null } });
  records.at(-1).waits.codeArrivalAfterSubmitMs = waitedMs; // measured from the submit click
  const tCode = Date.now();
  await d.seq(codeInput, code, 'code (sixth digit submits)');
  await LANDED(page).waitFor({ timeout: 30000 });
  return { codeToLandingMs: Date.now() - tCode };
}

async function newCtx(browser, w, h) { const ctx = await browser.newContext({ viewport: { width: w, height: h } }); return { ctx, page: await ctx.newPage() }; }
const DOH = { 'harbor-lane.org': ['ns1.domaincontrol.com'], 'brightwave-mail.com': ['ns1.ns.cloudflare.com'], 'quietfield.net': ['ns1.ns.cloudflare.com'] };

async function hosted(vars = {}) { return startInstance({ mode: 'hosted', port: portSeq++, tokenKey: true, dohNs: DOH, vars: { MCP_DCR_ENABLED: '1', ...vars } }); }

// ---------------------------------------------------------------- flows
async function flowA(browser, w, h) {
  const inst = await hosted();
  const { ctx, page } = await newCtx(browser, w, h); const d = driver(page); const R = flowRecorder(page, d, 'A', w, h);
  try {
    await publicDnsHasNoDmarc(page);
    const s = await signUpSteps(page, d, R, inst, `owner-a-${w}@example.test`, '#/signup?domain=brightwave-mail.com');
    await page.getByRole('heading', { name: "Let's set up Ready Set Mail" }).waitFor({ timeout: 20000 }).catch(() => {});
    await sleep(1200);
    await R.step('first-screen', { primary: btn(page, 'Connect Cloudflare'), between: true, waits: s, notes: ['lands on #/setup FirstScreen'] });
    await d.click(btn(page, 'Connect Cloudflare').first(), 'Connect Cloudflare');
    const tok = page.getByLabel('Cloudflare API token');
    const oauthBtn = page.getByRole('button', { name: /Continue with Cloudflare|Sign in with Cloudflare|Authorize/i });
    await tok.or(oauthBtn).first().waitFor({ timeout: 20000 });
    await R.step('cf-connect', { primary: btn(page, 'Connect', { exact: true }), input: tok, between: true, notes: ['fake Cloudflare has no OAuth screen: token paste (what the e2e specs do); OAuth return reaches the same import code'] });
    await d.fill(tok, 'e2e-fake-token-not-a-real-secret-0000', 'token');
    const tC = Date.now();
    await d.click(btn(page, 'Connect', { exact: true }), 'Connect');
    await page.getByRole('heading', { name: 'Domains', exact: true }).waitFor({ timeout: 60000 });
    const importMs = Date.now() - tC;
    await sleep(1500);
    await R.step('dashboard', { primary: brandPrimary(page), heading: page.locator('main h1').first(), waits: { connectToDashboardMs: importMs }, notes: ['auto-import: no zone list, no plan'] });
    // Domain page
    await d.click(page.getByRole('link', { name: 'brightwave-mail.com', exact: true }).first(), 'domain link');
    await page.locator('main h1').first().waitFor(); await sleep(2000);
    await R.step('domain', { primary: brandPrimary(page), heading: page.locator('main h1').first() });
    // Apply: the DMARC wizard step
    const id = inst.d1("SELECT id FROM domains WHERE domain = 'brightwave-mail.com'")[0]?.id;
    if (id) {
      await page.goto(`${inst.url}/#/domains/${id}/setup/4`); await page.locator('h1').first().waitFor(); await sleep(2500);
      const apply = btn(page, 'Apply via Cloudflare');
      await R.step('dmarc-apply', { primary: apply.or(brandPrimary(page)).first(), between: true, notes: ['reached by URL #/domains/:id/setup/4 (not a click)'] });
      if (await apply.count()) {
        const tA = Date.now(); await d.click(apply.first(), 'Apply via Cloudflare');
        await page.getByText(/Written to Cloudflare|Reports are connected|Live in public DNS/).first().waitFor({ timeout: 30000 }).catch(() => {});
        await sleep(1000);
        await R.step('dmarc-applied', { primary: brandPrimary(page), waits: { applyMs: Date.now() - tA } });
      }
    }
    R.finish({ flowMs: Date.now() - R.t0 });
  } catch (e) { errors.push({ flow: 'A', width: w, error: String(e.message).split('\n')[0] }); await page.screenshot({ path: path.join(SHOTS, `A-error-${w}.png`), fullPage: true }).catch(() => {}); R.finish(); }
  await ctx.close(); await inst.stop();
}

async function flowB(browser, w, h) {
  const inst = await hosted();
  const { ctx, page } = await newCtx(browser, w, h); const d = driver(page); const R = flowRecorder(page, d, 'B', w, h);
  try {
    await publicDnsHasNoDmarc(page);
    const s = await signUpSteps(page, d, R, inst, `owner-b-${w}@example.test`, '#/signup?domain=harbor-lane.org');
    await page.getByRole('heading', { name: "Let's set up Ready Set Mail" }).waitFor({ timeout: 20000 });
    await sleep(1200);
    await R.step('first-screen', { primary: btn(page, 'Connect Cloudflare'), between: true, waits: s });
    await d.click(btn(page, "I'll add DNS records myself"), "I'll add DNS records myself");
    const dom = page.getByLabel('Domain', { exact: true });
    await dom.waitFor(); await sleep(800);
    await R.step('domain-step', { primary: btn(page, 'Continue'), input: dom, between: true, notes: [`prefilled: ${await dom.inputValue()}`] });
    if ((await dom.inputValue()) !== 'harbor-lane.org') await d.fill(dom, 'harbor-lane.org', 'domain');
    const tD = Date.now();
    await d.click(btn(page, 'Continue'), 'Continue');
    const rec = page.getByRole('group', { name: 'DNS record to add' });
    await rec.waitFor({ timeout: 20000 }); await sleep(2500);
    await R.step('claim', { primary: btn(page, /^Verify/), input: rec.locator('code').last(), heading: page.locator('h1').first(), between: true, waits: { continueToClaimMs: Date.now() - tD }, notes: ['input = the TXT value to copy'] });
    // also the gap from the step title (h2 "Verify you own this domain") to the record
    const tV = Date.now();
    await d.click(btn(page, /^Verify/).first(), 'Verify (fails)');
    await page.getByText(/don.t see the record|not visible yet|not found|couldn.t find|No TXT|isn.t there|not there/i).first().waitFor({ timeout: 30000 }).catch(() => {});
    await sleep(800);
    await R.step('claim-failed', { primary: btn(page, /^Verify/), input: rec.locator('code').last(), heading: page.locator('h1').first(), between: true, waits: { verifyFailMs: Date.now() - tV } });
    // Success: put the TXT record into the fake's zone (the fake answers DNS-over-HTTPS from it), then Verify.
    const list = await (await page.request.get(`${inst.url}/api/domains`)).json();
    const claim = (list.pending_claims ?? []).find((c) => c.domain === 'harbor-lane.org');
    const st = await (await fetch(`${inst.fake.url}/__state`)).json();
    const zone = st.zones.find((z) => z.name === 'harbor-lane.org');
    const txtName = claim.txt_name; const txtValue = claim.txt_value;
    await fetch(`${inst.fake.url}/client/v4/zones/${zone.id}/dns_records`, { method: 'POST', headers: { authorization: 'Bearer e2e-seed', 'content-type': 'application/json' }, body: JSON.stringify({ type: 'TXT', name: txtName, content: txtValue, ttl: 1 }) });
    const tV2 = Date.now();
    await d.click(btn(page, /^Verify/).first(), 'Verify (succeeds)');
    await page.waitForURL(/setup\/\d|domains\/\d+/, { timeout: 30000 }).catch(() => {});
    await page.getByRole('heading', { level: 1 }).first().waitFor(); await sleep(2500);
    const verifyOk = Date.now() - tV2;
    const id = inst.d1("SELECT id FROM domains WHERE domain = 'harbor-lane.org'")[0]?.id;
    const names = { 2: 'spf', 3: 'dkim', 4: 'dmarc', 5: 'reports' };
    let first = true;
    for (const n of [2, 3, 4, 5]) {
      if (!first || !/setup\/2/.test(page.url())) { if (!new RegExp(`setup/${n}`).test(page.url())) { await page.goto(`${inst.url}/#/domains/${id}/setup/${n}`); await sleep(2500); } }
      first = false;
      await R.step(`wizard-${names[n]}`, { primary: brandPrimary(page), heading: page.locator('h1').first(), between: true, waits: n === 2 ? { verifySuccessToWizardMs: verifyOk, landedUrl: page.url().replace(/^https?:\/\/[^/]+/, '') } : {} });
      // advance the way a person would: the step's Next/Skip/Continue button
      const adv = page.getByRole('button', { name: /^(Next|Continue|Skip( for now)?|Skip this step|I've added it|Done)/ }).or(page.getByRole('link', { name: /^(Next|Continue|Skip)/ })).first();
      if (n < 5 && await adv.count()) { await d.click(adv, `advance:${(await adv.innerText()).slice(0, 30)}`); await sleep(2500); }
    }
    await page.goto(`${inst.url}/#/domains/${id}`); await page.locator('main h1').first().waitFor(); await sleep(2000);
    await R.step('domain', { primary: brandPrimary(page), heading: page.locator('main h1').first(), notes: ['reached by URL'] });
    R.finish({ flowMs: Date.now() - R.t0 });
  } catch (e) { errors.push({ flow: 'B', width: w, error: String(e.message).split('\n')[0] }); await page.screenshot({ path: path.join(SHOTS, `B-error-${w}.png`), fullPage: true }).catch(() => {}); R.finish(); }
  await ctx.close(); await inst.stop();
}

/** C cold sign-up, then E returning sign-in, D invite, F agents/consent, H billing, on one instance (fresh contexts). */
async function flowCDEFH(browser, w, h) {
  const inst = await hosted();
  const owner = `owner-c-${w}@example.test`;
  {
    const { ctx, page } = await newCtx(browser, w, h); const d = driver(page); const R = flowRecorder(page, d, 'C', w, h);
    try {
      const s = await signUpSteps(page, d, R, inst, owner, '#/signup');
      await sleep(1500);
      await R.step('first-screen', { primary: btn(page, 'Connect Cloudflare'), between: true, waits: s });
      // Overview (skip setup) for the "Get to your first answer" block
      await page.goto(`${inst.url}/#/`); await sleep(2500);
      await R.step('overview-empty', { primary: brandPrimary(page), heading: page.locator('main h1, h1').first(), between: true, notes: ['reached by URL #/ after landing'] });
      R.finish({ flowMs: Date.now() - R.t0 });
      // F: agents + H: settings/billing
      const RF = flowRecorder(page, d, 'F', w, h);
      await page.goto(`${inst.url}/#/agents`); await sleep(2500);
      await RF.step('agents', { primary: brandPrimary(page), heading: page.locator('main h1, h1').first(), between: true });
      // consent screen: measured in flowF2 (needs an HTTPS issuer)
      RF.finish();
      const RH = flowRecorder(page, d, 'H', w, h);
      await page.goto(`${inst.url}/#/settings`); await sleep(2500);
      const billingText = await page.evaluate(() => [...document.querySelectorAll('h1,h2,h3,button,a')].map((e) => e.innerText.trim()).filter((t) => /billing|plan|upgrade|subscription|invoice|pay/i.test(t)).slice(0, 10));
      await RH.step('settings', { primary: brandPrimary(page), heading: page.locator('main h1, h1').first(), notes: [`billing-like headings/buttons: ${JSON.stringify(billingText)}`] });
      RH.finish();
      // D: owner creates invite
      const RD = flowRecorder(page, d, 'D', w, h);
      await page.goto(`${inst.url}/#/members`); await page.getByRole('heading', { name: 'Members', level: 1 }).waitFor({ timeout: 20000 }); await sleep(1500);
      await RD.step('members', { primary: btn(page, 'Create invite link'), input: page.getByLabel('Email'), between: true });
      await d.fill(page.getByLabel('Email'), `teammate-${w}@example.test`, 'invitee email');
      await d.click(btn(page, 'Create invite link'), 'Create invite link');
      const link = (await page.getByTestId('invite-link').textContent()).trim();
      await sleep(800);
      await RD.step('invite-created', { primary: page.getByRole('button', { name: /Copy/ }).first(), input: page.getByTestId('invite-link'), between: true });
      RD.finish();
      await ctx.close();
      // teammate in a fresh context
      const t = await newCtx(browser, w, h); const d2 = driver(t.page); const R2 = flowRecorder(t.page, d2, 'D', w, h);
      await t.page.goto(link); await t.page.getByRole('button', { name: 'Accept invite' }).waitFor({ timeout: 20000 }); await sleep(1000);
      const pwField = t.page.locator('#password');
      await R2.step('invite-accept', { primary: btn(t.page, 'Accept invite'), input: pwField, between: true });
      await d2.fill(pwField, PW, 'password');
      const nameF = t.page.locator('#name'); if (await nameF.count()) await d2.fill(nameF, 'Teammate', 'name');
      const conf = t.page.locator('#confirm'); if (await conf.count()) await d2.fill(conf, PW, 'confirm');
      const before = mailedCodes(inst).length; const tA = Date.now();
      await d2.click(btn(t.page, 'Accept invite'), 'Accept invite');
      const codeInput = t.page.getByLabel('6-digit code');
      await codeInput.or(t.page.getByRole('navigation', { name: 'Main' })).first().waitFor({ timeout: 30000 });
      if (await codeInput.isVisible().catch(() => false)) {
        const { code, waitedMs } = await nextCode(inst, before);
        await R2.step('invite-code', { primary: codeInput, input: codeInput, between: true, waits: { codeArrivalAfterSubmitMs: waitedMs } });
        await d2.seq(codeInput, code, 'code');
        await codeInput.waitFor({ state: 'hidden', timeout: 30000 });
      }
      await t.page.locator('main h1, h1').first().waitFor({ timeout: 30000 }); await sleep(2000);
      await R2.step('invite-landed', { primary: brandPrimary(t.page), heading: t.page.locator('main h1, h1').first(), between: true, waits: { acceptToLandingMs: Date.now() - tA } });
      R2.finish({ flowMs: Date.now() - R2.t0 });
      await t.ctx.close();
    } catch (e) { errors.push({ flow: 'C/D/F/H', width: w, error: String(e.message).split('\n')[0] }); await page.screenshot({ path: path.join(SHOTS, `CDFH-error-${w}.png`), fullPage: true }).catch(() => {}); R.finish(); }
    await ctx.close().catch(() => {});
  }
  // E: returning sign-in, fresh context
  {
    const { ctx, page } = await newCtx(browser, w, h); const d = driver(page); const R = flowRecorder(page, d, 'E', w, h);
    try {
      await page.goto(`${inst.url}/`); await page.locator('#email').waitFor(); await sleep(800);
      const submit = btn(page, 'Sign in', { exact: true });
      await R.step('signin', { primary: submit, input: page.locator('#email'), between: true });
      await d.fill(page.locator('#email'), owner, 'email'); await d.fill(page.getByLabel('Password', { exact: true }), PW, 'password');
      const before = mailedCodes(inst).length; const tS = Date.now();
      await d.click(submit, 'Sign in');
      const codeInput = page.getByLabel('6-digit code');
      await codeInput.or(page.getByRole('navigation', { name: 'Main' })).first().waitFor({ timeout: 30000 });
      if (await codeInput.isVisible().catch(() => false)) {
        const { code, waitedMs } = await nextCode(inst, before);
        await R.step('code', { primary: codeInput, input: codeInput, between: true, waits: { codeArrivalAfterSubmitMs: waitedMs } });
        await d.seq(codeInput, code, 'code');
        await codeInput.waitFor({ state: 'hidden', timeout: 30000 });
      } else R.step && records.push({ flow: 'E', step: 'code', width: w, notes: ['no code asked'] });
      await LANDED(page).waitFor({ timeout: 30000 }); await sleep(2000);
      await R.step('landed', { primary: brandPrimary(page), heading: page.locator('main h1, h1').first(), between: true, waits: { submitToLandingMs: Date.now() - tS } });
      R.finish({ flowMs: Date.now() - R.t0 });
    } catch (e) { errors.push({ flow: 'E', width: w, error: String(e.message).split('\n')[0] }); await page.screenshot({ path: path.join(SHOTS, `E-error-${w}.png`), fullPage: true }).catch(() => {}); R.finish(); }
    await ctx.close();
  }
  await inst.stop();
}

async function flowG(browser, w, h) {
  const inst = await startInstance({ mode: 'selfhost', port: portSeq++, tokenKey: true, dohNs: DOH });
  const { ctx, page } = await newCtx(browser, w, h); const d = driver(page); const R = flowRecorder(page, d, 'G', w, h);
  try {
    // The bare instance: the installer-proof form
    await page.goto(`${inst.url}/`); await page.locator('#email').waitFor(); await sleep(800);
    await R.step('owner-proof-form', { primary: btn(page, 'Create account'), input: page.locator('#email'), between: true, notes: ['opened without the signed setup link'] });
    // The signed setup link the installer prints
    await page.goto(inst.setupLink()); await page.locator('#email').waitFor(); await sleep(800);
    await R.step('owner-setup-link', { primary: btn(page, 'Create account'), input: page.locator('#email'), between: true });
    await d.fill(page.locator('#email'), `owner-g-${w}@example.test`, 'email');
    await d.fill(page.locator('#password'), PW, 'password');
    const c = page.locator('#confirm'); if (await c.count()) await d.fill(c, PW, 'confirm');
    const tS = Date.now();
    await d.click(btn(page, 'Create account'), 'Create account');
    await LANDED(page).waitFor({ timeout: 30000 }); await sleep(1500);
    await R.step('first-screen', { primary: btn(page, 'Connect Cloudflare'), between: true, waits: { createToFirstScreenMs: Date.now() - tS } });
    await d.click(btn(page, "I'll add DNS records myself"), "I'll add DNS records myself");
    const dom = page.getByLabel('Main domain'); await dom.waitFor(); await sleep(800);
    await R.step('domain-step', { primary: btn(page, 'Continue'), input: dom, between: true });
    R.finish({ flowMs: Date.now() - R.t0 });
  } catch (e) { errors.push({ flow: 'G', width: w, error: String(e.message).split('\n')[0] }); await page.screenshot({ path: path.join(SHOTS, `G-error-${w}.png`), fullPage: true }).catch(() => {}); R.finish(); }
  await ctx.close(); await inst.stop();
}

// ---------------------------------------------------------------- website (live, public pages only)
const SITE = 'https://readysetmail.com';
async function siteChrome(page) {
  return page.evaluate(() => {
    const vis = (e) => e.checkVisibility ? e.checkVisibility({ checkVisibilityCSS: true }) : true;
    const items = (root) => root ? [...root.querySelectorAll('a[href], button')].filter(vis).map((a) => ({ text: (a.innerText || a.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' '), href: a.getAttribute('href') })) : [];
    const footer = document.querySelector('footer');
    return {
      headerNav: items(document.querySelector('nav[aria-label="Main navigation"]')),
      header: items(document.querySelector('header')),
      footerGroups: footer ? [...footer.querySelectorAll('nav[aria-label]')].map((n) => ({ group: n.getAttribute('aria-label'), links: [...n.querySelectorAll('a[href]')].map((a) => ({ text: a.innerText.trim(), href: a.getAttribute('href') })) })) : [],
    };
  });
}
async function ctaList(page) {
  return page.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.height > 0 && (e.checkVisibility ? e.checkVisibility({ checkVisibilityCSS: true }) : true); };
    const main = document.querySelector('main') || document.body;
    return [...main.querySelectorAll('a[href], button')].filter(vis).filter((e) => {
      const cs = getComputedStyle(e); const bg = cs.backgroundColor;
      return e.tagName === 'BUTTON' || (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') || /border/.test(e.className) && /px-/.test(e.className);
    }).map((e) => ({ text: (e.innerText || e.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 80), href: (e.getAttribute('href') || '').replace(/\/r\/[^/?#]+/, '/r/<id>'), top: Math.round(e.getBoundingClientRect().top + scrollY) }));
  });
}
async function resultBlock(page, domain) {
  return page.evaluate((domain) => {
    const vis = (e) => e.checkVisibility ? e.checkVisibility({ checkVisibilityCSS: true }) : true;
    const words = (s) => (s || '').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
    // smallest section/region/article/div that contains the domain's details links (home) or the result (tools)
    const anchors = [...document.querySelectorAll('a[href*="?domain="], [aria-live]')].filter(vis);
    let el = anchors[0]; if (!el) return null;
    while (el.parentElement && words(el.innerText) < 25) el = el.parentElement;
    while (el.parentElement && el.parentElement.tagName !== 'MAIN' && !/SECTION|ARTICLE|FORM/.test(el.tagName) && words(el.parentElement.innerText) < 400) el = el.parentElement;
    const nexts = [...el.querySelectorAll('a[href], button')].filter(vis).map((a) => ({ text: (a.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 80), href: (a.getAttribute('href') || '').replace(/\/r\/[^/?#]+/, '/r/<id>'), domain_external: /^https?:/.test(a.getAttribute('href') || '') ? new URL(a.getAttribute('href')).host : null }));
    const r = el.getBoundingClientRect();
    return { tag: el.tagName.toLowerCase(), words: words(el.innerText), top: Math.round(r.top + scrollY), height: Math.round(r.height), text: el.innerText.trim().replace(/\s+/g, ' ').slice(0, 400), nextSteps: nexts };
  }, domain);
}

async function webWalk(browser, w, h) {
  const { ctx, page } = await newCtx(browser, w, h); const d = driver(page);
  const go = async (p) => { await page.goto(SITE + p, { waitUntil: 'networkidle' }); await sleep(600); };
  const domainInput = () => page.locator('main input[type=text], main input[inputmode=url], main input[name=domain]').first();
  const submitOf = () => page.locator('main button[type=submit]').first();
  const check = async (R, stepBase, domain, mode) => {
    await d.fill(domainInput(), domain, 'domain');
    const t = Date.now();
    await d.click(submitOf(), 'Check');
    if (mode === 'home') await page.locator('main a[href*="dmarc-checker?domain="]').first().waitFor({ timeout: 90000 }).catch(() => {});
    else await page.waitForURL(/\/r\//, { timeout: 90000 }).catch(() => {});
    if (mode !== 'home') await page.locator('h1').first().waitFor();
    await page.waitForLoadState('networkidle').catch(() => {});
    const ms = Date.now() - t; await sleep(800);
    const block = mode === 'home' ? await resultBlock(page, domain) : null;
    const r = await R.step(stepBase, { primary: submitOf().or(page.getByRole('button', { name: 'Check again' })).first(), heading: page.locator('h1').first(), waits: { timeToResultMs: ms }, notes: [`domain=${domain}`] });
    r.resultBlock = block; r.ctas = await ctaList(page);
    if (mode !== 'home') r.reportPage = { navigatedToReport: /\/r\//.test(page.url()), headings: await page.evaluate(() => [...document.querySelectorAll('h1,h2')].map((e) => e.innerText.trim()).slice(0, 12)) };
    save();
  };
  try {
    // Home
    let R = flowRecorder(page, d, 'W-home', w, h);
    await go('/');
    let r = await R.step('home', { primary: submitOf(), input: domainInput(), between: true });
    r.chrome = await siteChrome(page); r.ctas = await ctaList(page);
    if (w === 375) {
      await d.click(page.locator('button[aria-controls="mobile-nav"]'), 'Open menu'); await sleep(600);
      r = await R.step('home-menu', { primary: page.locator('#mobile-nav a').last(), full: false });
      r.mobileNav = await page.evaluate(() => [...document.querySelectorAll('#mobile-nav a[href], #mobile-nav button')].map((a) => ({ text: a.innerText.trim().replace(/\s+/g, ' '), href: a.getAttribute('href') })));
      await page.keyboard.press('Escape'); await go('/');
    }
    await check(R, 'home-check-github', 'github.com', 'home');
    await go('/');
    await check(R, 'home-check-example', 'example.com', 'home');
    R.finish();
    // DMARC checker -> report
    R = flowRecorder(page, d, 'W-dmarc', w, h);
    await go('/tools/dmarc-checker');
    r = await R.step('tool', { primary: submitOf(), input: domainInput(), between: true }); r.ctas = await ctaList(page);
    await check(R, 'report', 'github.com', 'tool');
    R.finish();
    // Errors index + error page with embedded check
    R = flowRecorder(page, d, 'W-errors', w, h);
    await go('/errors');
    r = await R.step('index', { primary: page.locator('main a[href^="/errors/"]').first(), between: true }); r.ctas = await ctaList(page);
    await go('/errors/550-5-7-26');
    r = await R.step('550-5-7-26', { primary: submitOf(), input: domainInput(), between: true }); r.ctas = await ctaList(page);
    await check(R, '550-5-7-26-report', 'example.com', 'tool');
    R.finish();
    // /bounce/5-7-26 (redirect)
    R = flowRecorder(page, d, 'W-bounce', w, h);
    const resp = await page.goto(SITE + '/bounce/5-7-26', { waitUntil: 'networkidle' });
    r = await R.step('5-7-26', { primary: submitOf(), input: domainInput(), full: false, notes: [`final url ${page.url()} status ${resp?.status()}`] });
    R.finish();
    // For agencies
    R = flowRecorder(page, d, 'W-agencies', w, h);
    await go('/for-agencies');
    r = await R.step('page', { primary: submitOf(), input: domainInput(), between: true }); r.ctas = await ctaList(page);
    await check(R, 'report', 'github.com', 'tool');
    R.finish();
    // Pricing
    R = flowRecorder(page, d, 'W-pricing', w, h);
    await go('/pricing');
    r = await R.step('page', { primary: page.locator('main a[href*="tidycal.com"], main a[href*="app.readysetmail.com"], main .bg-brand, main a[class*="bg-"]').first(), between: true });
    r.ctas = await ctaList(page);
    r.allMainLinks = await page.evaluate(() => [...document.querySelectorAll('main a[href]')].map((a) => ({ text: a.innerText.trim().replace(/\s+/g, ' ').slice(0, 80), href: a.getAttribute('href') })));
    R.finish();
    save();
  } catch (e) { errors.push({ flow: 'web', width: w, error: String(e.message).split('\n')[0] }); await page.screenshot({ path: path.join(SHOTS, `web-error-${w}.png`), fullPage: true }).catch(() => {}); }
  await ctx.close();
}

async function tidycal(browser) {
  const { ctx, page } = await newCtx(browser, 1440, 900);
  const out = {};
  try {
    await page.goto('https://tidycal.com/maxfindel/spam-phishing-and-deliverability-audit', { waitUntil: 'networkidle', timeout: 60000 }); await sleep(2000);
    out.audit = { url: page.url(), title: await page.title(), h: await page.evaluate(() => [...document.querySelectorAll('h1,h2,h3')].map((e) => e.innerText.trim()).filter(Boolean).slice(0, 10)), bookable: await page.evaluate(() => /select a (date|time)|choose a time|book/i.test(document.body.innerText)) };
    await page.screenshot({ path: path.join(SHOTS, 'W-tidycal-audit-1440.png') });
    await page.goto('https://tidycal.com/maxfindel', { waitUntil: 'networkidle', timeout: 60000 }); await sleep(2000);
    out.profile = { url: page.url(), bookingTypes: await page.evaluate(() => [...document.querySelectorAll('a[href*="/maxfindel/"]')].map((a) => ({ text: a.innerText.trim().replace(/\s+/g, ' ').slice(0, 80), href: a.getAttribute('href') }))) };
    await page.screenshot({ path: path.join(SHOTS, 'W-tidycal-profile-1440.png') });
  } catch (e) { out.error = String(e.message).split('\n')[0]; }
  records.push({ flow: 'W-tidycal', step: 'booking', tidycal: out }); save();
  await ctx.close();
}


/** F: the agent OAuth consent screen. The issuer must be an HTTPS origin, so this is a self-host instance served with
 * --local-protocol https (as scripts/e2e-devbox.sh does), owner created through /api/auth/setup like e2e/support/session.ts. */
async function flowF2(browser, w, h) {
  const { spawn, spawnSync } = await import('node:child_process');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { randomBytes } = await import('node:crypto');
  const port = portSeq++; const origin = `https://127.0.0.1:${port}`;
  const dir = mkdtempSync(path.join(tmpdir(), 'rsm-https-'));
  spawnSync('node', ['packages/db/scripts/migrate.mjs', '--local', '--persist-to', dir], { encoding: 'utf8' });
  const proof = randomBytes(32).toString('hex');
  const child = spawn('npx', ['wrangler', 'dev', '--local', '--persist-to', dir, '--port', String(port), '--ip', '127.0.0.1', '--local-protocol', 'https', '--var', `BOOTSTRAP_SECRET:${proof}`, '--var', `BETTER_AUTH_URL:${origin}`, '--var', 'MCP_DCR_ENABLED:1'], { stdio: 'ignore', detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, ignoreHTTPSErrors: true }); const page = await ctx.newPage();
  const d = driver(page); const R = flowRecorder(page, d, 'F', w, h);
  try {
    for (let i = 0; i < 120; i++) { try { const r = await page.request.get(`${origin}/health`); if (r.ok()) break; } catch {} await sleep(1000); }
    const st = await page.request.post(`${origin}/api/auth/setup`, { headers: { Origin: origin, 'X-Ready-Set-Mail-Bootstrap': proof }, data: { email: `owner-f-${w}@example.test`, password: PW, name: 'Owner' } });
    if (st.status() !== 201) throw new Error(`setup ${st.status()}`);
    const reg = await page.request.post(`${origin}/oauth/register`, { data: { client_name: 'Local acceptance client', redirect_uris: ['https://client.example/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' } });
    if (reg.status() !== 201) throw new Error(`oauth/register ${reg.status()}`);
    const { client_id } = await reg.json();
    const q = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: 'https://client.example/callback', scope: 'ready-set-mail', resource: origin + '/mcp', code_challenge: 'A'.repeat(43), code_challenge_method: 'S256' });
    await page.goto(`${origin}/oauth/authorize?${q}`); await page.locator('h1').first().waitFor({ timeout: 20000 }); await sleep(1500);
    await R.step('oauth-consent', { primary: page.locator('button[type=submit]').first(), heading: page.locator('h1').first(), between: true, notes: ['self-host https instance; DCR client registered via API (unverified client)'] });
    R.finish();
  } catch (e) { errors.push({ flow: 'F-consent', width: w, error: String(e.message).split('\n')[0] }); await page.screenshot({ path: path.join(SHOTS, `F-error-${w}.png`), fullPage: true }).catch(() => {}); R.finish(); }
  await ctx.close();
  try { process.kill(-child.pid, 'SIGTERM'); } catch {} await sleep(800); try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  rmSync(dir, { recursive: true, force: true });
}

const browser = await chromium.launch();
try {
  if (MODE === 'app') {
    for (const [w, h] of VIEWS) {
      if (!ONLY || ONLY.includes('A')) await flowA(browser, w, h);
      if (!ONLY || ONLY.includes('B')) await flowB(browser, w, h);
      if (!ONLY || /[CDEFH]/.test(ONLY)) await flowCDEFH(browser, w, h);
      if (!ONLY || ONLY.includes('G')) await flowG(browser, w, h);
      if (!ONLY || ONLY.includes('F')) await flowF2(browser, w, h);
    }
  } else {
    for (const [w, h] of VIEWS) await webWalk(browser, w, h);
    await tidycal(browser);
  }
} finally { await browser.close(); save(); }
console.log(`DONE records=${records.length} errors=${errors.length} ${JSON.stringify(errors)}`);
process.exit(0);
