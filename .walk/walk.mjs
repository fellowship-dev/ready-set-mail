// Real-browser walk of sign-up / sign-in codes against a local `wrangler dev` (hosted mode, Turnstile test keys).
// Codes are read from the local send_email simulation's log (miniflare), never from real mail.
// usage: BASE=http://127.0.0.1:8788 LOG=~/devbox-logs/hosted.log SHOTS=~/shots node walk.mjs <scenario>
import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const BASE = process.env.BASE;
const LOG = process.env.LOG;
const SHOTS = process.env.SHOTS;
const PERSIST = process.env.PERSIST;
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (name, detail = '') => { results.push(`PASS ${name}${detail ? ` (${detail})` : ''}`); console.log(`PASS ${name}`); };
const bad = (name, detail) => { results.push(`FAIL ${name}: ${detail}`); console.log(`FAIL ${name}: ${detail}`); };
const check = (name, cond, detail = '') => (cond ? ok(name, detail) : bad(name, detail || 'condition false'));

// Each code email is logged once with its subject; to tell addresses apart, the log line of the builder includes "To".
function codeMails() {
  const text = readFileSync(LOG, 'utf8').replace(/\x1b\[[0-9;]*m/g, '');
  return [...text.matchAll(/(\d{6}) is your Ready Set Mail code/g)].map((m) => m[1]);
}
async function nextCode(before, label) {
  for (let i = 0; i < 80; i++) {
    const all = codeMails();
    if (all.length > before) return all.at(-1);
    await sleep(250);
  }
  throw new Error(`no code mail for ${label}`);
}
// The local AUTH_LIMITER binding allows 10 auth POSTs a minute per IP, and every walk comes from one IP: keep under it.
const posts = [];
async function pace() {
  for (;;) {
    const now = Date.now();
    while (posts.length && now - posts[0] > 61000) posts.shift();
    if (posts.length < 9) { posts.push(now); return; }
    await sleep(500);
  }
}
const d1 = (sql) => execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', '--persist-to', PERSIST, '--command', sql], { cwd: '/workspace/ready-set-mail', stdio: 'pipe' }).toString();

async function shot(page, name) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}
async function waitEnabled(page, name) {
  const b = page.getByRole('button', { name, exact: true });
  await b.waitFor();
  for (let i = 0; i < 80 && !(await b.isEnabled()); i++) await sleep(250);
  return b;
}
async function signOut(page) {
  await pace();
  await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }));
  await page.goto(`${BASE}/`);
}
async function signedIn(page) {
  const r = await page.evaluate(async () => (await fetch('/api/me', { credentials: 'same-origin' })).status);
  return r === 200;
}

async function signUp(page, email, password, w) {
  const before = codeMails().length;
  await page.goto(`${BASE}/signup?domain=walk-example.com`);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await shot(page, `${w}-01-signup-form`);
  await pace();
  await (await waitEnabled(page, 'Create account')).click();
  await page.getByRole('heading', { name: `Enter the 6-digit code we sent to ${email}` }).waitFor();
  await shot(page, `${w}-02-signup-code`);
  return nextCode(before, 'signup');
}
async function signIn(page, email, password) {
  const before = codeMails().length;
  await page.goto(`${BASE}/`);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await pace();
  await (await waitEnabled(page, 'Sign in')).click();
  await page.getByRole('heading', { name: `Enter the 6-digit code we sent to ${email}` }).waitFor();
  return nextCode(before, 'signin');
}
async function typeCode(page, code) {
  const input = page.getByLabel('6-digit code');
  await pace();
  await input.fill('');
  await input.pressSequentially(code, { delay: 30 });
}

async function hosted(width) {
  const w = String(width);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width, height: width < 600 ? 812 : 900 } });
  const page = await ctx.newPage();
  const email = `walker${w}@acme-walk.test`;
  const pw = 'walk-password-1';

  // sign-up → code → first-run, the domain intent kept
  const code = await signUp(page, email, pw, w);
  await typeCode(page, code);
  await page.waitForURL((u) => !u.hash.includes('signup'), { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  check(`${w} sign-up → code → signed in`, await signedIn(page));
  await shot(page, `${w}-03-after-signup`);
  const domainField = await page.locator('input').evaluateAll((els) => els.map((e) => e.value));
  check(`${w} sign-up intent ?domain= kept into first-run`, domainField.includes('walk-example.com'), JSON.stringify(domainField));

  // sign out → sign in → code
  await signOut(page);
  await page.getByLabel('Email', { exact: true }).waitFor();
  await shot(page, `${w}-04-signin-form`);
  const c2 = await signIn(page, email, pw);
  await shot(page, `${w}-05-signin-code`);
  await typeCode(page, c2);
  await page.waitForTimeout(1500);
  check(`${w} sign-in → code → signed in`, await signedIn(page));

  // wrong code five times
  await signOut(page);
  const c3 = await signIn(page, email, pw);
  for (let i = 1; i <= 5; i++) { await typeCode(page, String((Number(c3) + i) % 1000000).padStart(6, '0')); await page.waitForTimeout(600); }
  await shot(page, `${w}-06-wrong-five`);
  const msg = await page.getByRole('alert').first().textContent();
  await typeCode(page, c3);
  await page.waitForTimeout(800);
  check(`${w} five wrong codes kill the code (right one refused after)`, !(await signedIn(page)) && /no longer works/.test(msg ?? ''), msg ?? '');

  // new code invalidates old
  const c4 = await signIn(page, email, pw);
  const before = codeMails().length;
  await pace();
  await page.getByRole('button', { name: 'Send a new code' }).click();
  const c5 = await nextCode(before, 'resend');
  await page.getByText('The previous code no longer works.').waitFor();
  await shot(page, `${w}-07-new-code-sent`);
  await typeCode(page, c4);
  await page.waitForTimeout(800);
  const oldRefused = !(await signedIn(page));
  await typeCode(page, c5);
  await page.waitForTimeout(1500);
  check(`${w} a new code invalidates the old one`, oldRefused && (await signedIn(page)));

  // expired code
  await signOut(page);
  const c6 = await signIn(page, email, pw);
  d1("UPDATE verifications SET expires_at = 1 WHERE identifier LIKE 'signin-code:%'");
  await typeCode(page, c6);
  await page.waitForTimeout(800);
  await shot(page, `${w}-08-expired`);
  const expMsg = await page.getByRole('alert').first().textContent();
  check(`${w} expired code refused`, !(await signedIn(page)) && /expired/.test(expMsg ?? ''), expMsg ?? '');

  // a code typed in a second browser
  const c7 = await signIn(page, email, pw);
  const other = await browser.newContext({ viewport: { width, height: 800 } });
  const p2 = await other.newPage();
  await p2.goto(`${BASE}/`);
  await pace();
  const st = await p2.evaluate(async (code) => (await fetch('/api/auth/code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) })).status, c7);
  const c8 = await signIn(p2, email, pw);
  await typeCode(p2, c7);
  await p2.waitForTimeout(800);
  const secondRefused = !(await signedIn(p2));
  await shot(p2, `${w}-09-second-browser`);
  await other.close();
  // the first browser's attempt was replaced? no: each browser has its own attempt; the first one's code still works there
  await typeCode(page, c7);
  await page.waitForTimeout(1500);
  check(`${w} a code typed in another browser does nothing (no attempt: ${st}; other attempt: refused)`, st === 410 && secondRefused && (await signedIn(page)), `c8 unused ${c8 ? 'yes' : ''}`);

  // reset by code
  await signOut(page);
  await page.goto(`${BASE}/#/forgot`);
  await page.getByLabel('Email', { exact: true }).fill(email);
  const rb = codeMails().length;
  await pace();
  await (await waitEnabled(page, 'Send code')).click();
  const rc = await nextCode(rb, 'reset');
  await page.getByLabel('6-digit code').waitFor();
  await typeCode(page, rc);
  await page.getByLabel('New password').fill('walk-password-2');
  await shot(page, `${w}-10-reset`);
  await pace();
  await page.getByRole('button', { name: 'Set password and sign in' }).click();
  await page.waitForTimeout(1500);
  check(`${w} reset by code signs in`, await signedIn(page));
  await signOut(page);
  const c9 = await signIn(page, email, 'walk-password-2');
  await typeCode(page, c9);
  await page.waitForTimeout(1500);
  check(`${w} new password + code signs in`, await signedIn(page));
  await page.goto(`${BASE}/#/settings`);
  await page.waitForTimeout(1500);
  await shot(page, `${w}-11-settings`);

  // an old welcome link
  await signOut(page);
  await page.goto(`${BASE}/#/welcome/eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6ImFAYi5jIn0.sig`);
  await page.getByRole('heading', { name: 'This link is no longer used' }).waitFor();
  await shot(page, `${w}-12-old-link`);
  ok(`${w} old welcome link page`);

  await browser.close();
}

async function closed(width) {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width, height: 812 } })).newPage();
  await page.goto(`${BASE}/signup`);
  await page.getByText("New accounts can't be created here right now. If you already have one, sign in.").waitFor();
  await shot(page, `${width}-13-closed-signup`);
  const c = await signIn(page, `walker${width}@acme-walk.test`, 'walk-password-2');
  await typeCode(page, c);
  await page.waitForTimeout(1500);
  check(`${width} closed sign-up: existing user signs in with the code`, await signedIn(page));
  await pace();
  const st = await page.evaluate(async () => (await fetch('/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'new@acme-walk.test', password: 'pass-word-123' }) })).status);
  check(`${width} closed sign-up: no new account (503)`, st === 503, String(st));
  await browser.close();
}

async function selfHost(width) {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width, height: 812 } })).newPage();
  await page.goto(`${BASE}/`);
  const status = await page.evaluate(async () => (await fetch('/api/auth/status')).json());
  if (!status.configured) {
    await page.getByLabel('Installer proof').fill(process.env.PROOF);
    await page.getByLabel('Email', { exact: true }).fill('owner@selfhost-walk.test');
    await page.getByLabel('Password', { exact: true }).fill('owner-password-1');
    await page.getByLabel('Confirm password').fill('owner-password-1');
    await pace();
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.waitForTimeout(2000);
    check(`${width} self-host first-owner setup works without mail`, await signedIn(page));
    await signOut(page);
  }
  await page.getByLabel('Email', { exact: true }).fill('owner@selfhost-walk.test');
  await page.getByLabel('Password', { exact: true }).fill('owner-password-1');
  await shot(page, `${width}-14-selfhost-signin`);
  await pace();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForTimeout(2000);
  check(`${width} self-host without mail: password only signs in`, (await signedIn(page)) && !(await page.getByLabel('6-digit code').count()));
  await page.goto(`${BASE}/#/settings`);
  await page.getByText("Password only. This instance can't send email").waitFor();
  await shot(page, `${width}-15-selfhost-settings`);
  ok(`${width} self-host Settings says which mode`);
  await browser.close();
}

const scenario = process.argv[2];
try {
  if (scenario === 'hosted') { await hosted(375); await hosted(1440); }
  if (scenario === 'closed') { await closed(375); await closed(1440); }
  if (scenario === 'selfhost') { await selfHost(375); await selfHost(1440); }
} catch (e) {
  bad(`${scenario} aborted`, e.message.split('\n')[0]);
}
console.log('\n' + results.join('\n'));
process.exit(0); // a browser left open by a failed step must not keep the walk alive
