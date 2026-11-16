import { describe, it, expect, afterEach, vi } from 'vitest';
import { planWorld, json, rows } from '../plan/world';
vi.setConfig({ testTimeout: 120_000 });
afterEach(() => vi.unstubAllGlobals());
const itemQty = (w: any) => [...w.fake.state.subscriptionItems.values()].map((i: any) => i.quantity);

describe('C1 an owner already paying creates another workspace', () => {
  it('reproduce plan=free; can it hold a free domain?', async () => {
    const w = await planWorld();
    await w.addFree(w.owner, 'one.example.com');
    await w.addCard(w.owner);
    await w.addPaid(w.owner, 'two.example.org');
    await w.fake.flush();
    const made = await w.api(w.owner, 'POST', '/api/workspaces', { name: 'Second' });
    const body = await json(made);
    const id = rows(w.db, "SELECT id FROM workspaces WHERE name = 'Second'")[0]?.id;
    const ws = rows(w.db, 'SELECT plan, free_owner_user_id FROM workspaces WHERE id = ?', id)[0];
    const subs = rows(w.db, 'SELECT * FROM workspace_subscriptions WHERE workspace_id = ?', id);
    const p2 = { ...w.owner, workspaceId: id };
    const free = await w.tryVerify(p2, 'three.example.net');
    const fb = await json(free.clone());
    const sub = await w.tryVerify(p2, 'news.one.example.com'); // a unit the person holds free elsewhere
    const view = await json(await w.api(p2, 'GET', '/api/billing'));
    const paid = await w.addPaid(p2, 'four.example.net');
    await w.fake.flush();
    console.info('C1', JSON.stringify({ create: made.status, decision: body?.code ?? null, ws, subs: subs.length, freeTry: [free.status, fb.code, fb.error], subOfOtherFree: sub.status, planView: { name: view.plan?.name, includes_free_domain: view.plan?.includes_free_domain, billable: view.plan?.billable }, paidAdd: paid.status, domains: w.domainsOf(id), qty: itemQty(w), customers: w.fake.state.customers.size }));
    expect(free.status).toBe(402);
  });
});

describe('C2 subdomains are one domain', () => {
  it('example.com + news.example.com: one unit, free; subdomain without parent: one unit', async () => {
    const w = await planWorld();
    const ws = w.owner.workspaceId;
    const r1 = await w.addFree(w.owner, 'example-co.com');
    const r2 = await w.addFree(w.owner, 'news.example-co.com');
    const r3 = await w.addFree(w.owner, 'shop.example-co.com');
    const v1 = (await json(await w.api(w.owner, 'GET', '/api/billing'))).plan;
    const w2 = await planWorld();
    const s1 = await w2.addFree(w2.owner, 'a.other-co.org');
    const s2 = await w2.addFree(w2.owner, 'b.other-co.org');
    const s3 = await w2.addFree(w2.owner, 'other-co.org');
    const s4 = await w2.tryVerify(w2.owner, 'third-co.net');
    const v2 = (await json(await w2.api(w2.owner, 'GET', '/api/billing'))).plan;
    const lim = await json(await w.api(w.owner, 'GET', '/api/domains'));
    console.info('C2', JSON.stringify({ parentThenSubs: [r1.status, r2.status, r3.status], units1: v1.units, billable1: v1.billable, subsNoParent: [s1.status, s2.status, s3.status], unrelated: s4.status, units2: v2.units, billable2: v2.billable, rows2: w2.domainsOf(w2.owner.workspaceId), org: rows(w2.db, 'SELECT domain, org_domain, parent_id FROM domains WHERE workspace_id = ?', w2.owner.workspaceId), limitShape: JSON.stringify(lim).slice(0, 400) }));
    expect(v1.units).toBe(1); expect(v1.billable).toBe(0); expect(v2.units).toBe(1);
  });
});
