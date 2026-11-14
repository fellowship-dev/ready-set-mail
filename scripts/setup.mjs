#!/usr/bin/env node
// `npm run setup`: install Ready Set Mail on your Cloudflare account. See docs/self-hosting.md.
// The logic is in scripts/setup/install.mjs; this file connects it to the real world.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from './setup/install.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const wranglerBin = join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
// Never hand a generated secret to a child process through the environment.
const SCRUB = ['BOOTSTRAP_SECRET', 'TOKEN_ENCRYPTION_KEY', 'BETTER_AUTH_SECRET'];

function childEnv(accountId) {
  const env = { ...process.env };
  for (const k of SCRUB) delete env[k];
  if (accountId) env.CLOUDFLARE_ACCOUNT_ID = accountId;
  return env;
}

/** Run a command with no terminal attached (Wrangler then answers its own prompts with the default), capturing output. */
function run(cmd, args, { accountId, inherit = false } = {}) {
  return new Promise((resolve) => {
    const bin = cmd === 'wrangler' ? wranglerBin : cmd;
    const child = spawn(bin, args, {
      cwd: repoRoot,
      env: childEnv(accountId),
      stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (d) => { output += d; });
    child.stderr?.on('data', (d) => { output += d; });
    child.on('error', (e) => resolve({ code: 127, output: `${output}\n${e.message}` }));
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

async function wranglerAuthToken() {
  const r = await run('wrangler', ['auth', 'token', '--json']);
  if (r.code !== 0) return null;
  const start = r.output.indexOf('{');
  try {
    const parsed = JSON.parse(r.output.slice(start, r.output.lastIndexOf('}') + 1));
    return (parsed.type === 'oauth' || parsed.type === 'api_token') && parsed.token ? parsed.token : null;
  } catch {
    return null;
  }
}

const code = await main(process.argv.slice(2), {
  repoRoot,
  env: process.env,
  home: homedir(),
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  isTTY: !!(process.stdin.isTTY && process.stdout.isTTY),
  nodeVersion: process.version,
  wranglerVersion: () => JSON.parse(readFileSync(join(repoRoot, 'node_modules', 'wrangler', 'package.json'), 'utf8')).version,
  fetch: globalThis.fetch,
  randomBytes,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  run,
  wranglerAuthToken,
  wranglerLogin: async () => (await run('wrangler', ['login'], { inherit: true })).code,
});
process.exitCode = code;
