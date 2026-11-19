// HOSTED_SPF_FLATTENING unset on the hosted service: flattening has no price and nothing charges for it. The routes answer 404 and make no outbound call (so no
// Stripe call), no order or checkout row is written, the billing and offer code knows nothing of SPF flattening, and the setting is not switched on by default.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { call, makeEnv, signupVerified } from '../auth/helpers';

const ROOT = join(import.meta.dirname, '../..');
afterEach(() => vi.unstubAllGlobals());

describe('hosted, HOSTED_SPF_FLATTENING unset: nothing is charged for flattening', () => {
  it('every flattening route makes no outbound call and writes no order, checkout or flattening row', async () => {
    const db = createMigratedD1();
    const env = makeEnv(db, { MODE: 'saas', SAAS_ENABLED: '1' });
    const key = await signupVerified(env, 'a@example.com');
    const ws = db.sqlite.prepare('SELECT workspace_id FROM memberships').get().workspace_id as string;
    db.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address, verified_via) VALUES (1, ?, 'a-corp.com', '', 'txt')").run(ws);
    const fetched: string[] = [];
    vi.stubGlobal('fetch', async (u: unknown) => { fetched.push(String(u)); return new Response('{}', { status: 500 }); });
    for (const [m, p, body] of [['GET', '/api/domains/1/spf-flatten'], ['GET', '/api/domains/1/spf-flatten/preview'], ['POST', '/api/domains/1/spf-flatten', {}], ['POST', '/api/domains/1/spf-flatten/refresh', {}]] as const) {
      expect((await call(env, m, p, { key, body })).status).toBe(404);
    }
    const count = (t: string) => db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n as number;
    expect(fetched).toEqual([]);
    expect([count('spf_flatten_config'), count('billing_orders'), count('billing_checkout_sessions')]).toEqual([0, 0, 0]);
  });
  it('the billing and offer code never mentions SPF flattening, and the SPF code never reaches billing', () => {
    const files = (dir: string) => readdirSync(join(ROOT, dir)).filter((f) => f.endsWith('.ts')).map((f) => join(ROOT, dir, f));
    for (const f of [...files('src/billing'), ...files('src/lifecycle/email')]) expect(readFileSync(f, 'utf8'), f).not.toMatch(/spf[_ -]?flatten/i);
    for (const f of files('src/spf')) expect(readFileSync(f, 'utf8'), f).not.toMatch(/from '\.\.\/billing|stripe/i);
  });
  it('the setting has no value in the shipped configuration', () => {
    expect(readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8')).not.toMatch(/HOSTED_SPF_FLATTENING"\s*:/);
  });
});
