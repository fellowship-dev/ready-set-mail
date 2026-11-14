import { it, expect } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { verifyBootstrapProof, consumeBootstrapProof } from '../../src/auth/bootstrap';
import { hashApiKey } from '../../src/auth/api-keys';
import { makeEnv, call, setupOwner, type TestDb } from './helpers';

const SECRET = 'test-only-installer-proof-32-characters-minimum';
const TOKEN = 'setup-link-token-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const now = () => Math.floor(Date.now() / 1000);

async function withLink(expires: number, extra: Record<string, unknown> = {}) {
 const db: TestDb = createMigratedD1();
 const env = makeEnv(db, extra);
 const hash = await hashApiKey(TOKEN);
 db.sqlite.prepare("INSERT INTO settings (workspace_id, key, value) VALUES ('ws_default', 'setup_link', ?)").run(`${hash}.${expires}`);
 return { db, env };
}
const row = (db: TestDb, key: string) => db.sqlite.prepare("SELECT value FROM settings WHERE key=?").get(key);

it('accepts a valid setup link without BOOTSTRAP_SECRET', async () => {
 const { env } = await withLink(now() + 3600, { BOOTSTRAP_SECRET: undefined });
 expect(await verifyBootstrapProof(env, TOKEN)).toBe(true);
});
it('refuses an expired setup link', async () => {
 const { env } = await withLink(now() - 1, { BOOTSTRAP_SECRET: undefined });
 expect(await verifyBootstrapProof(env, TOKEN)).toBe(false);
});
it('refuses a wrong token, empty proof and non-strings', async () => {
 const { env } = await withLink(now() + 3600, { BOOTSTRAP_SECRET: undefined });
 expect(await verifyBootstrapProof(env, TOKEN + 'x')).toBe(false);
 expect(await verifyBootstrapProof(env, '')).toBe(false);
 expect(await verifyBootstrapProof(env, undefined)).toBe(false);
});
it('refuses the link after consumption and deletes it', async () => {
 const { db, env } = await withLink(now() + 3600);
 await consumeBootstrapProof(env);
 expect(row(db, 'setup_link')).toBeUndefined();
 expect(row(db, 'bootstrap_consumed')).toEqual({ value: 'true' });
 expect(await verifyBootstrapProof(env, TOKEN)).toBe(false);
 expect(await verifyBootstrapProof(env, SECRET)).toBe(false);
});
it('refuses the link once an owner exists', async () => {
 const { db, env } = await withLink(now() + 3600);
 db.sqlite.prepare("DELETE FROM settings WHERE key='setup_link'").run();
 await setupOwner(env);
 await withLinkInto(db);
 expect(await verifyBootstrapProof(env, TOKEN)).toBe(false);
});
async function withLinkInto(db: TestDb) {
 db.sqlite.prepare("INSERT OR REPLACE INTO settings (workspace_id, key, value) VALUES ('ws_default', 'setup_link', ?)").run(`${await hashApiKey(TOKEN)}.${now() + 3600}`);
}
it('BOOTSTRAP_SECRET still works, with or without a link stored', async () => {
 const { env } = await withLink(now() - 10);
 expect(await verifyBootstrapProof(env, SECRET)).toBe(true);
 expect(await verifyBootstrapProof(makeEnv(), SECRET)).toBe(true);
 expect(await verifyBootstrapProof(makeEnv(), 'wrong')).toBe(false);
 expect(await verifyBootstrapProof(makeEnv(undefined, { BOOTSTRAP_SECRET: 'short' }), 'short')).toBe(false);
});
it('legacy and current headers both still create the owner; a setup link works over the API', async () => {
 for (const header of ['x-ready-set-mail-bootstrap', 'x-inbox-angel-bootstrap']) { // @legacy-name: pre-rename header
  const env = makeEnv();
  const res = await call(env, 'POST', '/api/auth/setup', { headers: header === 'x-ready-set-mail-bootstrap' ? {} : { 'x-ready-set-mail-bootstrap': '', [header]: SECRET }, body: { email: 'a@example.com', password: 'unique-test-password' } });
  expect(res.status).toBe(201);
 }
 const { db, env } = await withLink(now() + 3600, { BOOTSTRAP_SECRET: undefined });
 const res = await call(env, 'POST', '/api/auth/setup', { headers: { 'x-ready-set-mail-bootstrap': TOKEN }, body: { email: 'b@example.com', password: 'unique-test-password' } });
 expect(res.status).toBe(201);
 expect(row(db, 'setup_link')).toBeUndefined();
 expect(row(db, 'bootstrap_consumed')).toEqual({ value: 'true' });
});
