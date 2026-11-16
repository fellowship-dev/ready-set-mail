// The second review (real-Stripe sandbox, round B): quantity repair, busy refusals and the rate limit, the payment-problem add path, the first payment
// that waits for the bank. One file so the fixes read together.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { planWorld, json, rows, type PlanWorld } from './world';

afterEach(() => vi.unstubAllGlobals());

async function ready() {
  const w = await planWorld();
  await w.addFree(w.owner, 'one.example.com');
  await w.addCard(w.owner);
  await w.addPaid(w.owner, 'two.example.org');
  await w.fake.flush();
  return { w, ws: w.owner.workspaceId };
}
const itemQty = (w: PlanWorld) => [...w.fake.state.subscriptionItems.values()].map((i: any) => i.quantity);
const hold = (w: PlanWorld, ws: string, seconds = 30) => w.db.sqlite.prepare('UPDATE workspaces SET plan_lock_token = ?, plan_lock_until = ? WHERE id = ?').run('someone', Math.floor(Date.now() / 1000) + seconds, ws);
const release = (w: PlanWorld, ws: string) => w.db.sqlite.prepare('UPDATE workspaces SET plan_lock_token = NULL, plan_lock_until = NULL WHERE id = ?').run(ws);

describe('S1: a quantity that drifted is repaired by the owner\'s next Billing page', () => {
  it('a removal that never gets the lease is marked dirty; the owner opening Billing puts Stripe right', async () => {
    const { w, ws } = await ready();
    await w.addPaid(w.owner, 'three.example.net');
    expect(itemQty(w)).toEqual([2]);
    const id = rows(w.db, "SELECT id FROM domains WHERE domain = 'three.example.net'")[0].id;
    hold(w, ws);
    expect((await w.api(w.owner, 'DELETE', `/api/domains/${id}`)).status).toBe(200); // never blocked
    expect(w.sub(ws).dirty).toBe(1);
    expect(itemQty(w)).toEqual([2]);
    // Billing is opened while the lease is still held: the read is not blocked and changes nothing
    expect((await w.api(w.owner, 'GET', '/api/billing')).status).toBe(200);
    expect(itemQty(w)).toEqual([2]);
    release(w, ws);
    // a member opening it does not repair (it is the owner's page)
    await w.api(await w.addMember(ws, 'admin@example.com', 'admin'), 'GET', '/api/billing');
    expect(itemQty(w)).toEqual([2]);
    const res = await json(await w.api(w.owner, 'GET', '/api/billing'));
    expect(itemQty(w)).toEqual([1]);
    expect(w.sub(ws)).toMatchObject({ dirty: 0, quantity_sent: 1 });
    expect(res.plan.quantity).toBe(1);
  });
  it('a removal retries the lease a few times before giving up: a lease that frees in time means no dirty flag', async () => {
    const { w, ws } = await ready();
    await w.addPaid(w.owner, 'three.example.net');
    const id = rows(w.db, "SELECT id FROM domains WHERE domain = 'three.example.net'")[0].id;
    hold(w, ws);
    setTimeout(() => release(w, ws), 200);
    expect((await w.api(w.owner, 'DELETE', `/api/domains/${id}`)).status).toBe(200);
    expect(w.sub(ws).dirty).toBe(0);
    expect(itemQty(w)).toEqual([1]);
  });
  it('a page load with nothing to repair takes no lease and calls Stripe for no write', async () => {
    const { w } = await ready();
    const writes = () => w.fake.calls.filter((c: any) => c.method !== 'GET' && !/create_preview/.test(c.path)).length;
    const before = writes();
    await w.api(w.owner, 'GET', '/api/billing');
    expect(writes()).toBe(before);
  });
});

describe('S5: plan_busy refusals do not use up the rate limit', () => {
  it('25 busy refusals, then the add still goes through', async () => {
    const { w, ws } = await ready();
    hold(w, ws);
    for (let i = 0; i < 25; i++) {
      const r = await w.addPaid(w.owner, 'three.example.net');
      expect(r.status).toBe(409);
    }
    release(w, ws);
    expect((await w.addPaid(w.owner, 'three.example.net')).status).toBe(201);
  });
});

describe('S2: the add path of a workspace whose payment did not go through says so', () => {
  it('plan_required carries the state and the payment-problem sentence, not "your free plan covers one domain"', async () => {
    const { w, ws } = await ready();
    const subId = [...w.fake.state.subscriptions.values()][0].id as string;
    w.fake.setCardBehavior([...w.fake.state.customers.keys()].find((id) => w.fake.state.customers.get(id)?.metadata?.workspace_id === ws)!, 'decline');
    w.fake.advancePeriod(subId);
    await w.fake.flush();
    const res = await w.tryVerify(w.owner, 'three.example.net');
    expect(res.status).toBe(402);
    expect(await json(res)).toMatchObject({ code: 'plan_required', state: 'payment_problem', error: 'Your last payment did not go through. Update your card to add more domains.' });
  });
  it('an ordinary free workspace still gets the plan sentence, with its state', async () => {
    const w = await planWorld();
    await w.addFree(w.owner, 'one.example.com');
    const res = await w.tryVerify(w.owner, 'two.example.org');
    expect(res.status).toBe(402);
    const body = await json(res);
    expect(body).toMatchObject({ code: 'plan_required', state: 'none' });
    expect(body.error).toMatch(/free plan covers one domain/);
  });
});

describe('S4: a first payment waiting for the bank can be cancelled', () => {
  async function pending() {
    const w = await planWorld();
    await w.addFree(w.owner, 'one.example.com');
    await w.addCard(w.owner, 'requires_action');
    expect((await w.addPaid(w.owner, 'two.example.org')).status).toBe(201);
    return w;
  }
  it('cancel: the incomplete subscription is cancelled at Stripe, the domain goes again, nothing is charged, no "not completed" notice', async () => {
    const w = await pending();
    const ws = w.owner.workspaceId;
    expect(w.domainsOf(ws)).toEqual(['one.example.com', 'two.example.org']);
    const res = await w.api(w.owner, 'POST', '/api/billing/plan/cancel-pending', {});
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ cancelled: true, domains: ['two.example.org'] });
    expect(w.domainsOf(ws)).toEqual(['one.example.com']);
    expect(w.sub(ws)).toBeNull();
    expect(w.ws(ws).plan).toBe('free');
    expect([...w.fake.state.subscriptions.values()].map((s: any) => s.status)).toEqual(['canceled']);
    await w.fake.flush();
    expect(w.sub(ws)).toBeNull();
    const view = await json(await w.api(w.owner, 'GET', '/api/billing'));
    expect(view.plan).toMatchObject({ pending: null, name: 'free', notice: null });
    expect(rows(w.db, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'billing.pending_payment_cancelled'")[0].n).toBe(1);
    // and the person can try again with another card
    await w.addCard(w.owner, 'ok');
    expect((await w.addPaid(w.owner, 'two.example.org')).status).toBe(201);
  });
  it('only while a payment is pending, only by the owner', async () => {
    const w = await pending();
    const admin = await w.addMember(w.owner.workspaceId, 'admin@example.com', 'admin');
    expect((await w.api(admin, 'POST', '/api/billing/plan/cancel-pending', {})).status).toBe(403);
    expect(w.domainsOf(w.owner.workspaceId)).toContain('two.example.org');
    expect((await w.api(w.owner, 'POST', '/api/billing/plan/cancel-pending', {})).status).toBe(200);
    const again = await w.api(w.owner, 'POST', '/api/billing/plan/cancel-pending', {});
    expect(again.status).toBe(409);
    expect((await json(again)).code).toBe('not_pending');
  });
  it('a Stripe failure changes nothing: still pending, the person is told to try again', async () => {
    const w = await pending();
    w.fake.failNext(/DELETE \/v1\/subscriptions\//, { status: 500 });
    const res = await w.api(w.owner, 'POST', '/api/billing/plan/cancel-pending', {});
    expect(res.status).toBe(502);
    expect(w.domainsOf(w.owner.workspaceId)).toContain('two.example.org');
    expect(w.sub(w.owner.workspaceId)).not.toBeNull();
  });
});

describe('S9: a plan that ended because the card was declined says so; one cancelled by the owner does not', () => {
  const customerOf = (w: PlanWorld, ws: string) => [...w.fake.state.customers.keys()].find((id) => w.fake.state.customers.get(id)?.metadata?.workspace_id === ws)!;
  it('lapsed after a declined renewal: card_declined', async () => {
    const { w, ws } = await ready();
    const subId = [...w.fake.state.subscriptions.values()][0].id as string;
    w.fake.setCardBehavior(customerOf(w, ws), 'decline');
    w.fake.advancePeriod(subId);
    w.fake.exhaustRetries(subId, { to: 'canceled' });
    await w.fake.flush();
    const p = (await json(await w.api(w.owner, 'GET', '/api/billing'))).plan;
    expect(p).toMatchObject({ lapsed: true, card_declined: true });
    const asAdmin = (await json(await w.api(await w.addMember(ws, 'admin@example.com', 'admin'), 'GET', '/api/billing'))).plan;
    expect(asAdmin.card_declined).toBeUndefined(); // the owner's fact
  });
  it('cancelled in the portal: lapsed, but the card did not fail', async () => {
    const { w, ws } = await ready();
    const subId = [...w.fake.state.subscriptions.values()][0].id as string;
    await w.fake.fetch(`https://api.stripe.com/v1/subscriptions/${subId}`, { method: 'DELETE', headers: { authorization: 'Bearer rk_test_testkey0123456789', 'stripe-version': '2025-09-30.clover' } });
    await w.fake.flush();
    const p = (await json(await w.api(w.owner, 'GET', '/api/billing'))).plan;
    expect(p).toMatchObject({ lapsed: true, card_declined: false });
  });
});
