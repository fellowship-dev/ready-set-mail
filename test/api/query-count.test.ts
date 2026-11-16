// D1 caps the queries one Worker invocation may make (1,000 on Workers Paid, 50 on Free). The overview's batch and the domain page's
// summary must cost a constant number of queries, whatever the number of domains: counted here around the D1 binding.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { resetSchemaReadyCache } from '@ready-set-mail/db';
import { call, makeEnv, setupOwner, signupVerified } from '../auth/helpers';
import { quiet } from '../hosted/world';


const NOW = Math.floor(Date.now() / 1000);
const RUA = 'rua.readysetmail.com';
const SAAS = { MODE: 'saas', SAAS_ENABLED: '1', INTAKE_DOMAIN: RUA, OWNER_EMAIL: 'operator@example.com', HOSTED_CONNECT_REPORTS: 'owner' };

beforeEach(() => {
  quiet();
  resetSchemaReadyCache();
  // No live DNS in these tests: every lookup is NXDOMAIN.
  vi.stubGlobal('fetch', async () => Response.json({ Status: 3 }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** Counts every statement the app executes: each prepare() of node:sqlite is one statement run (batches included). */
function counter(db: ReturnType<typeof createMigratedD1>) {
  const orig = db.sqlite.prepare.bind(db.sqlite);
  let n = 0;
  (db.sqlite as any).prepare = (s: string) => { n++; if (process.env.QC_LOG) process.stderr.write(`[sql] ${s.replace(/\s+/g, ' ').slice(0, 200)}\n`); return orig(s); };
  return { reset: () => { n = 0; }, get: () => n, raw: orig };
}

/**
 * A workspace with `n` domains: every 5th has a counted report, every 7th is a parent-added subdomain of d1, every 11th has
 * hosted records, the rest have nothing counted (each of those gets the visibility fields).
 */
async function world(n: number, mode: 'self' | 'saas') {
  const db = createMigratedD1();
  const env = makeEnv(db, mode === 'saas' ? SAAS : { REPORT_COUNTING: 'registry' });
  const token = mode === 'saas' ? await signupVerified(env, 'customer@example.com') : await setupOwner(env);
  const ws = mode === 'saas'
    ? (db.sqlite.prepare("SELECT m.workspace_id AS w FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = 'customer@example.com'").get() as { w: string }).w
    : 'ws_default';
  const ins = db.sqlite.prepare("INSERT INTO domains (id, workspace_id, domain, rua_address, verified_via, dmarc_policy, dmarc_p, dmarc_pct, dns_checked_at) VALUES (?, ?, ?, ?, ?, 'none', 'none', 100, ?)");
  const rep = db.sqlite.prepare("INSERT INTO aggregate_reports (domain_id, org_name, report_id, date_begin, date_end, total_count, pass_count, fail_count, workspace_id, reporter_tier) VALUES (?, 'g', ?, ?, ?, 10, 9, 1, ?, ?)");
  for (let i = 1; i <= n; i++) {
    const sub = i > 1 && i % 7 === 0;
    ins.run(i, ws, sub ? `s${i}.d1.com` : `d${i}.com`, mode === 'saas' ? '' : 'rua@r.test', sub ? 'parent' : 'txt', NOW - 60);
    if (i % 5 === 0) rep.run(i, `r${i}`, NOW - 3600, NOW, ws, 'counted');
    if (i % 3 === 0) rep.run(i, `u${i}`, NOW - 3600, NOW, ws, 'unknown');
    if (i % 11 === 0) db.sqlite.prepare("INSERT INTO hosted_domains (domain_id, workspace_id, hosted_id, zone_key) VALUES (?, ?, ?, 'z')").run(i, ws, `h${String(i).padStart(15, '0')}`);
  }
  const c = counter(db);
  const measure = async (path: string) => {
    if (process.env.QC_LOG) process.stderr.write(`[sql] ==== ${path}\n`);
    c.reset();
    const res = await call(env, 'GET', path, { key: token });
    const body = res.status === 200 ? await res.json() as any : null;
    return { status: res.status, queries: c.get(), body };
  };
  return { measure };
}

describe('the overview batch costs the same queries for 1, 50 and 200 domains', () => {
  for (const mode of ['self', 'saas'] as const) {
    it(`${mode}: GET /api/domains/summaries is constant and under 20 in all; GET /api/domains/:id/check-summary under 12 of its own`, async () => {
      const counts: Record<string, number[]> = {};
      for (const n of [1, 50, 200]) {
        const w = await world(n, mode);
        const batch = await w.measure('/api/domains/summaries');
        expect(batch.status).toBe(200);
        expect(batch.body.summaries).toHaveLength(n);
        const one = await w.measure('/api/domains/1/check-summary');
        expect(one.status).toBe(200);
        // What every signed-in request costs before its route runs (session, user, membership, settings, connections): an id that
        // is not there costs that plus the one domain lookup.
        const missing = await w.measure('/api/domains/0/check-summary');
        expect(missing.status).toBe(404);
        const before = missing.queries - 1;
        (counts.summaries ??= []).push(batch.queries);
        (counts['check-summary'] ??= []).push(one.queries);
        (counts['check-summary route'] ??= []).push(one.queries - before);
        (counts['per-request auth+tenant'] ??= []).push(before);
        // The other requests the overview makes on load, for the record (not asserted).
        for (const p of ['/api/me', '/api/domains', '/api/domains/claims', '/api/hosted/config', '/api/hosted/statuses']) (counts[p] ??= []).push((await w.measure(p)).queries);
        if (mode === 'saas') {
          // Same per-domain decision in the batch and on the single-domain summary.
          const one7 = await w.measure('/api/domains/7/check-summary');
          if (n >= 7) expect(one7.body.report_connect).toEqual(batch.body.summaries.find((s: any) => s.domain_id === 7).report_connect);
        }
      }
      process.stderr.write(`[query-count] ${mode} ${JSON.stringify(counts)}\n`);
      expect(new Set(counts.summaries).size).toBe(1);
      expect(counts.summaries![0]).toBeLessThan(20);
      expect(new Set(counts['check-summary']).size).toBe(1);
      // The route itself (its own queries, after sign-in) stays under 12.
      expect(counts['check-summary route']![0]).toBeLessThan(12);
    });
  }
});
