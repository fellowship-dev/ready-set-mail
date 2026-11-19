// TLS-RPT (RFC 8460) on the fixed hosted address `tls-rpt@<INTAKE_DOMAIN>`: the same idea as the DMARC address (src/hosted/fixed-address.ts).
//
// It carries no token, so the report itself says which domain it is about: `policies[].policy.policy-domain`. Anyone can mail this address, so before
// anything is allowed or stored the intake reads only that field, from at most the first PEEK_BYTES of the decompressed report, in a single linear
// scan of the JSON text (every character visited once, no regex, no backtracking). Attribution then goes through the one proven-owner rule
// (`mtaStsForReport` in packages/db/src/queries/intake.ts): the most specific live, proven domain that has MTA-STS on. The full parse
// (src/email/tls-rpt.ts) must find every policy covered by that domain, or nothing is stored.

import { intakeLookups, type IntakeTarget } from '@ready-set-mail/db';
import { normalizeDomain } from '@ready-set-mail/dns-checks';
import type { BoundEnv } from '../index';
import { extractAttachmentBytes, readStream } from '../email/mime-extract';
import { PEEK_BYTES, reportDomainCandidates, reportPrefix, tlsReportAddress, workspaceMayConnectReports } from './fixed-address';

export { tlsReportAddress };

const WS = /\s/;

/** One JSON string starting at the opening quote at `i`: its decoded text and the index after the closing quote, or null when it does not close. */
function readString(text: string, i: number): { value: string; next: number } | null {
  let out = '';
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j];
    if (c === '"') return { value: out, next: j + 1 };
    if (c === '\\') {
      const n = text[++j];
      if (n === undefined) return null;
      out += n === 'u' ? '?' : n; // only a plain name is accepted below, so an escape never produces one
      if (n === 'u') j += 4;
    } else out += c;
  }
  return null;
}

/**
 * The first `"policy-domain": "<name>"` of a JSON report, or null when it is absent or not a plain name. A string is a key only when a colon
 * follows it, so the text of a policy-string cannot pass for one.
 */
export function scanTlsPolicyDomain(text: string): string | null {
  let i = text.indexOf('{');
  if (i < 0) return null;
  while (i < text.length) {
    if (text[i] !== '"') { i++; continue; }
    const key = readString(text, i);
    if (!key) return null;
    let j = key.next;
    while (j < text.length && WS.test(text[j])) j++;
    if (text[j] !== ':') { i = key.next; continue; }
    if (key.value !== 'policy-domain') { i = j + 1; continue; }
    j++;
    while (j < text.length && WS.test(text[j])) j++;
    if (text[j] !== '"') return null;
    const value = readString(text, j);
    if (!value) return null;
    const v = value.value.trim();
    return /^[a-z0-9._-]+$/i.test(v) ? normalizeDomain(v) : null;
  }
  return null;
}

/** The report's policy domain from the raw message: a (gzip, zip or plain) attachment, else the message body; capped at PEEK_BYTES. */
export async function peekTlsPolicyDomain(raw: ReadableStream<Uint8Array>): Promise<string | null> {
  const all = await readStream(raw);
  let prefix: Uint8Array;
  try {
    prefix = reportPrefix(await extractAttachmentBytes(new Response(all).body!));
  } catch {
    prefix = all.subarray(0, PEEK_BYTES); // no usable attachment: the report is the message body (as src/email/tls-rpt.ts reads it)
  }
  return scanTlsPolicyDomain(new TextDecoder().decode(prefix));
}

/** The peek as a step of the intake: the domain, or the reason code to refuse the message with (src/hosted/reasons.ts). */
export async function peekTlsReportDomain(raw: ReadableStream<Uint8Array>): Promise<{ ok: true; domain: string } | { ok: false; reason: 'archive_invalid' | 'report_domain_unreadable' }> {
  let domain: string | null;
  try {
    domain = await peekTlsPolicyDomain(raw);
  } catch {
    return { ok: false, reason: 'archive_invalid' };
  }
  return domain ? { ok: true, domain } : { ok: false, reason: 'report_domain_unreadable' };
}

/** The workspace and domain that own TLS reports about `policyDomain`, when HOSTED_CONNECT_REPORTS admits that workspace. Null: refuse. */
export async function attributeTlsReport(env: Pick<BoundEnv, 'HOSTED_CONNECT_REPORTS' | 'OWNER_EMAIL'> & { DB: D1Database }, policyDomain: string): Promise<IntakeTarget | null> {
  const target = await intakeLookups(env.DB).mtaStsForReport(reportDomainCandidates(policyDomain));
  if (!target || !(await workspaceMayConnectReports(env, target.workspace_id))) return null;
  return target;
}
