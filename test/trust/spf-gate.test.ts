// The SPF flattening add-on gate (src/hosted/plan-limits.ts capability): hosted is off unless the operator admits the workspace, self-host always has it,
// and turning it off stays possible for a domain that has it.
import { describe, it, expect } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { call, makeEnv, setupOwner, signupVerified } from '../auth/helpers';
import { capability, spfFlatteningSetting } from '../../src/hosted/plan-limits';

const json = async (r: Response) => await r.json() as any;
const HOSTED = { MODE: 'saas', SAAS_ENABLED: '1' };

async function hosted(extra: Record<string, unknown> = {}, email = 'a@example.com') {
  const db = createMigratedD1();
  const env = makeEnv(db, { ...HOSTED, ...extra });
  const key = await signupVerified(env, email);
  const ws = db.sqlite.prepare('SELECT workspace_id FROM memberships').get().workspace_id as string;
  db.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address, verified_via) VALUES (1, ?, 'a-corp.com', '', 'txt')").run(ws);
  const rows = () => db.sqlite.prepare('SELECT COUNT(*) AS n FROM spf_flatten_config').get().n as number;
  return { db, env, key, ws, rows };
}
const ROUTES: Array<[string, string, unknown?]> = [
  ['GET', '/api/domains/1/spf-flatten'], ['GET', '/api/domains/1/spf-flatten/preview'], ['POST', '/api/domains/1/spf-flatten', {}],
  ['POST', '/api/domains/1/spf-flatten/refresh', {}], ['DELETE', '/api/domains/1/spf-flatten'],
];
const notAvailable = async (res: Response) => { expect(res.status).toBe(404); expect((await json(res)).error).toMatch(/not available on the hosted service/); };

describe('hosted: off by default, nothing read or written', () => {
  it.each(ROUTES)('%s %s answers 404 and writes nothing', async (m, p, body) => {
    const w = await hosted();
    await notAvailable(await call(w.env, m, p, { key: w.key, body }));
    expect(w.rows()).toBe(0);
  });
  it('/api/me says the add-on is not there', async () => {
    const w = await hosted();
    expect((await json(await call(w.env, 'GET', '/api/me', { key: w.key }))).add_ons).toEqual({ spf_flattening: false });
  });
  it('an unknown value of the setting is off too', async () => {
    for (const v of ['bogus', 'yes', '1', 'true']) {
      const w = await hosted({ HOSTED_SPF_FLATTENING: v });
      await notAvailable(await call(w.env, 'GET', '/api/domains/1/spf-flatten', { key: w.key }));
    }
  });
});

describe('hosted, not admitted: the by-hand breakdown of the lookups is still there', () => {
  it('GET /spf-lookups answers (reading only; it is the other way to the same end as flattening)', async () => {
    const w = await hosted();
    const res = await call(w.env, 'GET', '/api/domains/1/spf-lookups', { key: w.key });
    expect(res.status).toBe(200);
    expect(typeof (await json(res)).ok).toBe('boolean'); // an answer about the record (or why it could not be read), never a 404
  });
});

describe('hosted: the operator admits a workspace', () => {
  const reachable = async (w: Awaited<ReturnType<typeof hosted>>) => {
    const res = await call(w.env, 'GET', '/api/domains/1/spf-flatten', { key: w.key });
    expect(res.status).toBe(200);
    expect((await json(res)).access).toEqual({ allowed: true });
    // past the gate: the write answers for the missing Cloudflare connection, not 404
    expect((await call(w.env, 'POST', '/api/domains/1/spf-flatten', { key: w.key, body: {} })).status).toBe(422);
    expect((await json(await call(w.env, 'GET', '/api/me', { key: w.key }))).add_ons).toEqual({ spf_flattening: true });
  };
  it('all', async () => { await reachable(await hosted({ HOSTED_SPF_FLATTENING: 'all' })); });
  it('owner: the workspace owned by OWNER_EMAIL', async () => { await reachable(await hosted({ HOSTED_SPF_FLATTENING: 'owner', OWNER_EMAIL: 'a@example.com' })); });
  it('owner: another account\'s workspace is not admitted, and without OWNER_EMAIL nobody is', async () => {
    for (const extra of [{ HOSTED_SPF_FLATTENING: 'owner', OWNER_EMAIL: 'boss@example.com' }, { HOSTED_SPF_FLATTENING: 'owner' }]) {
      const w = await hosted(extra);
      await notAvailable(await call(w.env, 'GET', '/api/domains/1/spf-flatten', { key: w.key }));
    }
  });
  it('a list of workspace ids admits exactly those', async () => {
    const w = await hosted();
    (w.env as unknown as Record<string, string>).HOSTED_SPF_FLATTENING = `ws_000000000000000000000000000000aa, ${w.ws}`;
    await reachable(w);
    const other = await hosted({ HOSTED_SPF_FLATTENING: 'ws_000000000000000000000000000000aa' });
    await notAvailable(await call(other.env, 'GET', '/api/domains/1/spf-flatten', { key: other.key }));
  });
});

describe('self-host: always available', () => {
  it('is on, and /api/me says so', async () => {
    const db = createMigratedD1();
    const env = makeEnv(db);
    const owner = await setupOwner(env);
    db.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address, verified_via) VALUES (1, 'ws_default', 'a-corp.com', '', 'txt')").run();
    const res = await call(env, 'GET', '/api/domains/1/spf-flatten', { key: owner });
    expect(res.status).toBe(200);
    expect((await json(res)).access).toEqual({ allowed: true });
    expect((await json(await call(env, 'GET', '/api/me', { key: owner }))).add_ons).toEqual({ spf_flattening: true });
  });
});

describe('the add-on goes away while a domain has it on: reading and turning off stay, everything else answers 404', () => {
  it('GET shows the state; preview, turn on and check now are 404; turning off is routed (never trapped)', async () => {
    const w = await hosted(); // default off
    w.db.sqlite.prepare("INSERT INTO spf_flatten_config (domain_id, workspace_id, enabled, canonical_record, flattened_record, cf_record_id) VALUES (1, ?, 1, 'v=spf1 include:x.test -all', 'v=spf1 ip4:192.0.2.1 -all', 'rec')").run(w.ws);
    const get = await call(w.env, 'GET', '/api/domains/1/spf-flatten', { key: w.key });
    expect(get.status).toBe(200);
    const body = await json(get);
    expect(body.access).toEqual({ allowed: false });
    expect(body.config).toMatchObject({ enabled: true, original_record: 'v=spf1 include:x.test -all', flattened_record: 'v=spf1 ip4:192.0.2.1 -all' });
    expect(body.config.workspace_id).toBeUndefined();
    expect((await json(await call(w.env, 'GET', '/api/me', { key: w.key }))).add_ons).toEqual({ spf_flattening: true }); // so the dashboard still shows it
    for (const [m, p, b] of ROUTES.slice(1, 4)) await notAvailable(await call(w.env, m, p, { key: w.key, body: b }));
    // Turning off is not refused by the gate: with no Cloudflare connection it cannot put the record back, says so, and keeps the row and the original.
    const off = await call(w.env, 'DELETE', '/api/domains/1/spf-flatten', { key: w.key });
    expect(off.status).toBe(502);
    expect(await json(off)).toMatchObject({ code: 'restore_failed', original: 'v=spf1 include:x.test -all' });
    expect(w.rows()).toBe(1);
  });
});

describe('the one answer', () => {
  it('capability(): self-host, off, owner, all, ids; reasons', async () => {
    const db = createMigratedD1();
    const base = { DB: db as unknown as D1Database } as never;
    expect(await capability({ ...(base as object), MODE: 'selfhost' } as never, 'spf_flattening', { workspaceId: 'ws_x' })).toEqual({ allowed: true, reason: 'self_host' });
    expect(await capability({ ...(base as object), MODE: 'saas' } as never, 'spf_flattening', { workspaceId: 'ws_x' })).toEqual({ allowed: false, reason: 'not_enabled' });
    expect(await capability({ ...(base as object), MODE: 'saas', HOSTED_SPF_FLATTENING: 'all' } as never, 'spf_flattening', { workspaceId: 'ws_x' })).toEqual({ allowed: true, reason: 'operator_setting' });
    expect(await capability({ ...(base as object), MODE: 'saas', HOSTED_SPF_FLATTENING: 'ws_abc, ws_x1' } as never, 'spf_flattening', { workspaceId: 'ws_x1' })).toEqual({ allowed: true, reason: 'operator_setting' });
  });
  it('the setting parser: unset, owner, all, ids, junk', () => {
    const s = (v?: string) => { const a = spfFlatteningSetting({ HOSTED_SPF_FLATTENING: v }); return { all: a.all, owner: a.owner, ids: [...a.ids], valid: a.valid }; };
    expect(s()).toEqual({ all: false, owner: false, ids: [], valid: true });
    expect(s('  ')).toEqual({ all: false, owner: false, ids: [], valid: true });
    expect(s('ALL')).toEqual({ all: true, owner: false, ids: [], valid: true });
    expect(s('owner')).toEqual({ all: false, owner: true, ids: [], valid: true });
    expect(s('owner, ws_a1,ws_b2')).toEqual({ all: false, owner: true, ids: ['ws_a1', 'ws_b2'], valid: true });
    expect(s('bogus')).toEqual({ all: false, owner: false, ids: [], valid: false });
    expect(s('ws_a1, nonsense')).toEqual({ all: false, owner: false, ids: ['ws_a1'], valid: false });
  });
});
