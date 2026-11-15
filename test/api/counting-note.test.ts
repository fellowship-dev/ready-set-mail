// The counting note when AUTHSERV_* is not set: the operator (and a self-hoster, who runs the instance) is told which settings are
// missing; a hosted customer never reads operator configuration, in any response that carries the note.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { resetSchemaReadyCache } from '@ready-set-mail/db';
import { call, makeEnv, setupOwner, signupVerified } from '../auth/helpers';
import { quiet } from '../hosted/world';
import { AUTHSERV_CUSTOMER_NOTICE, AUTHSERV_NOTICE } from '../../src/reports/visibility';

vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));

const SAAS = { MODE: 'saas', SAAS_ENABLED: '1', INTAKE_DOMAIN: 'rua.readysetmail.com', OWNER_EMAIL: 'operator@example.com', HOSTED_CONNECT_REPORTS: 'owner' };
const CUSTOMER = 'Reports for this domain cannot be counted yet. This is on our side; there is nothing for you to do.';

beforeEach(() => {
  quiet();
  resetSchemaReadyCache();
  vi.stubGlobal('fetch', async () => Response.json({ Status: 3 }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** Every response the dashboard reads the note from, for domain 1 of the caller's workspace. */
async function notes(env: any, token: string, id: number) {
  const out: Record<string, unknown> = {};
  const get = async (p: string) => (await call(env, 'GET', p, { key: token })).json() as Promise<any>;
  out.summaries = (await get('/api/domains/summaries')).summaries.find((s: any) => s.domain_id === id)?.counting_note;
  out['check-summary'] = (await get(`/api/domains/${id}/check-summary`)).counting_note;
  out.stats = (await get(`/api/domains/${id}/stats?days=30`)).counting_note;
  out.analytics = (await get(`/api/domains/${id}/analytics`)).counting_note;
  return out;
}

async function hosted(email: string) {
  const db = createMigratedD1();
  const env = makeEnv(db, SAAS);
  const token = await signupVerified(env, email);
  const ws = (db.sqlite.prepare('SELECT m.workspace_id AS w FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ?').get(email) as { w: string }).w;
  db.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address, verified_via) VALUES (1, ?, 'cust.example', '', 'txt')").run(ws);
  return { env, token };
}

describe('counting note: operator text for the operator only', () => {
  it('the copy', () => {
    expect(AUTHSERV_CUSTOMER_NOTICE).toBe(CUSTOMER);
    expect(AUTHSERV_NOTICE).toBe('No report can be counted until AUTHSERV_ID and AUTHSERV_HEADER are set.');
  });

  it('a hosted customer gets "on our side" in every response, never the AUTHSERV_* settings', async () => {
    const { env, token } = await hosted('customer@example.com');
    const n = await notes(env, token, 1);
    for (const [where, note] of Object.entries(n)) expect([where, note]).toEqual([where, CUSTOMER]);
    // Nor anywhere else in those bodies.
    for (const p of ['/api/domains/summaries', '/api/domains/1/check-summary', '/api/domains/1/stats?days=30', '/api/domains/1/analytics']) {
      expect(await (await call(env, 'GET', p, { key: token })).text()).not.toMatch(/AUTHSERV/);
    }
  });

  it('the operator (OWNER_EMAIL) on the hosted service keeps the configuration sentence', async () => {
    const { env, token } = await hosted('operator@example.com');
    const n = await notes(env, token, 1);
    for (const [where, note] of Object.entries(n)) expect([where, note]).toEqual([where, AUTHSERV_NOTICE]);
  });

  it('a self-hosted instance keeps the configuration sentence: whoever signs in runs it', async () => {
    const db = createMigratedD1();
    const env = makeEnv(db, { REPORT_COUNTING: 'registry' });
    const token = await setupOwner(env);
    db.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address, verified_via) VALUES (1, 'ws_default', 'self.example', 'rua@r.test', 'selfhost')").run();
    const n = await notes(env, token, 1);
    for (const [where, note] of Object.entries(n)) expect([where, note]).toEqual([where, AUTHSERV_NOTICE]);
  });
});
