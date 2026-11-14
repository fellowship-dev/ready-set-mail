// The DNS plan of the one-click onboarding: what each step would write, computed from Cloudflare's current records.
// Nothing here writes. apply.ts performs a step's writes from the same plan.

import { lookupDmarc, type Resolver } from '@ready-set-mail/dns-checks';
import type { TenantContext } from '../tenancy/context';
import { CfNotConfiguredError, type CfClient } from '../tenancy/cf-client';
import { resolverFor } from '../dns/resolver';
import { planDmarc, unquote, type InheritedRead } from './dmarc-plan';
import { plainCloudflareError } from './errors';

export interface PlanWrite {
  id: string;
  domain: string;
  zone: string;
  type: string;
  name: string;
  content: string;
  priority?: number;
  action: 'create' | 'update' | 'delete' | 'rule' | 'none';
  before: string | null;
  reason: string;
}
export interface PlanStep { key: 'dmarc' | 'reports_mailbox'; writes: PlanWrite[]; satisfied: boolean }
export interface NotWritten { domain?: string; what: string; reason: string; link?: string }
export interface DnsPlan { plan_id: string; steps: PlanStep[]; not_written: NotWritten[] }

/** What apply needs beyond the public write: the zone and record to touch. */
export interface Exec { cf: CfClient; zoneId: string; recordId?: string; domainId?: number; kind: 'dmarc' | 'auth' | 'mx' | 'mx_delete' | 'catch_all' }


const CF_MX: readonly { readonly content: string; readonly priority: number }[] = Object.freeze([
  { content: 'route1.mx.cloudflare.net', priority: 40 },
  { content: 'route2.mx.cloudflare.net', priority: 83 },
  { content: 'route3.mx.cloudflare.net', priority: 98 },
]);
const isCfMx = (c: string) => /\.mx\.cloudflare\.net\.?$/i.test(c.trim());

async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return [...d].map(b => b.toString(16).padStart(2, '0')).join('');
}

const setupLink = (domainId: number) => `#/domains/${domainId}/setup`;

async function inheritedFor(resolver: Resolver, domain: string): Promise<InheritedRead> {
  try {
    const r = await lookupDmarc(resolver, domain);
    if (r.status === 'error') return { kind: 'unknown', reason: r.error ?? 'lookup failed' };
    if (r.status === 'none') return { kind: 'none' };
    if (r.status === 'multiple') return r.inherited ? { kind: 'unknown', reason: `${r.foundAt?.replace(/^_dmarc\./, '')} has several DMARC records` } : { kind: 'none' };
    // Found at the name itself although the zone holds none: public DNS and the zone disagree, so do not guess.
    if (!r.inherited) return { kind: 'unknown', reason: 'public DNS shows a record that the Cloudflare zone does not hold' };
    return { kind: 'inherited', parent: r.organizationalDomain ?? r.foundAt!.replace(/^_dmarc\./, ''), record: r.record!.raw };
  } catch (e) {
    return { kind: 'unknown', reason: e instanceof Error ? e.message : 'lookup failed' };
  }
}

export async function buildPlan(tenant: TenantContext, domainIds: number[]): Promise<{ plan: DnsPlan; exec: Map<string, Exec> }> {
  const exec = new Map<string, Exec>();
  const dmarcWrites: PlanWrite[] = [];
  const notWritten: NotWritten[] = [];
  const reportsDomain = tenant.settings.reportsDomain || null;
  const rua = reportsDomain ? `rua@${reportsDomain}` : null;
  const resolver = resolverFor(tenant.env);

  const rows = (await Promise.all([...new Set(domainIds)].map(id => tenant.scope.domains.getById(id)))).filter(<T>(r: T | null | undefined): r is T => !!r);
  let selectedBase = false;

  let reportsCf: { cf: CfClient; zoneId: string; zoneName: string } | null = null;
  let reportsError: string | null = null;
  if (reportsDomain) {
    try {
      const cf = await tenant.cfFor(reportsDomain);
      const z = await cf.zoneFor(reportsDomain);
      reportsCf = { cf, zoneId: z.id, zoneName: z.name };
    } catch (e) { reportsError = plainCloudflareError(e); }
  }

  for (const d of rows) {
    if (reportsDomain && reportsDomain === `reports.${d.domain}`) selectedBase = true;
    let cf: CfClient; let zone: { id: string; name: string };
    try {
      cf = await tenant.cfFor(d.domain);
      zone = await cf.zoneFor(d.domain);
    } catch (e) {
      notWritten.push({ domain: d.domain, what: 'DMARC', reason: plainCloudflareError(e), link: setupLink(d.id) });
      continue;
    }
    const dmarcName = `_dmarc.${d.domain}`;
    let own: string[];
    try {
      own = (await cf.listDnsRecords(zone.id, { type: 'TXT', name: dmarcName, per_page: 50 })).map(r => r.content);
    } catch (e) {
      notWritten.push({ domain: d.domain, what: 'DMARC', reason: plainCloudflareError(e), link: setupLink(d.id) });
      continue;
    }
    const hasOwn = own.some(c => /^\s*v\s*=\s*DMARC1/i.test(unquote(c)));
    const inherited: InheritedRead = hasOwn ? { kind: 'none' } : await inheritedFor(resolver, d.domain);
    const decision = planDmarc({ ownRecords: own, inherited, rua });
    if (decision.action === 'skip') {
      notWritten.push({ domain: d.domain, what: 'DMARC', reason: decision.reason, link: setupLink(d.id) });
    } else {
      const id = `dmarc:${d.id}`;
      const existing = decision.action === 'none' || decision.action === 'update'
        ? (await cf.listDnsRecords(zone.id, { type: 'TXT', name: dmarcName, per_page: 50 })).find(r => /^\s*v\s*=\s*DMARC1/i.test(unquote(r.content)))
        : undefined;
      dmarcWrites.push({
        id, domain: d.domain, zone: zone.name, type: 'TXT', name: dmarcName, content: decision.record, action: decision.action,
        before: decision.action === 'update' ? decision.before : null, reason: decision.reason,
      });
      exec.set(id, { cf, zoneId: zone.id, recordId: existing?.id, domainId: d.id, kind: 'dmarc' });
    }

    // Report authorisation: <d>._report._dmarc.<reports domain> (self-host).
    if (reportsDomain && reportsCf) {
      const authName = `${d.domain}._report._dmarc.${reportsDomain}`;
      let present = !!d.dns_record_id;
      if (!present) {
        try {
          present = (await reportsCf.cf.listDnsRecords(reportsCf.zoneId, { type: 'TXT', name: authName, per_page: 5 })).length > 0;
        } catch (e) {
          notWritten.push({ domain: d.domain, what: 'Report authorisation', reason: plainCloudflareError(e), link: setupLink(d.id) });
          continue;
        }
      }
      const id = `auth:${d.id}`;
      dmarcWrites.push({
        id, domain: d.domain, zone: reportsCf.zoneName, type: 'TXT', name: authName, content: 'v=DMARC1;', action: present ? 'none' : 'create', before: null,
        reason: present ? 'Already lets this domain send reports to Ready Set Mail.' : `Lets ${d.domain} send its reports to ${reportsDomain}.`,
      });
      exec.set(id, { cf: reportsCf.cf, zoneId: reportsCf.zoneId, domainId: d.id, kind: 'auth' });
    } else if (reportsDomain && reportsError) {
      notWritten.push({ domain: d.domain, what: 'Report authorisation', reason: reportsError, link: setupLink(d.id) });
    }
  }

  const steps: PlanStep[] = [{ key: 'dmarc', writes: dmarcWrites, satisfied: dmarcWrites.every(w => w.action === 'none') }];

  if (reportsDomain) {
    const writes: PlanWrite[] = [];
    if (!reportsCf) {
      notWritten.push({ what: 'Reports mailbox', reason: reportsError ?? 'No Cloudflare connection manages the reports domain.' });
    } else {
      const { cf, zoneId, zoneName } = reportsCf;
      try {
        const mx = await cf.listDnsRecords(zoneId, { type: 'MX', name: reportsDomain, per_page: 50 });
        const hasCfMx = mx.some(r => isCfMx(r.content));
        const mailbox: PlanWrite[] = [];
        if (!hasCfMx) {
          for (const old of mx) {
            const id = `mx-del:${old.id}`;
            mailbox.push({ id, domain: reportsDomain, zone: zoneName, type: 'MX', name: reportsDomain, content: old.content, priority: old.priority, action: 'delete', before: `${old.priority ?? ''} ${old.content}`.trim(), reason: 'Mail for this name must go to Cloudflare Email Routing only.' });
            exec.set(id, { cf, zoneId, recordId: old.id, kind: 'mx_delete' });
          }
        }
        for (const want of CF_MX) {
          const present = mx.some(r => r.content.toLowerCase().replace(/\.$/, '') === want.content);
          const id = `mx:${want.content}`;
          mailbox.push({ id, domain: reportsDomain, zone: zoneName, type: 'MX', name: reportsDomain, content: want.content, priority: want.priority, action: present ? 'none' : 'create', before: null, reason: present ? 'Already in place.' : 'Receives the DMARC reports sent to this domain.' });
          exec.set(id, { cf, zoneId, kind: 'mx' });
        }
        // Email Routing is never turned on from here: Cloudflare's zone-level enable adds and locks MX and SPF records at the
        // zone apex, which can break the zone's existing mail. Off is reported, and left to the owner.
        let routingOn: boolean | null = null;
        try { routingOn = !!(await cf.request<{ enabled?: boolean }>('GET', `/zones/${zoneId}/email/routing`))?.enabled; } catch { /* unreadable: say nothing about it */ }
        if (routingOn === false) {
          notWritten.push({ what: 'Email Routing', reason: `Email Routing is off for ${zoneName}. Turning it on changes the mail records of ${zoneName} itself, so Ready Set Mail leaves that to you: in Cloudflare, open ${zoneName} → Email → Email Routing and follow its steps. Then run this step again.` });
        }
        // Cloudflare's catch-all rule belongs to the zone, not to the reports subdomain: one rule for every address of the zone.
        let rule: { enabled?: boolean; actions?: { type: string; value?: string[] }[] } | null = null;
        try { rule = await cf.request('GET', `/zones/${zoneId}/email/routing/rules/catch_all`); } catch { /* no catch-all rule yet */ }
        const action = rule?.enabled ? rule.actions?.[0] : undefined;
        const ours = !!action && action.type === 'worker' && (action.value ?? []).includes(tenant.workerName);
        const theirs = !!action && !ours;
        if (theirs) {
          const now = action!.type === 'forward' ? `forwards to ${(action!.value ?? []).join(', ') || 'a mailbox'}` : action!.type === 'worker' ? `sends mail to the Worker ${(action!.value ?? []).join(', ')}` : action!.type === 'drop' ? 'drops the mail' : `does "${action!.type}"`;
          notWritten.push({ what: 'Catch-all rule', reason: `${zoneName} already has a catch-all rule that ${now}. Ready Set Mail does not replace it. To receive reports here, change it to send mail to the Worker ${tenant.workerName}, or add an address rule yourself.` });
        } else {
          mailbox.push({
            id: 'catch_all', domain: reportsDomain, zone: zoneName, type: 'EMAIL_ROUTING', name: reportsDomain,
            content: `Catch-all rule for ${zoneName}: mail to any address at ${zoneName} without its own rule goes to this Worker`,
            action: ours ? 'none' : 'rule', before: null, reason: ours ? 'Already in place.' : 'Delivers report emails to Ready Set Mail.',
          });
          exec.set('catch_all', { cf, zoneId, kind: 'catch_all' });
        }
        writes.push(...mailbox);
      } catch (e) {
        notWritten.push({ what: 'Reports mailbox', reason: plainCloudflareError(e) });
      }
    }
    const satisfied = writes.every(w => w.action === 'none');
    if (writes.length && (selectedBase || !satisfied)) steps.push({ key: 'reports_mailbox', writes, satisfied });
  }

  if (rows.length) notWritten.push({ what: 'SPF and DKIM', reason: 'They depend on which services send your mail, so they are never written here. Set them up per domain.', link: setupLink(rows[0].id) });

  const planId = await sha256Hex(JSON.stringify(steps.flatMap(s => s.writes)));
  return { plan: { plan_id: planId, steps, not_written: notWritten }, exec };
}

export { CfNotConfiguredError };
