// What the one-click DMARC step writes for one domain. Pure: no I/O.
//
// The rules mirror the dashboard's (web/src/lib/dmarc-coverage.ts, dmarc-record.ts), ported here so the server can plan
// without importing the web lib:
//  - a record of the domain's own is only ever extended with our rua=, every other tag (p, sp, pct, ...) stays as published;
//  - a new own record carries exactly the enforcement in force (the policy the domain inherits from its organizational
//    domain, pct and alignment included; p=none when nothing applies): never weaker, never stricter;
//  - several records, an invalid p= or a failed lookup mean no write at all.

import { isDmarcRecord, parseDmarcRecord, parseDmarcTags, recordHasAddress, withReportAddress } from '@ready-set-mail/dns-checks';

/** What the public DNS says applies to a name that has no DMARC record of its own. */
export type InheritedRead =
  | { kind: 'none' }
  | { kind: 'inherited'; parent: string; record: string }
  | { kind: 'unknown'; reason: string };

export interface DmarcPlanInput {
  /** TXT records at `_dmarc.<domain>` in the zone, as Cloudflare holds them. */
  ownRecords: string[];
  /** Read only when `ownRecords` has no DMARC record. */
  inherited: InheritedRead;
  /** Our report address (`rua@<reports domain>`); null when the instance has none (hosted). */
  rua: string | null;
}

export type DmarcDecision =
  | { action: 'none'; record: string; reason: string }
  | { action: 'update'; before: string; record: string; reason: string }
  | { action: 'create'; record: string; reason: string }
  | { action: 'skip'; reason: string };

/** Cloudflare returns TXT content quoted in some responses. */
export const unquote = (s: string): string => s.trim().replace(/^"([\s\S]*)"$/, '$1');

const isPolicy = (v: string | undefined): v is 'none' | 'quarantine' | 'reject' => v === 'none' || v === 'quarantine' || v === 'reject';
const mode = (v: string | undefined): 's' | 'r' | null => (v?.toLowerCase() === 's' ? 's' : v?.toLowerCase() === 'r' ? 'r' : null);

/** The record a name with none of its own must publish to change nothing about how failing mail is handled. */
export function equivalentRecord(inherited: InheritedRead, rua: string | null): string | null {
  if (inherited.kind === 'unknown') return null;
  let policy = 'none';
  let pct = 100;
  let adkim: 's' | 'r' | null = null;
  let aspf: 's' | 'r' | null = null;
  if (inherited.kind === 'inherited') {
    const tags = parseDmarcTags(inherited.record);
    const p = tags.p?.toLowerCase();
    const sp = tags.sp?.toLowerCase();
    // A subdomain follows the parent's sp= when it is a policy, else its p=.
    const effective = isPolicy(sp) ? sp : p;
    adkim = mode(tags.adkim);
    aspf = mode(tags.aspf);
    if (effective === 'quarantine' || effective === 'reject') {
      policy = effective;
      pct = /^\d{1,3}$/.test(tags.pct ?? '') ? Math.min(100, Number(tags.pct)) : 100;
    }
  }
  const parts = ['v=DMARC1', `p=${policy}`];
  if (pct < 100) parts.push(`pct=${pct}`);
  if (adkim) parts.push(`adkim=${adkim}`);
  if (aspf) parts.push(`aspf=${aspf}`);
  if (rua?.trim()) parts.push(`rua=mailto:${rua.trim()}`);
  return parts.join('; ');
}

export function planDmarc(input: DmarcPlanInput): DmarcDecision {
  const rua = input.rua?.trim() || null;
  const own = input.ownRecords.map(unquote).filter(isDmarcRecord);
  if (own.length > 1) return { action: 'skip', reason: 'There is more than one DMARC record. Receivers ignore all of them until only one is left.' };
  if (own.length === 1) {
    const record = own[0].trim();
    if (!parseDmarcRecord(record).valid) return { action: 'skip', reason: 'The DMARC record has no valid p= policy. Fix it first.' };
    if (!rua || recordHasAddress(record, rua)) return { action: 'none', record, reason: rua ? 'Already sends reports to Ready Set Mail.' : 'Already has a DMARC record.' };
    return { action: 'update', before: record, record: withReportAddress(record, rua), reason: 'Adds the Ready Set Mail report address. Every other tag stays as it is.' };
  }
  if (input.inherited.kind === 'unknown') return { action: 'skip', reason: `Couldn't read the DMARC policy that applies (${input.inherited.reason}). Nothing is written until it can be read.` };
  const record = equivalentRecord(input.inherited, rua)!;
  const where = input.inherited.kind === 'inherited' ? ` It keeps the policy ${input.inherited.parent} already applies.` : '';
  return { action: 'create', record, reason: `No DMARC record yet.${where}` };
}
