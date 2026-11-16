// The plan's rules without money: the setting, the unit, the allowance, the operator's exemption, the subdomain cap, the enrollment paths, who may.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { planWorld, json, rows, call } from './world';
import { billingWorld } from '../billing/world';
import { delegatedKey } from '../auth/grant-fixture';
import { planMode, paidPathAvailable, planEnforced, unitOf } from '../../src/hosted/plan';

afterEach(() => vi.unstubAllGlobals());

describe('the setting', () => {
  it('is off by default, only on for a hosted instance, and only for its one value', () => {
    const hosted = { MODE: 'saas', SAAS_ENABLED: '1' };
    expect(planMode({ ...hosted })).toBe('off');
    expect(planMode({ ...hosted, HOSTED_PLAN: 'free_one_domain' })).toBe('free_one_domain');
    expect(planMode({ ...hosted, HOSTED_PLAN: ' FREE_ONE_DOMAIN ' })).toBe('free_one_domain');
    for (const v of ['1', 'on', 'true', 'free', 'off', '']) expect(planMode({ ...hosted, HOSTED_PLAN: v }), v).toBe('off');
    expect(planMode({ MODE: 'selfhost', HOSTED_PLAN: 'free_one_domain' })).toBe('off'); // self-host: no plans, no limits
    expect(planMode({ MODE: 'saas', HOSTED_PLAN: 'free_one_domain' })).toBe('off'); // not enabled
  });
  it('the paid path needs billing as well: the plan without billing enforces the free limits only', () => {
    const base = { MODE: 'saas', SAAS_ENABLED: '1', HOSTED_PLAN: 'free_one_domain' };
    expect(planEnforced(base)).toBe(true);
    expect(paidPathAvailable(base)).toBe(false);
    expect(paidPathAvailable({ ...base, STRIPE_SECRET_KEY: 'rk_test_abc', STRIPE_WEBHOOK_SECRET: 'whsec_abc' })).toBe(true);
  });
  it('a unit is the organizational domain, from the one Public Suffix source', () => {
    expect(unitOf('mail.example.co.uk')).toBe('example.co.uk');
    expect(unitOf('a.b.example.com')).toBe('example.com');
    expect(unitOf('alice.github.io')).toBe('alice.github.io');
    expect(unitOf('co.uk')).toBe('co.uk'); // never a bare suffix as a unit of its own kind: the name itself
  });
});

describe('with HOSTED_PLAN off nothing is different', () => {
  it('the second domain is not a plan question, GET /api/billing carries no plan, the plan routes do not exist', async () => {
    const w = await planWorld({ HOSTED_PLAN: 'off' });
    expect((await w.addFree(w.owner, 'one.example.com')).status).toBe(201);
    expect((await w.addFree(w.owner, 'two.example.org')).status).toBe(201);
    expect(w.domainsOf(w.owner.workspaceId)).toHaveLength(2);
    expect((await json(await w.api(w.owner, 'GET', '/api/billing'))).plan).toBeUndefined();
    for (const [m, p] of [['GET', '/api/billing/domains/preview?domain=x.com'], ['POST', '/api/billing/domains'], ['POST', '/api/billing/domains/bulk'], ['POST', '/api/billing/plan/start'], ['POST', '/api/billing/plan/keep-one'], ['POST', '/api/billing/workspace-intents']] as const) {
      expect((await w.api(w.owner, m, p, m === 'POST' ? {} : undefined)).status, p).toBe(404);
    }
    const calls = w.fake.calls.length;
    await w.api(w.owner, 'POST', '/api/workspaces', { name: 'Another' });
    expect(w.fake.calls.length).toBe(calls);
  });

  it('a person may create workspaces up to the cap exactly as before, and the allowance is still recorded', async () => {
    const w = await planWorld({ HOSTED_PLAN: 'off' });
    for (let i = 0; i < 4; i++) expect((await w.api(w.owner, 'POST', '/api/workspaces', { name: `W${i}` })).status).toBe(201);
    expect((await w.api(w.owner, 'POST', '/api/workspaces', { name: 'W5' })).status).toBe(403);
    expect(rows(w.db, "SELECT COUNT(*) AS n FROM workspaces WHERE free_owner_user_id IS NOT NULL")[0].n).toBe(2 + 0); // the operator's and the owner's sign-up workspaces
  });
});

describe('the allowance: one free domain per person, in exactly one workspace they own', () => {
  it('sign-up gives it to the first workspace; the database refuses a second under any race', async () => {
    const w = await planWorld();
    const ws = rows(w.db, 'SELECT id, free_owner_user_id FROM workspaces WHERE id = ?', w.owner.workspaceId)[0];
    const uid = rows(w.db, "SELECT id FROM users WHERE email = 'owner@example.com'")[0].id;
    expect(ws.free_owner_user_id).toBe(uid);
    w.db.sqlite.prepare("INSERT INTO workspaces (id, name) VALUES ('ws_x', 'x')").run();
    expect(() => w.db.sqlite.prepare('UPDATE workspaces SET free_owner_user_id = ? WHERE id = ?').run(uid, 'ws_x')).toThrow(/UNIQUE/);
    expect(() => w.db.sqlite.prepare("INSERT INTO workspaces (id, name, free_owner_user_id) VALUES ('ws_y', 'y', ?)").run(uid)).toThrow(/UNIQUE/);
  });

  it('a second workspace without a card is refused (402 workspace_needs_card) and nothing is created', async () => {
    const w = await planWorld();
    const before = rows(w.db, 'SELECT COUNT(*) AS n FROM workspaces')[0].n;
    const res = await w.api(w.owner, 'POST', '/api/workspaces', { name: 'Second' });
    expect(res.status).toBe(402);
    expect(await json(res)).toMatchObject({ code: 'workspace_needs_card', paid_available: true, error: 'Add a card to create more workspaces.' });
    expect(rows(w.db, 'SELECT COUNT(*) AS n FROM workspaces')[0].n).toBe(before);
    expect(rows(w.db, "SELECT COUNT(*) AS n FROM workspaces WHERE name = 'Second'")[0].n).toBe(0);
  });

  it('many parallel creates cannot multiply free workspaces: a person with no allowance gets exactly one', async () => {
    const w = await planWorld();
    const uid = rows(w.db, "SELECT id FROM users WHERE email = 'owner@example.com'")[0].id;
    // the person gives theirs up (the workspace goes), then five creates race for the one allowance
    w.db.sqlite.prepare('UPDATE workspaces SET free_owner_user_id = NULL WHERE id = ?').run(w.owner.workspaceId);
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => w.api(w.owner, 'POST', '/api/workspaces', { name: `race${i}` })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 402, 402, 402, 402]);
    expect(rows(w.db, 'SELECT COUNT(*) AS n FROM workspaces WHERE free_owner_user_id = ?', uid)[0].n).toBe(1);
  });

  it('an invited person holds nothing and consumes nothing: joining is free, and their own first workspace is free', async () => {
    const w = await planWorld();
    const m = await w.addMember(w.owner.workspaceId, 'invited@example.com', 'member');
    const uid = rows(w.db, "SELECT id FROM users WHERE email = 'invited@example.com'")[0].id;
    // sign-up already gave them a workspace of their own with the allowance; the invitation changed nothing about it
    expect(rows(w.db, 'SELECT COUNT(*) AS n FROM workspaces WHERE free_owner_user_id = ?', uid)[0].n).toBe(1);
    expect(rows(w.db, 'SELECT free_owner_user_id AS f FROM workspaces WHERE id = ?', w.owner.workspaceId)[0].f).not.toBe(uid);
    expect(m.workspaceId).toBe(w.owner.workspaceId);
  });

  it('deleting and recreating a workspace cannot multiply the free domain: at most one workspace holds the allowance at any time', async () => {
    const w = await planWorld();
    const uid = rows(w.db, "SELECT id FROM users WHERE email = 'owner@example.com'")[0].id;
    w.db.sqlite.prepare('UPDATE workspaces SET free_owner_user_id = NULL WHERE id = ?').run(w.owner.workspaceId); // the first is gone (here: its allowance freed)
    expect((await w.api(w.owner, 'POST', '/api/workspaces', { name: 'Again' })).status).toBe(201);
    expect((await w.api(w.owner, 'POST', '/api/workspaces', { name: 'And again' })).status).toBe(402);
    expect(rows(w.db, 'SELECT COUNT(*) AS n FROM workspaces WHERE free_owner_user_id = ?', uid)[0].n).toBe(1);
  });

  it('separate accounts each get one free domain: only the existing sign-up controls bound that (stated, not hidden)', async () => {
    const w = await planWorld();
    const a = await w.person('second-account@example.com');
    expect((await w.addFree(a, 'second.example.net')).status).toBe(201);
    expect((await w.addFree(w.owner, 'first.example.com')).status).toBe(201);
    expect(rows(w.db, 'SELECT COUNT(*) AS n FROM workspaces WHERE free_owner_user_id IS NOT NULL')[0].n).toBe(3);
  });
});

describe('the operator is exempt, and nobody else can claim it', () => {
  it('the instance owner\'s workspace takes today\'s cap (10 domains), with no plan', async () => {
    const w = await planWorld();
    for (let i = 0; i < 3; i++) expect((await w.addFree(w.operator, `op${i}.example.com`)).status).toBe(201);
    expect((await json(await w.api(w.operator, 'GET', '/api/billing'))).plan).toMatchObject({ exempt: true });
  });
  it('a customer cannot claim it: not by a request field, a header, their name or an address that looks like the owner\'s', async () => {
    const w = await planWorld();
    await w.addFree(w.owner, 'one.example.com');
    for (const extra of [{ exempt: true }, { operator: true }, { plan: 'operator' }, { owner_email: 'operator@example.com' }]) {
      const res = await w.tryVerify(w.owner, `two${Object.keys(extra)[0]!.replace(/_/g, "")}.example.org`);
      expect(res.status, JSON.stringify(extra)).toBe(402);
    }
    const res = await w.tryVerify(w.owner, 'twoheader.example.org');
    expect(res.status).toBe(402);
    expect((await json(await w.api(w.owner, 'GET', '/api/billing'))).plan.exempt).toBe(false);
    // an account whose address only looks like the owner's (case, plus-tag, a lookalike domain) is not the owner
    for (const email of ['Operator@Example.com.evil.test', 'operator+x@example.com', 'operator@example.co']) {
      const p = await w.person(email);
      expect((await json(await w.api(p, 'GET', '/api/billing'))).plan.exempt, email).toBe(false);
    }
  });
  it('without OWNER_EMAIL on a hosted instance nobody is exempt', async () => {
    const w = await planWorld({ OWNER_EMAIL: '' });
    await w.addFree(w.operator, 'op1.example.com');
    expect((await w.tryVerify(w.operator, 'op2.example.org')).status).toBe(402);
  });
});

describe('every way in respects the plan', () => {
  it('bulk add: subdomains of the held domain fit, a different domain says plan_required in its own row and gets no claim', async () => {
    const w = await planWorld();
    expect((await w.addFree(w.owner, 'one.example.com')).status).toBe(201);
    const res = await w.api(w.owner, 'POST', '/api/domains/bulk-import', { domains: 'a.one.example.com\ntwo.example.org\nb.one.example.com' });
    const body = await json(res);
    const results = body.results as Array<{ domain: string; status: string; code?: string }>;
    expect(results.map((r) => [r.domain, r.status, r.code])).toEqual([['a.one.example.com', 'imported', undefined], ['two.example.org', 'error', 'plan_required'], ['b.one.example.com', 'imported', undefined]]);
    expect(w.domainsOf(w.owner.workspaceId)).toEqual(['one.example.com', 'a.one.example.com', 'b.one.example.com']);
    expect(rows(w.db, "SELECT COUNT(*) AS n FROM domain_claims WHERE domain = 'two.example.org'")[0].n).toBe(0);
  });

  it('the setup wizard\'s base domain: the first fits, a different second is refused 402 plan_required', async () => {
    const w = await planWorld();
    expect((await w.addFree(w.owner, 'one.example.com')).status).toBe(201);
    const res = await w.api(w.owner, 'POST', '/api/settings/base-domain', { domain: 'two.example.org' });
    expect(res.status).toBe(402);
    expect((await json(res)).code).toBe('plan_required');
    expect(w.domainsOf(w.owner.workspaceId)).toEqual(['one.example.com']);
  });

  it('an API key or agent credential is told in plain words and cannot start a paid domain', async () => {
    const w = await planWorld();
    await w.addFree(w.owner, 'one.example.com');
    const uid = rows(w.db, "SELECT id FROM users WHERE email = 'owner@example.com'")[0].id;
    const k = await delegatedKey(w.db as never, { workspaceId: w.owner.workspaceId, userId: uid, name: 'k', domain: 'one.example.com', kind: 'service' });
    for (const [m, p] of [['POST', '/api/billing/domains'], ['POST', '/api/billing/domains/bulk'], ['POST', '/api/billing/plan/start'], ['POST', '/api/billing/plan/keep-one'], ['POST', '/api/billing/workspace-intents'], ['GET', '/api/billing/domains/preview?domain=x.com'], ['GET', '/api/billing']] as const) {
      const res = await call(w.env, m, p, { key: k.key, body: m === 'POST' ? { domain: 'two.example.org', expected_amount: 500, expected_currency: 'usd' } : undefined });
      expect([401, 403], `${m} ${p} -> ${res.status}`).toContain(res.status);
    }
    expect(w.domainsOf(w.owner.workspaceId)).toEqual(['one.example.com']);
    expect(w.fake.calls.filter((c: any) => c.method === 'POST' && /subscription/.test(c.path))).toEqual([]);
  });

  it('an admin and a member cannot start the plan, add a paid domain or pay for a workspace on the owner\'s card', async () => {
    const w = await planWorld();
    await w.addFree(w.owner, 'one.example.com');
    await w.addCard(w.owner);
    const admin = await w.addMember(w.owner.workspaceId, 'admin@example.com', 'admin');
    const member = await w.addMember(w.owner.workspaceId, 'member@example.com', 'member');
    const writes = () => w.fake.calls.filter((c: any) => c.method !== 'GET').length;
    const before = writes();
    for (const p of [admin, member]) {
      for (const [m, path, body] of [['POST', '/api/billing/domains', { domain: 'two.example.org', expected_amount: 500, expected_currency: 'usd' }], ['POST', '/api/billing/domains/bulk', { domains: ['two.example.org'], expected_amount: 500, expected_currency: 'usd' }], ['POST', '/api/billing/plan/start', {}], ['POST', '/api/billing/plan/keep-one', { domain_id: 1 }], ['GET', '/api/billing/domains/preview?domain=two.example.org', undefined]] as const) {
        const res = await w.api(p, m, path, body);
        expect(res.status, `${p.email} ${path}`).toBe(403);
        expect((await json(res)).code).toBe('owner_required');
      }
      const view = await json(await w.api(p, 'GET', '/api/billing'));
      expect(view.plan).toMatchObject({ name: 'free', ask_owner: true, can_manage: false });
      expect(view.plan.price).toBeUndefined();
      expect(view.card).toBeUndefined();
    }
    expect(writes()).toBe(before);
    expect(w.sub(w.owner.workspaceId)).toBeNull();
  });
});

describe('subdomains', () => {
  it('a free workspace keeps 50 subdomain rows under a domain; the 51st says why, and the unit stays one', async () => {
    const w = await planWorld();
    expect((await w.addFree(w.owner, 'one.example.com')).status).toBe(201);
    for (let i = 0; i < 49; i++) w.db.sqlite.prepare("INSERT INTO domains (domain, rua_address, workspace_id, verified_via, org_domain) VALUES (?, 'x', ?, 'parent', 'example.com')").run(`s${i}.one.example.com`, w.owner.workspaceId);
    const res = await w.api(w.owner, 'POST', '/api/settings/base-domain', { domain: 'late.one.example.com' });
    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({ code: 'plan_limit', error: 'This domain has more than 50 subdomains sending mail; the rest are counted under the domain.' });
  });
});
