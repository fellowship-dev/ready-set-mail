import { describe, expect, it, vi } from 'vitest';
import { handleOnboardingRoutes } from '../../src/onboarding/routes';

vi.mock('../../src/audit/log', () => ({ logAudit: vi.fn() }));

/** other-org.net reports to reports.a-corp.com: the report authorisation record sits in a-corp.com's zone. */
function setup(opts: { authPresentAtPlan: boolean; authAppearsBeforeApply?: boolean }) {
  const created: string[] = [];
  const setDnsRecord = vi.fn(async () => {});
  let applying = false;
  const cf = {
    zoneFor: async (d: string) => (d === 'other-org.net' ? { id: 'z2', name: 'other-org.net' } : { id: 'z1', name: 'a-corp.com' }),
    listDnsRecords: async (zone: string, q: { type?: string; name?: string }) => {
      if (q.type === 'TXT' && q.name?.startsWith('_dmarc.')) return [{ id: 'd1', content: 'v=DMARC1; p=none' }];
      if (q.type === 'TXT' && q.name?.includes('_report._dmarc')) {
        const there = applying ? opts.authAppearsBeforeApply || opts.authPresentAtPlan : opts.authPresentAtPlan;
        return created.length ? [{ id: 'new-auth', content: 'v=DMARC1;' }] : there ? [{ id: 'old-auth', content: 'v=DMARC1;' }] : [];
      }
      return [];
    },
    createDnsRecord: async (_z: string, r: { name: string }) => { created.push(r.name); return { id: 'new-auth' }; },
    request: async () => ({ enabled: true }),
  };
  const tenant = {
    settings: { reportsDomain: 'reports.a-corp.com' }, workerName: 'w', mode: 'selfhost', workspaceId: 'ws', env: {},
    scope: { domains: { getById: async (id: number) => ({ id, domain: 'other-org.net', dns_record_id: null, status: 'verified' }), setDnsRecord } },
    cfFor: async () => cf,
  } as any;
  return { tenant, created, setDnsRecord, begin: () => { applying = true; } };
}
const post = (tenant: any, path: string, body: unknown) => handleOnboardingRoutes(new Request(`https://x${path}`, { method: 'POST', body: JSON.stringify(body) }), tenant, undefined, { role: 'owner', user: null });
const json = async (r: Response | null) => (await r!.json()) as any;

describe('the report authorisation record belongs to the product only when the product created it', () => {
  it('created by the apply: remembered (dns_record_id, provisioned) so removing the domain deletes it', async () => {
    const t = setup({ authPresentAtPlan: false });
    const plan = await json(await post(t.tenant, '/api/onboarding/dns-plan', { domain_ids: [1] }));
    const auth = plan.steps[0].writes.find((w: any) => w.id === 'auth:1');
    expect(auth.action).toBe('create');
    t.begin();
    const res = await json(await post(t.tenant, '/api/onboarding/dns-apply', { domain_ids: [1], step: 'dmarc', plan_id: plan.plan_id }));
    expect(res.results.find((r: any) => r.id === 'auth:1')).toMatchObject({ ok: true });
    expect(t.created).toEqual(['other-org.net._report._dmarc.reports.a-corp.com']);
    expect(t.setDnsRecord).toHaveBeenCalledWith(1, 'new-auth', { provisioned: true });
  });

  it('already there at plan time: planned as "none", nothing written, nothing remembered', async () => {
    const t = setup({ authPresentAtPlan: true });
    const plan = await json(await post(t.tenant, '/api/onboarding/dns-plan', { domain_ids: [1] }));
    expect(plan.steps[0].writes.find((w: any) => w.id === 'auth:1').action).toBe('none');
    t.begin();
    await post(t.tenant, '/api/onboarding/dns-apply', { domain_ids: [1], step: 'dmarc', plan_id: plan.plan_id });
    expect(t.created).toEqual([]);
    expect(t.setDnsRecord).not.toHaveBeenCalled();
  });

  it('appears between plan and apply (someone else made it): not adopted as the product\'s: the plan moves (409), nothing is written or remembered', async () => {
    const t = setup({ authPresentAtPlan: false, authAppearsBeforeApply: true });
    const plan = await json(await post(t.tenant, '/api/onboarding/dns-plan', { domain_ids: [1] }));
    t.begin();
    const res = await post(t.tenant, '/api/onboarding/dns-apply', { domain_ids: [1], step: 'dmarc', plan_id: plan.plan_id });
    expect(res!.status).toBe(409); // the plan moved (the record is there now): review again, nothing written
    expect(((await res!.json()) as any).plan.steps[0].writes.find((w: any) => w.id === 'auth:1').action).toBe('none');
    expect(t.created).toEqual([]);
    expect(t.setDnsRecord).not.toHaveBeenCalled();
  });
});
