// Per-instance private folder: the install state (what this installer created, written the moment it
// exists) and the backups of the two secrets that cannot be recovered from Cloudflare.
//
//   <config dir>/<name>/state.json             what was created, and how far the install got
//   <config dir>/<name>/bootstrap-proof        first-owner proof (BOOTSTRAP_SECRET)
//   <config dir>/<name>/token-encryption-key   TOKEN_ENCRYPTION_KEY
//
// The folder is 0700 and every file 0600. Secret files are never overwritten.
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

export const STATE_VERSION = 1;

export function defaultConfigDir(env, home) {
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'ready-set-mail');
}

export function instanceDir(configDir, name) {
  return join(configDir, name);
}

export function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

export function emptyState(name, accountId) {
  return {
    version: STATE_VERSION,
    name,
    account_id: accountId,
    created: {},      // d1: {id, name}, kv: {id, title}, worker: {name}: recorded as soon as each exists
    steps: {},        // step name -> ISO time it finished
    url: null,
    uninstalled_at: null,
  };
}

export function statePath(dir) {
  return join(dir, 'state.json');
}

export function readState(dir) {
  const p = statePath(dir);
  if (!existsSync(p)) return null;
  const s = JSON.parse(readFileSync(p, 'utf8'));
  if (s.version !== STATE_VERSION) throw new Error(`${p} was written by a different installer version (${s.version}); it is left as it is`);
  return s;
}

/** Atomic write: a crash leaves the previous state, never half a file. */
export function writeState(dir, state) {
  ensurePrivateDir(dir);
  const p = statePath(dir);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, p);
}

/**
 * Which of the existing account resources with this instance's names are NOT recorded as ours.
 * `existing` is { worker: bool, d1: {id}|null, kv: {id}|null }. Returns a list of human descriptions.
 */
export function foreignCollisions(existing, names, state) {
  const out = [];
  const ours = state?.created ?? {};
  if (existing.worker && !(ours.worker && ours.worker.name === names.worker)) out.push(`a Worker named "${names.worker}"`);
  if (existing.d1 && !(ours.d1 && ours.d1.id === existing.d1.id)) out.push(`a D1 database named "${names.d1}"`);
  if (existing.kv && !(ours.kv && ours.kv.id === existing.kv.id)) out.push(`a KV namespace named "${names.kv}"`);
  return out;
}

/**
 * What --uninstall may delete: only resources recorded in the state that still exist with the same
 * identity. Anything with the instance's name that the state does not record is reported, never deleted.
 */
export function uninstallSelection(state, existing) {
  const del = [];
  const missing = [];
  const c = state?.created ?? {};
  if (c.worker) (existing.worker ? del : missing).push({ kind: 'worker', label: `Worker "${c.worker.name}"`, id: c.worker.name });
  if (c.d1) (existing.d1?.id === c.d1.id ? del : missing).push({ kind: 'd1', label: `D1 database "${c.d1.name}" (${c.d1.id}) and all its data`, id: c.d1.id });
  if (c.kv) (existing.kv?.id === c.kv.id ? del : missing).push({ kind: 'kv', label: `KV namespace "${c.kv.title}" (${c.kv.id})`, id: c.kv.id });
  return { delete: del, alreadyGone: missing };
}
