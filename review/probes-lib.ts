import { storeReport } from '../src/dmarc/store-report';
import type { World } from '../test/lifecycle/email/world';
import type { MailMessage } from '../src/mail/mailer';
import { kindOf } from './lib';

export const utc = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) / 1000;
export const iso = (t: number) => new Date(t * 1000).toISOString().replace(':00.000Z', 'Z');
export const setClock = (w: World, t: number) => { w.clock.now = t; };
export const subjects = (ms: MailMessage[]) => ms.map((m) => `${kindOf(m.subject)}: ${m.subject}`);

export interface Rec {
  ip: string; count: number;
  dkim?: Array<[string, string]>; spf?: Array<[string, string]>;
  pe: { dkim: 'pass' | 'fail'; spf: 'pass' | 'fail' };
  from: string; rdns?: string | null; base?: string | null; org?: string | null;
}
export const COUNTED = { tier: 'counted', identity: 'google.com', auth: 'dkim', domain: 'google.com', reason: null, knownAs: 'Google' } as any;

/** Stores one report through the real storeReport (so toTuple keeps only dkim[0] and spf[0], as production does). */
export async function store(w: World, domainId: number, o: { id: string; begin: string; end?: string; org?: string; records: Rec[]; reporter?: any }) {
  const report = {
    xml_schema: 'draft' as const,
    report_metadata: { org_name: o.org ?? 'google.com', org_email: 'noreply-dmarc-support@google.com', org_extra_contact_info: null, report_id: o.id, begin_date: `${o.begin}T00:00:00Z`, end_date: `${o.end ?? o.begin}T23:59:59Z`, errors: [] },
    policy_published: { domain: 'x', adkim: 'r' as const, aspf: 'r' as const, p: 'none' as const, sp: 'none' as const, pct: 100, fo: '0' },
    records: o.records.map((r) => ({
      source: { ip: r.ip, reverse_dns: r.rdns ?? null, base_domain: r.base ?? null, country_code: null, country_name: null, subdivision: null, city: null, org: r.org ?? null },
      count: r.count, alignment: { spf: r.pe.spf === 'pass', dkim: r.pe.dkim === 'pass', dmarc: r.pe.spf === 'pass' || r.pe.dkim === 'pass' },
      policy_evaluated: { disposition: 'none' as const, dkim: r.pe.dkim, spf: r.pe.spf, policy_override_reasons: [] },
      identifiers: { header_from: r.from, envelope_from: null, envelope_to: null },
      auth_results: { dkim: (r.dkim ?? []).map(([result, domain]) => ({ domain, selector: 's1', result: result as any })), spf: (r.spf ?? []).map(([result, domain]) => ({ domain, scope: 'mfrom' as const, result: result as any })) },
    })),
  };
  return storeReport(w.tenant(), domainId, report as any, null, false, o.reporter ?? COUNTED);
}
