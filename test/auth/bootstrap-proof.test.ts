import { createHmac } from 'node:crypto';
import { it, expect } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { verifyBootstrapProof, consumeBootstrapProof } from '../../src/auth/bootstrap';
import { setupToken } from '../../scripts/setup/install.mjs';
import { makeEnv, call, type TestDb } from './helpers';

const SECRET = 'test-only-installer-proof-32-characters-minimum';
const OTHER = 'another-instances-secret-32-characters-minimum!';
const now = () => Math.floor(Date.now() / 1000);

/** Exactly what the installer (`npm run setup`) produces: HMAC-SHA256(secret, "setup-link:" + expiry), base64url, no padding. */
const mint = (secret = SECRET, expiry = now() + 900) => `${expiry}.${createHmac('sha256', secret).update(`setup-link:${expiry}`).digest('base64url')}`;
const row = (db: TestDb, key: string) => db.sqlite.prepare('SELECT value FROM settings WHERE key=?').get(key);

it('a token minted exactly as the installer does is accepted', async () => {
 const token = mint();
 expect(token.split('.')[1]).toHaveLength(43);
 expect(await verifyBootstrapProof(makeEnv(), token)).toBe(true);
});
it("the installer's own setupToken helper mints a token the server accepts, and not for another secret", async () => {
 const token = setupToken(SECRET, Date.now());
 expect(await verifyBootstrapProof(makeEnv(), token)).toBe(true);
 expect(await verifyBootstrapProof(makeEnv(undefined, { BOOTSTRAP_SECRET: OTHER }), token)).toBe(false);
 expect(await verifyBootstrapProof(makeEnv(), setupToken(SECRET, Date.now() - 20 * 60 * 1000))).toBe(false);
});
it('refuses a token dated further ahead than 15 minutes (plus a minute of clock difference)', async () => {
 expect(await verifyBootstrapProof(makeEnv(), mint(SECRET, now() + 960 + 5))).toBe(false);
 expect(await verifyBootstrapProof(makeEnv(), mint(SECRET, now() + 950))).toBe(true);
});
it('refuses an expired token', async () => {
 expect(await verifyBootstrapProof(makeEnv(), mint(SECRET, now() - 1))).toBe(false);
 expect(await verifyBootstrapProof(makeEnv(), mint(SECRET, now()))).toBe(false);
});
it('refuses a wrong signature, a token signed by another instance, a malformed token, and a token without a secret', async () => {
 const good = mint();
 const [expiry, sig] = good.split('.');
 expect(await verifyBootstrapProof(makeEnv(), `${expiry}.${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`)).toBe(false);
 expect(await verifyBootstrapProof(makeEnv(), mint(OTHER))).toBe(false);
 expect(await verifyBootstrapProof(makeEnv(), `${expiry}.short`)).toBe(false);
 expect(await verifyBootstrapProof(makeEnv(), `x${expiry}.${sig}`)).toBe(false);
 expect(await verifyBootstrapProof(makeEnv(), '')).toBe(false);
 expect(await verifyBootstrapProof(makeEnv(), undefined)).toBe(false);
 expect(await verifyBootstrapProof(makeEnv(undefined, { BOOTSTRAP_SECRET: undefined }), good)).toBe(false);
});
it('the raw BOOTSTRAP_SECRET still works as the installer proof', async () => {
 expect(await verifyBootstrapProof(makeEnv(), SECRET)).toBe(true);
 expect(await verifyBootstrapProof(makeEnv(), 'wrong')).toBe(false);
 expect(await verifyBootstrapProof(makeEnv(undefined, { BOOTSTRAP_SECRET: 'short' }), 'short')).toBe(false);
});
it('nothing is accepted after consumption or once an owner exists', async () => {
 const db: TestDb = createMigratedD1();
 const env = makeEnv(db);
 const token = mint();
 expect(await verifyBootstrapProof(env, token)).toBe(true);
 await consumeBootstrapProof(env);
 expect(row(db, 'bootstrap_consumed')).toEqual({ value: 'true' });
 expect(await verifyBootstrapProof(env, token)).toBe(false);
 expect(await verifyBootstrapProof(env, SECRET)).toBe(false);
});
it('a token creates the owner over the API (header only, never a URL); the old header names still work; reuse is refused', async () => {
 for (const header of ['x-ready-set-mail-bootstrap', 'x-inbox-angel-bootstrap']) { // @legacy-name: pre-rename header
  const env = makeEnv();
  const res = await call(env, 'POST', '/api/auth/setup', { headers: header === 'x-ready-set-mail-bootstrap' ? {} : { 'x-ready-set-mail-bootstrap': '', [header]: SECRET }, body: { email: 'a@example.com', password: 'unique-test-password' } });
  expect(res.status).toBe(201);
 }
 const db: TestDb = createMigratedD1();
 const env = makeEnv(db);
 const token = mint();
 const first = await call(env, 'POST', '/api/auth/setup', { headers: { 'x-ready-set-mail-bootstrap': token }, body: { email: 'b@example.com', password: 'unique-test-password' } });
 expect(first.status).toBe(201);
 expect(row(db, 'bootstrap_consumed')).toEqual({ value: 'true' });
 const again = await call(env, 'POST', '/api/auth/setup', { headers: { 'x-ready-set-mail-bootstrap': token }, body: { email: 'c@example.com', password: 'unique-test-password' } });
 expect(again.status).toBe(409); // already configured
 const viaUrl = await call(makeEnv(), 'POST', `/api/auth/setup?proof=${token}`, { body: { email: 'd@example.com', password: 'unique-test-password' } });
 expect(viaUrl.status).toBeGreaterThanOrEqual(400); // a token in the URL proves nothing
});
