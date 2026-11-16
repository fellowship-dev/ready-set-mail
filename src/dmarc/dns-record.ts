// The DMARC policy record at _dmarc.<domain>, in that domain's own Cloudflare zone: the one way the product finds,
// checks and writes it (POST /api/domains/:id/apply-dmarc and PATCH /api/domains/:id/dmarc).
//
// Never the report authorization record `<domain>._report._dmarc.<reports domain>` (src/dns/provision.ts), whose id is
// stored in domains.dns_record_id: that record lives under the reports domain and must keep its `v=DMARC1;` content.

import { readDmarcTag } from '@ready-set-mail/dns-checks/dmarc-tags';
import { isReportAddress } from '@ready-set-mail/dns-checks/dmarc-next-step';
import type { CfClient, CfDnsRecord } from '../tenancy/cf-client';

export type DmarcPolicy = 'none' | 'quarantine' | 'reject';

const POLICIES: ReadonlySet<string> = new Set(['none', 'quarantine', 'reject']);
/** Longer than any sensible record (several rua= addresses), short enough that a pasted blob is refused. */
export const MAX_DMARC_RECORD_LENGTH = 1024;

const MAILTO = /^mailto:[^\s@,;!]+@[^\s@,;!]+\.[^\s@,;!]+(?:![0-9]+[kmgt]?)?$/i;
/** RFC 7489 §6.3 / RFC 9989 value syntax of the tags the product knows; any other tag only needs a plain name. */
const TAG_VALUE: Readonly<Record<string, RegExp>> = {
  p: /^(none|quarantine|reject)$/i,
  sp: /^(none|quarantine|reject)$/i,
  np: /^(none|quarantine|reject)$/i,
  adkim: /^[rs]$/i,
  aspf: /^[rs]$/i,
  pct: /^(100|[1-9]?[0-9])$/,
  t: /^[yn]$/i,
  psd: /^[ynu]$/i,
  fo: /^[01ds](\s*:\s*[01ds])*$/i,
  rf: /^[a-z0-9-]+(\s*:\s*[a-z0-9-]+)*$/i,
  ri: /^[0-9]{1,10}$/,
};

/** One TXT character-string holds at most 255 characters; Cloudflare shows a longer record as several quoted strings. */
const TXT_STRING_MAX = 255;
const QUOTED_STRINGS = /^"(?:[^"\\]|\\.)*"(?:\s+"(?:[^"\\]|\\.)*")*$/;

/**
 * The record text of TXT content as Cloudflare returns it: one string with or without its quotes, or several quoted
 * strings, which RFC 7489 §6.4 (via RFC 7208 §3.3) concatenates without spaces.
 */
export function bareTxt(content: string): string {
  const c = content.trim();
  if (QUOTED_STRINGS.test(c)) return [...c.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, '$1')).join('');
  return c.replace(/^"|"$/g, '');
}

/** TXT content for a record: as is up to 255 characters, else quoted 255-character strings (no quotes or backslashes inside: see dmarcRecordProblem). */
export function txtContent(record: string): string {
  if (record.length <= TXT_STRING_MAX) return record;
  const parts: string[] = [];
  for (let i = 0; i < record.length; i += TXT_STRING_MAX) parts.push(`"${record.slice(i, i + TXT_STRING_MAX)}"`);
  return parts.join(' ');
}

/** Is this TXT content a DMARC record (its first tag is v=DMARC1)? */
export function isDmarcTxt(content: string): boolean {
  return /^v\s*=\s*DMARC1\s*(;|$)/i.test(bareTxt(content));
}

/**
 * Why `record` is not one well-formed DMARC record we are willing to publish, or null when it is. Checks: one line of
 * printable text without quotes or backslashes (nothing that could end or split the TXT string), at most
 * MAX_DMARC_RECORD_LENGTH characters, first tag exactly v=DMARC1, a valid p=, every tag a plain name with a value,
 * no tag twice, the known tags' value syntax, and rua=/ruf= as non-empty lists of mailto: addresses.
 */
export function dmarcRecordProblem(record: string): string | null {
  if (typeof record !== 'string' || !record.trim()) return 'the record is empty';
  if (record.length > MAX_DMARC_RECORD_LENGTH) return `the record is longer than ${MAX_DMARC_RECORD_LENGTH} characters`;
  if (/[^\x20-\x7e]/.test(record)) return 'the record contains a character that is not printable ASCII';
  if (/["\\]/.test(record)) return 'the record contains a quote or a backslash';
  const parts = record.trim().split(';').map((p) => p.trim());
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop(); // one trailing ";" is fine
  const seen = new Set<string>();
  for (const [i, part] of parts.entries()) {
    const tag = readDmarcTag(part);
    if (!tag || !/^[a-z][a-z0-9_-]*$/.test(tag.key) || tag.value === '') return `"${part}" is not a tag=value pair`;
    if (i === 0 && (tag.key !== 'v' || tag.value !== 'DMARC1')) return 'the record must start with v=DMARC1';
    if (i > 0 && tag.key === 'v') return 'v= may only appear first';
    if (seen.has(tag.key)) return `${tag.key}= appears more than once`;
    seen.add(tag.key);
    const syntax = TAG_VALUE[tag.key];
    if (syntax && !syntax.test(tag.value)) return `${tag.key}=${tag.value} is not a valid value`;
    if ((tag.key === 'rua' || tag.key === 'ruf') && !tag.value.split(',').every((u) => MAILTO.test(u.trim()))) {
      return `${tag.key}= must be a list of mailto: addresses`;
    }
  }
  if (!seen.has('p')) return 'the record has no p= policy';
  return null;
}

/**
 * The live record with only its policy changed: `p=` rewritten in place (or appended when missing), every other tag
 * kept in its order (pct, sp, adkim, aspf, fo, ruf, ri, third-party rua= addresses, unknown tags). Our report address is
 * added to rua= when it is usable and not already listed; an empty `mailto:` (left by an earlier version of this route)
 * is dropped, and the record never gets one. With no live record: `v=DMARC1; p=<policy>` plus our rua= when usable.
 * The same record the dashboard previews (web/src/lib/dmarc-record.ts buildRecommendedRecord).
 */
export function withPolicy(current: string | null, policy: DmarcPolicy, ourRua: string | null | undefined): string {
  const ours = isReportAddress(ourRua) ? ourRua!.trim() : null;
  if (!current) return ours ? `v=DMARC1; p=${policy}; rua=mailto:${ours}` : `v=DMARC1; p=${policy}`;
  const parts = bareTxt(current).replace(/[;\s]+$/, '').split(';');
  const lead = (s: string) => /^\s*/.exec(s)?.[0] ?? '';
  const pi = parts.findIndex((p) => readDmarcTag(p)?.key === 'p');
  if (pi >= 0) parts[pi] = `${lead(parts[pi])}p=${policy}`;
  else parts.push(` p=${policy}`);
  const ri = parts.findIndex((p) => readDmarcTag(p)?.key === 'rua');
  if (ri >= 0) {
    const entries = readDmarcTag(parts[ri])!.value.split(',').map((e) => e.trim()).filter((e) => e && !/^mailto:\s*$/i.test(e));
    const addr = (e: string) => e.replace(/^mailto:/i, '').replace(/![^,]*$/, '').toLowerCase();
    if (ours && !entries.some((e) => addr(e) === ours.toLowerCase())) entries.push(`mailto:${ours}`);
    if (entries.length) parts[ri] = `${lead(parts[ri])}rua=${entries.join(',')}`;
    else parts.splice(ri, 1);
  } else if (ours) {
    parts.push(` rua=mailto:${ours}`);
  }
  return parts.join(';');
}

export type LiveDmarcRecord =
  | { kind: 'none' }
  | { kind: 'one'; record: CfDnsRecord; content: string }
  | { kind: 'many'; count: number; contents: string[] };

/**
 * The DMARC record(s) published at `name` in `zoneId`: TXT records there that are not DMARC records are ignored. Every page
 * is read (CfIncompleteListError rather than a decision on part of the list), and only records at exactly that name count.
 */
export async function findDmarcRecord(cf: CfClient, zoneId: string, name: string): Promise<LiveDmarcRecord> {
  const exact = name.toLowerCase().replace(/\.$/, '');
  const found = (await cf.listDnsRecords(zoneId, { type: 'TXT', name }))
    .filter((r) => r.name.toLowerCase().replace(/\.$/, '') === exact && isDmarcTxt(r.content));
  if (found.length > 1) return { kind: 'many', count: found.length, contents: found.map((r) => bareTxt(r.content)) };
  return found.length ? { kind: 'one', record: found[0], content: bareTxt(found[0].content) } : { kind: 'none' };
}

/**
 * Write `content` to `_dmarc.<domain>` in its zone: update the existing DMARC record in place, or create one. The write
 * policy is told the one name it may land on (`allowedApexes`), so nothing else in the zone can be changed. A record
 * over 255 characters is written as several quoted strings (txtContent), which bareTxt joins back on the next read.
 */
export function writeDmarcRecord(cf: CfClient, zoneId: string, domain: string, existing: CfDnsRecord | null, record: string): Promise<CfDnsRecord> {
  const name = `_dmarc.${domain}`;
  const guard = { allowedApexes: [domain] };
  const content = txtContent(record);
  return existing
    ? cf.patchDnsRecord(zoneId, existing.id, { type: 'TXT', name, content }, guard)
    : cf.createDnsRecord(zoneId, { type: 'TXT', name, content, ttl: 3600 }, guard);
}
