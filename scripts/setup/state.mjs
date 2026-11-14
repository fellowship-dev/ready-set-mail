// Per-instance private folder: the install state (what this installer created, written the moment it
// exists) and the backups of the two secrets that cannot be recovered from Cloudflare.
//
//   <config dir>/<name>/state.json             what was created, and how far the install got
//   <config dir>/<name>/bootstrap-proof        first-owner proof (BOOTSTRAP_SECRET)
//   <config dir>/<name>/token-encryption-key   TOKEN_ENCRYPTION_KEY
//
// The folder is 0700 and every file 0600. Secret files are never overwritten.
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, chmodSync, readdirSync } from 'node:fs';
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

/** A record that exists and was not deleted by a (possibly interrupted) uninstall. */
export const live = (rec) => !!rec && !rec.deleted_at;

/** Any record an uninstall already deleted: the install must not be resumed until that uninstall finishes. */
export function hasDeletedRecords(state) {
  return Object.values(state?.created ?? {}).some(r => r && r.deleted_at);
}

/**
 * Is the Worker with the instance's name the one this installer deployed?
 * `worker` is null (no such Worker) or { created_on, d1Id, kvId } read from Cloudflare just now.
 *  - 'absent'     no Worker with that name
 *  - 'ours'       recorded after a successful deploy, same creation time, bound to our database and namespace
 *  - 'adoptable'  not recorded (a deploy was interrupted after Cloudflare created it), but bound to the
 *                 database and namespace this installer created: no other Worker can carry those ids
 *  - 'foreign'    anything else, with the reason
 */
export function workerOwnership(state, worker) {
  if (!worker) return { status: 'absent' };
  const c = state?.created ?? {};
  const bound = live(c.d1) && live(c.kv) && worker.d1Id === c.d1.id && worker.kvId === c.kv.id;
  const bindingText = `its DB binding is ${worker.d1Id ?? 'missing'} and its OAUTH_KV binding is ${worker.kvId ?? 'missing'}`;
  if (live(c.worker)) {
    if (worker.created_on !== c.worker.created_on) {
      return { status: 'foreign', reason: `it was created at ${worker.created_on ?? 'an unknown time'}, but the Worker this installer deployed was created at ${c.worker.created_on}` };
    }
    if (!bound) return { status: 'foreign', reason: `${bindingText}, not this installation's database ${c.d1?.id} and namespace ${c.kv?.id}` };
    return { status: 'ours' };
  }
  if (bound) return { status: 'adoptable' };
  return { status: 'foreign', reason: `this installer has no record of deploying it (${bindingText})` };
}

/**
 * Which of the existing account resources with this instance's names are NOT this installer's.
 * `existing` is { worker: null|{created_on,d1Id,kvId}, d1: {id}|null, kv: {id}|null }. Returns human descriptions.
 */
export function foreignCollisions(existing, names, state) {
  const out = [];
  const ours = state?.created ?? {};
  const w = workerOwnership(state, existing.worker);
  if (w.status === 'foreign') out.push(`a Worker named "${names.worker}" (${w.reason})`);
  if (existing.d1 && !(live(ours.d1) && ours.d1.id === existing.d1.id)) out.push(`a D1 database named "${names.d1}"`);
  if (existing.kv && !(live(ours.kv) && ours.kv.id === existing.kv.id)) out.push(`a KV namespace named "${names.kv}"`);
  return out;
}

/**
 * What --uninstall may delete: only resources recorded in the state that still exist with the same
 * identity. A Worker with the name that is not provably ours stops the whole uninstall (`refuse`).
 */
export function uninstallSelection(state, existing) {
  const del = [];
  const missing = [];
  const c = state?.created ?? {};
  const w = workerOwnership(state, existing.worker);
  if (w.status === 'foreign') return { refuse: `the Worker named "${state.name}" is not the one this installer deployed: ${w.reason}`, delete: [], alreadyGone: [] };
  if (w.status === 'ours' || w.status === 'adoptable') del.push({ kind: 'worker', label: `Worker "${state.name}"`, id: state.name });
  else if (live(c.worker)) missing.push({ kind: 'worker', label: `Worker "${c.worker.name}"` });
  if (live(c.d1)) (existing.d1?.id === c.d1.id ? del : missing).push({ kind: 'd1', label: `D1 database "${c.d1.name}" (${c.d1.id}) and all its data`, id: c.d1.id, name: c.d1.name });
  if (live(c.kv)) (existing.kv?.id === c.kv.id ? del : missing).push({ kind: 'kv', label: `KV namespace "${c.kv.title}" (${c.kv.id})`, id: c.kv.id });
  return { delete: del, alreadyGone: missing };
}

/** Files an uninstall moves aside (never deletes): the state, both secret backups and the log. */
export const ARCHIVED_FILES = ['state.json', 'bootstrap-proof', 'token-encryption-key', 'setup.log'];

/** `<dir>/removed-YYYYMMDD-HHMMSS`, created 0700. */
export function archiveDir(dir, date) {
  const stamp = date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  // Never reuse a folder that already holds files: an earlier key backup must not be overwritten.
  let out = join(dir, `removed-${stamp}`);
  for (let n = 2; existsSync(out) && readdirSync(out).length; n++) out = join(dir, `removed-${stamp}-${n}`);
  ensurePrivateDir(out);
  return out;
}

/** Move the instance's files into the archive folder. Returns the moved names. */
export function archiveInstanceFiles(dir, archive) {
  const moved = [];
  for (const f of ARCHIVED_FILES) {
    if (existsSync(join(dir, f))) { renameSync(join(dir, f), join(archive, f)); moved.push(f); }
  }
  return moved;
}
