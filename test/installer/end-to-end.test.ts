// `npm run setup` from start to finish against a fake Cloudflare (test/installer/fake-cloudflare.mjs):
// the exact sequence of API calls and commands, the files it leaves, and that no secret is printed
// except inside the one setup link.
import { describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { main } from '../../scripts/setup/install.mjs';
import { ratelimitBase } from '../../scripts/setup/config.mjs';
import { createFakeCloudflare, fakeDeps, TOKEN, ACCOUNT, OTHER_ACCOUNT } from './fake-cloudflare.mjs';

/** A throwaway checkout: the files the installer reads, and a stub where npm install would have put Wrangler. */
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'rsm-install-'));
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'node_modules', 'wrangler'), { recursive: true });
  writeFileSync(join(repo, 'node_modules', 'wrangler', 'package.json'), '{"version":"4.160.0"}');
  for (const f of ['package.json', 'wrangler.jsonc']) cpSync(f, join(repo, f));
  cpSync('migrations', join(repo, 'migrations'), { recursive: true });
  return { repo, home: join(root, 'home') };
}

const PROOF = '01'.repeat(32);                              // randomBytes is faked: first call fills with 0x01
const KEY = `k1:${Buffer.alloc(32, 2).toString('base64')}`; // second call 0x02
const NOW = Date.parse('2026-11-14T12:00:00Z');         // fakeDeps' clock
const EXPIRY = NOW / 1000 + 15 * 60;
/** Independent of the installer: the token rule as the server will check it. */
const expectedLink = (url: string, expiry = EXPIRY) =>
  `${url}/#/setup?t=${expiry}.${createHmac('sha256', PROOF).update(`setup-link:${expiry}`).digest('base64url')}`;
/** Sentences that frighten instead of help. None may appear in any output. */
const SCARE = /whoever|do not share|don't share|first (person|one)|becomes the owner|warning|keep it safe/i;
/** The one allowed proof sentence (until every instance accepts the link). */
const FALLBACK = /^If the page asks for an installer proof, paste the contents of \S+\/bootstrap-proof\.$/;
const NEWEST = readFileSync('packages/db/src/ready.ts', 'utf8').match(/REQUIRED_MIGRATION = '([^']+)'/)![1];

async function run(argv: string[], opts: Parameters<typeof fakeDeps>[0]) {
  const d = fakeDeps(opts);
  const code = await main(argv, d.deps);
  const all = d.out.join('') + d.err.join('');
  // No path a person can reach ends in an unexplained error, and the secrets never appear.
  expect(all).not.toMatch(/unexpected error/i);
  expect(all).not.toContain(PROOF);
  expect(all).not.toContain(KEY);
  return { code, out: d.out.join(''), err: d.err.join('') };
}

describe('npm run setup (fake Cloudflare)', () => {
  it('installs with only a confirmation, in the documented order, and prints the secret only inside the link', async () => {
    const { repo, home } = sandbox();
    const fake = createFakeCloudflare({ repoRoot: repo });
    const r = await run([], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN }, tty: true, answers: ['y'] });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);

    expect(fake.calls).toEqual([
      'GET /accounts',
      'GET /accounts/<acct>/workers/scripts',
      'GET /accounts/<acct>/d1/database',
      'GET /accounts/<acct>/storage/kv/namespaces',
      'GET /accounts/<acct>/workers/subdomain',
      // Rate-limit ids already used by other Workers in the account (none here).
      'GET /accounts/<acct>/workers/scripts',
      'POST /accounts/<acct>/d1/database',
      'POST /accounts/<acct>/storage/kv/namespaces',
      '$ npm run build:dashboard',
      '$ wrangler d1 migrations apply DB --remote --config wrangler.local.jsonc',
      // Re-read just before deploying: a Worker that appeared since must be ours.
      'GET /accounts/<acct>/workers/scripts',
      'GET /accounts/<acct>/d1/database',
      'GET /accounts/<acct>/storage/kv/namespaces',
      '$ wrangler deploy --config wrangler.local.jsonc --secrets-file <file>',
      // Recorded only after the deploy, with the identity Cloudflare reports.
      'GET /accounts/<acct>/workers/scripts',
      'GET /accounts/<acct>/d1/database',
      'GET /accounts/<acct>/storage/kv/namespaces',
      'GET /accounts/<acct>/workers/scripts/ready-set-mail/settings',
      'GET https://ready-set-mail.<sub>.workers.dev/health',
      `POST /accounts/<acct>/d1/database/${fake.world.d1[0].id}/query`,
      'GET https://ready-set-mail.<sub>.workers.dev/api/auth/status',
    ]);

    // Exactly one question in the default path: the confirmation.
    expect(r.out.match(/\[y\/N\]/g)).toHaveLength(1);
    expect(r.out).not.toMatch(/Which account/);

    // The plan came before any change and says what will run.
    const planAt = r.out.indexOf('Plan:');
    expect(planAt).toBeGreaterThan(0);
    expect(planAt).toBeLessThan(r.out.indexOf('[4/9]'));
    for (const c of ['0 4 * * *', '0 8 * * *', '0 9 * * 1', '0 10 * * *', '0 11 * * *']) expect(r.out).toContain(c);
    expect(r.out).toContain('workers.dev address on, preview URLs off');

    // The secret appears once, inside the setup link; the token and the encryption key never.
    expect(r.out).not.toContain(TOKEN);
    expect(r.out).not.toContain(KEY);
    expect(r.out).not.toContain(PROOF);
    expect(r.out).not.toMatch(SCARE);
    expect(r.out).toContain(`Ready Set Mail is running at https://ready-set-mail.example.workers.dev. Open this link to create your owner account:\n\n  ${expectedLink('https://ready-set-mail.example.workers.dev')}\n\nThe link works once and expires in 15 minutes. Need a new one? npm run setup -- --new-link --name ready-set-mail\nIf the page asks for an installer proof, paste the contents of ${join(home, '.config', 'ready-set-mail', 'ready-set-mail', 'bootstrap-proof')}.\n`);
    // The only sentence about the proof is the neutral fallback line.
    expect(r.out.split('\n').filter(l => /proof/i.test(l) && !/first-owner/.test(l))).toEqual([expect.stringMatching(FALLBACK)]);
    expect(r.out).toContain('git pull && npm install && npm run deploy');
    expect(r.out).toContain('npm run setup -- --uninstall --name ready-set-mail');
    expect(r.out).toMatch(/Connect Cloudflare/);

    // What the Worker received, and what was left on disk.
    expect(fake.world.secrets['ready-set-mail']).toEqual({ BOOTSTRAP_SECRET: PROOF, TOKEN_ENCRYPTION_KEY: KEY });
    const cfg = fake.world.lastDeployConfig;
    expect(cfg).toMatchObject({ name: 'ready-set-mail', account_id: ACCOUNT.id, workers_dev: true, preview_urls: false });
    expect(cfg.vars).toMatchObject({ WORKER_NAME: 'ready-set-mail', BETTER_AUTH_URL: 'https://ready-set-mail.example.workers.dev' });
    const dir = join(home, '.config', 'ready-set-mail', 'ready-set-mail');
    expect(readFileSync(join(dir, 'bootstrap-proof'), 'utf8').trim()).toBe(PROOF);
    expect(readFileSync(join(dir, 'token-encryption-key'), 'utf8').trim()).toBe(KEY);
    for (const f of ['bootstrap-proof', 'token-encryption-key', 'state.json']) expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600);
    expect(existsSync(join(dir, '.deploy-secrets.json'))).toBe(false);
    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    expect(state.created).toMatchObject({ d1: { name: 'ready-set-mail' }, kv: { title: 'ready-set-mail-oauth' }, worker: { name: 'ready-set-mail' } });
    expect(JSON.stringify(state)).not.toContain(PROOF);
    expect(readFileSync(join(dir, 'setup.log'), 'utf8')).not.toContain(PROOF);
    // Tracked config untouched.
    expect(readFileSync(join(repo, 'wrangler.jsonc'), 'utf8')).toBe(readFileSync('wrangler.jsonc', 'utf8'));
    expect(fake.world.d1[0].migrations.sort().at(-1)).toBe(NEWEST);
  });

  it('non-interactive with --yes --json: no prompt, human lines on stderr, one JSON line on stdout', async () => {
    const { repo, home } = sandbox();
    const fake = createFakeCloudflare({ repoRoot: repo });
    const r = await run(['--yes', '--json', '--name', 'rsm-ci'], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN } });
    expect(r.code).toBe(0);
    const lines = r.out.trim().split('\n');
    expect(lines).toHaveLength(1);
    const j = JSON.parse(lines[0]);
    expect(j).toMatchObject({ ok: true, name: 'rsm-ci', account_id: ACCOUNT.id, url: 'https://rsm-ci.example.workers.dev', resources: { worker: 'rsm-ci' } });
    expect(j.setup_link).toBe(expectedLink('https://rsm-ci.example.workers.dev'));
    expect(j.setup_link_expires_at).toBe(new Date(EXPIRY * 1000).toISOString());
    expect(r.out + r.err).not.toContain(PROOF);
    expect(r.out + r.err).not.toMatch(SCARE);
    expect(r.err).not.toMatch(/\[y\/N\]/);
    expect(r.err).not.toContain(KEY);
  });

  it('without a terminal and without --yes it changes nothing and names the flag', async () => {
    const { repo, home } = sandbox();
    const fake = createFakeCloudflare({ repoRoot: repo });
    const r = await run([], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN } });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/add --yes/);
    expect(fake.calls.filter(c => !c.startsWith('GET'))).toEqual([]);
  });

  it('refuses names that exist and were not created by it, and changes nothing', async () => {
    const { repo, home } = sandbox();
    const fake = createFakeCloudflare({ repoRoot: repo, workers: ['ready-set-mail'], kv: [{ id: 'f'.repeat(32), title: 'ready-set-mail-oauth' }] });
    const r = await run(['--yes'], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN } });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/already has a Worker named "ready-set-mail" \(this installer has no record of deploying it[^)]*\)\), a KV namespace named "ready-set-mail-oauth", not created by this installer/);
    expect(r.out).toMatch(/--name ready-set-mail-2/);
    expect(fake.calls.filter(c => !c.startsWith('GET'))).toEqual([]);
    expect(existsSync(join(repo, 'wrangler.local.jsonc'))).toBe(false);
  });

  it('several accounts: asks which when interactive, demands --account-id otherwise', async () => {
    const { repo, home } = sandbox();
    const fake = createFakeCloudflare({ repoRoot: repo, accounts: [OTHER_ACCOUNT, ACCOUNT] });
    const ci = await run(['--yes'], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN } });
    expect(ci.code).toBe(1);
    expect(ci.out).toMatch(new RegExp(`choose one with --account-id: ${OTHER_ACCOUNT.id}`));

    const tty = await run([], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN }, tty: true, answers: ['2', 'y'] });
    expect(tty.code).toBe(0);
    expect(tty.out.match(/\[1-2\]|\[y\/N\]/g)).toEqual(['[1-2]', '[y/N]']);
    expect(fake.world.lastDeployConfig.account_id).toBe(ACCOUNT.id);
  });

  it('an unknown CLOUDFLARE_ACCOUNT_ID is refused, never guessed', async () => {
    const { repo, home } = sandbox();
    const fake = createFakeCloudflare({ repoRoot: repo });
    const r = await run(['--yes'], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: 'c'.repeat(32) } });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/is not one this credential can see/);
  });

  it('uses the Wrangler login when there is no token, and fails plainly without either', async () => {
    const { repo, home } = sandbox();
    const fake = createFakeCloudflare({ repoRoot: repo });
    const ok = await run(['--yes', '--dry-run'], { fake, repoRoot: repo, home, authToken: TOKEN });
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/credential works \(your Wrangler login\)/);
    expect(ok.out).toMatch(/Dry run: nothing was changed/);
    const none = await run(['--yes'], { fake, repoRoot: repo, home });
    expect(none.code).toBe(1);
    expect(none.out).toMatch(/Set CLOUDFLARE_API_TOKEN .* or run `npx wrangler login`/);
    expect(fake.calls.filter(c => !c.startsWith('GET'))).toEqual([]);
  });

  it('a bad token stops at the first step', async () => {
    const { repo, home } = sandbox();
    const fake = createFakeCloudflare({ repoRoot: repo });
    const r = await run(['--yes'], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: 'wrong' } });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/is invalid or has expired .*Authentication error.*Create a fresh API token.*Nothing was changed/s);
    expect(r.out).not.toContain('wrong');
  });

  it('is resumable: a failed deploy is continued with --resume without creating anything twice', async () => {
    const { repo, home } = sandbox();
    const fake = createFakeCloudflare({ repoRoot: repo });
    fake.world.failNext.deploy = 1;
    const first = await run(['--yes'], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN } });
    expect(first.code).toBe(1);
    expect(first.out).toMatch(/Deploying failed \(exit 1\)[\s\S]*simulated deploy failure[\s\S]*--resume/);

    const plain = await run(['--yes'], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN } });
    expect(plain.code).toBe(1);
    expect(plain.out).toMatch(/run the same command with --resume/);

    fake.calls.length = 0;
    const again = await run(['--yes', '--resume'], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN } });
    expect(again.code).toBe(0);
    expect(fake.calls.filter(c => c.startsWith('POST /accounts/<acct>/d1/database') && !c.endsWith('/query'))).toEqual([]);
    expect(fake.calls).not.toContain('POST /accounts/<acct>/storage/kv/namespaces');
    expect(fake.world.d1).toHaveLength(1);
    expect(fake.world.kv).toHaveLength(1);
    expect(again.out).toMatch(/reusing the backups/);
    expect(fake.world.secrets['ready-set-mail']).toEqual({ BOOTSTRAP_SECRET: PROOF, TOKEN_ENCRYPTION_KEY: KEY });
  });

  it('a Worker an interrupted deploy created is adopted on --resume only because it is bound to our database and namespace', async () => {
    const { repo, home } = sandbox();
    const fake = createFakeCloudflare({ repoRoot: repo });
    fake.world.deployCreatesThenFails = true;
    expect((await run(['--yes'], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN } })).code).toBe(1);
    expect(fake.world.workers.has('ready-set-mail')).toBe(true);
    const dir = join(home, '.config', 'ready-set-mail', 'ready-set-mail');
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).created.worker).toBeUndefined();
    const again = await run(['--yes', '--resume'], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN } });
    expect(again.code).toBe(0);
    expect(again.out).toMatch(/bound to this installation's database and namespace/);
    const w = fake.world.workers.get('ready-set-mail');
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).created.worker).toMatchObject({ name: 'ready-set-mail', created_on: w.created_on });
  });

  it('BLOCKER 1: a deploy that failed before the Worker existed, then someone else deploys that name: --resume and --uninstall refuse and change nothing', async () => {
    const { repo, home } = sandbox();
    const fake = createFakeCloudflare({ repoRoot: repo });
    fake.world.failNext.deploy = 1;
    expect((await run(['--yes'], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN } })).code).toBe(1);
    expect(fake.world.workers.size).toBe(0);
    // Someone else's Worker with the default name.
    fake.world.workers.set('ready-set-mail', { created_on: '2026-11-15T09:00:00Z', d1Id: 'their-db', kvId: 'their-kv' });
    fake.calls.length = 0;
    const resume = await run(['--yes', '--resume'], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN } });
    expect(resume.code).toBe(1);
    expect(resume.out).toMatch(/already has a Worker named "ready-set-mail" \(this installer has no record of deploying it \(its DB binding is their-db/);
    expect(fake.calls.filter(c => !c.startsWith('GET'))).toEqual([]);

    const un = await run(['--uninstall', '--confirm', 'ready-set-mail'], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN } });
    expect(un.code).toBe(1);
    expect(un.out).toMatch(/is not the one this installer deployed: this installer has no record of deploying it.*Nothing was deleted/s);
    expect(fake.calls.filter(c => c.startsWith('DELETE') || c.startsWith('$'))).toEqual([]);
    expect(fake.world.workers.get('ready-set-mail')).toMatchObject({ d1Id: 'their-db' });
    expect(fake.world.d1).toHaveLength(1);
  });

  it('BLOCKER 1: a stale state file (our Worker was replaced by another of the same name) is refused by --resume and --uninstall', async () => {
    const { repo, home } = sandbox();
    const fake = createFakeCloudflare({ repoRoot: repo });
    expect((await run(['--yes'], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN } })).code).toBe(0);
    // Ours was deleted out of band; someone deploys a new one under the name, even bound to the same ids.
    const ours = fake.world.workers.get('ready-set-mail');
    fake.world.workers.set('ready-set-mail', { ...ours, created_on: '2026-12-01T00:00:00Z' });
    fake.calls.length = 0;
    const resume = await run(['--yes', '--resume'], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN } });
    expect(resume.code).toBe(1);
    expect(resume.out).toMatch(/created at 2026-12-01T00:00:00Z, but the Worker this installer deployed was created at/);
    const un = await run(['--uninstall', '--confirm', 'ready-set-mail'], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN } });
    expect(un.code).toBe(1);
    expect(fake.calls.filter(c => !c.startsWith('GET'))).toEqual([]);
  });

  it('BLOCKER 1: a copied state file whose Worker identity matches but whose bindings point elsewhere is refused', async () => {
    const { repo, home } = sandbox();
    const fake = createFakeCloudflare({ repoRoot: repo });
    expect((await run(['--yes'], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN } })).code).toBe(0);
    const ours = fake.world.workers.get('ready-set-mail');
    fake.world.workers.set('ready-set-mail', { ...ours, d1Id: 'someone-elses-db' });
    fake.calls.length = 0;
    const un = await run(['--uninstall', '--confirm', 'ready-set-mail'], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN } });
    expect(un.code).toBe(1);
    expect(un.out).toMatch(/its DB binding is someone-elses-db.*not this installation's database/s);
    expect(fake.calls.filter(c => !c.startsWith('GET'))).toEqual([]);
    const resume = await run(['--yes', '--resume'], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN } });
    expect(resume.code).toBe(1);
    expect(fake.calls.filter(c => !c.startsWith('GET'))).toEqual([]);
  });

  it('BLOCKER 1: a Worker that appears between the name check and the deploy is not deployed over', async () => {
    const { repo, home } = sandbox();
    const fake = createFakeCloudflare({ repoRoot: repo });
    const realRun = fake.run;
    let armed = true;
    const d = fakeDeps({ fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN } });
    d.deps.run = async (cmd: string, args: string[], o: object) => {
      if (armed && args[1] === 'migrations') { armed = false; fake.world.workers.set('ready-set-mail', { created_on: 'x', d1Id: 'other', kvId: 'other' }); }
      return realRun(cmd, args, o);
    };
    expect(await main(['--yes'], d.deps)).toBe(1);
    expect(d.out.join('')).toMatch(/now exists that this installer did not deploy.*Nothing was deployed/s);
    expect(fake.calls).not.toContain('$ wrangler deploy --config wrangler.local.jsonc --secrets-file <file>');
  });

  it('when an owner already exists it prints no link', async () => {
    const { repo, home } = sandbox();
    const fake = createFakeCloudflare({ repoRoot: repo });
    fake.world.owner = true;
    const r = await run(['--yes'], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN } });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain(PROOF);
    expect(r.out).not.toContain('#/setup');
    expect(r.out).toMatch(/already has an owner/);
  });

  it('uninstall lists what it will delete, needs the typed name, exports the database, deletes only what it created, and moves the backups aside', async () => {
    const { repo, home } = sandbox();
    const fake = createFakeCloudflare({ repoRoot: repo, workers: ['someone-else'], d1: [{ id: 'e'.repeat(32), name: 'someone-else' }] });
    expect((await run(['--yes'], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN } })).code).toBe(0);

    const ci = await run(['--uninstall'], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN } });
    expect(ci.code).toBe(1);
    expect(ci.out).toMatch(/add --confirm ready-set-mail\. Nothing was deleted/);
    const wrong = await run(['--uninstall'], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN }, tty: true, answers: ['ready'] });
    expect(wrong.code).toBe(1);
    expect(wrong.out).toMatch(/did not match\. Nothing was deleted/);
    expect(fake.calls.filter(c => c.startsWith('DELETE') || c.includes('d1 export'))).toEqual([]);

    fake.calls.length = 0;
    const r = await run(['--uninstall'], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN }, tty: true, answers: ['ready-set-mail'] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/This will permanently delete[\s\S]*Worker "ready-set-mail"[\s\S]*D1 database "ready-set-mail"[\s\S]*KV namespace "ready-set-mail-oauth"[\s\S]*wrangler.local.jsonc[\s\S]*the database is exported/);
    const destructive = fake.calls.filter(c => c.startsWith('DELETE') || c.startsWith('$'));
    expect(destructive).toEqual([
      '$ wrangler d1 export ready-set-mail --remote --output',
      'DELETE /accounts/<acct>/workers/scripts/ready-set-mail',
      expect.stringMatching(/^DELETE \/accounts\/<acct>\/d1\/database\/[0-9a-f-]{36}$/),
      expect.stringMatching(/^DELETE \/accounts\/<acct>\/storage\/kv\/namespaces\/[0-9a-f]{32}$/),
    ]);
    expect([...fake.world.workers.keys()]).toEqual(['someone-else']);
    expect(fake.world.d1.map(d => d.name)).toEqual(['someone-else']);
    expect(existsSync(join(repo, 'wrangler.local.jsonc'))).toBe(false);
    // Backups and the export are moved into a dated folder, never deleted.
    const dir = join(home, '.config', 'ready-set-mail', 'ready-set-mail');
    const archive = readdirSync(dir).filter(f => f.startsWith('removed-'));
    expect(archive).toEqual(['removed-20261114-120000']);
    expect(readdirSync(join(dir, archive[0])).sort()).toEqual(['bootstrap-proof', 'ready-set-mail-d1-export.sql', 'setup.log', 'state.json', 'token-encryption-key']);
    expect(readFileSync(join(dir, archive[0], 'token-encryption-key'), 'utf8').trim()).toBe(KEY);
    expect(r.out).toContain(`are in ${join(dir, archive[0])}`);
    const twice = await run(['--uninstall', '--confirm', 'ready-set-mail'], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN } });
    expect(twice.code).toBe(1);
    expect(twice.out).toMatch(/No install of "ready-set-mail" is recorded/);
  });

  it('BLOCKER 2: installing the same name again after uninstall works, in the same home', async () => {
    const { repo, home } = sandbox();
    const fake = createFakeCloudflare({ repoRoot: repo });
    expect((await run(['--yes'], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN } })).code).toBe(0);
    expect((await run(['--uninstall', '--confirm', 'ready-set-mail', '--no-export'], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN } })).code).toBe(0);
    expect(fake.calls.some(c => c.includes('d1 export'))).toBe(false);
    const again = await run(['--yes'], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN } });
    expect(again.code).toBe(0);
    expect(again.out).toMatch(/generated; backups written/);
    expect(fake.world.workers.has('ready-set-mail')).toBe(true);
  });

  it('BLOCKER 2: secret backups with no state are found before anything is created, with a plain message', async () => {
    const { repo, home } = sandbox();
    const fake = createFakeCloudflare({ repoRoot: repo });
    const dir = join(home, '.config', 'ready-set-mail', 'ready-set-mail');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'token-encryption-key'), 'k1:old\n');
    const r = await run(['--yes'], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN } });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/already holds secret backups \(token-encryption-key\).*Nothing was changed\. Move them into a subfolder/s);
    expect(fake.calls).toEqual([]);
    expect(readFileSync(join(dir, 'token-encryption-key'), 'utf8')).toBe('k1:old\n');
  });

  it('a partial uninstall blocks --resume until it is finished, and the second uninstall finishes it', async () => {
    const { repo, home } = sandbox();
    const fake = createFakeCloudflare({ repoRoot: repo });
    expect((await run(['--yes'], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN } })).code).toBe(0);
    fake.world.failDelete = 'kv';
    const first = await run(['--uninstall', '--confirm', 'ready-set-mail', '--no-export'], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN } });
    expect(first.code).toBe(1);
    expect(first.out).toMatch(/Cloudflare refused a request: DELETE \/accounts\/<account>\/storage\/kv\/namespaces\/<namespace> failed: 7000: simulated outage.*Run the uninstall again/s);
    const resume = await run(['--yes', '--resume'], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN } });
    expect(resume.code).toBe(1);
    expect(resume.out).toMatch(/uninstall of "ready-set-mail" started but did not finish/);
    fake.calls.length = 0;
    const second = await run(['--uninstall', '--confirm', 'ready-set-mail', '--no-export'], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN } });
    expect(second.code).toBe(0);
    expect(fake.calls.filter(c => c.startsWith('DELETE'))).toEqual([expect.stringMatching(/storage\/kv\/namespaces/)]);
    expect(fake.world.kv).toEqual([]);
  });

  it('--url with no workers.dev subdomain says what to attach, deploys without workers.dev and checks only the database', async () => {
    const { repo, home } = sandbox();
    const fake = createFakeCloudflare({ repoRoot: repo, subdomain: null });
    const r = await run(['--yes', '--url', 'https://mail.example.com'], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN } });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/--url only sets this address\. After setup, attach mail\.example\.com to the Worker "ready-set-mail"/);
    expect(r.out).toMatch(/no workers\.dev address, preview URLs off/);
    expect(fake.world.lastDeployConfig).toMatchObject({ workers_dev: false, vars: { BETTER_AUTH_URL: 'https://mail.example.com' } });
    expect(fake.calls.filter(c => c.includes('workers.dev') || c.includes('example.com'))).toEqual([]);
    expect(r.out).toContain(expectedLink('https://mail.example.com'));
    const other = sandbox();
    const fresh = createFakeCloudflare({ repoRoot: other.repo, subdomain: null });
    const none = await run(['--yes'], { fake: fresh, repoRoot: other.repo, home: other.home, env: { CLOUDFLARE_API_TOKEN: TOKEN } });
    expect(none.code).toBe(1);
    expect(none.out).toMatch(/no workers\.dev subdomain yet.*Nothing was changed/s);
  });

  it('--new-link mints a fresh link from the backup: no Cloudflare call, no redeploy, no secret printed', async () => {
    const { repo, home } = sandbox();
    const fake = createFakeCloudflare({ repoRoot: repo });
    expect((await run(['--yes'], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN } })).code).toBe(0);
    fake.calls.length = 0;
    const d = fakeDeps({ fake, repoRoot: repo, home });                      // no credential at all
    d.deps.now = () => new Date(NOW + 60 * 60 * 1000);                     // an hour later
    expect(await main(['--new-link'], d.deps)).toBe(0);
    const out = d.out.join('');
    expect(out).toContain(expectedLink('https://ready-set-mail.example.workers.dev', EXPIRY + 3600));
    expect(out).not.toContain(PROOF);
    expect(out).not.toMatch(SCARE);
    expect(fake.calls).toEqual(['GET https://ready-set-mail.<sub>.workers.dev/api/auth/status']);

    fake.world.owner = true;
    const after = fakeDeps({ fake, repoRoot: repo, home });
    expect(await main(['--new-link', '--json'], after.deps)).toBe(0);
    expect(JSON.parse(after.out.join('').trim())).toMatchObject({ ok: true, setup_link: null });
    expect(after.err.join('')).toMatch(/Sign in there with your owner account/);
  });

  it('--new-link without a finished install says what to run', async () => {
    const { repo, home } = sandbox();
    const fake = createFakeCloudflare({ repoRoot: repo });
    const r = await run(['--new-link', '--name', 'nope'], { fake, repoRoot: repo, home });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/No finished install of "nope".*npm run setup -- --name nope first/);
    expect(fake.calls).toEqual([]);
  });

  it('the install docs describe the link without alarm', () => {
    for (const f of ['README.md', 'docs/self-hosting.md', 'docs/coding-agents.md', 'docs/agent-operations.md']) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/whoever opens|do not share it|first person to open|first becomes the owner/i);
    }
  });

  it('an expired login says so and suggests logging in again', async () => {
    const { repo, home } = sandbox();
    const fake = createFakeCloudflare({ repoRoot: repo });
    const r = await run(['--yes'], { fake, repoRoot: repo, home, authToken: 'expired-token' });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/credential from your Wrangler login is invalid or has expired \(GET \/accounts failed: 9109: Invalid access token\)\. Log in again with `npx wrangler login`\. Nothing was changed\./);
  });

  it('each instance gets its own rate-limit namespace ids, past any id another Worker uses, kept on resume', async () => {
    const { repo, home } = sandbox();
    const base = ratelimitBase('ready-set-mail');
    const taken = [0, 1, 2, 3, 4, 5].map(i => String(base + i));
    const fake = createFakeCloudflare({ repoRoot: repo, workers: [{ name: 'other', created_on: 'x', d1Id: null, kvId: null, ratelimitIds: [taken[3]] }] });
    expect((await run(['--yes'], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN } })).code).toBe(0);
    const ids = fake.world.lastDeployConfig.unsafe.bindings.map((b: { namespace_id: string }) => b.namespace_id);
    expect(ids).toEqual([0, 1, 2, 3, 4, 5].map(i => String(base + 10 + i)));
    expect(ids).not.toContain('1001');
    // A second instance in the same account: its own block.
    const second = sandbox();
    fake.world.repoRoot = second.repo;
    expect((await run(['--yes', '--name', 'rsm-two'], { fake, repoRoot: second.repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN } })).code).toBe(0);
    fake.world.repoRoot = repo;
    const ids2 = fake.world.lastDeployConfig.unsafe.bindings.map((b: { namespace_id: string }) => b.namespace_id);
    expect(ids2.filter((id: string) => ids.includes(id))).toEqual([]);
    // Resume keeps the first instance's ids and says it redeploys.
    const again = await run(['--yes', '--resume'], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN } });
    expect(again.code).toBe(0);
    expect(fake.world.lastDeployConfig.unsafe.bindings.map((b: { namespace_id: string }) => b.namespace_id)).toEqual(ids);
    expect(again.out).toMatch(/Redeploy +Worker "ready-set-mail"/);
    expect(again.out).toMatch(/sent again unchanged/);
    expect(again.out).toMatch(/cron triggers \(already running/);
    expect(again.out).toMatch(/ok: redeployed/);
    expect(again.out).not.toMatch(/first version|start running|generated here/);
  });

  it('usage errors exit 2 before touching anything', async () => {
    const { repo, home } = sandbox();
    const fake = createFakeCloudflare({ repoRoot: repo });
    const r = await run(['--name', 'Bad Name'], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN } });
    expect(r.code).toBe(2);
    expect(fake.calls).toEqual([]);
  });

  it('refuses without npm install, and on an unsupported Node', async () => {
    const { repo, home } = sandbox();
    const fake = createFakeCloudflare({ repoRoot: repo });
    const d = fakeDeps({ fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN } });
    d.deps.nodeVersion = 'v20.10.0';
    expect(await main(['--yes'], d.deps)).toBe(1);
    expect(d.out.join('')).toMatch(/Node v20\.10\.0 is not supported/);
  });
});
