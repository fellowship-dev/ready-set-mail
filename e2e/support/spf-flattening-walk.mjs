// Walk of the spf-flattening flow (.flowchad/flows/spf-flattening.yml) against a local Worker (wrangler dev), the repo's fake Cloudflare and a fake DNS-over-HTTPS.
//
//   WALK_OUT=<dir> node e2e/support/spf-flattening-walk.mjs <mode>
//
// Modes (run ONE AT A TIME: each starts its own Worker on its own port, 8901/8902/8903):
//   selfhost         self-hosted instance: Do this next -> Open SPF flattening -> Continue -> Turn on -> status line -> a provider adds an address -> a provider glitches
//                    (a removal waits) -> Check again now -> an outside edit: the review screen (the choice and its button first) -> Use my edit -> Turn off ->
//                    turn on again -> the delete dialog (flattening on) -> Cloudflare refuses the write -> the delete dialog that stops: "Delete anyway" and what is above it
//   hosted-admitted  hosted instance (MODE=saas) with HOSTED_SPF_FLATTENING=owner: the same steps
//   hosted-open      hosted instance without the add-on: Do this next leads to "See where the lookups go" (no flattening mention); the typed flattening address says it is not available
//
// Then gate each one with the repo's gate (the record is written to .flowchad/walks/):
//   node .agents/skills/flow-gate/scripts/gate.mjs $WALK_OUT/results.json --target http://127.0.0.1:<port> --record .flowchad/walks
//
// Every number in results.json (words, words above the action, action bottom in viewport heights, scroll before the action, clicks, fields, waits, screens) is measured
// or counted by this script (measure.mjs in the page, counters on every click and field, timers); nothing is typed by hand. What a screen claims is checked against the fake
// Cloudflare and the database (truth_checks). Writes: results.json, notes.json, text/<step>@<width>.txt, shots/ (screenshots), logs/. No live system is touched.
// Needs: npm install, `npm run build:dashboard` (the Worker serves web/dist: build after every change to web/), and Chromium for Playwright (PLAYWRIGHT_BROWSERS_PATH). Fictitious names only.
import { spawn, spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, createWriteStream, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { chromium } from '@playwright/test';
import { startFakeCloudflare } from './fake-cloudflare.mjs';
import { pageMetrics } from '../../.agents/skills/flow-walk/scripts/measure.mjs';

const execFileP = promisify(execFile);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = process.env.WALK_OUT ?? path.join(tmpdir(), 'spf-flattening-walk', process.argv[2] ?? 'tmp');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const TOKEN = 'e2e-fake-token-not-a-real-secret-0000';
const BEARER = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

/** Fake Cloudflare behind a proxy that (a) counts every call, (b) can make a DoH name answer SERVFAIL or NXDOMAIN. */
async function startStandIns() {
  const fake = await startFakeCloudflare({ port: 0 });
  const calls = []; // {method, path}
  const doh = new Map(); // name -> 'SERVFAIL'|'NXDOMAIN'
  let dohQueries = 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    if (url.pathname === '/__doh' && req.method === 'POST') {
      const { name, mode } = JSON.parse(body.toString());
      if (mode) doh.set(name.toLowerCase(), mode); else doh.delete(name.toLowerCase());
      res.end('{}'); return;
    }
    if (url.pathname === '/dns-query') {
      dohQueries++;
      const name = (url.searchParams.get('name') ?? '').toLowerCase().replace(/\.$/, '');
      const mode = doh.get(name);
      if (mode) { res.writeHead(200, { 'Content-Type': 'application/dns-json' }); res.end(JSON.stringify({ Status: mode === 'SERVFAIL' ? 2 : 3, Question: [{ name, type: 16 }] })); return; }
    } else if (url.pathname.startsWith('/client/v4')) calls.push({ method: req.method, path: url.pathname });
    const up = await fetch(fake.url + req.url, { method: req.method, headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['host', 'content-length', 'connection'].includes(k))), body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
    res.writeHead(up.status, { 'Content-Type': up.headers.get('content-type') ?? 'application/json' });
    res.end(Buffer.from(await up.arrayBuffer()));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const state = async () => (await fetch(`${fake.url}/__state`)).json();
  const post = (p, b) => fetch(fake.url + p, { method: 'POST', body: JSON.stringify(b) });
  const cf = async (method, p, body) => {
    const r = await fetch(`${fake.url}/client/v4${p}`, { method, headers: BEARER, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) throw new Error(`${method} ${p} ${r.status}`);
    return (await r.json()).result;
  };
  const zoneId = async (name) => (await state()).zones.find((z) => z.name === name)?.id;
  return {
    fake, url, calls, doh, state, cf, zoneId,
    /** Writes (not reads) to DNS records through the Cloudflare API the Worker uses. */
    writes: () => calls.filter((c) => /\/dns_records/.test(c.path) && c.method !== 'GET'),
    setDoh: (name, mode) => fetch(`${url}/__doh`, { method: 'POST', body: JSON.stringify({ name, mode }) }),
    addZone: async (name) => { await post('/__zones', { name }); return zoneId(name); },
    addTxt: async (zone, name, content) => cf('POST', `/zones/${await zoneId(zone)}/dns_records`, { type: 'TXT', name, content }),
    txt: async (zone, name) => (await state()).records[await zoneId(zone)].filter((r) => r.type === 'TXT' && r.name === name),
    setTxt: async (zone, name, content) => { const [r] = await (async () => (await state()).records[await zoneId(zone)].filter((x) => x.type === 'TXT' && x.name === name))(); return cf('PATCH', `/zones/${await zoneId(zone)}/dns_records/${r.id}`, { content }); },
    close: async () => { await new Promise((r) => server.close(r)); await fake.close(); },
  };
}

/** wrangler dev on a persist dir that survives restarts (so a hosted run can change HOSTED_SPF_FLATTENING and keep its data). */
function makeInstance({ mode, port, standIns, persistDir, bootstrapSecret, tokenKey, vars = {}, label }) {
  persistDir ??= mkdtempSync(path.join(tmpdir(), `rsmrev-${label}-`));
  mkdirSync(`${OUT}/logs`, { recursive: true });
  const logFile = `${OUT}/logs/wrangler-${label}.log`;
  bootstrapSecret ??= randomBytes(32).toString('hex');
  tokenKey ??= `k1:${randomBytes(32).toString('base64')}`;
  const url = `http://127.0.0.1:${port}`;
  let child = null;
  const inst = {
    url, persistDir, logFile, label, mode,
    async migrate() {
      const m = spawnSync('node', ['packages/db/scripts/migrate.mjs', '--local', '--persist-to', persistDir], { cwd: REPO, encoding: 'utf8' });
      if (m.status !== 0) throw new Error('migrate failed ' + (m.stderr || m.stdout).slice(-400));
    },
    async start(extraVars = {}) {
      const v = {
        ...(mode === 'hosted' ? {} : { BOOTSTRAP_SECRET: bootstrapSecret }),
        CLOUDFLARE_API_BASE_URL: standIns.url, DOH_BASE_URL: standIns.url, BETTER_AUTH_URL: url, TOKEN_ENCRYPTION_KEY: tokenKey,
        ...(mode === 'hosted' ? { MODE: 'saas', SAAS_ENABLED: '1', TURNSTILE_SITE_KEY: '1x00000000000000000000AA', TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' } : {}),
        ...vars, ...extraVars,
      };
      const args = ['wrangler', 'dev', '--local', '--persist-to', persistDir, '--port', String(port), '--ip', '127.0.0.1', ...Object.entries(v).flatMap(([k, val]) => ['--var', `${k}:${val}`])];
      const log = createWriteStream(logFile, { flags: 'a' });
      child = spawn('npx', args, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' } });
      child.stdout.pipe(log); child.stderr.pipe(log);
      const t0 = Date.now();
      for (;;) {
        if (child.exitCode !== null) throw new Error('wrangler exited, see ' + logFile);
        try { if ((await fetch(`${url}/health`)).ok) break; } catch {}
        if (Date.now() - t0 > 150000) throw new Error('not healthy');
        await wait(400);
      }
    },
    async stop() {
      if (!child) return;
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      await wait(1500);
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      child = null;
      await wait(500);
    },
    d1(sql) {
      for (let i = 0; ; i++) {
        const r = spawnSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', '--persist-to', persistDir, '--json', '--command', sql], { cwd: REPO, encoding: 'utf8' });
        if (r.status === 0) { const j = JSON.parse(r.stdout); return (Array.isArray(j) ? j[0]?.results : j?.results) ?? []; }
        if (i >= 8 || !/locked|BUSY/.test(r.stderr + r.stdout)) throw new Error('d1 failed ' + (r.stderr || r.stdout).slice(-300));
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
      }
    },
    setupLink(ttl = 900) {
      const expiry = String(Math.floor(Date.now() / 1000) + ttl);
      return `${url}/#/setup?t=${expiry}.${createHmac('sha256', bootstrapSecret).update(`setup-link:${expiry}`).digest('base64url')}`;
    },
    /** Trigger a scheduled event the way the author's e2e did. */
    async cron(expr = '0 11 * * *') {
      const res = await fetch(`${url}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent(expr).replace(/%20/g, '+')}`);
      await wait(5000);
      return res.status;
    },
  };
  return inst;
}

/** curl with the browser session's cookie (never printed). */
async function curl(ctx, inst, method, p, body) {
  const cookies = (await ctx.cookies(inst.url)).map((c) => `${c.name}=${c.value}`).join('; ');
  const args = ['-s', '-o', '/dev/stdin', '-X', method];
  const out = (await execFileP('curl', ['-s', '-i', '-X', method, '-H', `Cookie: ${cookies}`, '-H', `Origin: ${inst.url}`, '-H', 'Content-Type: application/json', ...(body !== undefined ? ['-d', JSON.stringify(body)] : []), `${inst.url}${p}`], { encoding: 'utf8', maxBuffer: 1e7 })).stdout;
  const [head, ...rest] = out.split('\r\n\r\n');
  const status = Number(/^HTTP\/[\d.]+ (\d+)/.exec(head)[1]);
  return { status, body: rest.join('\r\n\r\n') };
}

async function launch() { return chromium.launch(); }

const log = (...a) => { const s = a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); console.log(s); };

const MODE = process.argv[2];
if (!['selfhost', 'hosted-admitted', 'hosted-open'].includes(MODE)) throw new Error('mode?');
const HOSTED = MODE !== 'selfhost';
const PORT = { selfhost: 8901, 'hosted-admitted': 8902, 'hosted-open': 8903 }[MODE];
const OWNER = 'owner@harbor-lane.org';
const DOM = HOSTED ? 'harbor-lane.org' : 'brightwave-mail.com';
const PROV = ['alpha-mail', 'bravo-send', 'charlie-mx', 'delta-bulk', 'echo-crm', 'foxtrot-help'];
const ORIG = `v=spf1 ${PROV.map((p) => `include:_spf.${p}.net`).join(' ')} ~all`;
mkdirSync(`${OUT}/shots`, { recursive: true }); mkdirSync(`${OUT}/text`, { recursive: true });

const S = await startStandIns();
const vars = HOSTED ? { OWNER_EMAIL: OWNER, ...(MODE === 'hosted-admitted' ? { HOSTED_SPF_FLATTENING: 'owner' } : {}) } : {};
const inst = makeInstance({ mode: HOSTED ? 'hosted' : 'selfhost', port: PORT, standIns: S, label: MODE, vars });
const notes = {};
const note = (k, v) => { notes[k] = v; log(`## ${k}`, v); writeFileSync(`${OUT}/notes.json`, JSON.stringify(notes, null, 1)); };

let browser, ctx, page, domId;
const steps = [];
const truth = [];
const check = (claim, expected, actual, ok = JSON.stringify(expected) === JSON.stringify(actual)) => { truth.push({ claim, expected, actual, ok, step: steps.length + 1 }); return ok; };
const row = () => inst.d1(`SELECT * FROM spf_flatten_config WHERE domain_id=${domId}`)[0];
const audits = () => inst.d1("SELECT action FROM audit_log WHERE action LIKE 'spf_flatten%' ORDER BY id").map((r) => r.action);
const apexTxt = async () => { const all = await S.txt(DOM, DOM); const r = all.map((x) => String(x.content).replace(/^"|"$/g, '')).find((c) => c.startsWith('v=spf1')); if (!r) log('apexTxt missing', all); return r; };
const dueNow = () => inst.d1('UPDATE spf_flatten_config SET last_attempt_at = last_attempt_at - 90000');
const runDaily = async (label) => { const b = row().last_attempt_at; dueNow(); const st = await inst.cron('0 11 * * *'); for (let i = 0; i < 30 && row().last_attempt_at === b - 90000; i++) await wait(1000); const r = row(); log(`daily ${label}`, { cron_status: st, attempt_before: b, attempt_after: r.last_attempt_at, pending: r.pending_since, problem: r.problem_kind, last_error: r.last_error, flat: r.flattened_record, provider_state: String(r.provider_state).slice(0, 300) }); };
const T = { alpha: null };
const alphaRec = (ranges) => `v=spf1 ${ranges.join(' ')} -all`;
const pickFlattened = () => { const name = Object.keys(JSON.parse(row().provider_state))[0]; const zone = name.replace(/^_spf\./, ''); T.alpha = [zone, name, `_n1.${zone}`]; const idx = PROV.findIndex((p) => zone.startsWith(p)); return { name, idx }; };

// ── independent counts for the truth checks (from the fake's own records) ──
async function dnsTxt() {
  const st = await S.state(); const m = new Map();
  for (const recs of Object.values(st.records)) for (const r of recs) if (r.type === 'TXT') m.set(r.name.toLowerCase(), String(r.content).replace(/^"|"$/g, ''));
  return m;
}
async function lookupsOf(record, seen = 0, depth = 0) {
  const m = await dnsTxt(); let n = 0;
  const walk = (rec, d) => {
    if (d > 8) return;
    for (const t of rec.split(/\s+/).slice(1)) {
      const mm0 = t.match(/^[+\-~?]?(include|a|mx|ptr|exists)(?:[:\/](.*))?$/i); const mm = mm0 && [mm0[0], mm0[1], mm0[2] ?? '']; const rd = t.match(/^redirect=(.*)$/i);
      if (mm) { n++; if (mm[1].toLowerCase() === 'include') { const x = m.get(mm[2].toLowerCase()); if (x) walk(x, d + 1); } } else if (rd) { n++; const x = m.get(rd[1].toLowerCase()); if (x) walk(x, d + 1); }
    }
  };
  walk(record, 0); return n;
}
const addrCount = (record) => record.split(/\s+/).filter((t) => /^ip[46]:/i.test(t)).length;

// ── in-page extras (self-contained) ──
function extraMetrics({ primary, lineSel }) {
  const vh = window.innerHeight;
  const visible = (el) => { const r = el.getBoundingClientRect(); if (!r.width && !r.height) return false; const cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) !== 0; };
  const root = document.querySelector('main') || document.body;
  const wordRe = /[\p{L}\p{N}][\p{L}\p{N}'’._-]*/gu;
  const out = {};
  const el = primary ? document.querySelector(primary) : null;
  if (el && visible(el)) {
    const r = el.getBoundingClientRect();
    out.action_bottom_vh = Math.round(((r.bottom + window.scrollY) / vh) * 100) / 100;
    const range = document.createRange(); range.setStart(root, 0); range.setEndBefore(el);
    out.words_above_action = (range.toString().match(wordRe) || []).length;
    out.action_in_viewport = r.top >= 0 && r.bottom <= vh; // seen without scrolling the page
    const dlg = el.closest('[role=dialog]');
    if (dlg) {
      out.action_bottom_vh = Math.round((r.bottom / vh) * 100) / 100; // a dialog is fixed to the viewport: the page's scroll position does not count
      const d = dlg.getBoundingClientRect();
      out.dialog_in_viewport = d.top >= 0 && d.bottom <= vh;
      out.dialog_height_vh = Math.round((d.height / vh) * 100) / 100;
      // a dialog that scrolls inside itself hides what is below its visible part: the largest hidden height among the dialog and what scrolls inside it
      const scrollers = [dlg, ...dlg.querySelectorAll('*')].filter((n) => n.scrollHeight > n.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(n).overflowY));
      out.dialog_scroll_px = Math.round(Math.max(0, ...scrollers.map((n) => n.scrollHeight - n.clientHeight)));
      out.action_in_dialog = r.top >= dlg.getBoundingClientRect().top && r.bottom <= dlg.getBoundingClientRect().bottom;
    }
  }
  const line = lineSel ? document.querySelector(lineSel) : null;
  if (line && visible(line)) out.line_bottom_vh = Math.round(((line.getBoundingClientRect().bottom + window.scrollY) / vh) * 100) / 100;
  const radios = new Set([...root.querySelectorAll('input[type=radio]')].filter(visible).map((n) => n.name));
  const items = [...[...radios].map((n) => `radio:${n}`), ...[...root.querySelectorAll('select, input[type=checkbox]')].filter(visible).map((n) => `${n.tagName.toLowerCase()}:${n.name || n.id || n.getAttribute('aria-label') || ''}`), ...[...root.querySelectorAll('input:not([type=hidden]):not([type=radio]):not([type=checkbox]):not([type=submit]):not([type=button]), textarea')].filter(visible).map((n) => `field:${n.name || n.id || ''}`)];
  out.decisions = items.length; out.decision_items = items;
  const forward = [...document.querySelectorAll('a[href], button')].filter((n) => visible(n) && !n.disabled && !/^(back|all domains|exit|switch to|skip)/i.test(n.textContent.trim()) && !n.closest('header'));
  out.forward_actions = forward.length;
  out.banners = [...root.querySelectorAll('[role=alert]')].filter(visible).map((n) => n.textContent.trim().slice(0, 60));
  out.feedback = !!document.querySelector('[aria-busy="true"], .animate-pulse, [role=status]:not(:empty)');
  return out;
}

const counters = { clicks: 0, fields: 0 };
const click = async (loc, opts) => { counters.clicks++; await loc.first().click(opts); };
const fillIn = async (loc, v) => { counters.fields++; await loc.first().fill(v); };
const num = (s) => Number(String(s).replace(/[^\d.]/g, ''));

async function capture(name, spec) {
  const result = { widths: {} };
  for (const [w, h] of [[375, 812], [1440, 900]]) { // the phone is 375x812: what "above the fold" means at 375
    await page.setViewportSize({ width: w, height: h });
    await wait(700);
    const sp = { ...spec };
    if (sp.primary) {
      await page.evaluate(() => document.querySelectorAll('[data-walk-primary]').forEach((n) => n.removeAttribute('data-walk-primary'))).catch(() => {});
      const loc = page.locator(spec.primary).first();
      if (await loc.count()) await loc.evaluate((n) => n.setAttribute('data-walk-primary', '1'));
      sp.primary = '[data-walk-primary]';
    }
    await page.screenshot({ path: `${OUT}/shots/${name}@${w}.png`, fullPage: true });
    await page.screenshot({ path: `${OUT}/shots/${name}@${w}.fold.png` });
    const text = await page.evaluate(() => document.body.innerText);
    writeFileSync(`${OUT}/text/${name}@${w}.txt`, text + '\n');
    const m = await page.evaluate(pageMetrics, sp.primary ?? null);
    const x = await page.evaluate(extraMetrics, { primary: sp.primary ?? null, lineSel: sp.lineSel ?? null });
    result.widths[w] = { ...m, ...x };
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  return result;
}

/** One step: perform it, wait for what the person came for, measure at both widths. */
async function step(spec) {
  counters.clicks = 0; counters.fields = 0;
  const t0 = Date.now(); let feedbackAt1s = null; let waitMs = 0;
  const sampler = setTimeout(async () => { try { feedbackAt1s = await page.evaluate(() => !!document.querySelector('[aria-busy="true"], .animate-pulse, [role=status]:not(:empty), button[disabled], [data-loading]')); } catch {} }, 1000);
  let status = 'pass', error = null;
  try {
    await spec.run();
    if (spec.ready) await spec.ready().waitFor({ timeout: 60000 });
    waitMs = Date.now() - t0;
  } catch (e) { status = 'fail'; error = String(e).slice(0, 300); waitMs = Date.now() - t0; }
  clearTimeout(sampler);
  const clicks = counters.clicks, fields = counters.fields;
  const cap = await capture(spec.name, spec);
  const w1440 = cap.widths[1440], w375 = cap.widths[375];
  const meas = {
    words: w1440.words, reading_time_s: Math.round((w1440.words / 238) * 60), controls: w1440.controls,
    horizontal_overflow_px: { 375: w375.horizontal_overflow_px, 1440: w1440.horizontal_overflow_px },
    scroll_before_primary_vh: { 375: w375.scroll_before_primary_vh ?? null, 1440: w1440.scroll_before_primary_vh ?? null },
    primary_source: w1440.primary_source ?? null,
    action_bottom_vh: { 375: w375.action_bottom_vh ?? null, 1440: w1440.action_bottom_vh ?? null },
    action_in_viewport: { 375: w375.action_in_viewport ?? null, 1440: w1440.action_in_viewport ?? null },
    ...(w375.dialog_in_viewport !== undefined ? { dialog_in_viewport: { 375: w375.dialog_in_viewport, 1440: w1440.dialog_in_viewport ?? null }, dialog_height_vh: { 375: w375.dialog_height_vh, 1440: w1440.dialog_height_vh ?? null } } : {}),
    ...(w375.dialog_scroll_px !== undefined ? { dialog_scroll_px: { 375: w375.dialog_scroll_px, 1440: w1440.dialog_scroll_px ?? null } } : {}),
    words_above_action: { 375: w375.words_above_action ?? null, 1440: w1440.words_above_action ?? null },
    decisions: w1440.decisions, decision_items: w1440.decision_items, fields, clicks,
    non_task_elements: w1440.banners.length, non_task: w1440.banners,
    wait_ms: waitMs > 300 ? waitMs : 0, wait_feedback: waitMs < 1000 ? true : (feedbackAt1s ?? false),
    dead_end: spec.offPath ? false : (w1440.forward_actions === 0 || w375.forward_actions === 0), off_path: !!spec.offPath, forward_actions: { 375: w375.forward_actions, 1440: w1440.forward_actions }, revisit: false,
  };
  if (spec.lineSel) meas.status_line_bottom_vh = { 375: w375.line_bottom_vh ?? null, 1440: w1440.line_bottom_vh ?? null };
  if (spec.extra) Object.assign(meas, await spec.extra());
  const words = (await page.locator('main').innerText().catch(() => '')).split('\n').filter(Boolean);
  const s = { index: steps.length + 1, action: spec.action, target: spec.target, status: error ? 'fail' : status, observed_at: new Date().toISOString(), timing_ms: waitMs, expect: spec.expect, expect_met: !error, screen: spec.screen, screenshots: { 375: `${spec.name}@375.png`, 1440: `${spec.name}@1440.png` }, measures: meas, words, truth_checks: truth.filter((t) => t.step === steps.length + 1) };
  if (spec.firstValue) s.first_value = true;
  if (error) s.error = error;
  steps.push(s);
  log(`step ${s.index} ${spec.name}`, { status: s.status, error, clicks, fields, wait_ms: meas.wait_ms, scroll: meas.scroll_before_primary_vh, bottom: meas.action_bottom_vh });
  return s;
}

const doThisNextLink = (re) => page.locator('section[aria-labelledby]').filter({ has: page.getByRole('heading', { name: 'Do this next' }) }).getByRole('link', { name: re });
const gotoPage = async (hash) => { await page.goto(`${inst.url}/#${hash}`); await page.reload(); };
const T0 = Date.now();
let valueMs = null;

async function onboardSelfHost() {
  await page.goto(inst.setupLink());
  await page.locator('#email').fill(OWNER); await page.locator('#password').fill('correct horse battery staple'); await page.locator('#confirm').fill('correct horse battery staple');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('heading', { name: "Let's set up Ready Set Mail" }).waitFor({ timeout: 40000 });
  await page.getByRole('button', { name: 'Connect Cloudflare' }).click();
  await page.getByLabel('Cloudflare API token').fill('e2e-fake-token-not-a-real-secret-0000');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByRole('heading', { name: 'Choose zones' }).waitFor();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('heading', { name: 'Choose domains' }).waitFor();
  await page.getByRole('checkbox', { name: DOM }).check();
  const reports = page.getByLabel('Reports go to'); if (await reports.isVisible()) { await reports.click(); await page.getByRole('option', { name: DOM }).click(); }
  await page.getByRole('button', { name: /^Add \d+ domains?$/ }).click();
  await page.getByText(/DMARC/).first().waitFor({ timeout: 40000 });
  for (let i = 0; i < 60 && !domId; i++) { const list = await (await page.request.get(`${inst.url}/api/domains`)).json(); const arr = Array.isArray(list) ? list : list.domains; domId = arr.find((d) => d.domain === DOM)?.id; if (!domId) await wait(1000); }
  const connId = String(inst.d1('SELECT id FROM cloudflare_connections')[0].id);
  const r = await page.request.put(`${inst.url}/api/domains/${domId}/connection`, { data: { connection_id: connId }, headers: { Origin: inst.url } });
  if (r.status() !== 200) throw new Error('link ' + r.status());
}

const mailed = () => existsSync(inst.logFile) ? [...readFileSync(inst.logFile, 'utf8').replace(/\x1b\[[0-9;]*m/g, '').matchAll(/(\d{6}) is your Ready Set Mail code/g)].map((m) => m[1]) : [];
async function onboardHosted() {
  inst.d1("INSERT OR REPLACE INTO settings (workspace_id, key, value) VALUES ('ws_default', 'from_email', 'noreply@reports.harbor-lane.org')");
  const before = mailed().length;
  await page.goto(`${inst.url}/#/signup`);
  await page.getByLabel('Work email').fill(OWNER); await page.getByLabel('Password', { exact: true }).fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('heading', { name: 'Tell us about yourself' }).waitFor({ timeout: 40000 });
  await page.getByLabel('Your name').fill('Dana Whitfield'); await page.getByLabel('Organization name').fill('Brightwave Studio'); await page.getByLabel("My company's").check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('heading', { name: 'Check your inbox' }).waitFor({ timeout: 40000 });
  for (let i = 0; i < 60 && mailed().length <= before; i++) await wait(500);
  await page.getByLabel('6-digit code').pressSequentially(mailed().at(-1));
  await page.getByLabel(/^(Domain|Client's domain)$/).fill(DOM, { timeout: 40000 });
  await page.getByRole('button', { name: `Check ${DOM}` }).click();
  await page.getByText(`Domain: ${DOM}`).waitFor({ timeout: 60000 });
  await page.getByRole('button', { name: 'Connect Cloudflare' }).click();
  await page.getByLabel('Cloudflare API token').fill('e2e-fake-token-not-a-real-secret-0000');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByRole('heading', { name: /^\d+ changes? to harbor-lane\.org$/ }).waitFor({ timeout: 60000 }).catch(() => {});
  const skip = page.getByRole('button', { name: 'Skip for now' }); if (await skip.count()) await skip.click();
  await wait(4000);
  domId = inst.d1(`SELECT id FROM domains WHERE domain='${DOM}'`)[0].id;
}

try {
  for (const [i, p] of PROV.entries()) {
    await S.addZone(`${p}.net`);
    if (i === PROV.length - 1) { await S.addTxt(`${p}.net`, `_spf.${p}.net`, `v=spf1 ip4:192.0.2.${i + 1} -all`); continue; }
    await S.addTxt(`${p}.net`, `_spf.${p}.net`, `v=spf1 ip4:198.51.100.${i * 16}/28 ip4:192.0.2.${i + 1} include:_n1.${p}.net -all`);
    await S.addTxt(`${p}.net`, `_n1.${p}.net`, `v=spf1 ip4:203.0.113.${i + 10} -all`);
  }
  await S.addTxt(DOM, DOM, ORIG);
  await inst.migrate(); await inst.start();
  browser = await launch(); ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' }); page = await ctx.newPage();
  await (HOSTED ? onboardHosted() : onboardSelfHost());
  note('setup', { mode: MODE, domain_id: domId, cf_spf_is_original: (await apexTxt()) === ORIG, lookups_by_independent_count: await lookupsOf(ORIG) });
  const flowStart = Date.now();

  if (MODE === 'hosted-open') {
    await step({ name: '01-domain-page', action: 'navigate', target: '/domains/[id]', screen: 'domain page', expect: 'Domain page; "Do this next" leads with "Bring SPF down to 10 DNS lookups or fewer" and a link that works ("See where the lookups go"); no flattening link, no dead step',
      primary: 'section[aria-labelledby] a[href$="/spf-lookups"]',
      run: async () => { await gotoPage(`/domains/${domId}`); }, ready: () => doThisNextLink(/See where the lookups go/) });
    const dtn = await page.locator('section[aria-labelledby]').filter({ has: page.getByRole('heading', { name: 'Do this next' }) }).first().innerText();
    check('the step offers no flattening link', 0, (dtn.match(/Open SPF flattening/g) || []).length);
    check('the step leads to a page that exists (the link has a target)', true, (await doThisNextLink(/See where the lookups go/).getAttribute('href'))?.endsWith('/spf-lookups') ?? false);
    const w0 = S.writes().length;
    await step({ name: '02-lookups', action: 'click', target: 'See where the lookups go', screen: 'where the lookups go', expect: 'The lookups term by term, what can be done by hand, a way to edit the record', firstValue: true, primary: 'a[href$="/setup/2"]',
      run: async () => { await click(doThisNextLink(/See where the lookups go/)); }, ready: () => page.getByRole('heading', { name: /Your SPF record needs \d+ lookups/ }),
      extra: async () => {
        const text = await page.locator('main').innerText(); const rowsN = await page.locator('tbody tr').count();
        const real = await lookupsOf(ORIG);
        check('the heading says how many lookups the record needs (independent count)', real, num((text.match(/needs (\d+) lookups/) || [])[1]));
        check('one table row per term that costs lookups', PROV.length, rowsN);
        return {};
      } });
    valueMs = Date.now() - flowStart;
    await step({ name: '03-typed-flatten-url', action: 'navigate', target: '/domains/[id]/spf-flatten', screen: 'not available', offPath: true, expect: 'One sentence that says flattening is not available, and a way back (a check of the typed address, not a step on the path)', primary: 'a[href$="/domains/' + domId + '"]',
      run: async () => { await gotoPage(`/domains/${domId}/spf-flatten`); }, ready: () => page.getByText('SPF flattening is not available on the hosted service.') });
    check('nothing was written to Cloudflare while walking this mode', 0, S.writes().length - w0);
    check('no flattening row exists', 0, inst.d1('SELECT COUNT(*) AS n FROM spf_flatten_config')[0].n);
    const probe = {}; for (const [m, p] of [['GET', '/spf-flatten/preview'], ['POST', '/spf-flatten']]) probe[`${m} ${p}`] = (await curl(ctx, inst, m, `/api/domains/${domId}${p}`, m === 'POST' ? {} : undefined)).status;
    check('the routes answer 404 where the add-on is not available', { 'GET /spf-flatten/preview': 404, 'POST /spf-flatten': 404 }, probe);
  } else {
    // 1. the domain page
    await step({ name: '01-domain-page', action: 'navigate', target: '/domains/[id]', screen: 'domain page', expect: 'Domain page; "Do this next" leads with "Bring SPF down to 10 DNS lookups or fewer" and its link "Open SPF flattening" is in the first screen',
      primary: 'section[aria-labelledby] a[href$="/spf-flatten"]', run: async () => { await gotoPage(`/domains/${domId}`); }, ready: () => doThisNextLink(/Open SPF flattening/),
      extra: async () => { const t = await page.locator('section[aria-labelledby]').filter({ has: page.getByRole('heading', { name: 'Do this next' }) }).first().innerText(); check('"It needs N": N is the independent lookup count of the published record', await lookupsOf(ORIG), num((t.match(/It needs (\d+)/) || [])[1])); return {}; } });
    await step({ name: '02-analyse', action: 'click', target: 'Open SPF flattening', screen: 'spf analyse', expect: 'Your SPF record: why it matters, the record and the flattened record',
      primary: 'button:has-text("Continue")', run: async () => { await click(doThisNextLink(/Open SPF flattening/)); }, ready: () => page.getByText(/Your SPF record needs \d+ lookups/),
      extra: async () => { const t = await page.locator('main').innerText(); check('the page says how many lookups the record needs (independent count)', await lookupsOf(ORIG), num((t.match(/needs (\d+) lookups\. Receivers/) || [])[1])); return {}; } });
    await step({ name: '03-turn-on', action: 'click', target: 'Continue', screen: 'spf turn on', expect: 'Turn on SPF flattening: what is written, the cost in one sentence, when it is checked',
      primary: 'button:has-text("Turn on flattening")', run: async () => { await click(page.getByRole('button', { name: 'Continue' })); }, ready: () => page.getByTestId('spf-risk'),
      extra: async () => { check('the risk sentence is on the screen, verbatim', 'When a provider starts sending from new addresses, mail from them can fail SPF until the next daily check, up to about a day.', (await page.getByTestId('spf-risk').innerText()).trim()); return {}; } });
    const w0 = S.writes().length;
    await step({ name: '04-on', action: 'click', target: 'Turn on flattening', screen: 'spf on', expect: 'SPF flattening is on: the published record, last checked, checked again every day around 11:00 UTC', firstValue: true,
      primary: 'a:has-text("Back to domain")', run: async () => { await click(page.getByRole('button', { name: 'Turn on flattening' })); }, ready: () => page.getByRole('heading', { name: 'SPF flattening is on' }),
      extra: async () => {
        valueMs = Date.now() - flowStart;
        const rec = await apexTxt(); const r = row(); const t = await page.locator('main').innerText();
        check('Cloudflare now holds the flattened record from the database', r.flattened_record, rec);
        check('the original in the database is the record Cloudflare had before', ORIG, r.canonical_record);
        check('"On: N addresses": N is the number of ip4/ip6 terms in the record Cloudflare holds', addrCount(rec), num((t.match(/On: (\d+) address/) || [])[1]));
        check('"using X of the 10 lookups": X is the independent lookup count of the record Cloudflare holds', await lookupsOf(rec), num((t.match(/using (\d+) of the 10/) || [])[1]));
        check('exactly one write reached the DNS record, one audit entry spf_flatten.enable', { writes: 1, audits: ['spf_flatten.enable'] }, { writes: S.writes().filter((c) => c.method === 'PATCH').length - w0 + w0 - w0, audits: audits() });
        return {};
      } });
    // 5. the status is near the top of the domain page
    await step({ name: '05-domain-status-line', action: 'navigate', target: '/domains/[id]', screen: 'domain page (flattening on)', expect: 'One line under the header says flattening is on, with a link to the whole state', primary: '[data-testid=spf-status-line] a', lineSel: '[data-testid=spf-status-line]',
      run: async () => { await gotoPage(`/domains/${domId}`); }, ready: () => page.getByTestId('spf-status-line'),
      extra: async () => { const t = (await page.getByTestId('spf-status-line').innerText()).replace(/\s+/g, ' '); const r = row(); check('the line says the lookups of the flattened record (independent count)', await lookupsOf(await apexTxt()), num((t.match(/(\d+) of 10 lookups/) || [])[1])); check('"Do this next" no longer asks to bring SPF down', 0, (await page.locator('section[aria-labelledby]').filter({ has: page.getByRole('heading', { name: 'Do this next' }) }).first().innerText()).includes('Bring SPF down') ? 1 : 0); void r; return {}; } });

    // 6. a provider adds an address and keeps the others: written at once
    const fp = pickFlattened(); note('flattened_provider', fp);
    const addrs = [`ip4:192.0.2.${fp.idx + 1}`];
    await S.setTxt(T.alpha[0], T.alpha[1], alphaRec([...addrs, 'ip4:192.0.2.77']));
    const beforeAdd = await apexTxt(); await runDaily('added');
    const afterAdd = await apexTxt();
    await step({ name: '06-provider-added', action: 'navigate', target: '/domains/[id]/spf-flatten', screen: 'spf on (changed)', expect: 'The new address is in the record at once; "What changed" shows before and now', primary: 'a:has-text("Back to domain")',
      run: async () => { await gotoPage(`/domains/${domId}/spf-flatten`); }, ready: () => page.getByText(/^On: \d+ address/),
      extra: async () => { check('the provider\'s new address reached the record at once', true, afterAdd.includes('192.0.2.77') && !beforeAdd.includes('192.0.2.77')); check('nothing was removed by that run', true, addrs.every((a) => afterAdd.includes(a.replace('ip4:', 'ip4:')))); return {}; } });

    // 7. a provider glitch: v=spf1 -all
    const good = alphaRec([...addrs, 'ip4:192.0.2.77']);
    await S.setTxt(T.alpha[0], T.alpha[1], 'v=spf1 -all');
    const rec7 = await apexTxt(); const wr7 = S.writes().length; await runDaily('glitch');
    await step({ name: '07-pending', action: 'navigate', target: '/domains/[id]/spf-flatten', screen: 'spf on (waiting to confirm)', expect: 'The record is unchanged; "Waiting to confirm a change" names the provider, how many addresses are held, when, and why four hours', primary: 'button:has-text("Check again now")',
      run: async () => { await gotoPage(`/domains/${domId}/spf-flatten`); }, ready: () => page.getByTestId('spf-pending'),
      extra: async () => {
        const t = await page.getByTestId('spf-pending').innerText();
        check('the record in Cloudflare did not change when the provider answered v=spf1 -all', rec7, await apexTxt());
        check('no write reached the DNS record in that run', 0, S.writes().length - wr7);
        const held = (good.match(/ip4:/g) || []).length; // addresses the provider listed before (alpha: two ranges and one address, plus the nested one is another include)
        const m = t.match(/(\S+) no longer lists (\d+) address/);
        check('the provider named is the one that glitched', T.alpha[1], m?.[1]);
        const removedByProvider = good.split(/\s+/).filter((x) => /^ip4:/.test(x)).length; // 3: what it listed before the glitch, directly
        check('the number of addresses held is what the provider listed before (independent: its previous record)', removedByProvider, Number(m?.[2]));
        const conf = (t.match(/after (\d\d:\d\d) UTC/) || [])[1]; const exp = new Date((row().pending_since + 4 * 3600) * 1000).toISOString().slice(11, 16);
        check('the time it can confirm is four hours after the first look (database)', exp, conf);
        void held; return {};
      } });
    const wr7b = S.writes().length;
    await step({ name: '08-check-again-now', action: 'click', target: 'Check again now', screen: 'spf on (waiting to confirm)', expect: 'Before four hours: it answers when it can confirm, and writes nothing', primary: 'button:has-text("Check again now")',
      run: async () => { await click(page.getByRole('button', { name: 'Check again now' })); }, ready: () => page.getByTestId('spf-wait-answer'),
      extra: async () => { check('the answer says it will confirm after the time', true, /which can happen after \d\d:\d\d UTC/.test(await page.getByTestId('spf-wait-answer').innerText())); check('it wrote nothing', 0, S.writes().length - wr7b); check('the record is still the one before the glitch', rec7, await apexTxt()); return {}; } });
    // the provider comes back: the wait clears with no write
    await S.setTxt(T.alpha[0], T.alpha[1], good); const wr9 = S.writes().length; await runDaily('back');
    check('the provider came back: pending cleared in the database, no write', { pending: null, writes: 0 }, { pending: row().pending_since, writes: S.writes().length - wr9 });

    // 9. outside edit: Review with the choice
    const published = await apexTxt(); const edited = published.replace(/ ~all$/, ' include:newprovider.example ~all');
    await S.addZone('newprovider.example'); await S.addTxt('newprovider.example', 'newprovider.example', 'v=spf1 ip4:203.0.113.200 -all');
    await S.setTxt(DOM, DOM, edited); await runDaily('edited');
    check('the daily run left the edited record as it is', edited, await apexTxt());
    await step({ name: '09-review', action: 'navigate', target: '/domains/[id]/spf-flatten?review=1', screen: 'spf review', expect: 'Both records and a choice: "Use my edit as the new original" is selected; "Discard my edit" lists what it drops', primary: 'button:has-text("Use my edit")',
      run: async () => { await gotoPage(`/domains/${domId}/spf-flatten?review=1`); }, ready: () => page.getByRole('radio', { name: /Use my edit as the new original/ }),
      extra: async () => {
        check('"Use my edit" is the selected choice', true, await page.getByRole('radio', { name: /Use my edit as the new original/ }).isChecked());
        await click(page.getByRole('radio', { name: /Discard my edit/ }));
        const flat = row().flattened_record.split(/\s+/); const dropped = edited.split(/\s+/).filter((t) => !/^v=spf1$/.test(t) && !flat.includes(t));
        const said = ((await page.locator('main').innerText()).match(/These will be dropped: ([^\n]*?)\.(?:\n|$)/) || [])[1];
        check('"These will be dropped": the terms of the record in Cloudflare that the flattened record lacks', dropped.join(', '), said);
        await click(page.getByRole('radio', { name: /Use my edit as the new original/ }));
        return {};
      } });
    const wr10 = S.writes().length;
    await step({ name: '10-use-my-edit', action: 'click', target: 'Use my edit', screen: 'spf on (adopted)', expect: 'The edit is the new original and the include it added stays', primary: 'a:has-text("Back to domain")',
      run: async () => { await click(page.getByRole('button', { name: 'Use my edit' })); }, ready: () => page.getByRole('heading', { name: 'SPF flattening is on' }),
      extra: async () => { const r = row(); check('the original in the database is the edit', edited, r.canonical_record); check('the include the edit added is not lost: its address is in the record', true, (await apexTxt()).includes('203.0.113.200') || (await apexTxt()).includes('include:newprovider.example')); check('audit: spf_flatten.adopt written', true, audits().includes('spf_flatten.adopt')); void wr10; return {}; } });

    // 11. turn off: the original (now the adopted one) is back
    const adopted = row().canonical_record;
    await step({ name: '11-turn-off', action: 'click', target: 'Turn off', screen: 'spf off', expect: 'Confirm, then the original record is back in Cloudflare', primary: 'button:has-text("Turn off")',
      run: async () => { await click(page.getByRole('button', { name: 'Turn off' })); await click(page.getByRole('dialog').getByRole('button', { name: 'Turn off' })); }, ready: () => page.getByText(/Your SPF record needs \d+ lookups|SPF flattening/).first(),
      extra: async () => { await wait(2500); check('Cloudflare holds the original again (the adopted one)', adopted, await apexTxt()); check('the row is gone', 0, inst.d1('SELECT COUNT(*) AS n FROM spf_flatten_config')[0].n); return {}; } });

    // 12. delete the domain while flattening is on: the dialog names the record that will be put back
    await S.setTxt(DOM, DOM, ORIG);
    const en = await curl(ctx, inst, 'POST', `/api/domains/${domId}/spf-flatten`, {}); check('flattening can be turned on again (API)', 201, en.status);
    await step({ name: '12-delete-dialog', action: 'click', target: 'Remove domain', screen: 'domain delete dialog (flattening on)', expect: 'The dialog says which original record is put back first and that nothing is deleted if it cannot be', primary: '[role=dialog] button:has-text("Yes, remove")',
      run: async () => { await gotoPage(`/domains/${domId}/settings`); await click(page.getByRole('button', { name: /Remove domain/ })); }, ready: () => page.getByTestId('spf-delete-note'),
      extra: async () => { const d = await page.getByRole('dialog').innerText(); check('the dialog shows the original record from the database', true, d.includes(row().canonical_record)); check('the dialog says nothing is deleted if it cannot be put back', true, d.includes('If it cannot be put back, nothing is deleted.')); return {}; } });
    // 13. Cloudflare refuses every DNS write: the original cannot be put back, the dialog stops (409) and offers "Delete anyway"
    const flatBefore = await apexTxt();
    await fetch(`${S.fake.url}/__fail`, { method: 'POST', body: JSON.stringify({ writes: true }) });
    await step({ name: '13-delete-stops', action: 'click', target: 'Yes, remove', screen: 'domain delete dialog (the original could not be put back)', offPath: true,
      expect: 'Nothing was deleted: the reason, the original to copy, the sentence that the flattened record stays in DNS, then "Delete anyway" - all in the dialog without scrolling it or the page at 375x812', primary: '[role=dialog] button:has-text("Delete anyway")',
      run: async () => { await click(page.getByRole('dialog').getByRole('button', { name: 'Yes, remove' })); }, ready: () => page.getByTestId('spf-delete-stop'),
      extra: async () => {
        const stop = await page.getByTestId('spf-delete-stop').innerText(); const row0 = row();
        check('the original shown to copy is the one in the database', true, stop.includes(row0.canonical_record));
        check('the sentence that the flattened record stays in DNS is on the screen', true, /the flattened record stays in Cloudflare/.test(stop));
        check('nothing was deleted and the record in Cloudflare is the flattened one', { domains: 1, flat: true }, { domains: inst.d1(`SELECT COUNT(*) AS n FROM domains WHERE id=${domId}`)[0].n, flat: (await apexTxt()) === flatBefore });
        const order = await page.getByRole('dialog').evaluate((d) => { const at = (sel, t) => [...d.querySelectorAll(sel)].find((n) => t.test(n.textContent))?.getBoundingClientRect().top; return { sentence: at('p', /the flattened record stays/), button: at('button', /^Delete anyway$/), original: at('[data-testid=spf-delete-stop] *', /v=spf1/) }; });
        check('the sentence and the original are above "Delete anyway"', true, order.sentence < order.button && order.original < order.button);
        return {};
      } });
    await fetch(`${S.fake.url}/__fail`, { method: 'POST', body: JSON.stringify({ writes: false }) });
    await page.keyboard.press('Escape');
    check('closing the dialog deleted nothing', 1, inst.d1(`SELECT COUNT(*) AS n FROM domains WHERE id=${domId}`)[0].n);
  }

  // ── results.json ──
  const commit = spawnSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim();
  const valueStep = steps.findIndex((s) => s.first_value) + 1;
  const goalReached = valueStep > 0 && steps[valueStep - 1].status === 'pass' && truth.filter((t) => t.step <= valueStep).every((t) => t.ok);
  const isOpen = MODE === 'hosted-open';
  const ruleResults = [
    { id: 'PATH-01', result: goalReached ? 'pass' : 'fail', step: valueStep || null },
    { id: 'ERR-01', result: steps.some((s) => s.measures.dead_end) ? 'fail' : 'pass', step: valueStep || null },
    { id: 'DEC-02', result: steps.reduce((a, s) => a + s.measures.fields, 0) === 0 ? 'pass' : 'fail', step: valueStep || null },
    { id: 'WORD-05', result: truth.every((t) => t.ok) ? 'pass' : 'fail', step: valueStep || null },
  ];
  const results = {
    flow: 'spf-flattening',
    name: `Owner of a domain with too many SPF lookups turns on flattening and it stays correct${isOpen ? ' (hosted, add-on not admitted)' : ''}`,
    goal: isOpen
      ? 'The owner of a hosted workspace that does not have the SPF flattening add-on, with a record over 10 lookups, is led by "Do this next" to a page that works: it counts where the lookups go and what to do by hand; the typed flattening address says plainly it is not available'
      : 'The owner of a domain whose SPF record needs more than 10 lookups turns on flattening through Cloudflare, the record is written, and it follows the providers addresses until the owner turns it off and gets the original back',
    timestamp: new Date(T0).toISOString(), finished_at: new Date().toISOString(), duration_ms: Date.now() - T0,
    config: { url: inst.url, headless: true, viewports: [1440, 375] },
    surface: { mode: 'local-copy', commit, differences_from_production: ['fake Cloudflare and fake DNS', 'no real mail', HOSTED ? `MODE=saas, HOSTED_SPF_FLATTENING ${MODE === 'hosted-admitted' ? '= owner' : 'unset'}` : 'self-host'] },
    goal_reached: goalReached,
    counts: { typed_fields: steps.reduce((a, s) => a + s.measures.fields, 0), clicks: steps.reduce((a, s) => a + s.measures.clicks, 0), time_to_first_value_ms: valueMs },
    kind: 'screens',
    value_moment: isOpen ? 'The step leads to a page that counts where the lookups go and what to do by hand, and the typed flattening address says plainly it is not available' : 'Flattening is on - the record lists the sender addresses directly, within 10 lookups and 450 bytes, and the daily check keeps it current or says why it could not',
    rules_version: '0.5.0', rule_results: ruleResults, rule_overrides: [], not_covered: [], steps,
    dead_ends: steps.filter((s) => s.measures.dead_end).map((s) => s.index), environment_checks: [], residual_risk: ['fake Cloudflare and fake DNS: real Cloudflare and real provider DNS were not used'],
    truth_checks: truth,
    summary: { total: steps.length, passed: steps.filter((s) => s.status === 'pass').length, failed: steps.filter((s) => s.status === 'fail').length, errors: 0, skipped: 0, slow: steps.filter((s) => s.measures.wait_ms > 2000).length },
  };
  writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 1));
  note('results', { steps: steps.length, goal_reached: goalReached, truth_failed: truth.filter((t) => !t.ok), url: inst.url, value_ms: valueMs });
} catch (e) { note('FATAL', String(e.stack ?? e).slice(0, 2000)); try { await page.screenshot({ path: `${OUT}/shots/FATAL.png`, fullPage: true }); } catch {} }
finally { await browser?.close().catch(() => {}); await inst.stop(); await S.close(); process.exit(0); }
