// Mints the one-time first-owner link for a throwaway local instance (e2e and the browser walk only).
//   node e2e/support/mint-setup-link.mjs --persist-to <dir> --url <origin>   → prints <origin>/#/claim/<token>
// It does what the Worker's setup link expects: only the token's SHA-256 and an expiry go into settings
// (`setup_link` = `<hex>.<expiresEpochSeconds>`, workspace ws_default); the token is printed once and kept nowhere.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }
const persist = arg('--persist-to');
const origin = (arg('--url') ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const token = randomBytes(32).toString('base64url');
const hash = createHash('sha256').update(token).digest('hex');
const expires = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
const sql = `INSERT INTO settings (workspace_id, key, value) VALUES ('ws_default', 'setup_link', '${hash}.${expires}') ON CONFLICT (workspace_id, key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`;
const r = spawnSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', ...(persist ? ['--persist-to', persist] : []), '--json', '--command', sql], { encoding: 'utf8' });
if (r.status !== 0) { console.error('could not store the setup link'); process.exit(1); }
console.log(`${origin}/#/claim/${token}`);
