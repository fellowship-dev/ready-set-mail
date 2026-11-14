#!/usr/bin/env node
// `npm run wrangler -- <args>`: the project's own Wrangler, pointed at this checkout's installation.
// When `npm run setup` has written wrangler.local.jsonc it is used (unless --config/-c is given), so
// `npm run deploy`, `npm run migrate` and one-off commands reach your instance without editing the
// tracked wrangler.jsonc. Without it, a remote command with the tracked placeholders stops with a
// plain explanation instead of a Cloudflare error.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_CONFIG, TRACKED_CONFIG, parseJsonc, hasPlaceholders } from './setup/config.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The arguments to hand Wrangler, or { error } when the command cannot work with the tracked placeholders. */
export function wranglerArgs(args, { localExists, trackedHasPlaceholders }) {
  const explicit = args.some(a => a === '--config' || a === '-c' || a.startsWith('--config='));
  if (explicit) return { args };
  if (localExists) return { args: [...args, '--config', LOCAL_CONFIG] };
  const remote = !args.includes('--dry-run') && (args[0] === 'deploy' || args.includes('--remote') || args[0] === 'secret' || args[0] === 'versions');
  if (remote && trackedHasPlaceholders) {
    return {
      error: `${TRACKED_CONFIG} still has the REPLACE_WITH_… placeholder ids and there is no ${LOCAL_CONFIG}.\n`
        + 'Install with `npm run setup` (it creates the resources and that file), or follow docs/self-hosting.md#manual-install.',
    };
  }
  return { args };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const tracked = parseJsonc(readFileSync(join(repoRoot, TRACKED_CONFIG), 'utf8'));
  const r = wranglerArgs(process.argv.slice(2), {
    localExists: existsSync(join(repoRoot, LOCAL_CONFIG)),
    trackedHasPlaceholders: hasPlaceholders(tracked),
  });
  if (r.error) {
    process.stderr.write(`${r.error}\n`);
    process.exit(1);
  }
  const bin = join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
  const res = spawnSync(bin, r.args, { stdio: 'inherit', cwd: repoRoot });
  process.exit(res.status ?? 1);
}
