#!/usr/bin/env node
/**
 * `npm run migrate` — the one way to move a Ready Set Mail database forward.
 *
 *   node packages/db/scripts/migrate.mjs [--local | --remote] [--db <binding-or-name>] [--persist-to <dir>]
 *
 * A thin wrapper over `wrangler d1 migrations apply`: unapplied files in /migrations run in
 * name order, each in one transaction, and are recorded by name in `d1_migrations`.
 * The Worker refuses to serve until the newest one (REQUIRED_MIGRATION) is recorded.
 *
 * --remote goes through scripts/wrangler.mjs, so it uses the installer's wrangler.local.jsonc when
 * there is one. --local always uses the tracked wrangler.jsonc, the file `wrangler dev` reads, so the
 * local database migrated here is the one the dev server opens.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const args = process.argv.slice(2);
const flag = args.includes('--local') ? '--local' : '--remote';
const dbIdx = args.indexOf('--db');
const DB = dbIdx >= 0 ? args[dbIdx + 1] : 'DB';
const persistIdx = args.indexOf('--persist-to');
// Local only: keep the miniflare database somewhere other than .wrangler/ (used by tests).
const persist = persistIdx >= 0 ? ['--persist-to', args[persistIdx + 1]] : [];
const config = flag === '--local' ? ['--config', join(repoRoot, 'wrangler.jsonc')] : [];

const apply = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'wrangler.mjs'), 'd1', 'migrations', 'apply', DB, flag, ...persist, ...config], { stdio: 'inherit' });
process.exit(apply.status ?? 1);
