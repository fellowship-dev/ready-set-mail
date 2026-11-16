// The plan without billing, in the preflight, for agents, the invitation limit, and the quantity's single writer.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { planWorld, json, rows, call } from './world';
import { billingPreflight } from '../../src/billing/preflight';
import { toolFailure } from '../../src/mcp/errors';
import { DomainServiceError } from '../../src/domains/service';
import { planRequiredBody, loadPlanState } from '../../src/hosted/plan';

afterEach(() => vi.unstubAllGlobals());

describe('the plan with billing off: the free limits, and "talk to us"', () => {
  it('the second domain is refused with paid_available false and the help link; the plan routes do not exist for a payment', async () => {
    const w = await planWorld({ BOOKING_URL: 'https://cal.example.com/max' }, { stripe: false });
    expect((await w.addFree(w.owner, 'one.example.com')).status).toBe(201);
    const res = await w.api(w.owner, 'POST', '/api/domains', { domain: 'two.example.org' });
    expect(res.status).toBe(402);
    expect(await json(res)).toMatchObject({ code: 'plan_required', paid_available: false, help_url: 'https://cal.example.com/max', error: 'Your free plan covers one domain and all its subdomains. For more domains, talk to us.' });
    expect((await w.api(w.owner, 'POST', '/api/billing/domains', { domain: 'two.example.org', expected_amount: 500, expected_currency: 'usd' })).status).toBe(404);
    const ws = await w.api(w.owner, 'POST', '/api/workspaces', { name: 'Second' });
    expect(ws.status).toBe(402);
    expect(await json(ws)).toMatchObject({ code: 'workspace_needs_card', paid_available: false, error: 'Your free plan includes one workspace. For more, talk to us.' });
  });

  it('the preflight says so, by setting name and never a value', async () => {
    const w = await planWorld({}, { stripe: false });
    const pf = await billingPreflight(w.env as never);
    expect(pf.status).toMatchObject({ state: 'off', plan: { mode: 'free_one_domain', paid: false } });
    expect(pf.items.find((i) => i.setting === 'HOSTED_PLAN')?.message).toMatch(/billing is not configured: the free limits are enforced and more domains say "talk to us"/);
  });

  it('with billing on the preflight checks both prices and says what is wrong', async () => {
    const w = await planWorld();
    expect((await billingPreflight(w.env as never)).status).toMatchObject({ state: 'configured', plan: { mode: 'free_one_domain', paid: true, prices: 'ok' } });
    for (const p of w.fake.state.prices.values()) if (p.lookup_key === 'rsm_extra_domain_yearly') p.unit_amount = 0;
    w.db.sqlite.prepare('DELETE FROM billing_price_cache').run();
    const bad = await billingPreflight(w.env as never);
    expect(bad.status?.plan?.prices).toBe('misconfigured');
    expect(bad.items.some((i) => i.severity === 'action' && /pay-as-you-go price/.test(i.message))).toBe(true);
  });

  it('a recurring price that is not per unit, not USD, metered or the wrong interval is refused', async () => {
    const w = await planWorld();
    const price = [...w.fake.state.prices.values()].find((p: any) => p.lookup_key === 'rsm_extra_domain_monthly') as any;
    const check = async () => { w.db.sqlite.prepare('DELETE FROM billing_price_cache').run(); return (await w.api(w.owner, 'GET', '/api/billing/domains/preview?domain=x.example.com')).status; };
    expect(await check()).toBe(200);
    const original = structuredClone(price);
    for (const change of [{ currency: 'eur' }, { billing_scheme: 'tiered' }, { recurring: { interval: 'year', interval_count: 1, usage_type: 'licensed' } }, { recurring: { interval: 'month', interval_count: 1, usage_type: 'metered' } }, { type: 'one_time', recurring: null }, { active: false }]) {
      Object.assign(price, original, change);
      expect(await check(), JSON.stringify(change)).toBe(502);
    }
  });
});

describe('agents', () => {
  it('an agent that cannot add a domain is told in plain words (the plan is the owner\'s to extend), never "unavailable"', () => {
    const failure = toolFailure(new DomainServiceError('Your free plan covers one domain and all its subdomains. Adding more domains needs the workspace owner: sign in to the dashboard and choose Add domain.', 402, { code: 'plan_required' }));
    expect(failure.isError).toBe(true);
    expect(failure.structuredContent.error.code).toBe('forbidden');
    expect(failure.structuredContent.error.message).toMatch(/needs the workspace owner/);
  });
  it('the sentence for a delegated credential names the owner and the dashboard; for a browser session it names the owner', async () => {
    const w = await planWorld();
    await w.addFree(w.owner, 'one.example.com');
    const env = w.env as never;
    const state = await loadPlanState(env, w.env.DB, w.owner.workspaceId);
    expect(planRequiredBody(env, state, { domain: 'two.example.org', session: false }).error).toBe('Your free plan covers one domain and all its subdomains. Adding more domains needs the workspace owner: sign in to the dashboard and choose Add domain.');
    expect(planRequiredBody(env, state, { domain: 'two.example.org', session: true }).error).toBe('Your free plan covers one domain and all its subdomains. The workspace owner can add more domains with pay as you go.');
  });
});

describe('invitations', () => {
  it('a free workspace sends 20 invitations a day, the 21st says so; a pay-as-you-go workspace and the operator are not held to it', async () => {
    const w = await planWorld();
    for (let i = 0; i < 20; i++) expect((await w.api(w.owner, 'POST', '/api/team/invite', { email: `p${i}@example.org` })).status, `invite ${i}`).toBe(201);
    const over = await w.api(w.owner, 'POST', '/api/team/invite', { email: 'p21@example.org' });
    expect(over.status).toBe(429);
    expect(await json(over)).toMatchObject({ code: 'invite_limit', error: "You've sent today's 20 invites; try tomorrow." });
    w.db.sqlite.prepare("UPDATE workspaces SET plan = 'payg' WHERE id = ?").run(w.owner.workspaceId);
    expect((await w.api(w.owner, 'POST', '/api/team/invite', { email: 'p22@example.org' })).status).toBe(201);
    for (let i = 0; i < 22; i++) expect((await w.api(w.operator, 'POST', '/api/team/invite', { email: `o${i}@example.org` })).status).toBe(201);
  });
  it('with the plan off nobody is limited', async () => {
    const w = await planWorld({ HOSTED_PLAN: 'off' });
    for (let i = 0; i < 22; i++) expect((await w.api(w.owner, 'POST', '/api/team/invite', { email: `p${i}@example.org` })).status).toBe(201);
  });
});

describe('product events', () => {
  it('the plan\'s moments carry categories only: never an amount, a domain or an id', async () => {
    const { allowed } = await import('../../src/product-analytics/events');
    expect(allowed('Plan Started', { interval: 'month', via: 'add_domain', amount: 500, domain: 'a.com', workspace_id: 'ws_1' })).toEqual({ interval: 'month', via: 'add_domain' });
    expect(allowed('Paid Domain Added', { via: 'cloudflare', added: '2-5', domain: 'a.com' })).toEqual({ via: 'cloudflare', added: '2-5' });
    expect(allowed('Subscription Failed', { reason: 'action_required', card: '4242' })).toEqual({ reason: 'action_required' });
    expect(allowed('Subscription Ended', { reason: 'lapsed' })).toEqual({ reason: 'lapsed' });
    expect(allowed('Subscription Ended', { reason: 'made up' })).toEqual({});
  });
});

describe('the export', () => {
  it('carries the plan and the subscription\'s state, and no Stripe id or link', async () => {
    const w = await planWorld();
    await w.addFree(w.owner, 'one.example.com');
    await w.addCard(w.owner);
    await w.addPaid(w.owner, 'two.example.org');
    const text = await (await w.api(w.owner, 'GET', `/api/workspaces/${w.owner.workspaceId}/export`)).text();
    const body = JSON.parse(text);
    expect(body.workspace).toBeTruthy();
    expect(JSON.stringify(body.workspace)).toMatch(/"plan":"payg"/);
    expect(body.workspace_subscriptions).toEqual([expect.objectContaining({ interval: 'month', status: 'active', quantity_sent: 1 })]);
    expect(JSON.stringify(body.workspace_subscriptions)).not.toMatch(/sub_fake|si_fake|price_fake|action_url|stripe_/);
    expect(JSON.stringify(body.workspace)).not.toMatch(/plan_lock|plan_revision/);
    expect(body.domains.map((d: any) => d.domain)).toEqual(['one.example.com', 'two.example.org']);
    expect(body.domains[0]).toHaveProperty('org_domain', 'example.com');
  });
});

describe('the quantity has one writer', () => {
  it('only the plan service sends a subscription quantity', () => {
    const root = join(import.meta.dirname, '../..');
    const src = readFileSync(join(root, 'src/billing/stripe-client.ts'), 'utf8');
    expect(src.match(/setItemQuantity/g)?.length).toBe(1);
    expect(readFileSync(join(root, 'src/billing/plan-service.ts'), 'utf8').match(/\.setItemQuantity\(/g)?.length).toBe(1);
  });
  it('no route reads a quantity, a price id or an item from a request body', () => {
    const routes = readFileSync(join(import.meta.dirname, '../../src/billing/routes.ts'), 'utf8');
    expect(routes).not.toMatch(/\bb\.(quantity|price|price_id|item|items)\b/);
  });
});

void rows; void call;
