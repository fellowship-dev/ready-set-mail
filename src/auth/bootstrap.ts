import { forImplicitWorkspace } from '@ready-set-mail/db';
import type { AuthEnv } from './config';
import { hashApiKey } from './api-keys';

/** Constant-time comparison of two equal-purpose hex digests. */
function sameDigest(a: string, b: string): boolean {
 let difference = a.length ^ b.length;
 for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ (b.charCodeAt(i) || 0);
 return difference === 0;
}

/**
 * Installer-held capability. Never accepted in URLs, persisted in clear, or returned to clients.
 * Two forms are accepted: the private `BOOTSTRAP_SECRET`, or a one-time setup link token (`npm run setup-link`) whose
 * SHA-256 and expiry are stored as `setup_link` = `<hex>.<expiresEpochSeconds>`. Setup links need no `BOOTSTRAP_SECRET`.
 */
export async function verifyBootstrapProof(env: AuthEnv, proof: unknown): Promise<boolean> {
 if (typeof proof !== 'string' || proof.length === 0 || proof.length > 512) return false;
 const ws = forImplicitWorkspace(env.DB!);
 if (await ws.settings.get('bootstrap_consumed')) return false;
 if (await ws.team.hasOwner()) return false;
 const actual = await hashApiKey(proof);
 let ok = false;
 if (env.BOOTSTRAP_SECRET && env.BOOTSTRAP_SECRET.length >= 32) ok = sameDigest(actual, await hashApiKey(env.BOOTSTRAP_SECRET));
 const link = (await ws.settings.get('setup_link'))?.value;
 if (link) {
  const [hash = '', expires = ''] = link.split('.');
  const expiresAt = Number(expires);
  const fresh = Number.isFinite(expiresAt) && expiresAt > Math.floor(Date.now() / 1000);
  // Always compare, so timing does not reveal whether a link exists.
  if (sameDigest(actual, hash) && fresh) ok = true;
 }
 return ok;
}
export async function consumeBootstrapProof(env: AuthEnv): Promise<void> {
 const settings = forImplicitWorkspace(env.DB!).settings;
 await settings.set('bootstrap_consumed', 'true');
 await settings.delete('setup_link');
}
