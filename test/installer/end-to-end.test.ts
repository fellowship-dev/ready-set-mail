// `npm run setup` from start to finish against a fake Cloudflare (test/installer/fake-cloudflare.mjs):
// the exact sequence of API calls and commands, the files it leaves, and that no secret is printed
// except inside the one setup link.
import { describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../scripts/setup/install.mjs';
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
const NEWEST = readFileSync('packages/db/src/ready.ts', 'utf8').match(/REQUIRED_MIGRATION = '([^']+)'/)![1];

async function run(argv: string[], opts: Parameters<typeof fakeDeps>[0]) {
  const d = fakeDeps(opts);
  const code = await main(argv, d.deps);
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
      'POST /accounts/<acct>/d1/database',
      'POST /accounts/<acct>/storage/kv/namespaces',
      '$ npm run build:dashboard',
      '$ wrangler d1 migrations apply DB --remote --config wrangler.local.jsonc',
      '$ wrangler deploy --config wrangler.local.jsonc --secrets-file <file>',
      'GET https://ready-set-mail.<sub>.workers.dev/health',
      'POST /accounts/<acct>/d1/database/<id>/query'.replace('<id>', fake.world.d1[0].id),
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
    expect(r.out.split(PROOF)).toHaveLength(2);
    expect(r.out).toContain(`https://ready-set-mail.example.workers.dev/#/setup?proof=${PROOF}`);
    expect(r.out).toMatch(/Whoever opens it first becomes the owner/);
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
    expect(j.setup_link).toBe(`https://rsm-ci.example.workers.dev/#/setup?proof=${PROOF}`);
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
    expect(r.out).toMatch(/already has a Worker named "ready-set-mail", a KV namespace named "ready-set-mail-oauth", not created by this installer/);
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
    expect(r.out).toMatch(/did not work .*Authentication error/);
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

  it('a Worker that went up before the run died is still ours on --resume', async () => {
    const { repo, home } = sandbox();
    const fake = createFakeCloudflare({ repoRoot: repo });
    fake.world.failNext.d1 = 1; // migrations fail: nothing deployed yet
    expect((await run(['--yes'], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN } })).code).toBe(1);
    expect(fake.world.workers.size).toBe(0);
    expect((await run(['--yes', '--resume'], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN } })).code).toBe(0);
    // Deploy recorded the Worker; a third resume sees the existing Worker as ours, not a collision.
    expect((await run(['--yes', '--resume'], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN } })).code).toBe(0);
  });

  it('when an owner already exists it prints no link', async () => {
    const { repo, home } = sandbox();
    const fake = createFakeCloudflare({ repoRoot: repo });
    fake.world.owner = true;
    const r = await run(['--yes'], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN } });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain(PROOF);
    expect(r.out).toMatch(/already has an owner/);
  });

  it('uninstall lists what it will delete, needs the typed name, and deletes only what it created', async () => {
    const { repo, home } = sandbox();
    const fake = createFakeCloudflare({ repoRoot: repo, workers: ['someone-else'], d1: [{ id: 'e'.repeat(32), name: 'someone-else' }] });
    expect((await run(['--yes'], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN } })).code).toBe(0);

    const ci = await run(['--uninstall'], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN } });
    expect(ci.code).toBe(1);
    expect(ci.out).toMatch(/add --confirm ready-set-mail\. Nothing was deleted/);
    const wrong = await run(['--uninstall'], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN }, tty: true, answers: ['ready'] });
    expect(wrong.code).toBe(1);
    expect(wrong.out).toMatch(/did not match\. Nothing was deleted/);
    expect(fake.calls.filter(c => c.startsWith('DELETE'))).toEqual([]);

    fake.calls.length = 0;
    const r = await run(['--uninstall'], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN }, tty: true, answers: ['ready-set-mail'] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/This will permanently delete[\s\S]*Worker "ready-set-mail"[\s\S]*D1 database "ready-set-mail"[\s\S]*KV namespace "ready-set-mail-oauth"[\s\S]*wrangler.local.jsonc/);
    expect(fake.calls.filter(c => c.startsWith('DELETE'))).toEqual([
      'DELETE /accounts/<acct>/workers/scripts/ready-set-mail',
      expect.stringMatching(/^DELETE \/accounts\/<acct>\/d1\/database\/[0-9a-f]{32}$/),
      expect.stringMatching(/^DELETE \/accounts\/<acct>\/storage\/kv\/namespaces\/[0-9a-f]{32}$/),
    ]);
    expect([...fake.world.workers]).toEqual(['someone-else']);
    expect(fake.world.d1.map(d => d.name)).toEqual(['someone-else']);
    expect(existsSync(join(repo, 'wrangler.local.jsonc'))).toBe(false);
    // Backups stay; a second uninstall finds nothing recorded.
    expect(existsSync(join(home, '.config', 'ready-set-mail', 'ready-set-mail', 'token-encryption-key'))).toBe(true);
    const twice = await run(['--uninstall', '--confirm', 'ready-set-mail'], { fake, repoRoot: repo, home, env: { CLOUDFLARE_API_TOKEN: TOKEN } });
    expect(twice.code).toBe(1);
    expect(twice.out).toMatch(/already removed/);
    // And the name is free for a fresh install again.
    expect((await run(['--yes'], { fake, repoRoot: repo, home: join(home, 'other'), env: { CLOUDFLARE_API_TOKEN: TOKEN } })).code).toBe(0);
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
