// Pure parts of `npm run setup` (scripts/setup/*): flags, names, URLs, config generation, state, secrets.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, UsageError, DEFAULT_NAME } from '../../scripts/setup/args.mjs';
import {
  parseJsonc, resourceNames, workersDevUrl, generateLocalConfig, renderLocalConfig, describeLocalConfig,
  hasPlaceholders, describeCrons, CRON_DESCRIPTIONS,
} from '../../scripts/setup/config.mjs';
import { foreignCollisions, uninstallSelection, writeState, readState, emptyState, statePath } from '../../scripts/setup/state.mjs';
import { generateProof, generateEncryptionKey, isValidEncryptionKey, loadOrCreateSecrets, withSecretsFile } from '../../scripts/setup/secrets.mjs';
import { satisfiesEngines, setupLink } from '../../scripts/setup/install.mjs';
import { wranglerArgs } from '../../scripts/wrangler.mjs';

const tracked = parseJsonc(readFileSync('wrangler.jsonc', 'utf8'));
const tmp = () => mkdtempSync(join(tmpdir(), 'rsm-setup-'));

describe('flags', () => {
  it('defaults to one instance name and nothing else', () => {
    expect(parseArgs([])).toMatchObject({ name: DEFAULT_NAME, accountId: null, url: null, yes: false, resume: false, json: false, uninstall: false });
  });
  it('takes every input as a flag, for agents and CI', () => {
    const o = parseArgs(['--name', 'mail-2', '--account-id', 'a'.repeat(32), '--url', 'https://mail.example.com', '--yes', '--json', '--resume', '--config-dir', '/x']);
    expect(o).toMatchObject({ name: 'mail-2', accountId: 'a'.repeat(32), url: 'https://mail.example.com', yes: true, json: true, resume: true, configDir: '/x' });
  });
  it.each([
    [['--name', 'Ready_Set'], /lowercase/],
    [['--name', 'x-'], /lowercase/],
    [['--name', 'a'.repeat(64)], /1-63/],
    [['--url', 'http://mail.example.com'], /https/],
    [['--url', 'https://mail.example.com/app'], /origin only/],
    [['--url', 'https://u:p@mail.example.com'], /user name/],
    [['--account-id', 'abc'], /32-character/],
    [['--bogus'], /Unknown option/],
    [['--confirm', 'x'], /only used with --uninstall/],
    [['--uninstall', '--url', 'https://a.example'], /--uninstall takes only/],
  ])('refuses %j', (argv, msg) => {
    expect(() => parseArgs(argv)).toThrow(UsageError);
    expect(() => parseArgs(argv)).toThrow(msg);
  });
  it('normalises --url to its origin', () => {
    expect(parseArgs(['--url', 'https://Mail.Example.com/']).url).toBe('https://mail.example.com');
  });
});

describe('names and URL', () => {
  it('derives all three resource names from one instance name', () => {
    expect(resourceNames('ready-set-mail')).toEqual({ worker: 'ready-set-mail', d1: 'ready-set-mail', kv: 'ready-set-mail-oauth' });
  });
  it('builds the workers.dev origin from the Worker name and the account subdomain', () => {
    expect(workersDevUrl('ready-set-mail', 'acme')).toBe('https://ready-set-mail.acme.workers.dev');
    expect(() => workersDevUrl('x', '')).toThrow();
  });
});

describe('local config', () => {
  const ids = { name: 'mail-2', accountId: 'a'.repeat(32), d1Id: 'd1-id', kvId: 'kv-id', url: 'https://mail-2.acme.workers.dev' };
  it('the tracked config parses and still ships placeholders', () => {
    expect(hasPlaceholders(tracked)).toBe(true);
    expect(tracked.workers_dev).toBe(true);
    expect(tracked.preview_urls).toBe(false);
    expect(tracked).not.toHaveProperty('email');
  });
  it('sets name, account, ids, WORKER_NAME, BETTER_AUTH_URL and serving flags; leaves the tracked object alone', () => {
    const before = JSON.stringify(tracked);
    const cfg = generateLocalConfig(tracked, ids);
    expect(JSON.stringify(tracked)).toBe(before);
    expect(cfg).toMatchObject({ name: 'mail-2', account_id: ids.accountId, workers_dev: true, preview_urls: false });
    expect(cfg.d1_databases[0]).toMatchObject({ binding: 'DB', database_name: 'mail-2', database_id: 'd1-id', migrations_dir: 'migrations' });
    expect(cfg.kv_namespaces[0]).toEqual({ binding: 'OAUTH_KV', id: 'kv-id' });
    expect(cfg.vars).toMatchObject({ WORKER_NAME: 'mail-2', BETTER_AUTH_URL: ids.url });
    expect(hasPlaceholders(cfg)).toBe(false);
    expect(cfg).not.toHaveProperty('build');
    // Everything else is carried over unchanged.
    expect(cfg.triggers).toEqual(tracked.triggers);
    expect(cfg.unsafe).toEqual(tracked.unsafe);
    expect(cfg.assets).toEqual(tracked.assets);
  });
  it('round-trips: the rendered file says which instance it belongs to and contains no secret names', () => {
    const text = renderLocalConfig(generateLocalConfig(tracked, ids), { name: 'mail-2' });
    expect(describeLocalConfig(text)).toEqual({ name: 'mail-2', d1Id: 'd1-id', kvId: 'kv-id' });
    expect(text).not.toMatch(/BOOTSTRAP_SECRET"|TOKEN_ENCRYPTION_KEY"/);
  });
  it('refuses a tracked config without exactly one DB and one OAUTH_KV binding', () => {
    expect(() => generateLocalConfig({ ...tracked, kv_namespaces: [] }, ids)).toThrow(/OAUTH_KV/);
  });
  it('parses comments and trailing commas but leaves // inside strings alone', () => {
    expect(parseJsonc('{ // c\n "a": "https://x", /* b */ "b": [1,2,], }')).toEqual({ a: 'https://x', b: [1, 2] });
  });
  it('describes every cron in wrangler.jsonc', () => {
    const crons = describeCrons(tracked);
    expect(crons.length).toBe(tracked.triggers.crons.length);
    for (const c of crons) expect(CRON_DESCRIPTIONS).toHaveProperty([c.cron]);
  });
});

describe('collisions and uninstall selection', () => {
  const names = resourceNames('ready-set-mail');
  const ours = { ...emptyState('ready-set-mail', 'a'.repeat(32)), created: { d1: { id: 'D', name: 'ready-set-mail' }, kv: { id: 'K', title: 'ready-set-mail-oauth' }, worker: { name: 'ready-set-mail' } } };
  it('refuses every existing name when there is no state', () => {
    expect(foreignCollisions({ worker: true, d1: { id: 'D' }, kv: { id: 'K' } }, names, null)).toEqual([
      'a Worker named "ready-set-mail"', 'a D1 database named "ready-set-mail"', 'a KV namespace named "ready-set-mail-oauth"',
    ]);
  });
  it('accepts resources whose ids the state recorded, and only those', () => {
    expect(foreignCollisions({ worker: true, d1: { id: 'D' }, kv: { id: 'K' } }, names, ours)).toEqual([]);
    expect(foreignCollisions({ worker: false, d1: { id: 'OTHER' }, kv: null }, names, ours)).toEqual(['a D1 database named "ready-set-mail"']);
  });
  it('a Worker the state does not record is never ours', () => {
    const noWorker = { ...ours, created: { ...ours.created, worker: undefined } };
    expect(foreignCollisions({ worker: true, d1: null, kv: null }, names, noWorker)).toEqual(['a Worker named "ready-set-mail"']);
  });
  it('uninstall deletes only recorded resources that still match', () => {
    const sel = uninstallSelection(ours, { worker: true, d1: { id: 'OTHER' }, kv: { id: 'K' } });
    expect(sel.delete.map(d => d.kind)).toEqual(['worker', 'kv']);
    expect(sel.alreadyGone.map(d => d.kind)).toEqual(['d1']);
    expect(uninstallSelection(emptyState('x', 'a'), { worker: true, d1: { id: 'D' }, kv: { id: 'K' } }).delete).toEqual([]);
  });
});

describe('state file', () => {
  it('is written atomically with mode 0600 in a 0700 folder and read back', () => {
    const dir = join(tmp(), 'inst');
    const s = emptyState('n', 'a');
    s.created.d1 = { id: 'D', name: 'n' };
    writeState(dir, s);
    expect(readState(dir)).toEqual(s);
    expect(statSync(statePath(dir)).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(existsSync(`${statePath(dir)}.tmp`)).toBe(false);
  });
  it('returns null when absent and refuses another version', () => {
    const dir = tmp();
    expect(readState(dir)).toBeNull();
    writeFileSync(statePath(dir), JSON.stringify({ version: 99 }));
    expect(() => readState(dir)).toThrow(/different installer version/);
  });
});

describe('secrets', () => {
  it('generates a 64-hex proof and a k1:<base64 of 32 bytes> key', () => {
    expect(generateProof()).toMatch(/^[0-9a-f]{64}$/);
    const key = generateEncryptionKey();
    expect(isValidEncryptionKey(key)).toBe(true);
    expect(Buffer.from(key.slice(3), 'base64')).toHaveLength(32);
    expect(isValidEncryptionKey('k1:' + Buffer.alloc(16).toString('base64'))).toBe(false);
  });
  it('backs up with mode 0600, reuses on resume and never overwrites without it', () => {
    const dir = join(tmp(), 'inst');
    const first = loadOrCreateSecrets(dir, { mayReuse: false });
    expect(first.created).toHaveLength(2);
    expect(statSync(first.proofPath).mode & 0o777).toBe(0o600);
    expect(statSync(first.keyPath).mode & 0o777).toBe(0o600);
    const again = loadOrCreateSecrets(dir, { mayReuse: true });
    expect(again).toMatchObject({ proof: first.proof, key: first.key, created: [] });
    expect(() => loadOrCreateSecrets(dir, { mayReuse: false })).toThrow(/already exists/);
    expect(readFileSync(first.proofPath, 'utf8').trim()).toBe(first.proof);
  });
  it('the deploy secrets file exists only while it is used', async () => {
    const dir = tmp();
    let seen = '';
    await withSecretsFile(dir, { A: 'b' }, async (p) => { seen = p; expect(statSync(p).mode & 0o777).toBe(0o600); });
    expect(existsSync(seen)).toBe(false);
    await expect(withSecretsFile(dir, { A: 'b' }, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(existsSync(seen)).toBe(false);
  });
});

describe('npm run wrangler', () => {
  it('adds the local config when it exists and nothing else was asked', () => {
    expect(wranglerArgs(['deploy'], { localExists: true, trackedHasPlaceholders: true }).args).toEqual(['deploy', '--config', 'wrangler.local.jsonc']);
    expect(wranglerArgs(['deploy', '-c', 'x.jsonc'], { localExists: true, trackedHasPlaceholders: true }).args).toEqual(['deploy', '-c', 'x.jsonc']);
  });
  it('explains instead of failing at Cloudflare when only placeholders exist', () => {
    expect(wranglerArgs(['deploy'], { localExists: false, trackedHasPlaceholders: true }).error).toMatch(/npm run setup/);
    expect(wranglerArgs(['d1', 'migrations', 'apply', 'DB', '--remote'], { localExists: false, trackedHasPlaceholders: true }).error).toBeDefined();
    expect(wranglerArgs(['deploy', '--dry-run'], { localExists: false, trackedHasPlaceholders: true }).args).toEqual(['deploy', '--dry-run']);
    expect(wranglerArgs(['d1', 'migrations', 'apply', 'DB', '--local'], { localExists: false, trackedHasPlaceholders: true }).args).toBeDefined();
    expect(wranglerArgs(['deploy'], { localExists: false, trackedHasPlaceholders: false }).args).toEqual(['deploy']);
  });
});

describe('misc', () => {
  it('checks Node against the repository engines', () => {
    const range = JSON.parse(readFileSync('package.json', 'utf8')).engines.node;
    expect(satisfiesEngines(range, 'v22.22.2')).toBe(true);
    expect(satisfiesEngines(range, 'v24.15.0')).toBe(true);
    expect(satisfiesEngines(range, 'v26.1.0')).toBe(true);
    expect(satisfiesEngines(range, 'v22.12.0')).toBe(false);
    expect(satisfiesEngines(range, 'v23.5.0')).toBe(false);
    expect(satisfiesEngines(range, 'v20.18.0')).toBe(false);
  });
  it('the setup link carries the proof in the fragment only', () => {
    const link = setupLink('https://x.acme.workers.dev', 'ab'.repeat(32));
    const u = new URL(link);
    expect(u.origin + u.pathname).toBe('https://x.acme.workers.dev/');
    expect(u.search).toBe('');
    expect(u.hash).toBe(`#/setup?proof=${'ab'.repeat(32)}`);
  });
});
