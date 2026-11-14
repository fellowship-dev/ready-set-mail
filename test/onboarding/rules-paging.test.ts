import { describe, expect, it, vi, afterEach } from 'vitest';
import { buildPlan } from '../../src/onboarding/plan';
import { handleOnboardingRoutes } from '../../src/onboarding/routes';
import { CfClient } from '../../src/tenancy/cf-client';
import { FakeCloudflare } from '../helpers/cf-fake';

vi.mock('../../src/audit/log', () => ({ logAudit: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

const Z = 'z'.repeat(32);
const WORKER = { type: 'worker', value: ['ready-set-mail'] };
const literal = (to: string, action: unknown = { type: 'forward', value: ['boss@a-corp.com'] }, i = 0) => ({ id: `r${i}-${to}`, enabled: true, matchers: [{ type: 'literal', field: 'to', value: to }], actions: [action] });
const filler = (n: number) => Array.from({ length: n }, (_, i) => literal(`person${i}@a-corp.com`, undefined, i));

/** A self-host tenant over a real CfClient talking to the in-memory Cloudflare (which pages like the real one). */
function setup(rules: unknown[], tweak?: (f: FakeCloudflare) => void) {
  const fake = new FakeCloudflare({ 'a-corp.com': { id: Z } });
  fake.rules[Z] = rules;
  tweak?.(fake);
  const cf = new CfClient('tok', { fetch: fake.fetch as unknown as typeof fetch });
  const tenant = {
    settings: { reportsDomain: 'reports.a-corp.com' }, workerName: 'ready-set-mail', mode: 'selfhost', workspaceId: 'ws', env: {},
    scope: { domains: { getById: async (id: number) => ({ id, domain: 'a-corp.com', dns_record_id: 'x', status: 'verified' }), setDnsRecord: async () => {} } },
    cfFor: async () => cf,
  } as any;
  return { fake, tenant };
}
const mail = (p: any) => p.steps.find((s: any) => s.key === 'reports_mailbox');
const ruleCalls = (f: FakeCloudflare) => f.calls.filter(c => c.method === 'GET' && /\/email\/routing\/rules/.test(c.url));
const post = (tenant: any, path: string, body: unknown) => handleOnboardingRoutes(new Request(`https://x${path}`, { method: 'POST', body: JSON.stringify(body) }), tenant, undefined, { role: 'owner', user: null });

describe('the rules of a zone are read from every page', () => {
  it('asks for 50 per page and follows the pages', async () => {
    const { fake, tenant } = setup(filler(120));
    await buildPlan(tenant, [1]);
    const urls = ruleCalls(fake).map(c => new URL(c.url).searchParams);
    expect(urls.map(u => [u.get('page'), u.get('per_page')])).toEqual([['1', '50'], ['2', '50'], ['3', '50']]);
  });

  it('a conflicting rua@ rule on page 2 is seen: a conflict is reported and no rule is written for it', async () => {
    const rules = [...filler(60), literal('rua@reports.a-corp.com', { type: 'forward', value: ['boss@a-corp.com'] })];
    const { tenant } = setup(rules);
    const { plan } = await buildPlan(tenant, [1]);
    expect(mail(plan).writes.map((w: any) => w.id)).not.toContain('rule:rua');
    expect(mail(plan).writes.map((w: any) => w.id)).toContain('rule:tls-rpt');
    expect(plan.not_written.find((n: any) => n.what === 'Address rule for rua@reports.a-corp.com')?.reason).toMatch(/forwards to boss@a-corp.com/);
  });

  it('our own rule on page 2 counts as already in place', async () => {
    const rules = [...filler(60), literal('rua@reports.a-corp.com', WORKER), literal('tls-rpt@reports.a-corp.com', WORKER)];
    const { tenant } = setup(rules);
    const { plan } = await buildPlan(tenant, [1]);
    expect(mail(plan).writes.filter((w: any) => w.type === 'EMAIL_ROUTING').map((w: any) => w.action)).toEqual(['none', 'none']);
  });

  it('page 2 unreadable: no rules are planned and the reason is given', async () => {
    const { tenant } = setup(filler(80), f => { f.ruleFailPage = 2; });
    const { plan } = await buildPlan(tenant, [1]);
    expect(mail(plan).writes.filter((w: any) => w.type === 'EMAIL_ROUTING')).toEqual([]);
    expect(plan.not_written.find((n: any) => n.what === 'Address rules')?.reason).toMatch(/could not read the Email Routing rules/);
  });

  it('more pages than the cap: no rules are planned and the reason is given', async () => {
    const { fake, tenant } = setup(filler(1001));
    const { plan } = await buildPlan(tenant, [1]);
    expect(mail(plan).writes.filter((w: any) => w.type === 'EMAIL_ROUTING')).toEqual([]);
    expect(plan.not_written.some((n: any) => n.what === 'Address rules')).toBe(true);
    expect(ruleCalls(fake)).toHaveLength(1); // the total on page 1 is already over the cap: no page is walked
  });

  it('an answer without paging information is not a complete list', async () => {
    const { tenant } = setup([], f => {
      const inner = f.fetch.getMockImplementation()!;
      f.fetch.mockImplementation(async (i, init) => {
        const r = await inner(i, init);
        if (!String(i).includes('/email/routing/rules')) return r;
        const b = await r.json() as any; delete b.result_info;
        return new Response(JSON.stringify(b), { status: 200 });
      });
    });
    const { plan } = await buildPlan(tenant, [1]);
    expect(plan.not_written.some((n: any) => n.what === 'Address rules')).toBe(true);
  });

  it('an inconsistent count (page shorter than its place in the total) is not a complete list', async () => {
    const { tenant } = setup(filler(60), f => {
      const inner = f.fetch.getMockImplementation()!;
      f.fetch.mockImplementation(async (i, init) => {
        const r = await inner(i, init);
        if (!String(i).includes('/email/routing/rules') || new URL(String(i)).searchParams.get('page') !== '2') return r;
        const b = await r.json() as any; b.result = b.result.slice(0, 3);
        return new Response(JSON.stringify(b), { status: 200 });
      });
    });
    const { plan } = await buildPlan(tenant, [1]);
    expect(plan.not_written.some((n: any) => n.what === 'Address rules')).toBe(true);
  });
});

describe('verifyWrite reads every page', () => {
  async function apply(tenant: any) {
    const plan = await (await post(tenant, '/api/onboarding/dns-plan', { domain_ids: [1] }))!.json() as any;
    const res = await post(tenant, '/api/onboarding/dns-apply', { domain_ids: [1], step: 'reports_mailbox', plan_id: plan.plan_id });
    return (await res!.json() as any).results as any[];
  }

  it('finds the rule it just wrote even when it lands on page 2', async () => {
    const { tenant } = setup(filler(55));
    const results = await apply(tenant);
    expect(results.find(r => r.id === 'rule:rua')).toMatchObject({ ok: true, verified: true });
  });

  it('a read-back that cannot be completed is not verified, with a reason', async () => {
    const { fake, tenant } = setup(filler(55));
    let posted = false;
    const inner = fake.fetch.getMockImplementation()!;
    fake.fetch.mockImplementation(async (i, init) => {
      if ((init?.method ?? 'GET') === 'POST' && String(i).includes('/email/routing/rules')) posted = true;
      if (posted && String(i).includes('/email/routing/rules') && new URL(String(i)).searchParams.get('page') === '2') return new Response(JSON.stringify({ success: false, errors: [{ message: 'boom' }] }), { status: 500 });
      return inner(i, init);
    });
    const results = await apply(tenant);
    const rua = results.find(r => r.id === 'rule:rua');
    expect(rua).toMatchObject({ ok: true, verified: false });
    expect(rua.verify_note).toMatch(/Could not read rua@reports.a-corp.com back/);
  });
});
