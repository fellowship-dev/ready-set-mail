// A throwaway local Ready Set Mail instance for walks and screenshots: fresh D1, the fake Cloudflare (which also answers
// DoH), and `wrangler dev --local`. Nothing leaves the machine except hosted sign-up's Turnstile check (see below).
//
//   import { startInstance } from './dev-instance.mjs';
//   const inst = await startInstance({ mode: 'selfhost' | 'hosted', port: 8801, tokenKey: true, dohNs: { 'harbor-lane.org': ['ns1.domaincontrol.com'] }, cwd });
//   inst.url  inst.fake (startFakeCloudflare handle: .url .reset())  inst.persistDir  inst.d1(sql)  inst.verificationLinks()  await inst.stop()
//
// Needs `npm run build:dashboard` done in `cwd` (default: this repo). `cwd` may be another checkout (e.g. the origin/main
// worktree ~/work/main-wt for BEFORE shots): that checkout's own wrangler, migrations and dashboard are used, and the DOH var is
// still passed (an older Worker ignores it).
//
// Vars passed: CLOUDFLARE_API_BASE_URL, DOH_BASE_URL (the fake), BETTER_AUTH_URL=http://127.0.0.1:<port>,
// TOKEN_ENCRYPTION_KEY=k1:<random 32 bytes base64> (per run, never printed; omit with tokenKey:false so "Connect Cloudflare"
// is not offered). Hosted adds MODE=saas SAAS_ENABLED=1 plus Cloudflare's documented always-pass Turnstile TEST keys
// (site 1x00000000000000000000AA, secret 1x0000000000000000000000000000000AA): the Worker's server-side check does reach
// challenges.cloudflare.com (not api.cloudflare.com), and a browser loads the widget from there and gets a dummy token.
// Hosted sign-up sends a verification email through the SEND_EMAIL binding, which a local run only logs: the sender address
// is seeded (settings.from_email) and inst.verificationLinks() reads the link out of the dev logs, falling back to D1.
// `dohNs` seeds the fake's NS answers (name and everything under it), e.g. Cloudflare ['ns1.ns.cloudflare.com'].
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, createWriteStream, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeCloudflare } from './fake-cloudflare.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function waitHealth(url, child, logFile, ms = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited (${child.exitCode}); see ${logFile}`);
    try { const r = await fetch(`${url}/health`); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 400));
  }
  throw new Error(`instance at ${url} not healthy after ${ms / 1000}s; see ${logFile}`);
}

export async function startInstance({ mode = 'selfhost', port, tokenKey = true, dohNs = {}, cwd = REPO, vars = {} } = {}) {
  if (!port) throw new Error('startInstance: port is required');
  const persistDir = mkdtempSync(path.join(tmpdir(), `rsm-${mode}-`));
  const logFile = path.join(persistDir, 'wrangler.log');
  const run = (args) => spawnSync('npx', args, { cwd, encoding: 'utf8' });

  const mig = spawnSync('node', ['packages/db/scripts/migrate.mjs', '--local', '--persist-to', persistDir], { cwd, encoding: 'utf8' });
  if (mig.status !== 0) throw new Error(`migrate failed: ${(mig.stderr || mig.stdout).split('\n').slice(-6).join('\n')}`);

  const fake = await startFakeCloudflare({ port: 0 });
  for (const [name, ns] of Object.entries(dohNs)) {
    await fetch(`${fake.url}/__ns`, { method: 'POST', body: JSON.stringify({ name, ns }) });
  }

  const url = `http://127.0.0.1:${port}`;
  const v = {
    CLOUDFLARE_API_BASE_URL: fake.url, DOH_BASE_URL: fake.url, BETTER_AUTH_URL: url,
    ...(tokenKey ? { TOKEN_ENCRYPTION_KEY: `k1:${randomBytes(32).toString('base64')}` } : {}),
    ...(mode === 'hosted' ? { MODE: 'saas', SAAS_ENABLED: '1', TURNSTILE_SITE_KEY: '1x00000000000000000000AA', TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' } : {}),
    ...vars,
  };
  const args = ['wrangler', 'dev', '--local', '--persist-to', persistDir, '--port', String(port), '--ip', '127.0.0.1', ...Object.entries(v).flatMap(([k, val]) => ['--var', `${k}:${val}`])];
  const log = createWriteStream(logFile);
  const child = spawn('npx', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' } });
  child.stdout.pipe(log); child.stderr.pipe(log);

  let stopped = false;
  const stop = async () => {
    if (stopped) return; stopped = true;
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ }
    await new Promise(r => setTimeout(r, 500));
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
    await fake.close();
    rmSync(persistDir, { recursive: true, force: true });
  };
  try { await waitHealth(url, child, logFile); } catch (e) { await stop(); throw e; }

  const d1 = (sql) => {
    const r = run(['wrangler', 'd1', 'execute', 'DB', '--local', '--persist-to', persistDir, '--json', '--command', sql]);
    if (r.status !== 0) throw new Error(`d1 failed: ${(r.stderr || r.stdout).split('\n').slice(-3).join('\n')}`);
    const j = JSON.parse(r.stdout); return (Array.isArray(j) ? j[0]?.results : j?.results) ?? [];
  };
  if (mode === 'hosted') {
    try { d1("INSERT OR REPLACE INTO settings (workspace_id, key, value) VALUES ('ws_default', 'from_email', 'noreply@reports.harbor-lane.org')"); } catch { /* optional */ }
  }
  /** Verification links the Worker "sent" (local SEND_EMAIL only logs/stores them), newest last. */
  const verificationLinks = () => {
    // The local SEND_EMAIL binding logs "Text: <file>" for every message; the link is in that file.
    const log = (() => { try { return readFileSync(logFile, 'utf8'); } catch { return ''; } })();
    const links = [];
    for (const m of log.matchAll(/^Text: (\S+)$/gm)) {
      try { links.push(...[...readFileSync(m[1], 'utf8').matchAll(/https?:\/\/127\.0\.0\.1:\d+\/\S*/g)].map((x) => x[0])); } catch { /* file gone */ }
    }
    if (links.length) return links;
    return [...log.matchAll(/https?:\/\/127\.0\.0\.1:\d+\/[^\s"'<>]*(?:welcome|verify)[^\s"'<>]*/g)].map((m) => m[0]);
  };
  return { url, fake, stop, persistDir, logFile, d1, verificationLinks, mode, cwd };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const mode = process.argv[2] === 'hosted' ? 'hosted' : 'selfhost';
  const inst = await startInstance({ mode, port: Number(process.argv[3]) || 8801 });
  console.log(`${mode} instance at ${inst.url} (fake Cloudflare ${inst.fake.url}); Ctrl-C to stop`);
  process.on('SIGINT', async () => { await inst.stop(); process.exit(0); });
}
