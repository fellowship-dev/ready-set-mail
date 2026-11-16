// TLS-RPT report handler — RFC 8460
//
// Sending MTAs deliver JSON reports to tls-rpt@REPORTS_DOMAIN summarising
// TLS connection outcomes for the reporting period. Similar to DMARC RUA
// but JSON format (not XML) and much simpler schema.
//
// WHO SENT IT (RFC 8460 section 3: "Reports sent via SMTP MUST contain a valid DomainKeys Identified Mail (DKIM) [RFC6376] signature by the reporting
// domain. Reports lacking such a signature MUST be ignored by the recipient."): the ONE rule DMARC reports use decides it (src/dmarc/reporter-auth.ts,
// with kind 'tls': registry src/dmarc/known-reporters.ts). A report that is not authenticated and from a known reporter is stored with its tier
// ('unknown' | 'unauthenticated') for the owner to see, and is never evidence for enforce (src/mta-sts/evidence.ts).
//
// Report format:
//   { organization-name, date-range: { start-datetime, end-datetime },
//     policies: [{ policy: { policy-type, policy-string[] },
//                  summary: { total-successful-session-count, total-failure-session-count },
//                  failure-details: [{ result-type, ... }] }] }

import type { TenantContext } from '../tenancy/context';
import { extractAttachmentBytes, readStream } from './mime-extract';
import { coversDomain, type TokenDomain } from '../hosted/scope';
import { extractReport, ReportTooLargeError } from '../dmarc/extract-report';
import { rawXmlRetentionDays } from '../lifecycle/config';
import { EVIDENCE_WINDOW_SECONDS } from '../mta-sts/config';
import { StorageFailure, type ReportResult } from './dmarc-report';
import { REASONS, type Outcome, type ReasonCode } from '../hosted/reasons';
import { carrierFromHeaders, decideTier, guardEnvelope, reporterInfo, type Carrier, type TierDecision } from '../dmarc/reporter-auth';
import { readAuthHeaders, type AuthHeaders } from './sender-proof';

/** The raw report JSON to keep, or null when RAW_XML_RETENTION_DAYS=0 (raw payloads are not stored). */
const rawJson = (tenant: TenantContext, raw: string): string | null => (rawXmlRetentionDays(tenant.env) > 0 ? raw.slice(0, 65536) : null);

// RFC 8460 § 4.3 — subset of fields we care about
interface TlsRptFailureDetail {
  'result-type': string;
  'sending-mta-ip'?: string;
  'receiving-mx-hostname'?: string;
  'failed-session-count'?: number;
  'additional-information'?: string;
}

interface TlsRptPolicy {
  policy: {
    'policy-type': string;
    'policy-string'?: string[];
    'policy-domain': string;
  };
  summary: {
    'total-successful-session-count': number;
    'total-failure-session-count': number;
  };
  'failure-details'?: TlsRptFailureDetail[];
}

interface TlsRptReport {
  'organization-name': string;
  'date-range': {
    'start-datetime': string;
    'end-datetime': string;
  };
  'contact-info'?: string;
  'report-id'?: string;
  policies: TlsRptPolicy[];
}

/**
 * The sessions of the MTA-STS policies of a report (policy-type "sts") and the distinct result-types of their failures. A report also counts DANE
 * (tlsa) sessions and sessions with no policy; only these say whether senders could use TLS under OUR policy (src/mta-sts/evidence.ts).
 */
export function stsStats(policies: readonly TlsRptPolicy[]): { sts_success: number; sts_failure: number; sts_failure_types: string } {
  let success = 0;
  let failure = 0;
  const types = new Set<string>();
  for (const p of policies) {
    if (p.policy?.['policy-type'] !== 'sts') continue;
    success += p.summary?.['total-successful-session-count'] ?? 0;
    failure += p.summary?.['total-failure-session-count'] ?? 0;
    for (const d of p['failure-details'] ?? []) if (typeof d?.['result-type'] === 'string') types.add(d['result-type']);
  }
  return { sts_success: success, sts_failure: failure, sts_failure_types: JSON.stringify([...types].sort()) };
}

/** The longest period a report may cover: RFC 8460 section 4.1 "The report SHOULD cover a full day, from 00:00-24:00 UTC", plus an hour of clock skew. */
export const MAX_PERIOD_SECONDS = 25 * 3600;
/** How far past now a report's end may be (clock skew). */
export const MAX_FUTURE_SECONDS = 3600;
/** Reports are delivered "after some delay, perhaps several hours" (section 4.1) and retried "for up to 24 hours" (section 5.5): one older than the evidence window is not about now. */
export const MAX_AGE_SECONDS = EVIDENCE_WINDOW_SECONDS;

const parseIso = (s: unknown): number | null => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(s)) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
};

/** The period of a report, or why it is refused: unreadable dates (they used to become "now"), an end not after the start, longer than 25 hours, in the future, or too old. */
export function checkPeriod(range: { 'start-datetime'?: unknown; 'end-datetime'?: unknown } | undefined, now: number): { ok: true; start: number; end: number } | { ok: false } {
  const start = parseIso(range?.['start-datetime']);
  const end = parseIso(range?.['end-datetime']);
  if (start === null || end === null || end <= start || end - start > MAX_PERIOD_SECONDS || end > now + MAX_FUTURE_SECONDS || end < now - MAX_AGE_SECONDS) return { ok: false };
  return { ok: true, start, end };
}

export interface TlsRptOptions {
  /**
   * Hosted intake. Reports may be gzip/zip attachments (as RFC 8460 senders usually send them), capped at
   * `maxBytes` once decompressed, and every policy must be for a domain this workspace owns or the whole
   * report is rejected. Unset (self-host): plain JSON bodies, unknown domains skipped.
   */
  hosted?: { maxBytes: number; token: TokenDomain };
  /** The carrier, when the caller has already classified it for kind 'tls' (hosted intake does, to pick caps). Absent: decided here from the message. */
  carrier?: Carrier;
  /** The headers already read (hosted intake). Absent: read here. */
  authHeaders?: AuthHeaders;
  /** The clock, unix seconds (tests). */
  now?: number;
}

/** The report text: the JSON body, or (hosted) a gzip/zip/JSON attachment. */
async function readReport(all: Uint8Array, opts: TlsRptOptions): Promise<string> {
  if (!opts.hosted) return new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(all);
  try {
    return extractReport(await extractAttachmentBytes(new Response(all).body!), { maxBytes: opts.hosted.maxBytes });
  } catch (e) {
    if (e instanceof ReportTooLargeError) throw e;
    // No usable attachment: the report is the message body.
    return new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(all);
  }
}

/** Failure details kept per report: a hostile report can list thousands, and a stored cell may not exceed 2,000,000 bytes. */
const MAX_FAILURE_DETAILS = 100;
const MAX_ORG_NAME = 256;
const MAX_REPORT_ID = 256;

const today = () => new Date().toISOString().slice(0, 10);

/** The first address in `contact-info` (an address, perhaps with a `mailto:` or a name), lowercased; null when it holds none. */
export const contactEmail = (v: unknown): string | null => (typeof v === 'string' ? v.match(/[^\s<>"',;:()]+@[^\s<>"',;()]+/)?.[0]?.toLowerCase() ?? null : null);

export async function handleTlsRptReport(
  message: ForwardableEmailMessage,
  tenant: TenantContext,
  opts: TlsRptOptions = {},
): Promise<ReportResult> {
  const dec: { v: TierDecision | null } = { v: null };
  let carrier: Carrier | null = opts.carrier ?? null;
  const trace = (extra: Partial<ReportResult> = {}): Partial<ReportResult> => ({ tier: dec.v?.tier ?? null, identity: dec.v?.identity ?? null, reporter: dec.v?.identity ?? null, dkimOrg: carrier?.dkimOrg ?? null, fromOrg: carrier?.fromOrg ?? null, emailMatched: dec.v?.emailMatched ?? null, ...extra });
  const result = (outcome: Outcome, reason: ReasonCode, extra: Partial<ReportResult> = {}): ReportResult => ({ failure_count: 0, outcome, reason, records: null, reporter: null, tier: null, ...extra });
  const refuse = (reason: ReasonCode, text: string = REASONS[reason]): ReportResult => { message.setReject(text); return result('refused', reason, trace()); };

  // The message: its headers (who sent it) and the report (what it says), from one read of the raw stream.
  let all: Uint8Array;
  let raw: string;
  try {
    all = await readStream(message.raw);
    raw = await readReport(all, opts);
  } catch (e) {
    return e instanceof ReportTooLargeError ? refuse('decompressed_too_large', 'TLS-RPT report is too large') : refuse('no_attachment', 'Could not read TLS-RPT report email body');
  }
  const headers = opts.authHeaders ?? await readAuthHeaders(new Response(all).body);
  carrier ??= guardEnvelope(carrierFromHeaders(headers, tenant.env, 'tls'), message.from);

  // A DMARC aggregate report (XML) sent to the TLS-RPT address: say so.
  if (/<feedback[\s>]/i.test(raw.slice(0, 8192)) && !/"policies"/.test(raw)) return refuse('kind_mismatch_rua_to_tlsrpt');

  // Parse JSON — find the JSON blob (may be after headers/preamble)
  let report: TlsRptReport;
  try {
    // Find first { to skip any MIME preamble
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('no JSON object found');
    report = JSON.parse(raw.slice(start, end + 1));
  } catch (e) {
    return refuse('json_invalid');
  }

  const orgName = String(report['organization-name'] ?? 'Unknown');
  if (orgName.length > MAX_ORG_NAME) return refuse('field_too_long');
  const rawId = report['report-id'];
  if (typeof rawId === 'string' && rawId.length > MAX_REPORT_ID) return refuse('field_too_long');
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const period = checkPeriod(report['date-range'], now);
  if (!period.ok) return refuse('date_range_invalid');

  // Who sent it: the one rule (reporter-auth.ts), with the report's contact-info and the TLS-Report-Submitter header (RFC 8460 section 5.3).
  const decision = decideTier(carrier, { email: contactEmail(report['contact-info']), submitters: headers.submitters });
  dec.v = decision;
  const reporter = reporterInfo(carrier, decision);

  if (!Array.isArray(report.policies) || report.policies.length === 0) {
    if (opts.hosted) return refuse('json_invalid', 'Invalid TLS-RPT report: no policies');
    return result('accepted', 'ok', trace());
  }

  // Which domain rows the report is about: hosted, every policy must be the token's domain or a subdomain (filed under the token's domain);
  // self-host, the monitored domains it names (others are skipped).
  const rows = new Map<number, { domain: { id: number; domain: string }; policies: TlsRptPolicy[] }>();
  for (const policy of report.policies) {
    const policyDomain = policy.policy?.['policy-domain'];
    let domain: { id: number; domain: string } | null = null;
    if (opts.hosted) {
      // Hosted: a report naming a domain this workspace doesn't own is spoofed or misrouted. Reject it whole, store nothing.
      if (!policyDomain || !coversDomain(opts.hosted.token.domain, policyDomain)) return refuse('domain_not_owned'); // the sender's text is not echoed back (see dmarc-report.ts)
      domain = await tenant.scope.domains.getById(opts.hosted.token.id);
      if (!domain) return refuse('domain_not_owned');
    } else if (policyDomain) {
      domain = await tenant.scope.domains.getByName(policyDomain);
    }
    if (!domain) continue;
    const entry = rows.get(domain.id) ?? { domain, policies: [] };
    entry.policies.push(policy);
    rows.set(domain.id, entry);
  }

  let stored = 0;
  let duplicates = 0;
  let totalFailureCount = 0;
  for (const { domain, policies } of rows.values()) {
    // The replay key: the reporter's own report-id, else its period and the domain (RFC 8460 reports have no other identity).
    const reportId = typeof rawId === 'string' && rawId.trim() ? rawId.trim() : `~period|${period.start}|${period.end}|${domain.domain.toLowerCase()}`;
    let success = 0;
    let failure = 0;
    const details: unknown[] = [];
    for (const policy of policies) {
      success += policy.summary?.['total-successful-session-count'] ?? 0;
      failure += policy.summary?.['total-failure-session-count'] ?? 0;
      if (details.length < MAX_FAILURE_DETAILS) details.push(...(policy['failure-details'] ?? []).slice(0, MAX_FAILURE_DETAILS - details.length));
    }
    totalFailureCount += failure;
    // A replay (the reporter retries, or someone resends it) is accepted and changes nothing.
    if (await tenant.scope.reports.tlsSeen(domain.id, decision.identity, reportId)) { duplicates++; continue; }
    const row = {
      domain_id: domain.id,
      // Counted: the reporter's own name. Not counted: the sender's text is only a label, and it may not collide with (or overwrite) a real reporter's row.
      org_name: decision.tier === 'counted' ? orgName : `${decision.identity}: ${orgName}`,
      date_begin: period.start, date_end: period.end,
      total_success: success, total_failure: failure,
      failure_details: details.length ? JSON.stringify(details) : null,
      ...stsStats(policies),
      reporter_auth: reporter.auth, reporter_tier: reporter.tier, reporter_identity: reporter.identity, report_id: reportId,
      raw_json: stored === 0 ? rawJson(tenant, raw) : null, // store raw on the first row only
    };
    try {
      await tenant.scope.reports.insertTls(row);
      stored++;
    } catch (e) {
      // Lost a race with the same report (the unique key): nothing to store.
      if (await tenant.scope.reports.tlsSeen(domain.id, decision.identity, reportId).catch(() => false)) { duplicates++; continue; }
      console.error('[tls-rpt] insert failed for domain', domain.id, e instanceof Error ? e.message : e);
      // A valid report that could not be stored is never accepted-and-dropped: count it for the owner and fail the delivery.
      try { await tenant.scope.intake.markFailure(domain.id, today(), 'storage_failed', Math.floor(Date.now() / 1000)); } catch { /* a courtesy */ }
      throw new StorageFailure({ failure_count: totalFailureCount, ...trace() }, e);
    }
  }
  if (stored === 0 && duplicates > 0) return result('duplicate', 'duplicate', trace({ failure_count: totalFailureCount, dedup: 'duplicate' }));
  return result('accepted', 'ok', trace({ failure_count: totalFailureCount, dedup: 'new' }));
}
