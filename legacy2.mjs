import { chromium } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, existsSync, createWriteStream } from 'node:fs';
import { startFakeCloudflare } from './e2e/support/fake-cloudflare.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const codesIn = (f) => (existsSync(f) ? [...readFileSync(f, 'utf8').replace(/\x1b\[[0-9;]*m/g, '').matchAll(/(\d{6}) is your Ready Set Mail code/g)].map((m) => m[1]) : []);
const state = '/tmp/legacy-state';
const old = Math.floor(Date.now() / 1000) - 30 * 86400;
const r = spawnSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', '--persist-to', state, '--command', `UPDATE domains SET created_at=${old}, updated_at=${old}; UPDATE domain_claims SET created_at=${old}`], { encoding: 'utf8' });
console.log('update', r.status, (r.stderr || '').slice(-200));
const fake = await startFakeCloudflare({ port: 0 });
await fetch(`${fake.url}/__ns`, { method: 'POST', body: JSON.stringify({ name: 'harbor-lane.org', ns: ['ns1.domaincontrol.com'] }) });
const url = 'http://127.0.0.1:8904'; const logFile = '/tmp/legacy-pr2.log';
const v = { CLOUDFLARE_API_BASE_URL: fake.url, DOH_BASE_URL: fake.url, BETTER_AUTH_URL: url, TOKEN_ENCRYPTION_KEY: process.env.KEY || 'k1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', MODE: 'saas', SAAS_ENABLED: '1', TURNSTILE_SITE_KEY: '1x00000000000000000000AA', TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' };
const child = spawn('npx', ['wrangler', 'dev', '--local', '--persist-to', state, '--port', '8904', '--ip', '127.0.0.1', ...Object.entries(v).flatMap(([k, val]) => ['--var', `${k}:${val}`])], { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, NO_COLOR: '1' } });
const lf = createWriteStream(logFile); child.stdout.pipe(lf); child.stderr.pipe(lf);
for (let i = 0; i < 120; i++) { try { if ((await fetch(url + '/health')).ok) break; } catch {} await sleep(1000); }
const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await p.goto(url + '/#/signin'); await sleep(2500);
await p.getByLabel(/email/i).first().fill('max@brightwave-mail.com'); await p.getByLabel('Password', { exact: true }).fill('correct-horse-battery');
const n = codesIn(logFile).length; await p.getByRole('button', { name: /Sign in|Continue/ }).first().click();
for (let i = 0; i < 60 && codesIn(logFile).length <= n; i++) await sleep(500);
await p.getByLabel(/code/i).first().pressSequentially(codesIn(logFile).at(-1)); await sleep(6000);
for (const [w, h] of [[375, 812], [1440, 900]]) { await p.setViewportSize({ width: w, height: h }); await sleep(400); await p.screenshot({ path: `${process.env.HOME}/walk-out/x-extra/L3-pr-old-domain@${w}.png` }); }
console.log('URL', p.url()); console.log((await p.evaluate(() => document.querySelector('main').innerText)).slice(0, 700));
await b.close(); try { process.kill(-child.pid, 'SIGKILL'); } catch {} await fake.close();
