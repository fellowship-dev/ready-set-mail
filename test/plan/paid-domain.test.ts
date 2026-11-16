// The paid domain, end to end against the fake Stripe: the free first domain, the plan_required answer for the second, the card, the confirm, the
// quantity, and everything that must not be possible.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { planWorld, json, rows } from './world';

afterEach(() => vi.unstubAllGlobals());

const qty = (w: Awaited<ReturnType<typeof planWorld>>) => [...w.fake.state.subscriptionItems.values()].map((i: any) => i.quantity);

describe('the free domain and the second one', () => {
  it('the first domain is free and says nothing about money; a second answers 402 plan_required', async () => {
    const w = await planWorld();
    const first = await w.addFree(w.owner, 'one.example.com');
    expect(first.status).toBe(201);
    expect(JSON.stringify(await first.clone().json())).not.toMatch(/\$|price|plan/i);
    const second = await w.tryVerify(w.owner, 'two.example.org');
    expect(second.status).toBe(402);
    expect(await json(second)).toMatchObject({ code: 'plan_required', paid_available: true, domain: 'two.example.org' });
    expect(w.rows ?? true).toBeTruthy();
  });

  it('a subdomain of a domain the workspace holds is the same unit: free, and never asks', async () => {
    const w = await planWorld();
    expect((await w.addFree(w.owner, 'one.example.com')).status).toBe(201);
    const sub = await w.addFree(w.owner, 'mail.one.example.com');
    expect(sub.status).toBe(201);
    expect(w.domainsOf(w.owner.workspaceId)).toEqual(['one.example.com', 'mail.one.example.com']);
    expect(w.sub(w.owner.workspaceId)).toBeNull();
  });
});

describe('adding a paid domain', () => {
  it('needs a card first (409 card_required), then bills through the quantity: confirm → added, plan payg, quantity 1', async () => {
    const w = await planWorld();
    await w.addFree(w.owner, 'one.example.com');
    const noCard = await w.addPaid(w.owner, 'two.example.org');
    expect(noCard.status).toBe(409);
    expect((await json(noCard)).code).toBe('card_required');
    await w.addCard(w.owner);
    const done = await w.addPaid(w.owner, 'two.example.org');
    expect(done.status).toBe(201);
    expect((await json(done)).added).toEqual([{ domain: 'two.example.org', domain_id: expect.any(Number) }]);
    expect(w.ws(w.owner.workspaceId).plan).toBe('payg');
    expect(w.sub(w.owner.workspaceId)).toMatchObject({ status: 'active', quantity_sent: 1 });
    expect(qty(w)).toEqual([1]);
    expect(w.domainsOf(w.owner.workspaceId)).toEqual(['one.example.com', 'two.example.org']);
  });

  it('the browser never sends a quantity or a price id: they are ignored, and a wrong shown price is 409 price_changed', async () => {
    const w = await planWorld();
    await w.addFree(w.owner, 'one.example.com');
    await w.addCard(w.owner);
    const sneaky = await w.addPaid(w.owner, 'two.example.org', { quantity: 0, price: 'price_x', items: [{ quantity: 99 }], billable: 0 });
    expect(sneaky.status).toBe(201);
    expect(qty(w)).toEqual([1]);
    const stale = await w.api(w.owner, 'POST', '/api/billing/domains', { domain: 'three.example.net', expected_amount: 400, expected_currency: 'usd' });
    expect(stale.status).toBe(409);
    expect(await json(stale)).toMatchObject({ code: 'price_changed', amount: 500, currency: 'usd' });
    expect(w.domainsOf(w.owner.workspaceId)).not.toContain('three.example.net');
  });

  it('a third domain raises the quantity to 2 and a removal brings it back down', async () => {
    const w = await planWorld();
    await w.addFree(w.owner, 'one.example.com');
    await w.addCard(w.owner);
    await w.addPaid(w.owner, 'two.example.org');
    await w.addPaid(w.owner, 'three.example.net');
    expect(qty(w)).toEqual([2]);
    const id = rows(w.db, "SELECT id FROM domains WHERE domain = 'three.example.net'")[0].id;
    const del = await w.api(w.owner, 'DELETE', `/api/domains/${id}`);
    expect(del.status).toBe(200);
    expect((await json(del)).billing).toEqual({ quantity_changed: true });
    expect(qty(w)).toEqual([1]);
    expect(w.sub(w.owner.workspaceId).quantity_sent).toBe(1);
  });

  it('a Stripe failure while updating rolls the domain back: not added, not free', async () => {
    const w = await planWorld();
    await w.addFree(w.owner, 'one.example.com');
    await w.addCard(w.owner);
    await w.addPaid(w.owner, 'two.example.org');
    w.fake.failNext(/POST \/v1\/subscription_items\//, { status: 500 });
    const res = await w.addPaid(w.owner, 'three.example.net');
    expect(res.status).toBe(502);
    expect(await json(res)).toMatchObject({ code: 'plan_update_failed', error: 'We could not update your plan; the domain was not added. Try again.' });
    expect(w.domainsOf(w.owner.workspaceId)).toEqual(['one.example.com', 'two.example.org']);
    expect(qty(w)).toEqual([1]);
    expect(rows(w.db, "SELECT COUNT(*) AS n FROM monitor_subscriptions WHERE domain = 'three.example.net'")[0].n).toBe(0);
  });
});
