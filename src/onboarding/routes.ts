// /api/onboarding/* — the one-click Cloudflare onboarding (owner/admin, the caller's workspace only).
//
//   GET  /api/onboarding/dns-state?names=a.com,b.com   public DNS state per name (max 50)
//   POST /api/onboarding/dns-plan    { domain_ids }                    what each step would write, from Cloudflare's current records
//   POST /api/onboarding/dns-apply   { domain_ids, step, plan_id }     perform one step's writes; 409 plan_changed when the plan moved
//   POST /api/onboarding/first-check { domain_ids }                    store the first DNS read so the overview shows real levels

import { isSpfRecord, lookupDmarc, lookupMx, normalizeDomainName, type Resolver } from '@ready-set-mail/dns-checks';
import { resolverFor } from '../dns/resolver';
import type { TenantContext } from '../tenancy/context';
import { logAudit } from '../audit/log';
import { recordFirstDnsCheck } from '../domains/first-check';
import { writableDomains } from './domains';
import { buildPlan, type DnsPlan, type PlanWrite } from './plan';
import { failureCode, plainCloudflareError } from './errors';

const json = (data: unknown, status = 200) => Response.json(data, { status });
const err = (message: string, status: number, code?: string) => json({ error: message, ...(code ? { code } : {}) }, status);

const MAX_NAMES = 50;
const MAX_DOMAINS = 50;

export interface OnboardingCaller { role?: string; user: { id: string; email: string } | null }

export const isOnboardingRoute = (path: string) => path.startsWith('/api/onboarding/');

async function dnsState(name: string, resolver: Resolver) {
  const [txt, dmarc, mx] = await Promise.all([
    resolver.txt(name).catch(() => ({ status: 'error' as const, records: [] as string[] })),
    lookupDmarc(resolver, name).catch(() => null),
    lookupMx(resolver, name).catch(() => null),
  ]);
  return {
    name,
    resolves: txt.status === 'ok' || txt.status === 'nodata',
    spf: txt.status === 'error' ? 'error' : txt.records.some(isSpfRecord) ? 'found' : 'missing',
    dmarc: !dmarc || dmarc.status === 'error'
      ? { state: 'error' }
      : dmarc.status === 'found' && dmarc.record
        ? { state: dmarc.inherited ? 'inherited' : 'found', ...(dmarc.record.valid ? { policy: dmarc.record.policy } : {}) }
        : dmarc.status === 'multiple' ? { state: dmarc.inherited ? 'inherited' : 'found' } : { state: 'missing' },
    mx: !mx || mx.status === 'error' ? null : mx.status === 'found',
  };
}

async function domainIds(request: Request): Promise<{ ids: number[]; body: Record<string, unknown> } | Response> {
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; } catch { return err('Invalid JSON body', 400); }
  const raw = body?.domain_ids;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_DOMAINS || !raw.every(n => Number.isInteger(n) && n > 0)) return err(`domain_ids must be 1 to ${MAX_DOMAINS} domain ids`, 400);
  return { ids: raw as number[], body };
}

async function applyWrite(tenant: TenantContext, w: PlanWrite, x: NonNullable<Awaited<ReturnType<typeof buildPlan>>['exec'] extends Map<string, infer E> ? E : never>, ctx: ExecutionContext | undefined, caller: OnboardingCaller): Promise<void> {
  const actor = { actor_id: caller.user?.id ?? null, actor_email: caller.user?.email ?? null, actor_type: 'user' as const };
  const same = (r: { content: string }) => r.content.trim().replace(/^"|"$/g, '').toLowerCase().replace(/\.$/, '') === w.content.toLowerCase().replace(/\.$/, '');
  switch (x.kind) {
    case 'dmarc':
    case 'auth': {
      const existing = await x.cf.listDnsRecords(x.zoneId, { type: 'TXT', name: w.name, per_page: 50 });
      let recordId = x.recordId ?? (x.kind === 'dmarc' ? existing.find(r => /^\s*"?v=DMARC1/i.test(r.content))?.id : existing[0]?.id);
      if (w.action === 'update') {
        if (existing.some(same)) return; // already in place
        if (!recordId) throw new Error('The DMARC record is gone; plan again.');
        await x.cf.patchDnsRecord(x.zoneId, recordId, { content: w.content });
        logAudit(tenant, { ...actor, action: 'dns.update', resource_type: 'dns_record', resource_id: recordId, resource_name: w.name, before_value: { type: 'TXT', name: w.name, content: w.before }, after_value: { type: 'TXT', name: w.name, content: w.content } }, ctx);
        return;
      }
      if (existing.some(same)) recordId = existing.find(same)!.id;
      else {
        recordId = (await x.cf.createDnsRecord(x.zoneId, { type: 'TXT', name: w.name, content: w.content, ttl: 3600 })).id;
        logAudit(tenant, { ...actor, action: 'dns.create', resource_type: 'dns_record', resource_id: recordId, resource_name: w.name, after_value: { type: 'TXT', name: w.name, content: w.content } }, ctx);
      }
      if (x.kind === 'auth' && x.domainId && recordId) await tenant.scope.domains.setDnsRecord(x.domainId, recordId, { provisioned: true });
      return;
    }
    case 'mx': {
      const existing = await x.cf.listDnsRecords(x.zoneId, { type: 'MX', name: w.name, per_page: 50 });
      if (existing.some(same)) return;
      const rec = await x.cf.createDnsRecord(x.zoneId, { type: 'MX', name: w.name, content: w.content, priority: w.priority, ttl: 1 });
      logAudit(tenant, { ...actor, action: 'dns.create', resource_type: 'dns_record', resource_id: rec.id, resource_name: w.name, after_value: { type: 'MX', name: w.name, content: w.content, priority: w.priority } }, ctx);
      return;
    }
    case 'mx_delete': {
      if (x.recordId && await x.cf.deleteDnsRecord(x.zoneId, x.recordId)) {
        logAudit(tenant, { ...actor, action: 'dns.delete', resource_type: 'dns_record', resource_id: x.recordId, resource_name: w.name, before_value: { type: 'MX', name: w.name, content: w.content, priority: w.priority } }, ctx);
      }
      return;
    }
    case 'catch_all':
      await x.cf.request('PUT', `/zones/${x.zoneId}/email/routing/rules/catch_all`, {
        body: { actions: [{ type: 'worker', value: [tenant.workerName] }], enabled: true, matchers: [{ type: 'all' }], name: `catch-all → ${tenant.workerName}` },
      });
      logAudit(tenant, { ...actor, action: 'setup.email_routing', resource_type: 'email_routing', resource_name: w.name, after_value: { catch_all: tenant.workerName } }, ctx);
      return;
  }
}

/** Reads the write back from Cloudflare. False when it cannot be confirmed (a failed read counts as not confirmed). */
async function verifyWrite(tenant: TenantContext, w: PlanWrite, x: Parameters<typeof applyWrite>[2]): Promise<boolean> {
  const norm = (c: string) => c.trim().replace(/^"|"$/g, '').toLowerCase().replace(/\.$/, '');
  try {
    switch (x.kind) {
      case 'dmarc':
      case 'auth':
      case 'mx': {
        const list = await x.cf.listDnsRecords(x.zoneId, { type: x.kind === 'mx' ? 'MX' : 'TXT', name: w.name, per_page: 50 });
        return list.some(r => norm(r.content) === norm(w.content));
      }
      case 'mx_delete': {
        const list = await x.cf.listDnsRecords(x.zoneId, { type: 'MX', name: w.name, per_page: 50 });
        return !list.some(r => r.id === x.recordId);
      }
      case 'catch_all': {
        const rule = await x.cf.request<{ enabled?: boolean; actions?: { type: string; value?: string[] }[] }>('GET', `/zones/${x.zoneId}/email/routing/rules/catch_all`);
        const a = rule?.actions?.[0];
        return !!rule?.enabled && a?.type === 'worker' && (a.value ?? []).includes(tenant.workerName);
      }
    }
  } catch { return false; }
  return false;
}

export async function handleOnboardingRoutes(request: Request, tenant: TenantContext, ctx: ExecutionContext | undefined, caller: OnboardingCaller): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!isOnboardingRoute(path)) return null;
  if (caller.role !== 'owner' && caller.role !== 'admin') return err('admin required', 403);

  if (path === '/api/onboarding/dns-state' && request.method === 'GET') {
    const names = [...new Set((url.searchParams.get('names') ?? '').split(',').map(s => s.trim()).filter(Boolean))];
    if (names.length === 0 || names.length > MAX_NAMES) return err(`names must list 1 to ${MAX_NAMES} domains`, 400);
    const clean: string[] = [];
    for (const n of names) {
      const r = normalizeDomainName(n);
      if (!r.ok) return err(`${n} is not a valid domain name`, 400);
      clean.push(r.domain);
    }
    if (tenant.env.DNS_PREVIEW_LIMITER) {
      const key = caller.user?.id ? `user:${caller.user.id}` : `ws:${tenant.workspaceId}`;
      if (!(await tenant.env.DNS_PREVIEW_LIMITER.limit({ key })).success) return json({ error: 'Checked too often. Try again in a minute.', code: 'rate_limited', retry_after: 60 }, 429);
    }
    return json({ states: await Promise.all(clean.map(n => dnsState(n, resolverFor(tenant.env)))) });
  }

  if (request.method !== 'POST') return null;

  if (path === '/api/onboarding/dns-plan') {
    const input = await domainIds(request);
    if (input instanceof Response) return input;
    return json((await buildPlan(tenant, input.ids)).plan);
  }

  if (path === '/api/onboarding/dns-apply') {
    const input = await domainIds(request);
    if (input instanceof Response) return input;
    const step = input.body.step;
    if (step !== 'dmarc' && step !== 'reports_mailbox') return err('step must be dmarc or reports_mailbox', 400);
    if (typeof input.body.plan_id !== 'string') return err('plan_id is required', 400);
    const { plan, exec } = await buildPlan(tenant, input.ids);
    if (plan.plan_id !== input.body.plan_id) return json({ error: 'Cloudflare changed since you looked; review again.', code: 'plan_changed', plan }, 409);
    const writes = plan.steps.find(s => s.key === step)?.writes ?? [];
    const results: { id: string; ok: boolean; verified?: boolean; error?: string; code?: string }[] = [];
    for (const w of writes) {
      if (w.action === 'none') continue;
      try {
        const x = exec.get(w.id);
        // Never turned on from here: the zone-level enable rewrites the zone apex's mail records.
        if (!x || (x.kind as string) === 'enable' || w.id === 'enable') throw new Error('Ready Set Mail does not turn on Email Routing; do that in Cloudflare.');
        await applyWrite(tenant, w, x, ctx, caller);
        results.push({ id: w.id, ok: true, verified: await verifyWrite(tenant, w, x) });
      } catch (e) {
        const code = failureCode(e);
        results.push({ id: w.id, ok: false, error: plainCloudflareError(e), ...(code ? { code } : {}) });
      }
    }
    return json({ results });
  }

  if (path === '/api/onboarding/first-check') {
    const input = await domainIds(request);
    if (input instanceof Response) return input;
    const results: { domain_id: number; stored: boolean }[] = [];
    for (const d of await writableDomains(tenant, input.ids)) {
      const id = d.id;
      results.push({ domain_id: id, stored: (await recordFirstDnsCheck(tenant, id, d.domain, { resolver: resolverFor(tenant.env) })) !== null });
    }
    return json({ results });
  }

  return null;
}

export type { DnsPlan };
