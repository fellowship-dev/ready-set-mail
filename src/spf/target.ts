// Where a flattened SPF record lives, as far as the refresh is concerned: read it, change it.
// Two places exist: the TXT record at the apex of the customer's own zone (every mode), and `<id>._spf.h.<zone>` in the operator's hosted zone
// (hosted records, src/hosted/). The engine (src/spf/refresh.ts) is the same for both.

import type { TenantContext } from '../tenancy/context';
import { CfApiError, CfAuthError, CfConnectionError, CfError, CfNetworkError, CfNotConfiguredError, CfNotFoundError, CfZoneNotAllowedError, CfZoneNotFoundError, cfErrorText, type CfDnsRecord } from '../tenancy/cf-client';
import { decodeTxtData, encodeTxtData, isSpfRecord } from '@ready-set-mail/dns-checks';
import type { HostedRecordWriter } from '../hosted/records';

export type SpfLive = { found: true; id: string; content: string } | { found: false } | { multiple: true };

export interface SpfTarget {
  read(): Promise<SpfLive>;
  /** Replace the record's content. Throws what Cloudflare throws. */
  write(id: string, content: string): Promise<void>;
}

/** Cloudflare returns TXT content as quoted character strings, several for a record over 255 bytes: decodeTxtData reads them, encodeTxtData writes them (packages/dns-checks/src/txt.ts). */
const isSpf = (r: CfDnsRecord) => isSpfRecord(decodeTxtData(r.content));

/** Is this a failure of the connection (as opposed to a bug)? Those become the `connection_lost` problem; anything else is rethrown. */
export function isConnectionFailure(e: unknown): boolean {
  return e instanceof CfError || e instanceof CfNotConfiguredError || e instanceof CfConnectionError || e instanceof CfZoneNotFoundError || e instanceof CfZoneNotAllowedError
    || e instanceof CfAuthError || e instanceof CfNetworkError || e instanceof CfNotFoundError || e instanceof CfApiError;
}
export const connectionText = (e: unknown): string => (e instanceof CfError ? cfErrorText(e) : e instanceof Error ? e.message : 'unknown error');

/** The SPF record at the apex of `domain`, in the domain's own zone (older installs may hold it in the base zone: still found and patched there). */
export function cloudflareTarget(tenant: TenantContext, domain: string): SpfTarget {
  return {
    async read() {
      const cf = await tenant.cfFor(domain);
      const zone = await cf.zoneFor(domain);
      let found = (await cf.listDnsRecords(zone.id, { type: 'TXT', name: domain, per_page: 100 })).filter(isSpf);
      if (found.length === 0) {
        const legacy = tenant.legacyZoneId(zone.id);
        if (legacy) {
          found = (await cf.listDnsRecords(legacy, { type: 'TXT', name: domain, per_page: 100 })).filter(isSpf);
          if (found.length) console.warn(`[spf] ${domain}: SPF record found in the base zone (legacy location)`);
        }
      }
      if (found.length > 1) return { multiple: true };
      return found[0] ? { found: true, id: found[0].id, content: decodeTxtData(found[0].content) } : { found: false };
    },
    async write(id, content) {
      const cf = await tenant.cfFor(domain);
      const zone = await cf.zoneFor(domain);
      try {
        await cf.patchDnsRecord(zone.id, id, { content: encodeTxtData(content) }, { allowedApexes: [domain] });
      } catch (e) {
        // Records written before per-domain zones live in the base zone.
        const legacy = e instanceof CfNotFoundError ? tenant.legacyZoneId(zone.id) : undefined;
        if (!legacy) throw e;
        console.warn(`[spf] ${domain}: record ${id} not in its own zone; patching it in the base zone (legacy location)`);
        await cf.patchDnsRecord(legacy, id, { content: encodeTxtData(content) });
      }
    },
  };
}

/** `<id>._spf.h.<zone>` in the operator's hosted zone. */
export function hostedTarget(writer: HostedRecordWriter, recordId: string, name: string): SpfTarget {
  return {
    async read() {
      const r = await writer.read(recordId, name);
      return { found: true, id: r.id, content: decodeTxtData(r.content) };
    },
    async write(id, content) {
      await writer.setContent(id, name, encodeTxtData(content));
    },
  };
}
