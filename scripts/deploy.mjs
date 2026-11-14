#!/usr/bin/env node
/**
 * `npm run deploy` tail: `wrangler deploy`, then make sure TOKEN_ENCRYPTION_KEY exists and, while there is no owner,
 * print a one-time setup link. Secret and setup-link problems are reported with what to run instead; they never fail
 * the deploy. Pass `--no-setup-link` to skip the link.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mintSetupLink, originFromDeployOutput, printResult } from './setup-link.mjs';

const skipLink = process.argv.includes('--no-setup-link');

const output = await new Promise((resolve) => {
 let text = '';
 const child = spawn('npx', ['wrangler', 'deploy'], { stdio: ['inherit', 'pipe', 'pipe'] });
 child.stdout.on('data', (d) => { text += d; process.stdout.write(d); });
 child.stderr.on('data', (d) => { text += d; process.stderr.write(d); });
 child.on('close', (code) => { if (code) process.exit(code); resolve(text); });
});

const MANUAL_KEY = "openssl rand -base64 32 | sed 's/^/k1:/' | npx wrangler secret put TOKEN_ENCRYPTION_KEY";

/** Secret names from `wrangler secret list --format json`, tolerating a banner line before the JSON array. Null when unreadable. */
function secretNames(stdout) {
 const start = stdout.search(/^\s*\[/m);
 if (start < 0) return null;
 try {
  const list = JSON.parse(stdout.slice(start));
  return Array.isArray(list) ? list.map((s) => s?.name) : null;
 } catch {
  return null;
 }
}

try {
 const list = spawnSync('npx', ['wrangler', 'secret', 'list', '--format', 'json'], { encoding: 'utf8' });
 const names = list.status === 0 ? secretNames(list.stdout ?? '') : null;
 if (!names) {
  console.log(`Could not check whether TOKEN_ENCRYPTION_KEY is set. If Settings says Cloudflare can't be connected, run: ${MANUAL_KEY}`);
 } else if (!names.includes('TOKEN_ENCRYPTION_KEY')) {
  const key = 'k1:' + randomBytes(32).toString('base64');
  const put = spawnSync('npx', ['wrangler', 'secret', 'put', 'TOKEN_ENCRYPTION_KEY'], { input: key + '\n', encoding: 'utf8', stdio: ['pipe', 'ignore', 'ignore'] });
  if (put.status !== 0) throw new Error('could not store the key');
  console.log('Created TOKEN_ENCRYPTION_KEY so the dashboard can connect Cloudflare.');
 }
} catch {
 console.log(`Could not create TOKEN_ENCRYPTION_KEY. Run: ${MANUAL_KEY}`);
}

if (!skipLink) {
 try {
  printResult(mintSetupLink({ origin: originFromDeployOutput(output) }));
 } catch {
  console.log('Could not check for an owner account. Run `npm run setup-link` to get the setup link.');
 }
}
