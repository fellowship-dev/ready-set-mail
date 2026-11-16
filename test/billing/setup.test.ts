// Billing in the preflight, the migration and the schema, and a guard on who may read across workspaces.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { REQUIRED_MIGRATION } from '@ready-set-mail/db';
import { instancePreflight } from '../../src/setup/preflight';
import { billingWorld, KEY, WHSEC, rows } from './world';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const ORIGIN = 'https://ia.example.com';

describe('preflight', () => {
  it('hosted without Stripe settings: billing is off, nothing to fix', async () => {
    const w = await billingWorld({}, { stripe: false });
    const r = await instancePreflight(w.env as never, ORIGIN);
    expect(r.billing).toMatchObject({ state: 'off' });
    expect(r.items.filter((i) => i.id === 'billing')).toEqual([]);
  });
  it('a full sk_ key is misconfigured, with a reason that names the setting and never the value', async () => {
    const w = await billingWorld({ STRIPE_SECRET_KEY: 'sk_live_SUPERSECRETVALUE0123' });
    const r = await instancePreflight(w.env as never, ORIGIN);
    expect(r.billing).toMatchObject({ state: 'misconfigured', reason: expect.stringMatching(/restricted key/) });
    expect(r.items.find((i) => i.id === 'billing')).toMatchObject({ severity: 'action', setting: 'STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET' });
    expect(JSON.stringify(r)).not.toContain('SUPERSECRETVALUE');
  });
  it('only one of the two secrets set is misconfigured', async () => {
    const w = await billingWorld({ STRIPE_WEBHOOK_SECRET: undefined });
    expect((await instancePreflight(w.env as never, ORIGIN)).billing).toMatchObject({ state: 'misconfigured' });
  });
  it('configured: checks the price resolves, and that the instance owner will be told of orders', async () => {
    const w = await billingWorld();
    const r = await instancePreflight(w.env as never, ORIGIN);
    expect(r.billing).toEqual({ state: 'configured', livemode: false, price: 'ok' });
    expect(r.items.filter((i) => i.id === 'billing')).toEqual([]);
    expect(JSON.stringify(r)).not.toMatch(new RegExp(`${KEY}|${WHSEC}`));
    const noOwner = await billingWorld({ OWNER_EMAIL: undefined });
    expect((await instancePreflight(noOwner.env as never, ORIGIN)).items.find((i) => i.id === 'billing')).toMatchObject({ severity: 'action', setting: 'OWNER_EMAIL' });
  });
  it('a price that cannot be sold is an action naming the lookup key setting; an unreachable Stripe is a note', async () => {
    const w = await billingWorld();
    for (const p of w.fake.state.prices.values()) p.active = false;
    const bad = await instancePreflight(w.env as never, ORIGIN);
    expect(bad.billing).toMatchObject({ state: 'configured', price: 'misconfigured' });
    expect(bad.items.find((i) => i.id === 'billing')).toMatchObject({ severity: 'action', setting: 'STRIPE_PRICE_LOOKUP_KEY' });
    const down = await billingWorld();
    down.fake.failNext(/prices/, { status: 500, error: { type: 'api_error', message: 'x' } });
    const r = await instancePreflight(down.env as never, ORIGIN);
    expect(r.billing).toMatchObject({ price: 'unreachable' });
    expect(r.items.find((i) => i.id === 'billing')).toMatchObject({ severity: 'note' });
  });
  it('self-host: Stripe settings are reported as ignored; without them there is no billing field at all', async () => {
    const withSettings = { DB: createMigratedD1() as unknown as D1Database, STRIPE_SECRET_KEY: 'rk_test_abc123', STRIPE_WEBHOOK_SECRET: 'whsec_abc123' };
    const r = await instancePreflight(withSettings as never, ORIGIN);
    expect(r.billing).toMatchObject({ state: 'off' });
    expect(r.items.find((i) => i.id === 'billing')).toMatchObject({ severity: 'note' });
    const none = await instancePreflight({ DB: createMigratedD1() as unknown as D1Database } as never, ORIGIN);
    expect(none.billing).toBeUndefined();
  });
});

describe('migration 0016 and the schema', () => {
  const db = createMigratedD1().sqlite;
  const info = (t: string) => db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string; notnull: number }>;
  it('is the newest migration the Worker requires', () => {
    expect(REQUIRED_MIGRATION).toBe('0017_report_alignment.sql'); // 0016 (billing) is still applied before it
  });
  it('is additive: one nullable column on workspaces, new tables, nothing dropped', () => {
    const sql = readFileSync(join(import.meta.dirname, '../../migrations/0016_billing.sql'), 'utf8');
    expect(sql).not.toMatch(/\bDROP\b|\bDELETE\b|\bUPDATE\b|ALTER TABLE \w+ (DROP|RENAME)/i);
    expect(info('workspaces').find((c) => c.name === 'stripe_customer_id')).toMatchObject({ notnull: 0 });
    for (const t of ['billing_orders', 'billing_events', 'billing_checkout_sessions', 'billing_price_cache']) expect(info(t).length).toBeGreaterThan(3);
  });
  it('orders have no foreign key, so deleting a workspace or a domain keeps them', () => {
    for (const t of ['billing_orders', 'billing_events', 'billing_checkout_sessions', 'billing_price_cache']) expect(db.prepare(`PRAGMA foreign_key_list(${t})`).all(), t).toEqual([]);
  });
  it('one Stripe customer is one workspace, and many workspaces may have none', () => {
    db.prepare("INSERT INTO workspaces (id, name) VALUES ('ws_a', 'A'), ('ws_b', 'B'), ('ws_c', 'C')").run();
    db.prepare("UPDATE workspaces SET stripe_customer_id = 'cus_1' WHERE id = 'ws_a'").run();
    expect(() => db.prepare("UPDATE workspaces SET stripe_customer_id = 'cus_1' WHERE id = 'ws_b'").run()).toThrow(/UNIQUE/);
    expect(db.prepare('SELECT COUNT(*) n FROM workspaces WHERE stripe_customer_id IS NULL').get()).toMatchObject({ n: 3 }); // ws_default, ws_b and ws_c
  });
  it('an invoice belongs to one order, an event id is stored once', () => {
    const ins = (id: string, invoice: string | null) => db.prepare("INSERT INTO billing_orders (id, workspace_id, workspace_name, domain_name, offer, stripe_price_id, amount, currency, status, stripe_invoice_id) VALUES (?, 'w', 'W', ?, 'o', 'p', 1, 'usd', 'done', ?)").run(id, id, invoice);
    ins('o1', 'in_1'); ins('o2', null); ins('o3', null);
    expect(() => ins('o4', 'in_1')).toThrow(/UNIQUE/);
    db.prepare("INSERT INTO billing_events (id, type) VALUES ('evt_1', 't')").run();
    expect(() => db.prepare("INSERT INTO billing_events (id, type) VALUES ('evt_1', 't')").run()).toThrow(/UNIQUE/);
  });
});

describe('who may read orders across workspaces', () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []; });
  it('only the webhook, the routes, reconcile, notify, price and sync code use billingLookups', () => {
    const root = join(import.meta.dirname, '../..');
    const users = walk(join(root, 'src')).filter((f) => /\bbillingLookups\b/.test(readFileSync(f, 'utf8'))).map((f) => relative(root, f)).sort();
    expect(users).toEqual(['src/billing/notify.ts', 'src/billing/price.ts', 'src/billing/reconcile.ts', 'src/billing/routes.ts', 'src/billing/sync.ts', 'src/billing/webhook.ts']);
  });
  it('the Worker keeps no billing state between requests (nothing module-level is mutable)', () => {
    const root = join(import.meta.dirname, '../../src/billing');
    for (const f of walk(root)) expect(readFileSync(f, 'utf8'), f).not.toMatch(/^(let|var) /m);
  });
});

describe('what an attacker with a stolen owner session can spend', () => {
  it('is at most one Fix order per domain, five order attempts per ten minutes', async () => {
    const w = await billingWorld();
    const ids = Array.from({ length: 10 }, (_, i) => w.addDomain(w.owner.workspaceId, `d${i}.example.com`));
    await w.addCard(w.owner);
    const statuses: number[] = [];
    for (const id of ids) statuses.push((await w.buy(w.owner, id)).status);
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429, 429, 429, 429, 429]);
    expect(rows(w.db, 'SELECT COUNT(*) n FROM billing_orders')[0].n).toBe(5);
    // buying the same domain again never charges again
    expect((await w.buy(w.owner, ids[0]!)).status).toBe(429);
    expect(w.fake.state.charges.size).toBe(5);
  });
});
