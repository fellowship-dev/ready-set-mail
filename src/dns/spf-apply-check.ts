// Is an SPF record one POST /api/domains/:id/apply-spf may publish? Parsed with the shared RFC 7208 parser.
//
// Lookup cost is not judged here: the wizard counts it (POST /api/spf-lookup-count) before it offers a record.
// TODO(after PR 161): refuse a record over the limit with the shared spfLookupJudgement / SPF_LOOKUP_LIMIT.

import { isSpfRecord, parseSpfTerms } from '@ready-set-mail/dns-checks/spf';

const MECHANISMS: ReadonlySet<string> = new Set(['all', 'include', 'a', 'mx', 'ptr', 'ip4', 'ip6', 'exists']);
const NEEDS_VALUE: ReadonlySet<string> = new Set(['include', 'ip4', 'ip6', 'exists']);
const MODIFIER_NAME = /^[a-z][a-z0-9._-]*$/;

/**
 * Why `record` cannot be applied, in a plain sentence, or null when it can. It must be printable ASCII starting with
 * v=spf1, every term a known mechanism (with a value where one is required) or a modifier, redirect= and exp= at most
 * once, and it must be complete: a terminal `all` mechanism (nothing after it but modifiers), or a redirect= with no
 * `all` (RFC 7208 §6.1: a redirect is ignored when the record has an all). +all is refused.
 */
export function spfApplyProblem(record: string): string | null {
  if (!isSpfRecord(record)) return 'SPF record must start with v=spf1';
  if (record.length > 2048 || /[^\x20-\x7e]/.test(record) || /["\\]/.test(record)) return 'SPF record must be printable text without quotes or backslashes, at most 2048 characters';
  const terms = parseSpfTerms(record);
  const seen = new Map<string, number>();
  for (const t of terms) {
    if (t.kind === 'modifier') {
      if (!MODIFIER_NAME.test(t.name) || !t.value) return `SPF record is not valid: "${t.raw}" is not a valid modifier`;
      seen.set(t.name, (seen.get(t.name) ?? 0) + 1);
      continue;
    }
    if (!MECHANISMS.has(t.name)) return `SPF record is not valid: "${t.raw}" is not an SPF mechanism`;
    if (NEEDS_VALUE.has(t.name) && !t.value) return `SPF record is not valid: "${t.raw}" needs a value`;
  }
  for (const m of ['redirect', 'exp']) if ((seen.get(m) ?? 0) > 1) return `SPF record is not valid: ${m}= appears more than once`;
  const mechanisms = terms.filter((t) => t.kind === 'mechanism');
  const allIndex = mechanisms.findIndex((t) => t.name === 'all');
  const redirect = seen.has('redirect');
  if (allIndex >= 0 && redirect) return 'SPF record has both an all mechanism and redirect=: receivers ignore redirect= when all is present. Keep one of them.';
  if (allIndex >= 0) {
    if (mechanisms[allIndex].qualifier === '+') return 'SPF record must not use +all: it lets any server send as this domain. Use -all or ~all.';
    if (allIndex !== mechanisms.length - 1) return 'SPF record must end with its all mechanism: anything after all is never evaluated';
    return null;
  }
  return redirect ? null : 'SPF record must end with an all mechanism or a redirect= modifier';
}
