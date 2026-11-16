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
