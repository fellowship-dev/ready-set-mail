// Bulk domain import — admin-only fast path.
// Accepts a list of domains, inserts valid/new ones, provisions DNS for each.
// Returns per-domain status without throwing on partial failure.

import type { TenantContext } from '../tenancy/context';
import { provisionDomain } from '../dns/provision';
import { logAudit } from '../audit/log';
import { PlanLimitError } from '@ready-set-mail/db';
import { planLimitBody } from '../hosted/plan-limits';
import { normalizeDomainName } from '@ready-set-mail/dns-checks';
import { domainCap, domainRefusal } from './service';
import { admitDomain, claimView, settleClaims, type ClaimView } from './ownership';
import { createResolver, type Resolver } from '@ready-set-mail/dns-checks';
import { recordFirstDnsCheck } from './first-check';

const BATCH_LIMIT = 50;

// The first DNS read of each imported domain (the one the single add stores), so the overview shows its level at once.
// Cost per domain: the SPF walk (1 + up to 10 terms) and 1-2 DMARC TXT reads, 2-3 DoH queries for a plain domain and about 14
// at worst. The budget bounds one import (50 domains at most) to 500 DoH queries, well inside a paid Worker's subrequest
// limit; a check is started only while a worst-case one still fits, and any domain whose read was not started, failed or was
// cut off is reported as not checked yet (`dns_checked: false`), never as checked.
export const BULK_DNS_LOOKUP_BUDGET = 500;
const DNS_LOOKUPS_PER_DOMAIN = 14;
const FIRST_CHECK_CONCURRENCY = 5;

export const REPORTS_DOMAIN_MISSING = 'Reports domain not configured — complete the setup wizard first';

export type BulkImportStatus = 'imported' | 'duplicate' | 'invalid' | 'error' | 'pending';

export interface BulkImportResult {
  domain: string;
  status: BulkImportStatus;
  error?: string;
  /** 'plan_limit': the workspace is at its hosted domain cap; this row and every row after it were not attempted. */
  code?: 'plan_limit';
  /** With code 'plan_limit': where to ask for more (https only), or null. */
  help_url?: string | null;
  dns_record_id?: string | null;
  manual_dns?: boolean;
  /** status 'pending' (SaaS): the TXT record that proves ownership. Nothing else is done for the domain until it is verified. */
  claim?: ClaimView;
  /** status 'imported': its first DNS read was stored (true), or it was not checked yet (false). */
  dns_checked?: boolean;
}

function atCapRow(tenant: TenantContext, domain: string, max: number): BulkImportResult {
  const { error, help_url } = planLimitBody(tenant.env, 'domains_per_workspace', max);
  return { domain, status: 'error', error, code: 'plan_limit', help_url };
}

export function validateDomain(domain: string): boolean {
  return normalizeDomainName(domain).ok;
}

/** Parse a newline- or comma-separated domain list into unique, lowercase entries. */
export function parseDomainList(input: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of input.split(/[\n,]+/)) {
    const d = raw.trim().toLowerCase();
    if (d && !seen.has(d)) {
      seen.add(d);
      result.push(d);
    }
  }
  return result;
}

interface AuditOpts {
  actorId?: string | null;
  actorEmail?: string | null;
  ctx?: ExecutionContext;
}

/**
 * Insert each domain in the list, provision DNS, and return per-row status.
 * Caps at BATCH_LIMIT entries; excess entries are omitted from results.
 * Throws when no reports domain is configured: aggregate reports must go to a domain this instance runs.
 */
export async function bulkInsertDomains(
  tenant: TenantContext,
  domains: string[],
  audit: AuditOpts = {},
  dns: { resolver?: Resolver; lookupBudget?: number } = {},
): Promise<BulkImportResult[]> {
  // Hosted: never a reports address, so no reports domain is needed and the domain gets no rua.
  const hosted = tenant.mode === 'saas';
  const rdomain = hosted ? undefined : tenant.settings.reportsDomain;
  if (!hosted && !rdomain) throw new Error(REPORTS_DOMAIN_MISSING);
  const ruaAddress = rdomain ? `rua@${rdomain}` : '';
  const batch = domains.slice(0, BATCH_LIMIT);
  const results: BulkImportResult[] = [];
  const cap = domainCap(tenant);
  let atCap = false;
  // One count up front, then a local tally. It is advisory: the capped INSERT below is what enforces the cap, so a stale tally
  // can only send a row to that insert, never past the cap.
  let held = cap === undefined ? 0 : (await tenant.scope.domains.list()).length;
  const toCheck: { id: number; domain: string; row: BulkImportResult }[] = [];

  for (const typed of batch) {
    const named = normalizeDomainName(typed);
    if (!named.ok) {
      results.push({ domain: typed, status: 'invalid', error: domainRefusal(named).error });
      continue;
    }
    const domain = named.domain;

    // Dedup check
    const existing = await tenant.scope.domains.getByName(domain);
    if (existing) {
      results.push({ domain, status: 'duplicate' });
      continue;
    }

    // Advisory (see service.ts): a domain that can never be added gets no claim. The INSERT below is what enforces the cap.
    if (cap !== undefined && (atCap || held >= cap)) { atCap = true; results.push(atCapRow(tenant, domain, cap)); continue; }

    const admission = await admitDomain(tenant, domain);
    if (admission.kind === 'taken') { results.push({ domain, status: 'duplicate', error: 'already registered in another workspace' }); continue; }
    if (admission.kind === 'limit') { results.push({ domain, status: 'error', error: 'too many unverified domains — verify or remove some first' }); continue; }
    if (admission.kind === 'pending') { results.push({ domain, status: 'pending', claim: claimView(admission.claim) }); continue; }

    let domainId: number;
    try {
      const result = await tenant.scope.domains.insert({ domain, rua_address: ruaAddress, verified_via: admission.via }, undefined, { maxDomains: cap });
      domainId = result.meta.last_row_id as number;
      held++;
    } catch (e: unknown) {
      if (e instanceof PlanLimitError) { atCap = true; results.push(atCapRow(tenant, domain, e.max)); continue; }
      const msg = e instanceof Error ? e.message : String(e);
      // Race condition: another request inserted the domain between our check and insert
      if (msg.includes('UNIQUE')) {
        results.push({ domain, status: 'duplicate' });
      } else {
        results.push({ domain, status: 'error', error: msg });
      }
      continue;
    }

    await settleClaims(tenant, domain);
    logAudit(tenant, {
      actor_id: audit.actorId ?? null,
      actor_email: audit.actorEmail ?? null,
      actor_type: 'user',
      action: 'domain.add',
      resource_type: 'domain',
      resource_id: String(domainId),
      resource_name: domain,
      after_value: { domain, rua_address: ruaAddress, source: 'bulk_import' },
    }, audit.ctx);

    // Provision the cross-domain DMARC auth record
    let dnsRecordId: string | null = null;
    let manual = false;
    try {
      const dnsResult = await provisionDomain(
        tenant,
        domain,
        { actor_id: audit.actorId, actor_email: audit.actorEmail, actor_type: 'user', ctx: audit.ctx },
      );
      dnsRecordId = dnsResult.recordId;
      manual = dnsResult.manual;

      if (dnsRecordId) {
        await tenant.scope.domains.setDnsRecord(domainId, dnsRecordId, { touch: true });
      }
    } catch (e: unknown) {
      // DNS provisioning failure is non-fatal — domain is inserted, user can provision later
      console.warn(`[bulk-import] DNS provision failed for ${domain}:`, e);
      manual = true;
    }

    const row: BulkImportResult = { domain, status: 'imported', dns_record_id: dnsRecordId, manual_dns: manual, dns_checked: false };
    results.push(row);
    toCheck.push({ id: domainId, domain, row });
  }

  await firstDnsChecks(tenant, toCheck, dns);
  return results;
}

/** Store the first DNS read of each imported domain, a few at a time and within the import's lookup budget (see above). */
async function firstDnsChecks(
  tenant: TenantContext,
  items: { id: number; domain: string; row: BulkImportResult }[],
  opts: { resolver?: Resolver; lookupBudget?: number },
): Promise<void> {
  if (!items.length) return;
  const base = opts.resolver ?? createResolver();
  const budget = opts.lookupBudget ?? BULK_DNS_LOOKUP_BUDGET;
  let used = 0;
  let inFlight = 0;
  const spend = () => { if (++used > budget) throw new Error('the import\'s DNS lookup budget is spent'); };
  const resolver: Resolver = {
    fetch: base.fetch,
    resolve: (name, type) => { spend(); return base.resolve(name, type); },
    txt: (name) => { spend(); return base.txt(name); },
  };
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      if (used + (inFlight + 1) * DNS_LOOKUPS_PER_DOMAIN > budget) continue; // stays dns_checked: false
      inFlight++;
      try {
        item.row.dns_checked = (await recordFirstDnsCheck(tenant, item.id, item.domain, { resolver })) !== null;
      } finally {
        inFlight--;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(FIRST_CHECK_CONCURRENCY, items.length) }, worker));
}
