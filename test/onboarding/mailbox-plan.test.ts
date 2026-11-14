import { describe, expect, it } from 'vitest';
import { buildPlan } from '../../src/onboarding/plan';


/** A self-host tenant whose Cloudflare client answers from fixtures: only what buildPlan touches. */
function setup(opts: { routing: boolean; catchAll: unknown; mx?: { id: string; content: string; priority: number }[] }) {
  const calls: string[] = [];
  const cf = {
    zoneFor: async () => ({ id: 'z1', name: 'a-corp.com' }),
    listDnsRecords: async (_z: string, q: { type?: string }) => (q.type === 'MX' ? opts.mx ?? [] : []),
    request: async (method: string, path: string) => {
      calls.push(`${method} ${path}`);
      return path.endsWith('/catch_all') ? opts.catchAll : { enabled: opts.routing };
    },
  };
  const tenant = {
    settings: { reportsDomain: 'reports.a-corp.com' }, workerName: 'ready-set-mail',
    scope: { domains: { getById: async (id: number) => ({ id, domain: 'a-corp.com', dns_record_id: 'x' }) } },
    cfFor: async () => cf,
    env: {},
  } as any;
  return { tenant, calls };
}
const mail = (p: any) => p.steps.find((s: any) => s.key === 'reports_mailbox');

describe('reports mailbox plan (self-host)', () => {
  it('Email Routing off: no enable write, a note instead; MX and catch-all still planned', async () => {
    const { tenant, calls } = setup({ routing: false, catchAll: { enabled: false, actions: [{ type: 'drop' }] } });
    const { plan } = await buildPlan(tenant, [1]);
    const ids = mail(plan).writes.map((x: any) => x.id);
    expect(ids).not.toContain('enable');
    expect(ids).toEqual(expect.arrayContaining(['mx:route1.mx.cloudflare.net', 'catch_all']));
    const note = plan.not_written.find(n => n.what === 'Email Routing')!;
    expect(note.step).toBe('reports_mailbox');
    expect(note.reason).toBe('Email Routing is off for a-corp.com. Turning it on changes the mail records of a-corp.com itself, so Ready Set Mail leaves that to you: in Cloudflare, open a-corp.com → Email → Email Routing and follow its steps. Then run this step again.');
    expect(mail(plan).writes.find((x: any) => x.id === 'catch_all').content).toBe('Catch-all rule for a-corp.com: mail to any address at a-corp.com without its own rule goes to this Worker');
    expect(calls.every(c => c.startsWith('GET'))).toBe(true);
  });

  it('a catch-all that forwards elsewhere is not replaced and is reported', async () => {
    const { tenant } = setup({ routing: true, catchAll: { enabled: true, actions: [{ type: 'forward', value: ['boss@a-corp.com'] }] } });
    const { plan } = await buildPlan(tenant, [1]);
    expect(mail(plan).writes.map((x: any) => x.id)).not.toContain('catch_all');
    expect(plan.not_written.find(n => n.what === 'Catch-all rule')!.reason).toContain('forwards to boss@a-corp.com');
    expect(plan.not_written.find(n => n.what === 'Catch-all rule')!.step).toBe('reports_mailbox');
  });

  it('a catch-all that already goes to this Worker is satisfied, an unreadable routing state says nothing', async () => {
    const { tenant } = setup({ routing: true, catchAll: { enabled: true, actions: [{ type: 'worker', value: ['ready-set-mail'] }] }, mx: [
      { id: '1', content: 'route1.mx.cloudflare.net', priority: 40 }, { id: '2', content: 'route2.mx.cloudflare.net', priority: 83 }, { id: '3', content: 'route3.mx.cloudflare.net', priority: 98 }] });
    const { plan } = await buildPlan(tenant, [1]);
    expect(mail(plan).satisfied).toBe(true);
    expect(plan.not_written.map(n => n.what)).not.toContain('Email Routing');
  });

  it('a non-Cloudflare MX on the subdomain is shown as a delete', async () => {
    const { tenant } = setup({ routing: true, catchAll: null, mx: [{ id: 'old', content: 'mail.example.net', priority: 10 }] });
    const { plan } = await buildPlan(tenant, [1]);
    expect(mail(plan).writes.find((x: any) => x.id === 'mx-del:old')).toMatchObject({ action: 'delete', before: '10 mail.example.net' });
  });
});

describe('report authorisation record', () => {
  const dmarcStep = (plan: any) => plan.steps.find((s: any) => s.key === 'dmarc').writes.map((w: any) => w.id);
  it('is skipped when the policy domain and the reports domain share an organisational domain', async () => {
    const { tenant } = setup({ routing: true, catchAll: null });
    const cf = await tenant.cfFor();
    cf.listDnsRecords = async (_z: string, q: { type?: string }) => (q.type === 'TXT' ? [{ id: 'x', content: 'v=DMARC1; p=none' }] : []);
    const { plan } = await buildPlan(tenant, [1]); // a-corp.com reporting to reports.a-corp.com
    expect(dmarcStep(plan)).toEqual(['dmarc:1']); // and no auth:1
  });
  it('is planned for another organisation', async () => {
    const { tenant } = setup({ routing: true, catchAll: null });
    tenant.scope.domains.getById = async (id: number) => ({ id, domain: 'other-org.net', dns_record_id: null });
    const own = { zoneFor: async () => ({ id: 'z2', name: 'other-org.net' }), listDnsRecords: async (_z: string, q: { type?: string; name?: string }) => (q.type === 'TXT' && q.name?.startsWith('_dmarc') ? [{ id: 'x', content: 'v=DMARC1; p=none' }] : []), request: async () => ({}) };
    tenant.cfFor = async () => own;
    const { plan } = await buildPlan(tenant, [1]);
    expect(dmarcStep(plan)).toEqual(expect.arrayContaining(['dmarc:1', 'auth:1']));
  });
  it('knows the public suffix list: co.uk names of different organisations are not the same', async () => {
    const { sameOrganisation } = await import('../../src/onboarding/plan');
    expect(sameOrganisation('a.co.uk', 'reports.a.co.uk')).toBe(true);
    expect(sameOrganisation('a.co.uk', 'b.co.uk')).toBe(false);
  });
});
