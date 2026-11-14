#!/usr/bin/env node
/**
 * `npm run setup-link [-- --local] [-- --url <origin>]` — mint the one-time link that creates the first owner.
 *
 * Refuses when an owner already exists. Otherwise generates a random token locally, stores ONLY its SHA-256 and an
 * expiry (24 hours) in D1 `settings` (`setup_link` = `<hex>.<expiresEpochSeconds>`, replacing any earlier link) and
 * prints `<instance URL>/#/claim/<token>`. The token itself is never stored or sent anywhere but your terminal.
 * In GitHub Actions no link is minted (logs may be public).
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SETUP_LINK_TTL_SECONDS = 24 * 60 * 60;

function d1(target, sql) {
 const r = spawnSync('npx', ['wrangler', 'd1', 'execute', 'DB', target, '--json', '--command', sql], { encoding: 'utf8' });
 if (r.status !== 0) throw new Error((r.stderr || r.stdout || 'wrangler d1 execute failed').trim().split('\n').slice(-3).join('\n'));
 try {
  const parsed = JSON.parse(r.stdout);
  return (Array.isArray(parsed) ? parsed[0]?.results : parsed?.results) ?? [];
 } catch {
  throw new Error('could not read the wrangler d1 output');
 }
}

/** BETTER_AUTH_URL from the environment or wrangler.jsonc vars, else null. */
export function configuredOrigin(env = process.env) {
 if (env.BETTER_AUTH_URL) return env.BETTER_AUTH_URL.replace(/\/+$/, '');
 for (const file of ['wrangler.jsonc', 'wrangler.json']) {
  if (!existsSync(file)) continue;
  const text = readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '');
  const m = text.match(/"BETTER_AUTH_URL"\s*:\s*"(https?:\/\/[^"]+)"/);
  if (m) return m[1].replace(/\/+$/, '');
 }
 return null;
}

/** The workers.dev URL in wrangler deploy output, else the first https URL (custom domain). */
export function originFromDeployOutput(text) {
 const dev = /https:\/\/[a-z0-9.-]+\.workers\.dev(?=[\s/]|$)/i.exec(text ?? '');
 if (dev) return dev[0];
 const m = /https:\/\/[a-z0-9.-]+\.(?:workers\.dev|[a-z]{2,})(?=[\s/]|$)/i.exec(text ?? '');
 return m ? m[0] : null;
}

/**
 * Returns { status: 'created', url } | { status: 'owner_exists' } | { status: 'skipped' } | throws on D1 failure.
 * Prints nothing itself.
 */
export function mintSetupLink({ local = false, origin = null, env = process.env } = {}) {
 if (env.GITHUB_ACTIONS === 'true') return { status: 'skipped' };
 const target = local ? '--local' : '--remote';
 const owners = d1(target, "SELECT COUNT(*) AS n FROM memberships WHERE role = 'owner'");
 if (Number(owners[0]?.n ?? 0) > 0) return { status: 'owner_exists' };
 const token = randomBytes(32).toString('base64url');
 const hash = createHash('sha256').update(token).digest('hex');
 const expires = Math.floor(Date.now() / 1000) + SETUP_LINK_TTL_SECONDS;
 d1(target, `INSERT INTO settings (workspace_id, key, value) VALUES ('ws_default', 'setup_link', '${hash}.${expires}') ON CONFLICT (workspace_id, key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`);
 const base = origin || configuredOrigin(env) || (local ? 'http://localhost:8787' : null);
 return { status: 'created', url: base ? `${base}/#/claim/${token}` : null, fragment: `/#/claim/${token}` };
}

export function printResult(result) {
 if (result.status === 'skipped') return console.log('Run `npm run setup-link` on your machine to get the setup link.');
 if (result.status === 'owner_exists') return console.log('An owner account already exists, so no setup link was made.');
 const link = result.url ?? `Open your Worker's address followed by ${result.fragment}`;
 const lines = ['Next: open this link to create the owner account (works once, for 24 hours):', '', link];
 const width = Math.max(...lines.map((l) => l.length));
 console.log(['+-' + '-'.repeat(width) + '-+', ...lines.map((l) => '| ' + l.padEnd(width) + ' |'), '+-' + '-'.repeat(width) + '-+'].join('\n'));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
 const args = process.argv.slice(2);
 const urlIdx = args.indexOf('--url');
 try {
  printResult(mintSetupLink({ local: args.includes('--local'), origin: urlIdx >= 0 ? args[urlIdx + 1] : null }));
 } catch (e) {
  console.error(`Could not create the setup link: ${e.message}`);
  console.error('Check that you are logged in to Wrangler (npx wrangler whoami) and the DB binding exists, then run `npm run setup-link` again.');
  process.exit(1);
 }
}
