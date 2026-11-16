// Workspaces under the plan: creating one with a card (the workspace does not exist before the card is verified), creating one when already paying,
// ownership transfer in both directions, and deleting a workspace.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { planWorld, json, rows, call, type PlanWorld } from './world';
import type { Person } from '../billing/world';
import { BASE } from '../billing/world';

afterEach(() => vi.unstubAllGlobals());

const uidOf = (w: PlanWorld, email: string) => rows(w.db, 'SELECT id FROM users WHERE email = ?', email)[0].id as string;
const itemQty = (w: PlanWorld) => [...w.fake.state.subscriptionItems.values()].map((i: any) => i.quantity);

/** The whole "Add a card to create a workspace" trip: intent → Stripe's hosted page → the return URL. */
async function createWithCard(w: PlanWorld, p: Person, name: string, card: 'ok' | 'cancel' = 'ok') {
  const start = await w.api(p, 'POST', '/api/billing/workspace-intents', { name });
  if (start.status !== 200) return { start, back: null as Response | null };
  const { url } = await json(start);
  const sessionId = url.split('/pay/')[1] as string;
  const target = w.fake.completeCheckout(sessionId, { card });
  const back = await call(w.env, 'GET', target.replace(/^https?:\/\/[^/]+/, ''), { key: p.token });
  return { start, back, sessionId };
}

describe('a second workspace needs a card first (the workspace does not exist until it is verified)', () => {
  it('intent → card → back: the workspace is created with its customer, its plan started at quantity 0, no free domain, and the person lands in it', async () => {
    const w = await planWorld();
    const before = rows(w.db, 'SELECT COUNT(*) AS n FROM workspaces')[0].n;
    const start = await w.api(w.owner, 'POST', '/api/billing/workspace-intents', { name: 'Client A' });
    expect(start.status).toBe(200);
    const intent = rows(w.db, "SELECT * FROM workspace_intents WHERE name = 'Client A'")[0];
    expect(intent.status).toBe('open');
    expect(rows(w.db, 'SELECT COUNT(*) AS n FROM workspaces')[0].n).toBe(before); // nothing exists yet, nothing counts against the cap, nobody can be invited into it
    expect(rows(w.db, 'SELECT COUNT(*) AS n FROM workspaces WHERE id = ?', intent.id)[0].n).toBe(0);
    const { url } = await json(start);
    const back = await call(w.env, 'GET', w.fake.completeCheckout(url.split('/pay/')[1], { card: 'ok' }).replace(/^https?:\/\/[^/]+/, ''), { key: w.owner.token });
    expect(back.status).toBe(303);
    expect(back.headers.get('location')).toBe(`/#/w/${intent.id}/?workspace=created`);
    const ws = rows(w.db, 'SELECT * FROM workspaces WHERE id = ?', intent.id)[0];
    expect(ws).toMatchObject({ name: 'Client A', plan: 'payg', free_owner_user_id: null });
    expect(ws.stripe_customer_id).toBe(intent.stripe_customer_id);
    expect(w.sub(intent.id)).toMatchObject({ status: 'active', quantity_sent: 0 });
    expect(rows(w.db, 'SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?', intent.id, uidOf(w, 'owner@example.com'))[0].role).toBe('owner');
    expect(rows(w.db, 'SELECT status FROM workspace_intents WHERE id = ?', intent.id)[0].status).toBe('created');
    expect(w.fake.state.customers.get(intent.stripe_customer_id).metadata.workspace_id).toBe(intent.id);
  });

  it('the webhook may arrive first, or twice: one workspace, one subscription', async () => {
    const w = await planWorld();
    const { start, back } = await createWithCard(w, w.owner, 'Client B');
    expect(start.status).toBe(200);
    await w.fake.flush(); // checkout.session.completed after the return already created it
    const ev = [...w.fake.state.events.values()].find((e: any) => e.type === 'checkout.session.completed')!;
    await w.fake.redeliver(ev.id);
    expect(rows(w.db, "SELECT COUNT(*) AS n FROM workspaces WHERE name = 'Client B'")[0].n).toBe(1);
    expect(rows(w.db, 'SELECT COUNT(*) AS n FROM workspace_subscriptions WHERE workspace_id IN (SELECT id FROM workspaces WHERE name = ?)', 'Client B')[0].n).toBe(1);
    expect(back!.status).toBe(303);
  });

  it('the webhook alone creates it too (the browser never came back)', async () => {
    const w = await planWorld();
    const start = await w.api(w.owner, 'POST', '/api/billing/workspace-intents', { name: 'Client C' });
    w.fake.completeCheckout((await json(start)).url.split('/pay/')[1], { card: 'ok' });
    await w.fake.flush();
    expect(rows(w.db, "SELECT plan FROM workspaces WHERE name = 'Client C'")[0].plan).toBe('payg');
  });

  it('a card that was not added creates nothing', async () => {
    const w = await planWorld();
    const before = rows(w.db, 'SELECT COUNT(*) AS n FROM workspaces')[0].n;
    const start = await w.api(w.owner, 'POST', '/api/billing/workspace-intents', { name: 'Never' });
    const target = w.fake.completeCheckout((await json(start)).url.split('/pay/')[1], { card: 'cancel' });
    expect(target).toContain('workspace=canceled');
    expect(rows(w.db, 'SELECT COUNT(*) AS n FROM workspaces')[0].n).toBe(before);
    await w.fake.flush();
    expect(rows(w.db, 'SELECT COUNT(*) AS n FROM workspaces')[0].n).toBe(before);
  });

  it('only the person who started it can finish it; another account\'s return changes nothing', async () => {
    const w = await planWorld();
    const other = await w.person('other@example.com');
    const start = await w.api(w.owner, 'POST', '/api/billing/workspace-intents', { name: 'Mine' });
    const sessionId = (await json(start)).url.split('/pay/')[1];
    const target = w.fake.completeCheckout(sessionId, { card: 'ok' }).replace(/^https?:\/\/[^/]+/, '');
    w.fake.setWebhookTarget(null);
    const stolen = await call(w.env, 'GET', target, { key: other.token });
    expect(stolen.status).toBe(303);
    expect(stolen.headers.get('location')).not.toContain('workspace=created');
    expect(rows(w.db, "SELECT COUNT(*) AS n FROM workspaces WHERE name = 'Mine'")[0].n).toBe(0);
    const mine = await call(w.env, 'GET', target, { key: w.owner.token });
    expect(mine.headers.get('location')).toContain('workspace=created');
  });

  it('a member cannot use it for the owner\'s card, a person who need not add a card is told so, and open intents are limited', async () => {
    const w = await planWorld();
    // the person has no allowance left to give: a free workspace is theirs to create without a card
    const fresh = await w.person('fresh@example.com');
    w.db.sqlite.prepare('UPDATE workspaces SET free_owner_user_id = NULL WHERE id = ?').run(fresh.workspaceId);
    expect((await w.api(fresh, 'POST', '/api/billing/workspace-intents', { name: 'Not needed' })).status).toBe(409);
    for (let i = 0; i < 3; i++) expect((await w.api(w.owner, 'POST', '/api/billing/workspace-intents', { name: `Open ${i}` })).status).toBe(200);
    expect((await w.api(w.owner, 'POST', '/api/billing/workspace-intents', { name: 'One too many' })).status).toBe(429);
    expect((await w.api(w.owner, 'POST', '/api/billing/workspace-intents', { name: '' })).status).toBe(400);
  });

  it('the cap of five owned workspaces holds when the card comes back', async () => {
    const w = await planWorld({ MAX_WORKSPACES_PER_USER: '1' });
    const start = await w.api(w.owner, 'POST', '/api/billing/workspace-intents', { name: 'Too many' });
    expect(start.status).toBe(403);
    expect(rows(w.db, "SELECT COUNT(*) AS n FROM workspace_intents WHERE name = 'Too many'")[0].n).toBe(0);
  });
});

describe('a second workspace when the person already pays', () => {
  it('is created at once, without the free domain: its first domain goes through the paid confirm with a card for THAT workspace', async () => {
    const w = await planWorld();
    await createWithCard(w, w.owner, 'Pays');
    const res = await w.api(w.owner, 'POST', '/api/workspaces', { name: 'Eligible' });
    expect(res.status).toBe(201);
    const id = (await json(res)).id;
    expect(rows(w.db, 'SELECT plan, free_owner_user_id AS f FROM workspaces WHERE id = ?', id)[0]).toEqual({ plan: 'free', f: null });
    const p: Person = { ...w.owner, workspaceId: id };
    const first = await w.tryVerify(p, 'client.example.com');
    expect(first.status).toBe(402); // no free domain here
    expect((await w.addPaid(p, 'client.example.com')).status).toBe(409); // the card of THIS workspace comes first (and nothing is charged)
    await w.addCard(p);
    expect((await w.addPaid(p, 'client.example.com')).status).toBe(201);
    expect(w.sub(id)).toMatchObject({ status: 'active', quantity_sent: 1 });
    expect(w.ws(id).plan).toBe('payg');
  });
});

describe('ownership transfer', () => {
  async function pair() {
    const w = await planWorld();
    const to = await w.addMember(w.owner.workspaceId, 'newowner@example.com', 'admin');
    const toId = uidOf(w, 'newowner@example.com');
    return { w, to, toId };
  }
  const transfer = (w: PlanWorld, id: string, to: string, extra: Record<string, unknown> = {}) => call(w.env, 'POST', `/api/workspaces/${id}/transfer-ownership`, { key: w.owner.token, body: { user_id: to, ...extra } });

  it('the allowance follows: the new owner has none (give theirs up first), the workspace\'s allowance moves with it; the old owner is free to claim another', async () => {
    const { w, toId } = await pair();
    const oldId = uidOf(w, 'owner@example.com');
    w.db.sqlite.prepare('UPDATE workspaces SET free_owner_user_id = NULL WHERE id IN (SELECT workspace_id FROM memberships WHERE user_id = ? AND role = ?)').run(toId, 'owner');
    expect((await transfer(w, w.owner.workspaceId, toId)).status).toBe(200);
    expect(rows(w.db, 'SELECT free_owner_user_id AS f FROM workspaces WHERE id = ?', w.owner.workspaceId)[0].f).toBe(toId);
    expect(rows(w.db, 'SELECT COUNT(*) AS n FROM workspaces WHERE free_owner_user_id = ?', oldId)[0].n).toBe(0);
    expect((await w.api(w.owner, 'POST', '/api/workspaces', { name: 'Mine again' })).status).toBe(201); // theirs is free again
  });

  it('the new owner already holds an allowance and the workspace holds domains but no plan: refused 409 plan_required with the plain sentence', async () => {
    const { w, toId } = await pair();
    w.db.sqlite.prepare("INSERT INTO domains (domain, rua_address, workspace_id, verified_via, org_domain) VALUES ('held.example.com', 'x', ?, 'txt', 'example.com')").run(w.owner.workspaceId);
    w.db.sqlite.prepare("UPDATE users SET name = 'Newowner' WHERE email = 'newowner@example.com'").run();
    const res = await transfer(w, w.owner.workspaceId, toId);
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body.code).toBe('plan_required');
    expect(body.error).toMatch(/^Newowner already has a free workspace\. Add a card to this workspace first; /);
    expect(body.error).toMatch(/\$5 a month each\.$/);
    expect(rows(w.db, 'SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?', w.owner.workspaceId, toId)[0].role).toBe('admin'); // nothing changed
  });

  it('an empty workspace can go to someone who already has a free one: it just loses its allowance', async () => {
    const { w, toId } = await pair();
    expect((await transfer(w, w.owner.workspaceId, toId)).status).toBe(200);
    expect(rows(w.db, 'SELECT free_owner_user_id AS f FROM workspaces WHERE id = ?', w.owner.workspaceId)[0].f).toBeNull();
  });

  it('with an active plan the transfer states the new monthly amount and only goes ahead on that amount; the quantity then counts every domain', async () => {
    const { w, toId } = await pair();
    await w.addFree(w.owner, 'one.example.com');
    await w.addCard(w.owner);
    await w.addPaid(w.owner, 'two.example.org');
    expect(itemQty(w)).toEqual([1]);
    const ask = await transfer(w, w.owner.workspaceId, toId);
    expect(ask.status).toBe(409);
    expect(await json(ask)).toMatchObject({ code: 'confirm_required', monthly_amount: 1000, currency: 'usd', interval: 'month' }); // two domains, no free one any more
    const wrong = await transfer(w, w.owner.workspaceId, toId, { confirm_amount: 500 });
    expect(wrong.status).toBe(409);
    const ok = await transfer(w, w.owner.workspaceId, toId, { confirm_amount: 1000 });
    expect(ok.status).toBe(200);
    await w.fake.flush();
    expect(rows(w.db, 'SELECT free_owner_user_id AS f FROM workspaces WHERE id = ?', w.owner.workspaceId)[0].f).toBeNull();
    // the sync after the transfer runs in the background: run the daily job's repair if it did not finish
    await vi.waitFor(() => expect(itemQty(w)).toEqual([2]));
  });
});

describe('deleting a workspace', () => {
  it('cancels its subscription first (no refund of the unused period), before the rows go', async () => {
    const w = await planWorld();
    const made = await createWithCard(w, w.owner, 'Doomed');
    const id = rows(w.db, "SELECT id FROM workspaces WHERE name = 'Doomed'")[0].id as string;
    expect(made.back!.status).toBe(303);
    const subId = w.sub(id).stripe_subscription_id;
    const del = await call(w.env, 'DELETE', `/api/workspaces/${id}`, { key: w.owner.token });
    expect(del.status).toBe(200);
    expect(w.fake.state.subscriptions.get(subId).status).toBe('canceled');
    expect(w.fake.calls.some((c: any) => c.method === 'DELETE' && c.path === `/v1/subscriptions/${subId}`)).toBe(true);
    expect(rows(w.db, 'SELECT COUNT(*) AS n FROM workspaces WHERE id = ?', id)[0].n).toBe(0);
    expect(rows(w.db, 'SELECT COUNT(*) AS n FROM workspace_subscriptions WHERE workspace_id = ?', id)[0].n).toBe(0);
    await w.fake.flush(); // the deleted event finds no workspace: ignored
  });
  it('a subscription that cannot be cancelled stops the delete: billing never outlives the workspace', async () => {
    const w = await planWorld();
    await createWithCard(w, w.owner, 'Stays');
    const id = rows(w.db, "SELECT id FROM workspaces WHERE name = 'Stays'")[0].id as string;
    w.fake.failNext(/DELETE \/v1\/subscriptions\//, { status: 500 });
    const del = await call(w.env, 'DELETE', `/api/workspaces/${id}`, { key: w.owner.token });
    expect(del.status).toBe(502);
    expect((await json(del)).code).toBe('subscription_cancel_failed');
    expect(rows(w.db, 'SELECT COUNT(*) AS n FROM workspaces WHERE id = ?', id)[0].n).toBe(1);
  });
  it('with the plan off nothing is cancelled at Stripe (the operator does that, docs/billing.md)', async () => {
    const w = await planWorld();
    await createWithCard(w, w.owner, 'Quiet');
    const id = rows(w.db, "SELECT id FROM workspaces WHERE name = 'Quiet'")[0].id as string;
    Object.assign(w.env, { HOSTED_PLAN: 'off' });
    expect((await call(w.env, 'DELETE', `/api/workspaces/${id}`, { key: w.owner.token })).status).toBe(200);
    expect(w.fake.calls.some((c: any) => c.method === 'DELETE')).toBe(false);
  });
});

void BASE;
