// `npm run setup`: install, resume and uninstall. Everything that touches the outside world comes in
// through `deps`, so tests run the same code against a fake Cloudflare API and a fake Wrangler.
import { existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { parseArgs, UsageError, USAGE } from './args.mjs';
import { createCloudflare } from './cloudflare.mjs';
import {
  TRACKED_CONFIG, LOCAL_CONFIG, parseJsonc, resourceNames, workersDevUrl, generateLocalConfig,
  renderLocalConfig, describeLocalConfig, describeCrons,
} from './config.mjs';
import {
  defaultConfigDir, instanceDir, ensurePrivateDir, emptyState, readState, writeState, statePath,
  foreignCollisions, uninstallSelection,
} from './state.mjs';
import { loadOrCreateSecrets, withSecretsFile, PROOF_FILE } from './secrets.mjs';
import { createUi } from './ui.mjs';

/** How long a setup link works. */
export const SETUP_LINK_TTL_SECONDS = 15 * 60;

/**
 * The short-lived setup token: `<expiry>.<signature>`, where expiry is Unix seconds and signature is
 * base64url (no padding) of HMAC-SHA256(key = BOOTSTRAP_SECRET, message = "setup-link:" + expiry).
 * The raw secret never leaves the machine; the server recomputes the signature from its own copy.
 */
export function setupToken(secret, nowMs, ttlSeconds = SETUP_LINK_TTL_SECONDS) {
  const expiry = Math.floor(nowMs / 1000) + ttlSeconds;
  const sig = createHmac('sha256', secret).update(`setup-link:${expiry}`).digest('base64url');
  return `${expiry}.${sig}`;
}

/**
 * The setup link: the dashboard's first-owner screen with the token in the URL fragment (never sent to
 * the server in the request line, never in access logs). The format belongs to the dashboard; change it here only.
 */
export function setupLink(url, secret, nowMs, ttlSeconds = SETUP_LINK_TTL_SECONDS) {
  return `${url}/#/setup?t=${setupToken(secret, nowMs, ttlSeconds)}`;
}

/** "^22.22.2 || ^24.15.0 || >=26.0.0" against "v22.23.5". Supports the ^ and >= forms the repo uses. */
export function satisfiesEngines(range, version) {
  const v = version.replace(/^v/, '').split('.').map(Number);
  const cmp = (a, b) => { for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0); return 0; };
  return range.split('||').map(s => s.trim()).some(part => {
    const m = /^(\^|>=)?\s*(\d+)\.(\d+)\.(\d+)$/.exec(part);
    if (!m) return false;
    const want = [Number(m[2]), Number(m[3]), Number(m[4])];
    if (m[1] === '>=') return cmp(v, want) >= 0;
    if (m[1] === '^') return v[0] === want[0] && cmp(v, want) >= 0;
    return cmp(v, want) === 0;
  });
}

export function newestMigration(repoRoot) {
  return readdirSync(join(repoRoot, 'migrations')).filter(f => /^\d{4}_.*\.sql$/.test(f)).sort().at(-1) ?? null;
}

class Failure extends Error {}
const fail = (msg) => { throw new Failure(msg); };
const nowDate = (deps) => (deps.now ? deps.now() : new Date());
const now = (deps) => nowDate(deps).toISOString();

/** Entry point. Returns the exit code; never calls process.exit itself. */
export async function main(argv, deps) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) { deps.stderr.write(`${e.message}\n`); return 2; }
    throw e;
  }
  if (opts.help) { deps.stdout.write(USAGE); return 0; }
  const interactive = !!deps.isTTY;
  const ui = createUi({ stdout: deps.stdout, stderr: deps.stderr, stdin: deps.stdin, interactive, json: opts.json });
  try {
    const result = opts.uninstall ? await uninstall(opts, deps, ui) : opts.newLink ? await newLink(opts, deps, ui) : await install(opts, deps, ui);
    if (opts.json) ui.json({ ok: true, ...result });
    return 0;
  } catch (e) {
    const message = e instanceof Failure || e instanceof UsageError ? e.message : `Unexpected error: ${e?.message ?? e}`;
    ui.line('');
    ui.line(`Setup stopped: ${message}`);
    if (!(e instanceof Failure) && !(e instanceof UsageError) && deps.env.RSM_SETUP_DEBUG && e?.stack) ui.line(e.stack);
    if (opts.json) ui.json({ ok: false, error: ui.redact(message) });
    return e instanceof UsageError ? 2 : 1;
  } finally {
    ui.close();
  }
}

// ── shared steps ───────────────────────────────────────────────────────────────────────────────

async function checkTools(deps, ui) {
  const pkg = JSON.parse(readFileSync(join(deps.repoRoot, 'package.json'), 'utf8'));
  const range = pkg.engines?.node;
  if (range && !satisfiesEngines(range, deps.nodeVersion)) {
    fail(`Node ${deps.nodeVersion} is not supported here; this project needs Node ${range}. Install a supported Node (for example the current 22 or 24 release) and run again.`);
  }
  if (!existsSync(join(deps.repoRoot, 'node_modules', 'wrangler', 'package.json'))) {
    fail('Wrangler is not installed yet. It comes with the project\'s dependencies: run `npm install`, then `npm run setup` again.');
  }
  ui.ok(`Node ${deps.nodeVersion}; Wrangler ${deps.wranglerVersion ? deps.wranglerVersion() : 'installed'} (from npm install)`);
}

async function connect(opts, deps, ui, { expectedAccount } = {}) {
  if (expectedAccount && opts.accountId && opts.accountId !== expectedAccount) {
    fail(`This instance was installed in account ${expectedAccount}, not ${opts.accountId}.`);
  }
  let token = deps.env.CLOUDFLARE_API_TOKEN || null;
  let source = 'CLOUDFLARE_API_TOKEN';
  if (!token && deps.env.CLOUDFLARE_API_KEY) {
    fail('CLOUDFLARE_API_KEY (a global API key) is not supported. Use an API token in CLOUDFLARE_API_TOKEN, or `npx wrangler login`.');
  }
  if (!token) {
    source = 'your Wrangler login';
    token = await deps.wranglerAuthToken();
    if (!token) {
      if (!ui.interactive) fail('No Cloudflare credential. Set CLOUDFLARE_API_TOKEN (see docs/self-hosting.md#permissions), or run `npx wrangler login` once and try again.');
      ui.info('You are not logged in to Cloudflare. Opening the Cloudflare login in your browser (wrangler login)...');
      const code = await deps.wranglerLogin();
      token = code === 0 ? await deps.wranglerAuthToken() : null;
      if (!token) fail('The Cloudflare login did not finish. Run `npx wrangler login` yourself, then `npm run setup` again.');
    }
  }
  ui.addSecret(token);
  const cf = createCloudflare({ token, fetch: deps.fetch, apiBase: deps.env.RSM_SETUP_CF_API_BASE || undefined });
  let accounts;
  try {
    accounts = await cf.listAccounts();
  } catch (e) {
    fail(`The Cloudflare credential from ${source} did not work (${e.message}). ${source === 'CLOUDFLARE_API_TOKEN' ? 'Check the token and its permissions (docs/self-hosting.md#permissions).' : 'Run `npx wrangler login` again.'}`);
  }
  ui.ok(`Cloudflare credential works (${source}); it can see ${accounts.length} account${accounts.length === 1 ? '' : 's'}`);

  const wanted = expectedAccount || opts.accountId || deps.env.CLOUDFLARE_ACCOUNT_ID || null;
  let account;
  if (wanted) {
    account = accounts.find(a => a.id === wanted);
    if (!account) fail(`Account ${wanted} is not one this credential can see. Visible: ${accounts.map(a => `${a.name} (${a.id})`).join(', ') || 'none'}.`);
  } else if (accounts.length === 1) {
    account = accounts[0];
  } else if (accounts.length === 0) {
    fail('This credential cannot see any Cloudflare account. If it is an API token, give it access to your account (docs/self-hosting.md#permissions).');
  } else if (!ui.interactive) {
    fail(`This credential can see ${accounts.length} accounts; choose one with --account-id: ${accounts.map(a => `${a.id} (${a.name})`).join(', ')}`);
  } else {
    ui.info('Several Cloudflare accounts are available:');
    account = await ui.choose('Which account should Ready Set Mail be installed in?', accounts, a => `${a.name} (${a.id})`);
  }
  ui.ok(`Account: ${account.name} (${account.id})`);
  return { cf, account, viaLogin: source !== 'CLOUDFLARE_API_TOKEN' };
}

async function lookupExisting(cf, accountId, names) {
  const [workers, d1s, kvs] = await Promise.all([cf.listWorkers(accountId), cf.listD1(accountId), cf.listKv(accountId)]);
  return {
    worker: workers.includes(names.worker),
    d1: d1s.find(d => d.name === names.d1) ?? null,
    kv: kvs.find(k => k.title === names.kv) ?? null,
  };
}

function makeLog(dir, ui) {
  const path = join(dir, 'setup.log');
  return { path, write: (text) => { ensurePrivateDir(dir); appendFileSync(path, ui.redact(text), { mode: 0o600 }); } };
}

/** Run a tool, its output into the private log; on failure, show the last lines. */
async function runLogged(deps, ui, log, label, cmd, args, opts = {}) {
  log.write(`\n$ ${cmd} ${args.join(' ')}\n`);
  const r = await deps.run(cmd, args, opts);
  log.write(r.output ?? '');
  if (r.code !== 0) {
    const tail = ui.redact(r.output ?? '').trimEnd().split('\n').slice(-15).map(l => `        ${l}`).join('\n');
    fail(`${label} failed (exit ${r.code}). Last lines:\n${tail}\nFull log: ${log.path}\nFix the cause and run the same command with --resume to continue.`);
  }
  return r;
}

// ── install ────────────────────────────────────────────────────────────────────────────────────

const TOTAL = 9;

async function install(opts, deps, ui) {
  const names = resourceNames(opts.name);
  const configDir = opts.configDir ?? defaultConfigDir(deps.env, deps.home);
  const dir = instanceDir(configDir, opts.name);

  ui.line(`Ready Set Mail setup: instance "${opts.name}"`);
  ui.line('');
  ui.step(1, TOTAL, 'Checking Node and Wrangler');
  await checkTools(deps, ui);

  let state = readState(dir);
  if (state?.uninstalled_at) state = null;
  if (state && !opts.resume) {
    fail(`An earlier install of "${opts.name}" is recorded in ${statePath(dir)}. To continue it, run the same command with --resume. To start over, uninstall it first (npm run setup -- --uninstall --name ${opts.name}).`);
  }
  if (!state && opts.resume) fail(`--resume: no earlier install of "${opts.name}" is recorded in ${dir}`);

  ui.step(2, TOTAL, 'Checking your Cloudflare credential');
  const { cf, account } = await connect(opts, deps, ui, { expectedAccount: state?.account_id });

  ui.step(3, TOTAL, `Checking that the names for "${opts.name}" are free`);
  const existing = await lookupExisting(cf, account.id, names);
  const foreign = foreignCollisions(existing, names, state);
  if (foreign.length) {
    fail(`This account already has ${foreign.join(', ')}, not created by this installer. Nothing was changed. Choose another name with --name (for example --name ${opts.name}-2).`);
  }
  const localPath = join(deps.repoRoot, LOCAL_CONFIG);
  if (existsSync(localPath)) {
    const desc = describeLocalConfig(readFileSync(localPath, 'utf8'));
    const ours = desc && state && desc.name === names.worker && desc.d1Id === state.created.d1?.id && desc.kvId === state.created.kv?.id;
    if (!ours) fail(`${LOCAL_CONFIG} in this checkout belongs to ${desc?.name ? `the instance "${desc.name}"` : 'another configuration'}. One checkout deploys one instance: use a separate clone for another instance, or move that file away if it is stale.`);
  }
  ui.ok(existing.worker || existing.d1 || existing.kv ? 'the existing resources with these names were created by this installer (resuming)' : 'Worker, D1 database and KV namespace names are free');

  let url = opts.url;
  let workersDev = null;
  const subdomain = await cf.workersSubdomain(account.id);
  if (subdomain) workersDev = workersDevUrl(names.worker, subdomain);
  if (!url) {
    if (!subdomain) fail('This account has no workers.dev subdomain yet. Open the Cloudflare dashboard, go to Workers & Pages once to choose one, then run again (or pass --url with your own domain).');
    url = workersDev;
  }
  ui.ok(`Address: ${url}`);

  const tracked = parseJsonc(readFileSync(join(deps.repoRoot, TRACKED_CONFIG), 'utf8'));
  const crons = describeCrons(tracked);

  // ── plan ──
  ui.line('');
  ui.line('Plan:');
  ui.line(`  Account          ${account.name} (${account.id})`);
  ui.line(`  Address          ${url}${opts.url ? ' (you attach this domain to the Worker yourself)' : ''}`);
  ui.line(`  Create           ${state?.created.d1 ? 'reuse' : 'new'} D1 database "${names.d1}", ${state?.created.kv ? 'reuse' : 'new'} KV namespace "${names.kv}"`);
  ui.line(`  Deploy           Worker "${names.worker}": workers.dev address on, preview URLs off`);
  ui.line('  Secrets          a first-owner proof and a token encryption key, generated here, sent to the Worker,');
  ui.line(`                   backed up in ${dir} (only you can read it)`);
  ui.line(`  Local config     ${LOCAL_CONFIG} in this checkout (git-ignored; tracked files stay unchanged)`);
  ui.line(`  Scheduled jobs   ${crons.length} cron triggers start running:`);
  for (const c of crons) ui.line(`                     ${c.cron.padEnd(11)} ${c.what}`);
  ui.line('  Not asked for    no Cloudflare token for DNS changes; you can connect one later in the dashboard');
  ui.line('');

  if (opts.dryRun) {
    ui.line('Dry run: nothing was changed.');
    return { dry_run: true, name: opts.name, account_id: account.id, url, resources: names, crons: crons.map(c => c.cron) };
  }
  if (!opts.yes) {
    if (!ui.interactive) fail('Not a terminal, so nothing can be confirmed: add --yes to go ahead with this plan.');
    if (!(await ui.confirm('Go ahead?'))) fail('Cancelled. Nothing was changed.');
  }

  state = state ?? emptyState(opts.name, account.id);
  state.url = url;
  writeState(dir, state);
  const log = makeLog(dir, ui);
  const record = (fn) => { fn(state); writeState(dir, state); };

  ui.step(4, TOTAL, 'Creating the D1 database and KV namespace');
  if (!state.created.d1) {
    const d1 = await cf.createD1(account.id, names.d1);
    record(s => { s.created.d1 = { id: d1.id, name: d1.name }; });
    ui.ok(`D1 database "${d1.name}" created (${d1.id})`);
  } else ui.ok(`D1 database "${state.created.d1.name}" already created (${state.created.d1.id})`);
  if (!state.created.kv) {
    const kv = await cf.createKv(account.id, names.kv);
    record(s => { s.created.kv = { id: kv.id, title: kv.title }; });
    ui.ok(`KV namespace "${kv.title}" created (${kv.id})`);
  } else ui.ok(`KV namespace "${state.created.kv.title}" already created (${state.created.kv.id})`);

  const cfg = generateLocalConfig(tracked, { name: opts.name, accountId: account.id, d1Id: state.created.d1.id, kvId: state.created.kv.id, url });
  writeFileSync(localPath, renderLocalConfig(cfg, { name: opts.name }));
  ui.ok(`${LOCAL_CONFIG} written (BETTER_AUTH_URL=${url})`);

  ui.step(5, TOTAL, 'Generating the first-owner proof and the token encryption key');
  // Marked before the files are written, so a crash between the two still lets --resume reuse them.
  const mayReuse = !!state.steps.secrets_started;
  record(s => { s.steps.secrets_started = s.steps.secrets_started ?? now(deps); });
  const secrets = loadOrCreateSecrets(dir, { randomBytes: deps.randomBytes, mayReuse });
  ui.addSecret(secrets.proof);
  ui.addSecret(secrets.key);
  record(s => { s.steps.secrets = s.steps.secrets ?? now(deps); });
  ui.ok(secrets.created.length ? `generated; backups written to ${dir} (mode 0600)` : `reusing the backups in ${dir}`);

  ui.step(6, TOTAL, 'Building the dashboard');
  await runLogged(deps, ui, log, 'Building the dashboard', 'npm', ['run', 'build:dashboard']);
  record(s => { s.steps.build = now(deps); });
  ui.ok('built');

  ui.step(7, TOTAL, 'Applying database migrations');
  await runLogged(deps, ui, log, 'Applying migrations', 'wrangler', ['d1', 'migrations', 'apply', 'DB', '--remote', '--config', LOCAL_CONFIG], { accountId: account.id });
  record(s => { s.steps.migrate = now(deps); });
  ui.ok(`migrations applied (newest: ${newestMigration(deps.repoRoot)})`);

  ui.step(8, TOTAL, `Deploying the Worker "${names.worker}"`);
  ui.info('The secrets go up with this first version (wrangler deploy --secrets-file), so the Worker never runs without them');
  ui.info('and no placeholder Worker is created before the real one.');
  // Recorded before the call: if the deploy dies half-way, the Worker it may have created is still known to be ours.
  record(s => { s.created.worker = { name: names.worker }; });
  await withSecretsFile(dir, { BOOTSTRAP_SECRET: secrets.proof, TOKEN_ENCRYPTION_KEY: secrets.key }, (file) =>
    runLogged(deps, ui, log, 'Deploying', 'wrangler', ['deploy', '--config', LOCAL_CONFIG, '--secrets-file', file], { accountId: account.id }));
  record(s => { s.steps.deploy = now(deps); });
  ui.ok('deployed');

  ui.step(9, TOTAL, 'Checking the instance');
  const probe = workersDev ?? url;
  const verified = await verify(deps, ui, cf, account.id, state.created.d1.id, probe);
  record(s => { s.steps.verify = now(deps); });

  // ── done ──
  const waiting = verified.waitingForOwner;
  const link = waiting ? setupLink(url, secrets.proof, nowDate(deps).getTime()) : null;
  ui.line('');
  printReady(ui, url, link, opts.name);
  ui.line('');
  ui.line(`  Backups      ${dir} (the encryption key there reads stored Cloudflare connections)`);
  ui.line('  DNS changes  optional: "Connect Cloudflare" in the dashboard (docs/self-hosting.md#permissions)');
  ui.line('  Upgrade      git pull && npm install && npm run deploy');
  ui.line(`  Remove       npm run setup -- --uninstall --name ${opts.name}`);
  if (opts.url) ui.line(`  Custom domain: add ${new URL(url).host} to the Worker "${names.worker}" (Workers & Pages > Settings > Domains & Routes); until then it answers at ${workersDev ?? 'its workers.dev address'}.`);

  return {
    name: opts.name, account_id: account.id, url,
    setup_link: link,
    setup_link_expires_at: link ? new Date((Math.floor(nowDate(deps).getTime() / 1000) + SETUP_LINK_TTL_SECONDS) * 1000).toISOString() : null,
    proof_file: secrets.proofPath, key_file: secrets.keyPath, state_file: statePath(dir),
    resources: { worker: names.worker, d1: state.created.d1, kv: state.created.kv },
  };
}

async function verify(deps, ui, cf, accountId, d1Id, base) {
  const attempts = deps.verifyAttempts ?? 20;
  let health = null;
  let lastProblem = '';
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await deps.fetch(new URL('/health', base));
      if (r.ok) { health = await r.json().catch(() => null); if (health?.ok) break; lastProblem = 'unexpected answer'; }
      else lastProblem = `HTTP ${r.status}${r.status === 503 ? ' (database not migrated yet?)' : ''}`;
    } catch (e) { lastProblem = e.cause?.code ?? e.message; }
    health = null;
    if (i === 0) ui.info('waiting for the new address to answer (this can take a minute the first time)...');
    await deps.sleep(3000);
  }
  if (!health?.ok) fail(`${base}/health did not answer correctly (${lastProblem}). The Worker is deployed; check it in the Cloudflare dashboard, then run again with --resume.`);
  ui.ok(`/health answers (version ${health.version ?? 'unknown'})`);

  const newest = newestMigration(deps.repoRoot);
  const rows = await cf.queryD1(accountId, d1Id, 'SELECT name FROM d1_migrations ORDER BY name DESC LIMIT 1');
  if (rows[0]?.name !== newest) fail(`The database's newest migration is ${rows[0]?.name ?? 'none'}, expected ${newest}. Run again with --resume.`);
  ui.ok(`database migrations are current (${newest})`);

  let waitingForOwner = true;
  try {
    const r = await deps.fetch(new URL('/api/auth/status', base));
    const s = await r.json();
    waitingForOwner = s.configured === false;
    ui.ok(waitingForOwner ? 'waiting for its first owner' : 'it already has an owner');
  } catch (e) {
    ui.warn(`could not read the owner status (${e.message}); the setup link below still works until an owner exists`);
  }
  return { waitingForOwner };
}

/** The ending: where it runs and the one thing to do next. */
function printReady(ui, url, link, name) {
  if (link) {
    ui.line(`Ready Set Mail is running at ${url}. Open this link to create your owner account:`);
    ui.line('');
    ui.line(`  ${link}`);
    ui.line('');
    ui.line(`The link works once and expires in ${SETUP_LINK_TTL_SECONDS / 60} minutes. Need a new one? npm run setup -- --new-link --name ${name}`);
  } else {
    ui.line(`Ready Set Mail is running at ${url}. Sign in there with your owner account.`);
  }
}

// ── new link ───────────────────────────────────────────────────────────────────────────────────

/** A fresh setup link from the backed-up secret: no Cloudflare call, no redeploy. */
async function newLink(opts, deps, ui) {
  const configDir = opts.configDir ?? defaultConfigDir(deps.env, deps.home);
  const dir = instanceDir(configDir, opts.name);
  const state = readState(dir);
  if (!state || state.uninstalled_at || !state.steps.deploy || !state.url) {
    fail(`No finished install of "${opts.name}" is recorded in ${dir}. Run npm run setup${opts.name === 'ready-set-mail' ? '' : ` -- --name ${opts.name}`} first.`);
  }
  const proofPath = join(dir, PROOF_FILE);
  if (!existsSync(proofPath)) fail(`${proofPath} is missing, so no link can be made. See docs/self-hosting.md#manual-install for the other way to create the owner account.`);
  const secret = readFileSync(proofPath, 'utf8').trim();
  ui.addSecret(secret);
  let waiting = true;
  try {
    const r = await deps.fetch(new URL('/api/auth/status', state.url));
    waiting = (await r.json()).configured === false;
  } catch { /* unreachable right now: the link is still made */ }
  const link = waiting ? setupLink(state.url, secret, nowDate(deps).getTime()) : null;
  printReady(ui, state.url, link, opts.name);
  return { name: opts.name, url: state.url, setup_link: link,
    setup_link_expires_at: link ? new Date((Math.floor(nowDate(deps).getTime() / 1000) + SETUP_LINK_TTL_SECONDS) * 1000).toISOString() : null };
}

// ── uninstall ──────────────────────────────────────────────────────────────────────────────────

async function uninstall(opts, deps, ui) {
  const names = resourceNames(opts.name);
  const configDir = opts.configDir ?? defaultConfigDir(deps.env, deps.home);
  const dir = instanceDir(configDir, opts.name);
  const state = readState(dir);
  ui.line(`Ready Set Mail uninstall: instance "${opts.name}"`);
  ui.line('');
  if (!state || state.uninstalled_at) {
    fail(`No install of "${opts.name}" is recorded in ${dir}${state?.uninstalled_at ? ' (it was already removed)' : ''}. This command only deletes what this installer created and recorded; nothing was changed.`);
  }
  ui.step(1, 3, 'Checking your Cloudflare credential');
  const { cf, account } = await connect(opts, deps, ui, { expectedAccount: state.account_id });
  ui.step(2, 3, 'Finding what this installer created');
  const existing = await lookupExisting(cf, account.id, names);
  const sel = uninstallSelection(state, existing);
  ui.line('');
  if (sel.delete.length) {
    ui.line(`This will permanently delete, in account ${account.name} (${account.id}):`);
    for (const item of sel.delete) ui.line(`  - ${item.label}`);
  } else ui.line('Nothing recorded by this installer still exists in Cloudflare.');
  for (const item of sel.alreadyGone) ui.line(`  (already gone: ${item.label})`);
  const local = join(deps.repoRoot, LOCAL_CONFIG);
  const localDesc = existsSync(local) ? describeLocalConfig(readFileSync(local, 'utf8')) : null;
  const removeLocal = !!localDesc && localDesc.name === names.worker && localDesc.d1Id === state.created.d1?.id;
  if (removeLocal) ui.line(`  - ${LOCAL_CONFIG} in this checkout`);
  ui.line(`Kept: the backups in ${dir}; DNS records and Email Routing rules the dashboard added to your zones`);
  ui.line('(remove each domain in the dashboard first to take those away). Export any data you want to keep before going on.');
  ui.line('');

  if (opts.confirm !== null) {
    if (opts.confirm !== opts.name) fail(`--confirm "${opts.confirm}" does not match the instance name "${opts.name}". Nothing was deleted.`);
  } else {
    if (!ui.interactive) fail(`Not a terminal: to delete these, add --confirm ${opts.name}. Nothing was deleted.`);
    const typed = await ui.ask(`Type the instance name (${opts.name}) to delete it: `);
    if (typed !== opts.name) fail('The name did not match. Nothing was deleted.');
  }

  ui.step(3, 3, 'Deleting');
  // The Worker first, so nothing is serving from the database while it goes.
  for (const item of sel.delete) {
    if (item.kind === 'worker') await cf.deleteWorker(account.id, item.id);
    if (item.kind === 'd1') await cf.deleteD1(account.id, item.id);
    if (item.kind === 'kv') await cf.deleteKv(account.id, item.id);
    state.created[item.kind] = { ...state.created[item.kind], deleted_at: now(deps) };
    writeState(dir, state);
    ui.ok(`deleted ${item.label}`);
  }
  if (removeLocal) { unlinkSync(local); ui.ok(`removed ${LOCAL_CONFIG}`); }
  state.uninstalled_at = now(deps);
  writeState(dir, state);
  ui.line('');
  ui.line(`Removed. The backups are still in ${dir}; delete that folder when you no longer need them.`);
  return { uninstalled: true, name: opts.name, account_id: account.id, deleted: sel.delete.map(i => i.kind) };
}
