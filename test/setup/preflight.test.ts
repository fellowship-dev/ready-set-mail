import { describe, expect, it } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import type { BoundEnv } from '../../src/index';
import { agentAvailability, instancePreflight } from '../../src/setup/preflight';
import { call, inviteAndAccept, makeEnv, setupOwner, type TestDb } from '../auth/helpers';

const ORIGIN = 'https://ia.example.com';
const kv = {} as KVNamespace;
const sendEmail = { send: async () => {} } as unknown as SendEmail;
const bound = { limit: async () => ({ success: true }) };
const limiters = { API_LIMITER: bound, AUTH_LIMITER: bound, MCP_LIMITER: bound, OAUTH_TOKEN_LIMITER: bound, MCP_ANON_LIMITER: bound, DNS_PREVIEW_LIMITER: bound };
function env(extra: Record<string, unknown> = {}): BoundEnv {
 const db = createMigratedD1();
 return { DB: db as unknown as D1Database, ...extra } as BoundEnv;
}
const ids = async (e: BoundEnv, origin = ORIGIN) => (await instancePreflight(e, origin)).items.map(i => `${i.severity}:${i.id}`);

describe('instance preflight', () => {
 it('a fully configured self-host instance has nothing to report', async () => {
  const e = env({ OAUTH_KV: kv, BETTER_AUTH_URL: ORIGIN, SEND_EMAIL: sendEmail, TOKEN_ENCRYPTION_KEY: 'k1:x' });
  (e.DB as unknown as TestDb).sqlite.prepare("INSERT INTO settings (workspace_id, key, value) VALUES ('ws_default', 'from_email', 'noreply@reports.example.com')").run();
  const result = await instancePreflight(e, ORIGIN);
  expect(result).toEqual({ mode: 'self-host', agents: { available: true, server_url: `${ORIGIN}/mcp`, dynamic_registration: false, metadata_documents: false }, items: [] });
 });

 it('names each missing self-host setting once, in one result', async () => {
  expect(await ids(env())).toEqual(['action:auth_url', 'action:oauth_storage', 'note:mail_sender', 'action:cloudflare_connections']);
  const result = await instancePreflight(env(), ORIGIN);
  expect(result.agents).toEqual({ available: false, server_url: null, dynamic_registration: false, metadata_documents: false });
  expect(result.items.find(i => i.id === 'oauth_storage')).toMatchObject({ setting: 'OAUTH_KV', message: expect.stringContaining('agents cannot connect') });
 });

 it('hosted mode needs the bot check and a mail sender to open sign-up, and a booking link', async () => {
  const hosted = env({ MODE: 'saas', SAAS_ENABLED: '1', OAUTH_KV: kv, BETTER_AUTH_URL: ORIGIN });
  expect(await ids(hosted)).toEqual(['action:mail_sender', 'action:bot_check', 'note:cloudflare_connections', 'action:rate_limits', 'action:intake', 'note:intake', 'note:booking_link']);
  const ready = env({ TOKEN_ENCRYPTION_KEY: 'k1:x', MODE: 'saas', SAAS_ENABLED: '1', AUTHSERV_ID: 'mx.cloudflare.net', AUTHSERV_HEADER: 'ar', ...limiters, OAUTH_KV: kv, BETTER_AUTH_URL: ORIGIN, SEND_EMAIL: sendEmail, TURNSTILE_SECRET_KEY: 'x', TURNSTILE_SITE_KEY: 'y', BOOKING_URL: 'https://cal.example/max', INTAKE_DOMAIN: 'rua.example.com', HOSTED_CONNECT_REPORTS: 'all' });
  (ready.DB as unknown as TestDb).sqlite.prepare("INSERT INTO settings (workspace_id, key, value) VALUES ('ws_default', 'base_domain', 'example.com')").run();
  expect(await ids(ready)).toEqual(['note:intake']); // the one line that always shows HOSTED_CONNECT_REPORTS's current value
 });

 it('flags inconsistent settings: an unknown mode, SAAS_ENABLED without saas, one Turnstile key, open client registration, a different address', async () => {
  const odd = env({ MODE: 'hosted', OAUTH_KV: kv, BETTER_AUTH_URL: ORIGIN, SEND_EMAIL: sendEmail, TURNSTILE_SITE_KEY: 'only-one', MCP_DCR_ENABLED: '1' });
  expect(await ids(odd, 'https://other.example.com')).toEqual(['action:mode', 'note:auth_url', 'note:client_registration', 'note:mail_sender', 'action:bot_check', 'action:cloudflare_connections']);
  expect(await ids(env({ SAAS_ENABLED: '1', OAUTH_KV: kv, BETTER_AUTH_URL: ORIGIN }))).toContain('note:mode');
  expect(await ids(env({ OAUTH_KV: kv, BETTER_AUTH_URL: 'http://ia.example.com/path' }))).toContain('action:auth_url');
 });

 it('without TOKEN_ENCRYPTION_KEY: self-host gets an action with the fix, hosted only a note, and the key is never shown', async () => {
  const self = (await instancePreflight(env({ OAUTH_KV: kv, BETTER_AUTH_URL: ORIGIN, SEND_EMAIL: sendEmail }), ORIGIN)).items.find(i => i.id === 'cloudflare_connections');
  expect(self).toMatchObject({ severity: 'action', setting: 'TOKEN_ENCRYPTION_KEY', message: expect.stringContaining('npx wrangler secret put TOKEN_ENCRYPTION_KEY') });
  expect(self!.message).toContain('npx wrangler secret put TOKEN_ENCRYPTION_KEY');
  const hosted = (await instancePreflight(env({ MODE: 'saas', SAAS_ENABLED: '1' }), ORIGIN)).items.find(i => i.id === 'cloudflare_connections');
  expect(hosted?.severity).toBe('note');
  const withKey = await instancePreflight(env({ TOKEN_ENCRYPTION_KEY: 'k1:secret-key-value' }), ORIGIN);
  expect(withKey.items.some(i => i.id === 'cloudflare_connections')).toBe(false);
  expect(JSON.stringify(withKey)).not.toContain('secret-key-value');
 });

 it('never includes a configured value, secret or not', async () => {
  const values = {
   BETTER_AUTH_URL: 'http://not-https.example/secret-path', TURNSTILE_SECRET_KEY: 'turnstile-secret-value-123', BOOKING_URL: 'ftp://booking-value.example',
   MODE: 'mode-value-xyz', MCP_DCR_ENABLED: '1', BETTER_AUTH_SECRET: 'auth-secret-value-456', BOOTSTRAP_SECRET: 'bootstrap-secret-value-789',
  };
  const text = JSON.stringify(await instancePreflight(env(values), ORIGIN));
  for (const v of Object.values(values).filter(v => v !== '1')) expect(text).not.toContain(v);
 });

 it('agents are available only with OAuth storage and a canonical HTTPS address', () => {
  const none = { available: false, server_url: null, dynamic_registration: false, metadata_documents: false };
  expect(agentAvailability({ OAUTH_KV: kv, BETTER_AUTH_URL: ORIGIN })).toEqual({ available: true, server_url: `${ORIGIN}/mcp`, dynamic_registration: false, metadata_documents: false });
  expect(agentAvailability({ BETTER_AUTH_URL: ORIGIN })).toEqual(none);
  expect(agentAvailability({ OAUTH_KV: kv })).toEqual(none);
  expect(agentAvailability({ OAUTH_KV: kv, BETTER_AUTH_URL: 'http://ia.example.com' })).toEqual(none);
 });

 it('says what the instance really supports: registration only when the owner turned it on, client documents only with the Worker flag the library needs', () => {
  const g = globalThis as { Cloudflare?: unknown };
  const before = g.Cloudflare;
  try {
   expect(agentAvailability({ OAUTH_KV: kv, BETTER_AUTH_URL: ORIGIN, MCP_DCR_ENABLED: '1' })).toMatchObject({ dynamic_registration: true, metadata_documents: false });
   expect(agentAvailability({ OAUTH_KV: kv, BETTER_AUTH_URL: ORIGIN, MCP_DCR_ENABLED: 'true' })).toMatchObject({ dynamic_registration: false });
   g.Cloudflare = { compatibilityFlags: { global_fetch_strictly_public: true } };
   expect(agentAvailability({ OAUTH_KV: kv, BETTER_AUTH_URL: ORIGIN })).toMatchObject({ dynamic_registration: false, metadata_documents: true });
   // never true when agents cannot connect at all
   expect(agentAvailability({ BETTER_AUTH_URL: ORIGIN, MCP_DCR_ENABLED: '1' })).toMatchObject({ dynamic_registration: false, metadata_documents: false });
  } finally { g.Cloudflare = before; }
 });

 it('the open-registration note says what being on means and what protects it, with the limits in effect', async () => {
  const on = (await instancePreflight(env({ OAUTH_KV: kv, BETTER_AUTH_URL: ORIGIN, MCP_DCR_ENABLED: '1' }), ORIGIN)).items.find(i => i.id === 'client_registration')!;
  expect(on).toMatchObject({ severity: 'note', setting: 'MCP_DCR_ENABLED' });
  expect(on.message).toContain('no access until a signed-in person approves it');
  expect(on.message).toContain('20 a day for one address and 2000 a day for the whole instance');
  expect(on.message).toContain('5000 apps stored at most');
  expect(on.message).toContain('deleted after 24 hours');
  const tuned = (await instancePreflight(env({ OAUTH_KV: kv, BETTER_AUTH_URL: ORIGIN, MCP_DCR_ENABLED: '1', MCP_DCR_DAILY_LIMIT: '25', MCP_DCR_UNUSED_HOURS: '2' }), ORIGIN)).items.find(i => i.id === 'client_registration')!;
  expect(tuned.message).toContain('25 a day for the whole instance'); expect(tuned.message).toContain('deleted after 2 hours');
 });
});
