// The domain S4 was given is held on the server (settings `first_run_domain`, shown in GET /api/domains), so a second browser names the same domain.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { call, makeEnv, signupVerified } from '../auth/helpers';
import { HOSTED_ENV } from '../hosted/world';
import { dohFetch } from '../../packages/dns-checks/test/helpers';

vi.mock('../../src/telemetry', () => ({ track: vi.fn() }));
beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.stubGlobal('fetch', dohFetch({}, [])); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const json = async (r: Response) => await r.json() as any;

function world() {
  const db = createMigratedD1();
  const env = makeEnv(db, { ...HOSTED_ENV, SEND_EMAIL: { send: vi.fn(async () => {}) } });
  return { db, env };
}
const list = async (w: ReturnType<typeof world>, key: string) => json(await call(w.env, 'GET', '/api/domains', { key }));

describe('first_run_domain', () => {
  it('is the first domain typed, and later domains do not move it', async () => {
    const w = world();
    const key = await signupVerified(w.env, 'dana@brightwave-mail.com');
    expect((await list(w, key)).first_run_domain).toBeNull();
    expect((await call(w.env, 'POST', '/api/domains', { key, body: { domain: 'brightwave-mail.com' } })).status).toBe(202);
    expect((await list(w, key)).first_run_domain).toBe('brightwave-mail.com');
    await call(w.env, 'POST', '/api/domains', { key, body: { domain: 'quietfield.net' } });
    expect((await list(w, key)).first_run_domain).toBe('brightwave-mail.com');
  });

  it('a typo\'d first domain, removed, is replaced by the one typed next', async () => {
    const w = world();
    const key = await signupVerified(w.env, 'dana@brightwave-mail.com');
    const typo = await json(await call(w.env, 'POST', '/api/domains', { key, body: { domain: 'brightwave-mial.com' } }));
    expect((await call(w.env, 'DELETE', `/api/domains/claims/${typo.claim.id}`, { key })).status).toBeLessThan(300);
    await call(w.env, 'POST', '/api/domains', { key, body: { domain: 'brightwave-mail.com' } });
    expect((await list(w, key)).first_run_domain).toBe('brightwave-mail.com');
  });

  it('an existing workspace that already holds a domain is not given one by adding another', async () => {
    const w = world();
    const key = await signupVerified(w.env, 'dana@brightwave-mail.com');
    w.db.sqlite.prepare("INSERT INTO domains (workspace_id, domain, rua_address, verified_via) SELECT workspace_id, 'harbor-lane.org', '', 'txt' FROM memberships LIMIT 1").run();
    await call(w.env, 'POST', '/api/domains', { key, body: { domain: 'brightwave-mail.com' } });
    expect((await list(w, key)).first_run_domain).toBeNull();
  });
});
