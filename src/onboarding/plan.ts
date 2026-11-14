// The DNS plan of the one-click onboarding: what each step would write, computed from Cloudflare's current records.
// Nothing here writes. apply.ts performs a step's writes from the same plan.

import { lookupDmarc, organizationalDomain, type Resolver } from '@ready-set-mail/dns-checks';
import type { TenantContext } from '../tenancy/context';
import { CfNotConfiguredError, type CfClient } from '../tenancy/cf-client';
import { resolverFor } from '../dns/resolver';
import { assertDnsWriteAllowed } from '../dns/write-policy';
import { planDmarc, unquote, type InheritedRead } from './dmarc-plan';
import { plainCloudflareError } from './errors';
import { writableDomains } from './domains';

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
export interface NotWritten { domain?: string; what: string; reason: string; link?: string; /** The plan step this note belongs to; null = shown only on the final screen. */ step: 'dmarc' | 'reports_mailbox' | null }
export interface DnsPlan { plan_id: string; steps: PlanStep[]; not_written: NotWritten[] }

/** What apply needs beyond the public write: the zone and record to touch. */
export interface Exec { cf: CfClient; zoneId: string; recordId?: string; domainId?: number; kind: 'dmarc' | 'auth' | 'mx' | 'rule'; /** rule: the full address it matches. */ address?: string }

/** An Email Routing rule as Cloudflare lists it. */
export interface EmailRule { id?: string; enabled?: boolean; matchers?: { type: string; field?: string; value?: string }[]; actions?: { type: string; value?: string[] }[] }

/** The addresses the product receives at the reports domain that a literal rule can match (src/email/handler.ts). */
export const REPORT_ADDRESSES = ['rua', 'tls-rpt'] as const;


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

/** Same organisational domain (public-suffix aware): `brightwave-mail.com` and `reports.brightwave-mail.com`. */
export function sameOrganisation(a: string, b: string): boolean {
  const x = organizationalDomain(a);
  return !!x && x === organizationalDomain(b);
}

const setupLink = (domainId: number) => `/domains/${domainId}/setup`;

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

  const rows = await writableDomains(tenant, domainIds);
  // Nothing verified in this workspace to act on (pending claims, other workspaces' ids, unknown ids): no writes of any kind.
  if (rows.length === 0) return { plan: { plan_id: await sha256Hex('[]'), steps: [{ key: 'dmarc', writes: [], satisfied: true }], not_written: [] }, exec };
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
      notWritten.push({ domain: d.domain, what: 'DMARC', step: 'dmarc', reason: plainCloudflareError(e), link: setupLink(d.id) });
      continue;
    }
    const dmarcName = `_dmarc.${d.domain}`;
    let own: string[];
    try {
      own = (await cf.listDnsRecords(zone.id, { type: 'TXT', name: dmarcName, per_page: 50 })).map(r => r.content);
    } catch (e) {
      notWritten.push({ domain: d.domain, what: 'DMARC', step: 'dmarc', reason: plainCloudflareError(e), link: setupLink(d.id) });
      continue;
    }
    const hasOwn = own.some(c => /^\s*v\s*=\s*DMARC1/i.test(unquote(c)));
    const inherited: InheritedRead = hasOwn ? { kind: 'none' } : await inheritedFor(resolver, d.domain);
    const decision = planDmarc({ ownRecords: own, inherited, rua });
    if (decision.action === 'skip') {
      notWritten.push({ domain: d.domain, what: 'DMARC', step: 'dmarc', reason: decision.reason, link: setupLink(d.id) });
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

    // Report authorisation: <d>._report._dmarc.<reports domain> (self-host). Not needed when both names share an organisational
    // domain (RFC 7489 §7.1: external-destination verification only applies to a different organisation).
    if (reportsDomain && reportsCf && !sameOrganisation(d.domain, reportsDomain)) {
      const authName = `${d.domain}._report._dmarc.${reportsDomain}`;
      let present = !!d.dns_record_id;
      if (!present) {
        try {
          present = (await reportsCf.cf.listDnsRecords(reportsCf.zoneId, { type: 'TXT', name: authName, per_page: 5 })).length > 0;
        } catch (e) {
          notWritten.push({ domain: d.domain, what: 'Report authorisation', step: 'dmarc', reason: plainCloudflareError(e), link: setupLink(d.id) });
          continue;
        }
      }
      const id = `auth:${d.id}`;
      dmarcWrites.push({
        id, domain: d.domain, zone: reportsCf.zoneName, type: 'TXT', name: authName, content: 'v=DMARC1;', action: present ? 'none' : 'create', before: null,
        reason: present ? 'Already lets this domain send reports to Ready Set Mail.' : `Lets ${d.domain} send its reports to ${reportsDomain}.`,
      });
      exec.set(id, { cf: reportsCf.cf, zoneId: reportsCf.zoneId, domainId: d.id, kind: 'auth' });
    } else if (reportsDomain && reportsError && !sameOrganisation(d.domain, reportsDomain)) {
      notWritten.push({ domain: d.domain, what: 'Report authorisation', step: 'dmarc', reason: reportsError, link: setupLink(d.id) });
    }
  }

  const steps: PlanStep[] = [{ key: 'dmarc', writes: dmarcWrites, satisfied: dmarcWrites.every(w => w.action === 'none') }];

  if (reportsDomain) {
    const writes: PlanWrite[] = [];
    const note = (what: string, reason: string) => notWritten.push({ what, step: 'reports_mailbox', reason });
    if (!reportsCf) {
      note('Reports mailbox', reportsError ?? 'No Cloudflare connection manages the reports domain.');
    } else {
      const { cf, zoneId, zoneName } = reportsCf;
      try {
        const mx = await cf.listDnsRecords(zoneId, { type: 'MX', name: reportsDomain, per_page: 50 });
        const foreign = mx.filter(r => !isCfMx(r.content));
        // Mail records are never deleted or replaced from here: a name that already receives mail elsewhere, or the zone apex
        // (the mail of the whole domain), is left alone and no mailbox is planned for it.
        if (reportsDomain === zoneName) {
          note('Reports mailbox', `${reportsDomain} is the apex of its zone, so mail records here would change the mail of the whole domain. Ready Set Mail leaves its mail records alone; use a reports subdomain such as reports.${zoneName}.`);
        } else if (foreign.length > 0) {
          note('Reports mailbox', `${reportsDomain} already receives mail elsewhere (${foreign.map(r => r.content).join(', ')}). Ready Set Mail leaves its mail records alone; change them yourself if you want reports delivered here.`);
        } else {
          const mailbox: PlanWrite[] = [];
          // The DNS write policy decides first, with the inputs apply will use: if any create would be refused, no MX is planned.
          let mxAllowed = true;
          let refusedBecause = '';
          for (const want of CF_MX) {
            try { assertDnsWriteAllowed({ method: 'POST', zoneName, type: 'MX', name: reportsDomain, content: want.content, mode: tenant.mode }); }
            catch (e) { mxAllowed = false; refusedBecause = e instanceof Error ? e.message : 'refused'; break; }
          }
          if (!mxAllowed) note('Reports mailbox', `The MX records for ${reportsDomain} are not something this connection may write (${refusedBecause}). Set up Email Routing for it yourself in Cloudflare.`);
          else {
            for (const want of CF_MX) {
              const present = mx.some(r => r.content.toLowerCase().replace(/\.$/, '') === want.content);
              const id = `mx:${want.content}`;
              mailbox.push({ id, domain: reportsDomain, zone: zoneName, type: 'MX', name: reportsDomain, content: want.content, priority: want.priority, action: present ? 'none' : 'create', before: null, reason: present ? 'Already in place.' : 'Receives the DMARC reports sent to this domain.' });
              exec.set(id, { cf, zoneId, kind: 'mx' });
            }
          }
          // Email Routing is never turned on from here: Cloudflare's zone-level enable adds and locks MX and SPF records at the
          // zone apex, which can break the zone's existing mail. Off is reported, and left to the owner.
          let routingOn: boolean | null = null;
          try { routingOn = !!(await cf.request<{ enabled?: boolean }>('GET', `/zones/${zoneId}/email/routing`))?.enabled; } catch { /* unreadable: say nothing about it */ }
          if (routingOn === false) {
            note('Email Routing', `Email Routing is off for ${zoneName}. Turning it on changes the mail records of ${zoneName} itself, so Ready Set Mail leaves that to you: in Cloudflare, open ${zoneName} → Email → Email Routing and follow its steps. Then run this step again.`);
          }
          // One literal address rule per fixed report address. Existing rules (the catch-all included, enabled or not) are never
          // touched; a literal rule for the same address that goes elsewhere is a conflict and nothing is written for it.
          if (mxAllowed) {
            let rules: EmailRule[] = [];
            let rulesRead = true;
            try { rules = (await cf.request<EmailRule[]>('GET', `/zones/${zoneId}/email/routing/rules`)) ?? []; } catch { rulesRead = false; }
            if (!rulesRead) note('Address rules', 'Ready Set Mail could not read the Email Routing rules of this zone, so it plans none. Add rules for rua@ and tls-rpt@ yourself, or run this step again.');
            else {
              for (const local of REPORT_ADDRESSES) {
                const address = `${local}@${reportsDomain}`;
                const existing = rules.find(r => (r.matchers ?? []).some(m => m.type === 'literal' && m.field === 'to' && (m.value ?? '').toLowerCase() === address));
                const act = existing?.actions?.[0];
                const ours = !!existing && existing.enabled !== false && act?.type === 'worker' && (act.value ?? []).includes(tenant.workerName);
                if (existing && !ours) {
                  const now = existing.enabled === false ? 'is switched off' : act?.type === 'forward' ? `forwards to ${(act.value ?? []).join(', ') || 'a mailbox'}` : act?.type === 'worker' ? `sends mail to the Worker ${(act.value ?? []).join(', ')}` : act?.type === 'drop' ? 'drops the mail' : `does "${act?.type ?? 'nothing'}"`;
                  note(`Address rule for ${address}`, `${address} already has a rule that ${now}. Ready Set Mail does not change it. To receive reports here, point it at the Worker ${tenant.workerName} yourself.`);
                  continue;
                }
                const id = `rule:${local}`;
                mailbox.push({ id, domain: reportsDomain, zone: zoneName, type: 'EMAIL_ROUTING', name: address, content: `Address rule: mail to ${address} goes to this Worker`, action: ours ? 'none' : 'rule', before: null, reason: ours ? 'Already in place.' : `Delivers ${local === 'rua' ? 'DMARC' : 'TLS'} reports to Ready Set Mail.` });
                exec.set(id, { cf, zoneId, kind: 'rule', address });
              }
              // check+<token>@ is a different address for every check: only a catch-all can receive it, and a catch-all belongs to the whole zone.
              note(`Free-check replies (check+<token>@${reportsDomain})`, `Every check uses its own address, which an address rule cannot match, and Ready Set Mail does not change the catch-all rule of ${zoneName}. DMARC and TLS reports work without it; for free-check replies, send your catch-all to the Worker ${tenant.workerName} yourself.`);
            }
          }
          writes.push(...mailbox);
        }
      } catch (e) {
        note('Reports mailbox', plainCloudflareError(e));
      }
    }
    const satisfied = writes.every(w => w.action === 'none');
    if (writes.length && (selectedBase || !satisfied)) steps.push({ key: 'reports_mailbox', writes, satisfied });
  }

  if (rows.length) notWritten.push({ what: 'SPF and DKIM', step: null, reason: 'They depend on which services send your mail, so they are never written here. Set them up per domain.', link: setupLink(rows[0].id) });

  const planId = await sha256Hex(JSON.stringify(steps.flatMap(s => s.writes)));
  return { plan: { plan_id: planId, steps, not_written: notWritten }, exec };
}

export { CfNotConfiguredError };
