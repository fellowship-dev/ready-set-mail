// Pointer verification: has the customer added the records in their own DNS that point at ours?
//
//   _dmarc.customer.com      CNAME  <id>._dmarc.h.<zone>
//   customer.com             TXT    v=spf1 … include:<id>._spf.h.<zone> …
//   _smtp._tls.customer.com  CNAME  <id>._tlsrpt.h.<zone>
//
// Checked over DNS-over-HTTPS with @ready-set-mail/dns-checks, whose four-way answer (ok / nodata / nxdomain /
// error) keeps "the DNS says no" apart from "we couldn't find out". Statuses:
//   ok       the pointer is in place
//   missing  nothing there
//   wrong    something else is there (another target, or an SPF record without our include)
//   error    the lookup failed; the previous answer should be kept by callers that can

import { createResolver, isSpfRecord, normalizeName, parseSpfRecord, type Resolver } from '@ready-set-mail/dns-checks';
import type { PointerStatus } from '@ready-set-mail/db';
import { hostedNames } from './records';

export interface PointerReport {
  dmarc: PointerStatus;
  spf: PointerStatus;
  tls_rpt: PointerStatus;
}

async function checkCname(resolver: Resolver, name: string, target: string): Promise<PointerStatus> {
  const res = await resolver.resolve(name, 'CNAME');
  if (res.status === 'error') return 'error';
  if (res.status === 'ok') return res.answers.some(a => normalizeName(a.data) === target) ? 'ok' : 'wrong';
  if (res.status === 'nxdomain') return 'missing';
  // NODATA: the name exists with other records. A TXT there instead of our CNAME is "wrong", not "missing".
  const txt = await resolver.txt(name);
  if (txt.status === 'error') return 'error';
  return txt.records.length > 0 ? 'wrong' : 'missing';
}

async function checkSpfInclude(resolver: Resolver, domain: string, include: string): Promise<PointerStatus> {
  const txt = await resolver.txt(domain);
  if (txt.status === 'error') return 'error';
  const spf = txt.records.filter(isSpfRecord);
  if (spf.length === 0) return 'missing';
  const has = (raw: string) => parseSpfTerms(raw).includes(include);
  return spf.some(has) ? 'ok' : 'wrong';
}

function parseSpfTerms(raw: string): string[] {
  return parseSpfRecord(raw).terms
    .filter(t => t.kind === 'mechanism' && t.name === 'include' && t.value)
    .map(t => normalizeName(t.value!));
}

export async function verifyPointers(
  domain: string,
  hostedId: string,
  apex: string,
  resolver: Resolver = createResolver(),
): Promise<PointerReport> {
  const names = hostedNames(hostedId, apex);
  const d = normalizeName(domain);
  const [dmarc, spf, tls_rpt] = await Promise.all([
    checkCname(resolver, `_dmarc.${d}`, names.dmarc),
    checkSpfInclude(resolver, d, names.spf),
    checkCname(resolver, `_smtp._tls.${d}`, names.tlsRpt),
  ]);
  return { dmarc, spf, tls_rpt };
}

/**
 * What the pointer status means for the domain's Level (Delivering → Authenticated → Protected):
 * a hosted record only counts as published once the customer's pointer to it is in place.
 */
export function levelInputs(p: { dmarc: PointerStatus | null; spf: PointerStatus | null }) {
  return {
    dmarc_published: p.dmarc === 'ok',
    spf_published: p.spf === 'ok',
  };
}

/** The records the customer has to add, for the dashboard and the docs. */
export function customerPointers(domain: string, hostedId: string, apex: string) {
  const names = hostedNames(hostedId, apex);
  const d = normalizeName(domain);
  return [
    { purpose: 'dmarc', type: 'CNAME', name: `_dmarc.${d}`, value: names.dmarc },
    { purpose: 'spf', type: 'TXT', name: d, value: `include:${names.spf}`, note: 'add this include to your existing v=spf1 record; do not publish a second SPF record' },
    { purpose: 'tls_rpt', type: 'CNAME', name: `_smtp._tls.${d}`, value: names.tlsRpt },
  ];
}

type HostedRow = { dmarc_pointer: string | null; spf_pointer: string | null; tls_rpt_pointer: string | null };
type Stored = { dmarc_pointer: PointerStatus; spf_pointer: PointerStatus; tls_rpt_pointer: PointerStatus };

/** What to store after a check: the new answers, except that a failed lookup keeps the previous status. */
export function mergePointerReport(prev: HostedRow, r: PointerReport): Stored {
  const keep = (next: PointerStatus, before: string | null): PointerStatus => (next === 'error' && before ? before as PointerStatus : next);
  return {
    dmarc_pointer: keep(r.dmarc, prev.dmarc_pointer),
    spf_pointer: keep(r.spf, prev.spf_pointer),
    tls_rpt_pointer: keep(r.tls_rpt, prev.tls_rpt_pointer),
  };
}
