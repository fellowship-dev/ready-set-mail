// The two secrets the installer generates. BETTER_AUTH_SECRET is not one of them: the Worker
// generates its own session-signing secret and keeps it in D1 when the variable is unset (src/auth/secret.ts).
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ensurePrivateDir } from './state.mjs';

export const PROOF_FILE = 'bootstrap-proof';
export const KEY_FILE = 'token-encryption-key';

/** 32 random bytes, hex: URL-safe (it travels in the setup link's fragment) and over the Worker's 32-character minimum. */
export function generateProof(randomBytes = nodeRandomBytes) {
  return randomBytes(32).toString('hex');
}

/** `k1:<base64 of 32 random bytes>`: the format src/connections/crypto.ts reads (key id k1). */
export function generateEncryptionKey(randomBytes = nodeRandomBytes) {
  return `k1:${randomBytes(32).toString('base64')}`;
}

/** Secret backups already in the folder (paths). Checked before anything is created. */
export function existingBackups(dir) {
  return [PROOF_FILE, KEY_FILE].map(f => join(dir, f)).filter(p => existsSync(p));
}

export function isValidEncryptionKey(value) {
  const m = /^k1:([A-Za-z0-9+/]+={0,2})$/.exec(value);
  return !!m && Buffer.from(m[1], 'base64').length === 32;
}

/** Create a 0600 file; refuse to replace one that exists. */
export function writeSecretFile(path, value) {
  writeFileSync(path, value + '\n', { mode: 0o600, flag: 'wx' });
}

/**
 * The instance's proof and encryption key: read from the backups when an earlier run of this installer
 * wrote them (resume), otherwise generated and backed up before anything uses them.
 */
export function loadOrCreateSecrets(dir, { randomBytes, mayReuse }) {
  ensurePrivateDir(dir);
  const proofPath = join(dir, PROOF_FILE);
  const keyPath = join(dir, KEY_FILE);
  const out = { proofPath, keyPath, created: [] };
  for (const [field, path, gen, check] of [
    ['proof', proofPath, () => generateProof(randomBytes), v => /^[0-9a-f]{64}$/.test(v)],
    ['key', keyPath, () => generateEncryptionKey(randomBytes), isValidEncryptionKey],
  ]) {
    if (existsSync(path)) {
      if (!mayReuse) {
        throw new Error(`${path} already exists and this installer did not record writing it. It is left untouched: move it somewhere safe, or continue an earlier install with --resume.`);
      }
      const value = readFileSync(path, 'utf8').trim();
      if (!check(value)) throw new Error(`${path} does not hold a value this installer wrote; it is left untouched`);
      out[field] = value;
    } else {
      const value = gen();
      writeSecretFile(path, value);
      out[field] = value;
      out.created.push(path);
    }
  }
  return out;
}

/**
 * Run `fn(path)` with a 0600 file holding `content`, removed afterwards whatever happens: on success, on an
 * error, and on Ctrl-C or SIGTERM while `fn` runs (then the process exits as the signal would have).
 */
export async function withTempFile(path, content, fn, proc = process) {
  const remove = () => { try { unlinkSync(path); } catch { /* already gone */ } };
  remove();
  writeFileSync(path, content, { mode: 0o600, flag: 'wx' });
  // Ctrl-C or a kill while Wrangler runs: remove the file, then exit as the signal would have.
  const onSignal = (signal) => { remove(); proc.exit(signal === 'SIGINT' ? 130 : 143); };
  proc.once('SIGINT', onSignal);
  proc.once('SIGTERM', onSignal);
  try {
    return await fn(path);
  } finally {
    proc.removeListener('SIGINT', onSignal);
    proc.removeListener('SIGTERM', onSignal);
    remove();
  }
}

/** The JSON secrets file for `wrangler deploy --secrets-file`, in the private instance folder, never in the checkout. */
export function withSecretsFile(dir, secrets, fn, proc = process) {
  return withTempFile(join(dir, '.deploy-secrets.json'), JSON.stringify(secrets), fn, proc);
}
