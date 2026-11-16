// Extra checks: existing (main-created) owner after upgrade; enumeration redo; return at C2; hand-off resend loss.
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, createWriteStream } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { startInstance } from './e2e/support/dev-instance.mjs';

const OUT = `${process.env.HOME}/walk-out/x-extra`; mkdirSync(OUT, { recursive: true });
const R = {}; const save = () => writeFileSync(path.join(OUT, 'extra.json'), JSON.stringify(R, null, 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const codesIn = (f) => (existsSync(f) ? [...strip(readFileSync(f, 'utf8')).matchAll(/(\d{6}) is your Ready Set Mail code/g)].map((m) => m[1]) : []);
const PW = 'correct-horse-battery';
const TS = 'XXXX.DUMMY.TOKEN.XXXX';
const KEY = `k1:${randomBytes(32).toString('base64')}`;
const dohNs = { 'brightwave-mail.com': ['ns1.ns.cloudflare.com'], 'harbor-lane.org': ['ns1.domaincontrol.com'] };
const browser = await chromium.launch();
const shot = async (p, n) => { for (const [w, h] of [[375, 812], [1440, 900]]) { await p.setViewportSize({ width: w, height: h }); await sleep(400); await p.screenshot({ path: path.join(OUT, `${n}@${w}.png`) }); } };
const text = (p) => p.evaluate(() => (document.querySelector('main') || document.body).innerText.slice(0, 1500));

async function apiIn(page, pth, body, method = 'POST') {
  return page.evaluate(async ([pth, body, method]) => { const r = await fetch(pth, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { s: r.status, b: (await r.text()).slice(0, 400) }; }, [pth, body, method]);
}

// 1. legacy owner created on main a6e1f7b, then the PR build on the same database
try {
  const main = await startInstance({ mode: 'hosted', port: 8901, cwd: '/tmp/rsm-main', dohNs, vars: { TOKEN_ENCRYPTION_KEY: KEY, INTAKE_DOMAIN: 'rua.intake.example.net', HOSTED_CONNECT_REPORTS: 'all' } });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const p = await ctx.newPage();
  await p.goto(main.url + '/');
  R.main_signup = await apiIn(p, '/api/auth/signup', { email: 'max@brightwave-mail.com', password: PW, cf_turnstile_token: TS });
  await sleep(1500);
  R.main_code = await apiIn(p, '/api/auth/code', { code: codesIn(main.logFile).at(-1) });
  // a proven domain via the record path
  const add = await apiIn(p, '/api/domains', { domain: 'harbor-lane.org' }); R.main_add = add;
  const claim = JSON.parse(add.b).claim;
  const prev = await apiIn(p, `/api/domains/claims/${claim?.id}`, null, 'GET'); R.main_claim = prev;
  const tok = (JSON.stringify(JSON.parse(add.b)).match(/readysetmail-verify=[A-Za-z0-9_-]+/) || prev.b.match(/readysetmail-verify=[A-Za-z0-9_-]+/) || [])[0];
  const zones = (await (await fetch(`${main.fake.url}/client/v4/zones?name=harbor-lane.org`, { headers: { authorization: 'Bearer w' } })).json()).result;
  await fetch(`${main.fake.url}/client/v4/zones/${zones[0].id}/dns_records`, { method: 'POST', headers: { authorization: 'Bearer w', 'content-type': 'application/json' }, body: JSON.stringify({ type: 'TXT', name: '_readysetmail.harbor-lane.org', content: tok, ttl: 1 }) });
  R.main_verify = await apiIn(p, `/api/domains/claims/${claim?.id}/verify`, {});
  await p.goto(main.url + '/'); await sleep(3000); await shot(p, 'L0-main-dashboard'); R.main_dash = await text(p);
  R.main_ws = main.d1('SELECT name FROM workspaces');
  await ctx.close();
  const state = '/tmp/legacy-state'; cpSync(main.persistDir, state, { recursive: true });
  const fakeUrl = main.fake.url; // fake goes away on stop; start a new instance-like worker on the PR code with the same state
  await main.stop();
  const { startFakeCloudflare } = await import('./e2e/support/fake-cloudflare.mjs');
  const fake = await startFakeCloudflare({ port: 0 });
  for (const [name, ns] of Object.entries(dohNs)) await fetch(`${fake.url}/__ns`, { method: 'POST', body: JSON.stringify({ name, ns }) });
  const url = 'http://127.0.0.1:8902';
  const v = { CLOUDFLARE_API_BASE_URL: fake.url, DOH_BASE_URL: fake.url, BETTER_AUTH_URL: url, TOKEN_ENCRYPTION_KEY: KEY, MODE: 'saas', SAAS_ENABLED: '1', TURNSTILE_SITE_KEY: '1x00000000000000000000AA', TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA', INTAKE_DOMAIN: 'rua.intake.example.net', HOSTED_CONNECT_REPORTS: 'all' };
  const logFile = '/tmp/legacy-pr.log';
  const child = spawn('npx', ['wrangler', 'dev', '--local', '--persist-to', state, '--port', '8902', '--ip', '127.0.0.1', ...Object.entries(v).flatMap(([k, val]) => ['--var', `${k}:${val}`])], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, NO_COLOR: '1' } });
  const lf = createWriteStream(logFile); child.stdout.pipe(lf); child.stderr.pipe(lf);
  for (let i = 0; i < 120; i++) { try { if ((await fetch(url + '/health')).ok) break; } catch {} await sleep(1000); }
  const c2 = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const q = await c2.newPage();
  await q.goto(url + '/#/signin'); await sleep(2500);
  await q.getByLabel(/email/i).first().fill('max@brightwave-mail.com'); await q.getByLabel('Password', { exact: true }).fill(PW);
  const before = codesIn(logFile).length;
  await q.getByRole('button', { name: /Sign in|Continue/ }).first().click();
  for (let i = 0; i < 60 && codesIn(logFile).length <= before; i++) await sleep(500);
  await q.getByLabel(/code/i).first().pressSequentially(codesIn(logFile).at(-1));
  await sleep(6000);
  await shot(q, 'L1-pr-after-signin'); R.pr_landing_url = q.url(); R.pr_landing = await text(q);
  await q.reload(); await sleep(4000); await shot(q, 'L2-pr-reload'); R.pr_reload = await text(q);
  R.pr_me = await apiIn(q, '/api/me', null, 'GET');
  await c2.close();
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  await fake.close();
} catch (e) { R.legacy_error = String(e.stack || e); }
save();

// 2. enumeration redo + hand-off resend + return at C2, on a PR instance
try {
  const inst = await startInstance({ mode: 'hosted', port: 8903, dohNs, vars: { INTAKE_DOMAIN: 'rua.intake.example.net', HOSTED_CONNECT_REPORTS: 'all' } });
  const u = inst.url;
  const post = async (pth, body, { cookie = '', ip = '' } = {}) => { const r = await fetch(u + pth, { method: 'POST', headers: { 'content-type': 'application/json', origin: u, ...(cookie ? { cookie } : {}), ...(ip ? { 'CF-Connecting-IP': ip } : {}) }, body: JSON.stringify(body) }); return { s: r.status, b: (await r.text()).slice(0, 300), c: (r.headers.getSetCookie?.() || []).map((x) => x.split(';')[0]).join('; ') }; };
  const get = async (pth, cookie, ip) => { const r = await fetch(u + pth, { headers: { cookie, 'CF-Connecting-IP': ip } }); return { s: r.status, b: (await r.text()).slice(0, 300) }; };
  // verified account
  let s = await post('/api/auth/signup', { email: 'known@brightwave-mail.com', password: PW, cf_turnstile_token: TS }, { ip: '10.7.0.1' }); await sleep(1500);
  await post('/api/auth/code', { code: codesIn(inst.logFile).at(-1) }, { cookie: s.c, ip: '10.7.0.1' });
  const E = {};
  for (const [k, email, ip] of [['known', 'known@brightwave-mail.com', '10.7.1.1'], ['fresh', 'fresh@brightwave-mail.com', '10.7.1.2']]) {
    const a = await post('/api/auth/signup', { email, password: PW, cf_turnstile_token: TS }, { ip });
    E[k] = { signup: [a.s, a.b], pending1: await get('/api/auth/signup/pending', a.c, ip) };
    E[k].profile = await post('/api/auth/signup/profile', { name: 'X', organization: 'Y', whose_email: 'company' }, { cookie: a.c, ip });
    E[k].pending2 = await get('/api/auth/signup/pending', a.c, ip);
    E[k].wrong = await post('/api/auth/code', { code: '000001' }, { cookie: a.c, ip });
    E[k].cancel = await post('/api/auth/signup/cancel', {}, { cookie: a.c, ip });
  }
  R.enum = E; save();
  // hand-off resend loss + cross-domain message, via browser
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const p = await ctx.newPage();
  await p.goto(u + '/');
  let b4 = codesIn(inst.logFile).length;
  await apiIn(p, '/api/auth/signup', { email: 'dana@brightwave-mail.com', password: PW, cf_turnstile_token: TS }); for (let i = 0; i < 40 && codesIn(inst.logFile).length <= b4; i++) await sleep(250);
  await apiIn(p, '/api/auth/signup/profile', { name: 'Dana', organization: 'Brightwave', whose_email: 'company' });
  R.dana_code = await apiIn(p, '/api/auth/code', { code: codesIn(inst.logFile).at(-1) });
  R.dana_add = await apiIn(p, '/api/domains', { domain: 'harbor-lane.org' });
  R.ho_other = await apiIn(p, '/api/team/invite', { email: 'dev@pixelforge.dev', role: 'admin', handoff_domain: 'harbor-lane.org' });
  R.ho_same = await apiIn(p, '/api/team/invite', { email: 'sam@brightwave-mail.com', role: 'admin', handoff_domain: 'harbor-lane.org' });
  R.plain_admin_invite_other = await apiIn(p, '/api/team/invite', { email: 'dev2@pixelforge.dev', role: 'admin' });
  const list = await apiIn(p, '/api/team/handoffs', null, 'GET'); R.ho_list = list;
  const hid = (JSON.parse(list.b).handoffs || JSON.parse(list.b))[0]?.id;
  R.ho_resend = await apiIn(p, `/api/team/handoffs/${hid}/resend`, {});
  R.ho_list_after = await apiIn(p, '/api/team/handoffs', null, 'GET');
  await ctx.close(); save();
  // return at C2 (same browser) and a second browser at C2
  const oauth = null;
  await inst.stop();
} catch (e) { R.enum_error = String(e.stack || e); }
save();
await browser.close();
console.log('EXTRA DONE');
