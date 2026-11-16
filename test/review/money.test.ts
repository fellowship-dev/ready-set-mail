// Review probes for PR 180 (not part of the PR). Each `it` states what an attacker / a person does and asserts what SHOULD happen;
// a failing assertion is a finding.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { planWorld, json, rows, call, type PlanWorld } from '../plan/world';
import { runBillingJob } from '../../src/billing/reconcile';
import { unitOf } from '../../src/hosted/plan';
vi.setConfig({ testTimeout: 120_000 });
afterEach(() => vi.unstubAllGlobals());

async function ready(extra: Record<string, unknown> = {}) {
  const w = await planWorld(extra);
  await w.addFree(w.owner, 'one.example.com');
  await w.addCard(w.owner);
  await w.addPaid(w.owner, 'two.example.org');
  await w.fake.flush();
  const sub = [...w.fake.state.subscriptions.values()][0] as any;
  return { w, subId: sub.id as string, ws: w.owner.workspaceId };
}
const itemQty = (w: PlanWorld) => [...w.fake.state.subscriptionItems.values()].map((i: any) => i.quantity);
const uidOf = (w: PlanWorld, email: string) => rows(w.db, 'SELECT id FROM users WHERE email = ?', email)[0].id as string;
const custOf = (w: PlanWorld, ws: string) => [...w.fake.state.customers.keys()].find((id) => w.fake.state.customers.get(id)?.metadata?.workspace_id === ws)!;

describe('P1 transfer: the new owner spends on the previous owner\'s card', () => {
  it('after a transfer the new owner must not be able to charge the card the previous owner saved, nor see it', async () => {
    const { w, ws } = await ready();
    const b = await w.addMember(ws, 'newowner@example.com', 'admin');
    const t = await call(w.env, 'POST', `/api/workspaces/${ws}/transfer-ownership`, { key: w.owner.token, body: { user_id: uidOf(w, 'newowner@example.com'), confirm_amount: 1000 } });
    expect(t.status).toBe(200);
    const view = await json(await w.api(b, 'GET', '/api/billing'));
    console.info('P1 new owner sees', JSON.stringify({ card: view.card, billing_email: view.billing_email }));
    const add = await w.addPaid(b, 'three.example.net');
    console.info('P1 new owner paid add status', add.status, 'qty', JSON.stringify(itemQty(w)), 'customer', custOf(w, ws));
    // what should happen: the card stays the previous owner's, so the new owner is asked for their own card first
    expect(view.billing_email).not.toBe('owner@example.com');
    expect(add.status).not.toBe(201);
  });
});

describe('P2 who can spend (direct API calls)', () => {
  it('admin and member are refused on every money route; an admin may start a workspace intent on their own card', async () => {
    const { w, ws } = await ready();
    const admin = await w.addMember(ws, 'adm@example.com', 'admin');
    const member = await w.addMember(ws, 'mem@example.com', 'member');
    const out: Record<string, number> = {};
    for (const [who, p] of [['admin', admin], ['member', member]] as const) {
      out[`${who} add`] = (await w.api(p, 'POST', '/api/billing/domains', { domain: 'x.example.net', expected_amount: 500, expected_currency: 'usd' })).status;
      out[`${who} bulk`] = (await w.api(p, 'POST', '/api/billing/domains/bulk', { domains: ['y.example.net'], expected_amount: 500, expected_currency: 'usd' })).status;
      out[`${who} start`] = (await w.api(p, 'POST', '/api/billing/plan/start', {})).status;
      out[`${who} keep`] = (await w.api(p, 'POST', '/api/billing/plan/keep-one', { domain_id: 1 })).status;
      out[`${who} cancel-pending`] = (await w.api(p, 'POST', '/api/billing/plan/cancel-pending', {})).status;
      out[`${who} portal`] = (await w.api(p, 'POST', '/api/billing/portal-session', {})).status;
      out[`${who} preview`] = (await w.api(p, 'GET', '/api/billing/domains/preview?domain=x.example.net')).status;
    }
    const twoId = rows(w.db, "SELECT id FROM domains WHERE domain = 'two.example.org'")[0].id;
    out['admin delete billable'] = (await w.api(admin, 'DELETE', `/api/domains/${twoId}`)).status;
    await w.fake.flush();
    out['qty after admin delete'] = itemQty(w)[0];
    console.info('P2', JSON.stringify(out));
    for (const [k, v] of Object.entries(out)) if (!k.startsWith('admin delete') && !k.startsWith('qty')) expect([401, 403, 404], k).toContain(v);
  });
});

describe('P3 isolation', () => {
  it('the owner of workspace A cannot read or act on workspace B\'s billing by naming it', async () => {
    const { w } = await ready();
    const other = await w.person('victim@example.com');
    await w.addCard(other);
    const asA = { ...w.owner, workspaceId: other.workspaceId };
    const s = {
      get: (await w.api(asA, 'GET', '/api/billing')).status,
      add: (await w.api(asA, 'POST', '/api/billing/domains', { domain: 'z.example.net', expected_amount: 500, expected_currency: 'usd' })).status,
      start: (await w.api(asA, 'POST', '/api/billing/plan/start', {})).status,
      portal: (await w.api(asA, 'POST', '/api/billing/portal-session', {})).status,
      removal: (await w.api(asA, 'GET', '/api/billing/domains/1/removal')).status,
    };
    console.info('P3', JSON.stringify(s));
    for (const v of Object.values(s)) expect([401, 403, 404]).toContain(v);
  });
});

describe('P4 tampering', () => {
  it('price, quantity, interval and charge fields from the browser cannot change what is billed', async () => {
    const w = await planWorld();
    await w.addFree(w.owner, 'one.example.com');
    await w.addCard(w.owner);
    const r: Record<string, unknown> = {};
    r.cheap = (await w.addPaid(w.owner, 'two.example.org', { expected_amount: 1 })).status;
    r.no_charge_echo = (await w.api(w.owner, 'POST', '/api/billing/domains', { domain: 'two.example.org', expected_amount: 500, expected_currency: 'usd' })).status;
    r.wrong_charge = (await w.api(w.owner, 'POST', '/api/billing/domains', { domain: 'two.example.org', expected_amount: 500, expected_currency: 'usd', expected_charge: 1 })).status;
    r.year_at_month_price = (await w.api(w.owner, 'POST', '/api/billing/domains', { domain: 'two.example.org', expected_amount: 500, expected_currency: 'usd', expected_charge: 500, interval: 'year' })).status;
    const ok = await w.addPaid(w.owner, 'two.example.org', { quantity: 50, billable: 50, price: 'price_x' });
    r.ok = ok.status;
    await w.fake.flush();
    r.qty = itemQty(w);
    console.info('P4', JSON.stringify(r));
    expect(r.cheap).toBe(409); expect(r.no_charge_echo).toBe(409); expect(r.wrong_charge).toBe(409); expect(r.year_at_month_price).toBe(409);
    expect(r.qty).toEqual([1]);
  });
});

describe('P5 races', () => {
  it('five concurrent paid adds and two concurrent removals end with quantity = billable domains', async () => {
    const { w, ws } = await ready();
    const names = ['a1.example.net', 'a2.example.net', 'a3.example.net', 'a4.example.net', 'a5.example.net'];
    const res = await Promise.all(names.map((n) => w.addPaid(w.owner, n)));
    console.info('P5 add statuses', res.map((x) => x.status).join(','));
    await w.fake.flush();
    const ids = rows(w.db, "SELECT id FROM domains WHERE workspace_id = ? AND domain LIKE 'a%.example.net' LIMIT 2", ws).map((r) => r.id);
    await Promise.all(ids.map((id) => w.api(w.owner, 'DELETE', `/api/domains/${id}`)));
    await w.fake.flush();
    await w.api(w.owner, 'GET', '/api/billing');
    await runBillingJob(w.env as never, { waitUntil() {} } as never).catch(() => undefined);
    await w.fake.flush();
    const units = new Set(w.domainsOf(ws).map(unitOf)).size;
    console.info('P5 units', units, 'qty', JSON.stringify(itemQty(w)), 'sub', JSON.stringify(w.sub(ws)));
    expect(itemQty(w)).toEqual([units - 1]);
  });
});

describe('P6 removal while a payment is failing', () => {
  it('removing a billable domain during past_due lowers (or marks to lower) the quantity before the next renewal', async () => {
    const { w, subId, ws } = await ready();
    await w.addPaid(w.owner, 'three.example.net');
    await w.fake.flush();
    expect(itemQty(w)).toEqual([2]);
    w.fake.setCardBehavior(custOf(w, ws), 'decline');
    w.fake.advancePeriod(subId);
    await w.fake.flush();
    const id = rows(w.db, "SELECT id FROM domains WHERE domain = 'three.example.net'")[0].id;
    const del = await w.api(w.owner, 'DELETE', `/api/domains/${id}`);
    await w.fake.flush();
    const after = { del: del.status, qty: itemQty(w), sub: w.sub(ws) };
    console.info('P6 after removal in past_due', JSON.stringify({ del: after.del, qty: after.qty, status: after.sub.status, dirty: after.sub.dirty, sent: after.sub.quantity_sent }));
    // the card is fixed and Stripe retries the open invoice; then the next renewal comes
    w.fake.setCardBehavior(custOf(w, ws), 'ok');
    w.fake.retryPayment(subId);
    await w.fake.flush();
    const renew = w.fake.advancePeriod(subId) as any;
    await w.fake.flush();
    const invs = [...w.fake.state.invoices.values()].filter((i: any) => i.subscription === subId || i.parent?.subscription_details?.subscription === subId);
    const last = invs[invs.length - 1] as any;
    console.info('P6 next renewal amount', last?.amount_due ?? last?.total, 'qty now', JSON.stringify(itemQty(w)));
    expect(after.qty[0] === 1 || after.sub.dirty === 1).toBe(true);
  });
});

describe('P8 units', () => {
  it('what is one domain', () => {
    const u = ['a.example.com', 'b.example.com', 'example.com', 'x.vercel.app', 'y.vercel.app', 'foo.co.uk', 'co.uk', 'a.b.github.io', 'readysetmail.com', 'app.readysetmail.com'].map((d) => `${d}->${unitOf(d)}`);
    console.info('P8', u.join(' | '));
    expect(unitOf('a.example.com')).toBe(unitOf('b.example.com'));
    expect(unitOf('x.vercel.app')).not.toBe(unitOf('y.vercel.app'));
    expect(unitOf('app.readysetmail.com')).toBe('readysetmail.com');
  });
});
