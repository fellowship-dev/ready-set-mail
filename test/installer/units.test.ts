// Pure parts of `npm run setup` (scripts/setup/*): flags, names, URLs, config generation, state, secrets.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, UsageError, DEFAULT_NAME } from '../../scripts/setup/args.mjs';
import {
  parseJsonc, resourceNames, workersDevUrl, generateLocalConfig, renderLocalConfig, describeLocalConfig,
  hasPlaceholders, describeCrons, CRON_DESCRIPTIONS, ratelimitBase, freeRatelimitBase, ratelimitBindings,
} from '../../scripts/setup/config.mjs';
import { foreignCollisions, uninstallSelection, workerOwnership, hasDeletedRecords, writeState, readState, emptyState, statePath } from '../../scripts/setup/state.mjs';
import { labelPath, CloudflareError } from '../../scripts/setup/cloudflare.mjs';
import { EventEmitter } from 'node:events';
import { generateProof, generateEncryptionKey, isValidEncryptionKey, loadOrCreateSecrets, withSecretsFile } from '../../scripts/setup/secrets.mjs';
import { satisfiesEngines, setupLink, setupToken, SETUP_LINK_TTL_SECONDS, describeError } from '../../scripts/setup/install.mjs';
import { createHmac } from 'node:crypto';
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
    [['--new-link', '--uninstall'], /--new-link takes only/],
    [['--no-export'], /only used with --uninstall/],
    [['--uninstall', '--url', 'https://a.example'], /--uninstall takes only/],
  ])('refuses %j', (argv, msg) => {
    expect(() => parseArgs(argv)).toThrow(UsageError);
    expect(() => parseArgs(argv)).toThrow(msg);
  });
  it('normalises --url to its origin', () => {
    expect(parseArgs(['--url', 'https://Mail.Example.com/']).url).toBe('https://mail.example.com');
  });
});

describe('rate-limit namespace ids', () => {
  it('are derived from the name: stable, in steps of 10, from 10000, different for different names', () => {
    const b = ratelimitBase('ready-set-mail');
    expect(ratelimitBase('ready-set-mail')).toBe(b);
    expect(b % 10).toBe(0);
    expect(b).toBeGreaterThanOrEqual(10000);
    expect(b).toBeLessThan(1_000_000);
    expect(ratelimitBase('rsm-two')).not.toBe(b);
  });
  it('move past ids in use, and the generated config uses one block for the six bindings', () => {
    expect(freeRatelimitBase(10000, 6, new Set(['10005']))).toBe(10010);
    expect(freeRatelimitBase(10000, 6, new Set(['10006']))).toBe(10000);
    const cfg = generateLocalConfig(tracked, { name: 'n', accountId: 'a', d1Id: 'd', kvId: 'k', url: 'https://x', ratelimitBase: 20000 });
    expect(ratelimitBindings(cfg).map(b => b.namespace_id)).toEqual(['20000', '20001', '20002', '20003', '20004', '20005']);
    expect(ratelimitBindings(cfg).map(b => b.name)).toEqual(ratelimitBindings(tracked).map(b => b.name));
    expect(ratelimitBindings(tracked)[0].namespace_id).toBe('1001');
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
    expect(tracked).not.toHaveProperty('workers_dev');
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
  it('turns workers.dev off when the account has no subdomain', () => {
    expect(generateLocalConfig(tracked, { ...ids, workersDev: false }).workers_dev).toBe(false);
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

describe('collisions, Worker ownership and uninstall selection', () => {
  const names = resourceNames('ready-set-mail');
  const W = { created_on: '2026-11-14T12:00:01Z', d1Id: 'D', kvId: 'K' };
  const ours = { ...emptyState('ready-set-mail', 'a'.repeat(32)), created: { d1: { id: 'D', name: 'ready-set-mail' }, kv: { id: 'K', title: 'ready-set-mail-oauth' }, worker: { name: 'ready-set-mail', created_on: W.created_on } } };
  const noWorkerRecord = { ...ours, created: { d1: ours.created.d1, kv: ours.created.kv } };
  it('refuses every existing name when there is no state', () => {
    const f = foreignCollisions({ worker: W, d1: { id: 'D' }, kv: { id: 'K' } }, names, null);
    expect(f).toHaveLength(3);
    expect(f[0]).toMatch(/^a Worker named "ready-set-mail" \(this installer has no record of deploying it/);
  });
  it('a recorded Worker is ours only with the same creation time and bindings to our database and namespace', () => {
    expect(workerOwnership(ours, W).status).toBe('ours');
    expect(workerOwnership(ours, { ...W, created_on: '2026-12-01T00:00:00Z' })).toMatchObject({ status: 'foreign', reason: expect.stringMatching(/created at 2026-12-01/) });
    expect(workerOwnership(ours, { ...W, d1Id: 'OTHER' })).toMatchObject({ status: 'foreign', reason: expect.stringMatching(/DB binding is OTHER/) });
    expect(workerOwnership(ours, { ...W, kvId: null }).status).toBe('foreign');
    expect(workerOwnership(ours, null).status).toBe('absent');
  });
  it('an unrecorded Worker is adoptable only when bound to our database and namespace; otherwise a collision', () => {
    expect(workerOwnership(noWorkerRecord, W).status).toBe('adoptable');
    expect(workerOwnership(noWorkerRecord, { ...W, d1Id: 'X', kvId: 'Y' }).status).toBe('foreign');
    expect(foreignCollisions({ worker: { ...W, d1Id: 'X' }, d1: null, kv: null }, names, noWorkerRecord)).toHaveLength(1);
  });
  it('records deleted by an uninstall count as absent', () => {
    const half = { ...ours, created: { ...ours.created, d1: { ...ours.created.d1, deleted_at: 'x' } } };
    expect(hasDeletedRecords(half)).toBe(true);
    expect(workerOwnership(half, W).status).toBe('foreign');
    expect(foreignCollisions({ worker: null, d1: { id: 'D' }, kv: null }, names, half)).toEqual(['a D1 database named "ready-set-mail"']);
  });
  it('uninstall deletes only recorded resources that still match, and refuses outright over a foreign Worker', () => {
    const sel = uninstallSelection(ours, { worker: W, d1: { id: 'OTHER' }, kv: { id: 'K' } });
    expect(sel.delete.map(d => d.kind)).toEqual(['worker', 'kv']);
    expect(sel.alreadyGone.map(d => d.kind)).toEqual(['d1']);
    const refused = uninstallSelection(ours, { worker: { ...W, created_on: 'later' }, d1: { id: 'D' }, kv: { id: 'K' } });
    expect(refused.refuse).toMatch(/not the one this installer deployed/);
    expect(refused.delete).toEqual([]);
    expect(uninstallSelection(emptyState('x', 'a'), { worker: null, d1: { id: 'D' }, kv: { id: 'K' } }).delete).toEqual([]);
  });
});

describe('error messages', () => {
  it('label ids in API paths by kind', () => {
    expect(labelPath(`/accounts/${'a'.repeat(32)}/d1/database/0000-11/query`)).toBe('/accounts/<account>/d1/database/<database>/query');
    expect(labelPath(`/accounts/${'a'.repeat(32)}/storage/kv/namespaces/${'b'.repeat(32)}`)).toBe('/accounts/<account>/storage/kv/namespaces/<namespace>');
    expect(labelPath(`/accounts/${'a'.repeat(32)}/workers/scripts/x/settings`)).toBe('/accounts/<account>/workers/scripts/<worker>/settings');
  });
  it('every error has a plain message and what to do; none says "Unexpected"', () => {
    const fsErr = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES', syscall: 'mkdir', path: '/x/y' });
    expect(describeError(fsErr, 'install')).toMatch(/^Could not mkdir \/x\/y \(EACCES\)\. .*--config-dir\. Run the same command with --resume/);
    expect(describeError(new CloudflareError('POST /accounts/<account>/d1/database failed: 7500: quota'), 'install')).toMatch(/^Cloudflare refused a request: .*quota.*permissions/);
    expect(describeError(new Error('boom'), 'uninstall')).toMatch(/^boom\. Run the uninstall again/);
    for (const m of ['install', 'uninstall', 'new-link']) expect(describeError(new TypeError('x'), m)).not.toMatch(/unexpected/i);
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
  it('the deploy secrets file is removed on Ctrl-C and on SIGTERM, with the exit code of the signal', async () => {
    for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
      const dir = tmp();
      const proc = Object.assign(new EventEmitter(), { exit: (c: number) => { exited = c; } });
      let exited = -1;
      let seen = '';
      await withSecretsFile(dir, { A: 'b' }, async (p) => { seen = p; proc.emit(signal, signal); expect(existsSync(p)).toBe(false); }, proc as never);
      expect(exited).toBe(code);
      expect(existsSync(seen)).toBe(false);
      expect(proc.listenerCount('SIGINT') + proc.listenerCount('SIGTERM')).toBe(0);
    }
  });
});

describe('npm run wrangler', () => {
  it('adds the local config when it exists and nothing else was asked', () => {
    expect(wranglerArgs(['deploy'], { localExists: true, trackedHasPlaceholders: true }).args).toEqual(['deploy', '--config', 'wrangler.local.jsonc']);
    expect(wranglerArgs(['deploy', '-c', 'x.jsonc'], { localExists: true, trackedHasPlaceholders: true }).args).toEqual(['deploy', '-c', 'x.jsonc']);
    expect(wranglerArgs(['deploy', '-c=x.jsonc'], { localExists: true, trackedHasPlaceholders: true }).args).toEqual(['deploy', '-c=x.jsonc']);
    expect(wranglerArgs(['deploy', '--config=x.jsonc'], { localExists: true, trackedHasPlaceholders: true }).args).toEqual(['deploy', '--config=x.jsonc']);
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
  it('the setup link carries a 15-minute signed token in the fragment, never the secret', () => {
    const secret = 'ab'.repeat(32);
    const now = Date.parse('2026-11-14T12:00:00Z');
    const link = setupLink('https://x.acme.workers.dev', secret, now);
    const u = new URL(link);
    expect(u.origin + u.pathname).toBe('https://x.acme.workers.dev/');
    expect(u.search).toBe('');
    expect(link).not.toContain(secret);
    const m = /^#\/setup\?t=(\d+)\.([A-Za-z0-9_-]{43})$/.exec(u.hash);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(now / 1000 + SETUP_LINK_TTL_SECONDS);
    expect(SETUP_LINK_TTL_SECONDS).toBe(900);
    expect(m![2]).toBe(createHmac('sha256', secret).update(`setup-link:${m![1]}`).digest('base64url'));
    expect(setupToken(secret, now, 60)).toMatch(new RegExp(`^${now / 1000 + 60}\\.`));
    // Another secret or another expiry gives another signature.
    expect(setupToken('cd'.repeat(32), now)).not.toBe(setupToken(secret, now));
    expect(setupToken(secret, now + 1000)).not.toBe(setupToken(secret, now));
  });
});
