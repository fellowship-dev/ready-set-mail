import { forImplicitWorkspace } from '@ready-set-mail/db';
import type { AuthEnv } from './config';
import { hashApiKey } from './api-keys';

/** Constant-time comparison of two equal-purpose strings (digests, signatures). */
function sameDigest(a: string, b: string): boolean {
 let difference = a.length ^ b.length;
 for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ (b.charCodeAt(i) || 0);
 return difference === 0;
}

/** A setup link lives 15 minutes; one minute of clock difference between installer and Worker is tolerated. */
export const SETUP_TOKEN_TTL_SECONDS = 900;
const SETUP_TOKEN_SKEW_SECONDS = 60;
const SETUP_TOKEN = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/;

const b64url = (bytes: ArrayBuffer): string => {
 let s = '';
 for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
 return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/**
 * The signature of a setup link: HMAC-SHA256(key = BOOTSTRAP_SECRET as UTF-8, message = "setup-link:" + expiry),
 * base64url without padding (43 characters). The installer (`npm run setup`) signs exactly this.
 */
export async function signSetupToken(secret: string, expiry: string): Promise<string> {
 const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
 return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`setup-link:${expiry}`)));
}

/** A `<expiry>.<sig>` setup token signed with `secret` that has not expired and is not dated further ahead than its lifetime. */
export async function verifySetupToken(secret: string, token: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<boolean> {
 const m = SETUP_TOKEN.exec(token);
 if (!m) return false;
 const expiry = Number(m[1]);
 // Always compute and compare the signature, so timing does not reveal why a token was refused.
 const sigOk = sameDigest(await signSetupToken(secret, m[1]), m[2]);
 return sigOk && expiry > nowSeconds && expiry <= nowSeconds + SETUP_TOKEN_TTL_SECONDS + SETUP_TOKEN_SKEW_SECONDS;
}

/**
 * Installer-held capability. Never accepted in URLs, persisted in clear, or returned to clients.
 * Two forms are accepted, both needing a `BOOTSTRAP_SECRET` of 32+ characters: the secret itself (the installer-proof
 * header), or a short-lived signed setup-link token (`<expiry>.<sig>`) that proves the holder of the secret made it.
 */
export async function verifyBootstrapProof(env: AuthEnv, proof: unknown): Promise<boolean> {
 if (typeof proof !== 'string' || proof.length === 0 || proof.length > 512) return false;
 if (!env.BOOTSTRAP_SECRET || env.BOOTSTRAP_SECRET.length < 32) return false;
 const ws = forImplicitWorkspace(env.DB!);
 if (await ws.settings.get('bootstrap_consumed')) return false;
 if (await ws.team.hasOwner()) return false;
 if (SETUP_TOKEN.test(proof)) return verifySetupToken(env.BOOTSTRAP_SECRET, proof);
 return sameDigest(await hashApiKey(proof), await hashApiKey(env.BOOTSTRAP_SECRET));
}
export async function consumeBootstrapProof(env: AuthEnv): Promise<void> {
 await forImplicitWorkspace(env.DB!).settings.set('bootstrap_consumed', 'true');
}
