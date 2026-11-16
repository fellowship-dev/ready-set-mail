// The resource cleanup of taking a domain out of service: its hosted records (and their quota in the shared zone), its MTA-STS records and
// policy host, and its report-authorisation DNS record. Shared by DELETE /api/domains/:id and by the eviction of an unproven holder.
import { disableHosted } from '../hosted/service';
import { retireMtaSts } from '../mta-sts/service';
import { hostedEnabled } from '../hosted/config';
import { deprovisionDomain } from '../dns/provision';
import { logAudit } from '../audit/log';
import { removalAction, keptFromError, type DnsRemoval, type KeptRecord } from '../dns/removal';
import type { TenantContext } from '../tenancy/context';
import type { DomainRow } from '@ready-set-mail/db';

export type Actor = { id?: string | null; email?: string | null };

/** Remove the hosted records of a domain, if it has any. Throws HostedError when the DNS cleanup fails. */
export async function removeHostedRecords(tenant: TenantContext, domain: DomainRow, actor?: Actor, ctx?: ExecutionContext): Promise<boolean> {
  if (!(hostedEnabled(tenant.env) && (await tenant.scope.hosted.get(domain.id)))) return false;
  await disableHosted(tenant, domain, {}, actor && { id: actor.id ?? undefined, email: actor.email ?? undefined }, ctx);
  return true;
}

/**
 * Best-effort removal of what MTA-STS made for a domain: the customer's records by id (a changed one is kept and returned), the operator's custom
 * hostname and Worker route by stored id, and the config. Never throws: the daily job removes operator-side leftovers (src/mta-sts/refresh.ts).
 */
export async function removeMtaSts(tenant: TenantContext, domain: DomainRow, actor?: Actor, ctx?: ExecutionContext): Promise<KeptRecord[]> {
  try {
    return (await retireMtaSts({ tenant, domain, actor: actor ? { id: actor.id, email: actor.email } : undefined, ec: ctx }))?.kept ?? [];
  } catch (e) {
    console.warn(`removeMtaSts failed for domain ${domain.id}:`, e instanceof Error ? e.message : e);
    return [];
  }
}

/**
 * Best-effort removal of the report-authorisation DNS record (never fatal), with the audit entry the outcome deserves:
 * `dns.delete` only for a record that was deleted, `dns.already_gone` when it was not there, `dns.kept` when it was left
 * in place. Returns the records that were kept, so the caller can tell the customer.
 */
export async function removeAuthRecord(tenant: TenantContext, domain: DomainRow, actor?: Actor, ctx?: ExecutionContext): Promise<KeptRecord[]> {
  if (!domain.dns_record_id) return [];
  const rdomain = tenant.settings.reportsDomain;
  const recordName = rdomain ? `${domain.domain}._report._dmarc.${rdomain}` : domain.dns_record_id;
  const removal: DnsRemoval = await deprovisionDomain(tenant, domain.dns_record_id, domain.domain)
    .then(r => r ?? { state: 'deleted' as const }) // a stub that resolves to nothing: no refusal was reported
    .catch((e): DnsRemoval => { console.warn(`deprovisionDomain failed for domain ${domain.id}:`, e); return keptFromError(e); });
  logAudit(tenant, {
    actor_id: actor?.id ?? null, actor_email: actor?.email ?? null, actor_type: actor ? 'user' : 'system',
    action: removalAction(removal),
    resource_type: 'dns_record', resource_id: domain.dns_record_id, resource_name: recordName,
    before_value: { type: 'TXT', name: recordName, content: 'v=DMARC1;', ttl: 3600 },
    ...(removal.state === 'kept' ? { after_value: { kept: true, reason: removal.reason } } : {}),
  }, ctx);
  return removal.state === 'kept' ? [{ type: 'TXT', name: recordName, reason: removal.reason }] : [];
}
