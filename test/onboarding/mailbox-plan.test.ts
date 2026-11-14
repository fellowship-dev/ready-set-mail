import { describe, expect, it } from 'vitest';
import { buildPlan } from '../../src/onboarding/plan';


/** A self-host tenant whose Cloudflare client answers from fixtures: only what buildPlan touches. */
function setup(opts: { routing: boolean; rules?: unknown[] | Error; mx?: { id: string; content: string; priority: number }[]; reports?: string; zone?: string; mode?: string }) {
  const calls: string[] = [];
  const zone = opts.zone ?? 'a-corp.com';
  const cf = {
    zoneFor: async () => ({ id: 'z1', name: zone }),
    listDnsRecords: async (_z: string, q: { type?: string }) => (q.type === 'MX' ? opts.mx ?? [] : []),
    request: async (method: string, path: string) => {
      calls.push(`${method} ${path}`);
      if (path.endsWith('/email/routing/rules')) { if (opts.rules instanceof Error) throw opts.rules; return opts.rules ?? []; }
      return { enabled: opts.routing };
    },
  };
  const tenant = {
    settings: { reportsDomain: opts.reports ?? 'reports.a-corp.com' }, workerName: 'ready-set-mail', mode: opts.mode ?? 'selfhost',
    scope: { domains: { getById: async (id: number) => ({ id, domain: 'a-corp.com', dns_record_id: 'x' }) } },
    cfFor: async () => cf,
    env: {},
  } as any;
  return { tenant, calls };
}
const mail = (p: any) => p.steps.find((s: any) => s.key === 'reports_mailbox');
const literal = (to: string, action: unknown, enabled = true) => ({ id: 'r', enabled, matchers: [{ type: 'literal', field: 'to', value: to }], actions: [action] });
const CF = [
  { id: '1', content: 'route1.mx.cloudflare.net', priority: 40 }, { id: '2', content: 'route2.mx.cloudflare.net', priority: 83 }, { id: '3', content: 'route3.mx.cloudflare.net', priority: 98 }];

describe('reports mailbox plan (self-host)', () => {
  it('Email Routing off: no enable write, a note instead; MX and one literal rule per report address are planned, never a catch-all', async () => {
    const { tenant, calls } = setup({ routing: false });
    const { plan, exec } = await buildPlan(tenant, [1]);
    const ids = mail(plan).writes.map((x: any) => x.id);
    expect(ids).not.toContain('enable');
    expect(ids).not.toContain('catch_all');
    expect(ids).toEqual(expect.arrayContaining(['mx:route1.mx.cloudflare.net', 'rule:rua', 'rule:tls-rpt']));
    expect(mail(plan).writes.filter((x: any) => x.type === 'EMAIL_ROUTING').map((x: any) => [x.name, x.action])).toEqual([['rua@reports.a-corp.com', 'rule'], ['tls-rpt@reports.a-corp.com', 'rule']]);
    expect(exec.get('rule:rua')).toMatchObject({ kind: 'rule', address: 'rua@reports.a-corp.com' });
    const note = plan.not_written.find(n => n.what === 'Email Routing')!;
    expect(note.step).toBe('reports_mailbox');
    expect(note.reason).toBe('Email Routing is off for a-corp.com. Turning it on changes the mail records of a-corp.com itself, so Ready Set Mail leaves that to you: in Cloudflare, open a-corp.com → Email → Email Routing and follow its steps. Then run this step again.');
    expect(calls.every(c => c.startsWith('GET'))).toBe(true);
    expect(calls.some(c => c.includes('catch_all'))).toBe(false); // the catch-all is not even read
  });

  it('names the check+<token> addresses as not written: only a catch-all could receive them', async () => {
    const { tenant } = setup({ routing: true });
    const { plan } = await buildPlan(tenant, [1]);
    const n = plan.not_written.find(x => x.what.startsWith('Free-check replies'))!;
    expect(n.what).toBe('Free-check replies (check+<token>@reports.a-corp.com)');
    expect(n.step).toBe('reports_mailbox');
    expect(n.reason).toContain('does not change the catch-all rule');
  });

  it('a literal rule for the address that goes elsewhere is a conflict: shown, nothing written for it; the other address is still planned', async () => {
    const { tenant } = setup({ routing: true, rules: [literal('rua@reports.a-corp.com', { type: 'forward', value: ['boss@a-corp.com'] })] });
    const { plan } = await buildPlan(tenant, [1]);
    expect(mail(plan).writes.map((x: any) => x.id)).not.toContain('rule:rua');
    expect(mail(plan).writes.map((x: any) => x.id)).toContain('rule:tls-rpt');
    const c = plan.not_written.find(n => n.what === 'Address rule for rua@reports.a-corp.com')!;
    expect(c.reason).toContain('forwards to boss@a-corp.com');
    expect(c.step).toBe('reports_mailbox');
  });

  it('a disabled literal rule for the address is also left alone', async () => {
    const { tenant } = setup({ routing: true, rules: [literal('tls-rpt@reports.a-corp.com', { type: 'worker', value: ['ready-set-mail'] }, false)] });
    const { plan } = await buildPlan(tenant, [1]);
    expect(mail(plan).writes.map((x: any) => x.id)).not.toContain('rule:tls-rpt');
    expect(plan.not_written.find(n => n.what === 'Address rule for tls-rpt@reports.a-corp.com')!.reason).toContain('is switched off');
  });

  it('existing rules (a catch-all that forwards, an unrelated address) are never touched or replaced', async () => {
    const rules = [{ id: 'c', enabled: true, matchers: [{ type: 'all' }], actions: [{ type: 'forward', value: ['boss@a-corp.com'] }] }, literal('sales@a-corp.com', { type: 'forward', value: ['x@y.z'] })];
    const { tenant, calls } = setup({ routing: true, rules });
    const { plan } = await buildPlan(tenant, [1]);
    expect(mail(plan).writes.map((x: any) => x.id)).toEqual(expect.arrayContaining(['rule:rua', 'rule:tls-rpt']));
    expect(plan.not_written.map(n => n.what)).not.toContain('Catch-all rule');
    expect(calls.every(c => c.startsWith('GET'))).toBe(true);
  });

  it('rules that already deliver to this Worker are satisfied; an unreadable routing state says nothing', async () => {
    const w = { type: 'worker', value: ['ready-set-mail'] };
    const { tenant } = setup({ routing: true, rules: [literal('rua@reports.a-corp.com', w), literal('tls-rpt@reports.a-corp.com', w)], mx: CF });
    const { plan } = await buildPlan(tenant, [1]);
    expect(mail(plan).satisfied).toBe(true);
    expect(plan.not_written.map(n => n.what)).not.toContain('Email Routing');
  });

  it('rules that cannot be read plan no rules and say so', async () => {
    const { tenant } = setup({ routing: true, rules: new Error('nope') });
    const { plan } = await buildPlan(tenant, [1]);
    expect(mail(plan).writes.map((x: any) => x.id).filter((i: string) => i.startsWith('rule:'))).toEqual([]);
    expect(plan.not_written.some(n => n.what === 'Address rules')).toBe(true);
  });

  it('a non-Cloudflare MX on the reports name: no mailbox at all, no delete, the plain sentence', async () => {
    const { tenant } = setup({ routing: true, mx: [{ id: 'old', content: 'mail.example.net', priority: 10 }] });
    const { plan, exec } = await buildPlan(tenant, [1]);
    expect(mail(plan)).toBeUndefined();
    expect([...exec.keys()].some(k => k.startsWith('mx') || k.startsWith('rule'))).toBe(false);
    expect(plan.not_written.find(n => n.what === 'Reports mailbox')).toMatchObject({ step: 'reports_mailbox', reason: 'reports.a-corp.com already receives mail elsewhere (mail.example.net). Ready Set Mail leaves its mail records alone; change them yourself if you want reports delivered here.' });
  });

  it('a reports domain that is the zone apex gets no mailbox', async () => {
    const { tenant } = setup({ routing: true, reports: 'a-corp.com' });
    const { plan } = await buildPlan(tenant, [1]);
    expect(mail(plan)).toBeUndefined();
    expect(plan.not_written.find(n => n.what === 'Reports mailbox')!.reason).toContain('apex of its zone');
  });

  it('when the write policy would refuse an MX create, no MX and no rule is planned, and it says why', async () => {
    const { tenant } = setup({ routing: true, mode: 'saas' });
    const { plan } = await buildPlan(tenant, [1]);
    expect(mail(plan)).toBeUndefined();
    expect(plan.not_written.find(n => n.what === 'Reports mailbox')!.reason).toContain('not something this connection may write');
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
