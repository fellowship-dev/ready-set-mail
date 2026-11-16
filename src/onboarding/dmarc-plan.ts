// What the one-click DMARC step writes for one domain. Pure: no I/O (except `readInherited`, the one read of the policy a name inherits).
//
// The rules mirror the dashboard's (web/src/lib/dmarc-coverage.ts, dmarc-record.ts), ported here so the server can plan
// without importing the web lib:
//  - a record of the domain's own is only ever extended with our rua=, every other tag (p, sp, pct, ...) stays as published;
//  - a new own record carries exactly the enforcement in force (the policy the domain inherits from its organizational
//    domain, pct and alignment included; p=none when nothing applies): never weaker, never stricter;
//  - several records, an invalid p= or a failed lookup mean no write at all.
//
// This is the one builder behind the hosted report address too (`reviewReportRecord` in src/hosted/report-address.ts): both entry points
// (the domain page and the first-run Apply) get their record from here, by the address-count rule in packages/dns-checks/src/dmarc-rua.ts.

import { decodeTxtData } from '@ready-set-mail/dns-checks/txt';
import { RUA_ADDRESS_LIMIT, isDmarcRecord, lookupDmarc, parseDmarcRecord, parseDmarcTags, recordHasAddress, ruaEntries, ruaLimitSentence, withReportAddress, type Resolver } from '@ready-set-mail/dns-checks';

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
  /** Hosted: a record that already lists two addresses never gets ours after them (the two receivers must honour); the person chooses which of the first two to replace. */
  ruaLimit?: boolean;
}

export type DmarcDecision =
  | { action: 'none'; record: string; reason: string }
  /** `ruaLimit` only: the record lists two or more addresses; `options` is the record for each of the first two it could replace. Nothing is written until one is chosen. */
  | { action: 'choose'; record: string; existing: string[]; options: { replaces: string; record: string }[]; reason: string }
  | { action: 'update'; before: string; record: string; reason: string }
  | { action: 'create'; record: string; reason: string }
  | { action: 'skip'; reason: string };

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

/** What a plan writes when no address-count choice is involved (`ruaLimit` off): the self-host plan and the hosted plan's mapping of a choice. */
export type WriteDecision = Exclude<DmarcDecision, { action: 'choose' }>;

export function planDmarc(input: DmarcPlanInput & { ruaLimit: true }): DmarcDecision;
export function planDmarc(input: DmarcPlanInput & { ruaLimit?: false }): WriteDecision;
export function planDmarc(input: DmarcPlanInput): DmarcDecision {
  const rua = input.rua?.trim() || null;
  const own = input.ownRecords.map(decodeTxtData).filter(isDmarcRecord);
  if (own.length > 1) return { action: 'skip', reason: 'There is more than one DMARC record. Receivers ignore all of them until only one is left.' };
  if (own.length === 1) {
    const record = own[0].trim();
    if (!parseDmarcRecord(record).valid) return { action: 'skip', reason: 'The DMARC record has no valid p= policy. Fix it first.' };
    if (!rua || recordHasAddress(record, rua)) return { action: 'none', record, reason: rua ? 'Already sends reports to Ready Set Mail.' : 'Already has a DMARC record.' };
    const existing = ruaEntries(record);
    if (input.ruaLimit && existing.length >= RUA_ADDRESS_LIMIT) {
      const kept = existing.slice(0, RUA_ADDRESS_LIMIT);
      return { action: 'choose', record, existing, options: kept.map((e) => ({ replaces: e, record: withReportAddress(record, rua, e) })), reason: ruaLimitSentence(existing.length) };
    }
    return { action: 'update', before: record, record: withReportAddress(record, rua), reason: 'Adds the Ready Set Mail report address. Every other tag stays as it is.' };
  }
  if (input.inherited.kind === 'unknown') return { action: 'skip', reason: `Couldn't read the DMARC policy that applies (${input.inherited.reason}). Nothing is written until it can be read.` };
  const record = equivalentRecord(input.inherited, rua)!;
  const where = input.inherited.kind === 'inherited' ? ` It keeps the policy ${input.inherited.parent} already applies.` : '';
  return { action: 'create', record, reason: `No DMARC record yet.${where}` };
}

/** What the public DNS says applies to a name that has no DMARC record of its own in its zone (src/onboarding/plan.ts, src/hosted/report-address.ts). */
export async function readInherited(resolver: Resolver, domain: string): Promise<InheritedRead> {
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
