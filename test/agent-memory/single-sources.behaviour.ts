// The behaviour guard behind docs/single-sources.md ("SPF flattening: what a module does"). The name guard in single-sources.lists.ts catches the names
// we know (`collectIps`, `flattenFromSource`); a second flattener under a new name slipped past it (the reviewer's `flattenSpf2`). This one asks what a
// module DOES, whatever its functions are called:
//   - it resolves the targets of `include:` or `redirect=` (the SPF syntax is handled and a TXT record is read), or
//   - it builds `ip4:` / `ip6:` SPF terms from the answers of DNS (a template or a concatenation, in a module that reads DNS).
// The record parser (packages/dns-checks/src/spf-terms.ts) reads no DNS and builds no address term; display code (the dashboard, the report catalog) names
// `include:` and shows addresses, but reads no TXT: neither matches. The owners are the engine and the TXT codec. Everything else that matches is listed in
// ALLOW_BEHAVIOUR with the reason it is not a second flattener, or the guard fails.

/** A read of a TXT record: the resolver's `txt(name)`, or a DoH query for type TXT. */
export const TXT_READ = /\.txt\(|\bresolveTxt\(|\bqueryTxt\(|\blookupTxt\(|\bdohQuery\([^)]*['"]TXT['"]|\bdoh\.query\([^)]*['"]TXT['"]/;
/** Any DNS read that could return an address. */
export const DNS_READ = /\.txt\(|\.resolve\(|\bresolveTxt\(|\bresolveA\(|\bdohQuery\(|\bdoh\.query\(|\bqueryTxt\(|\blookupTxt\(/;
/** The SPF `include` / `redirect` syntax being handled: a comparison or case on the term name, a pattern with `include:`, a key `include`. */
export const INCLUDE_SYNTAX = /(?:===?|!==?)\s*['"](?:include|redirect)['"]|case\s+['"](?:include|redirect)['"]|\/(?:\^?\\s\?)?include:|\binclude:\s*\(|\binclude:\[|\bredirect=\(|['"]include['"]\s*[,\]]|\[?['"]?include['"]?\s*:/;
/** An address term built from a value: `ip4:${x}`, 'ip6:' + x. A fixed example (`ip4:192.0.2.1`) is not built. */
export const IP_TERM_BUILT = /`[^`]*\bip[46]:\$\{|['"]ip[46]:['"]\s*\+/;

export const resolvesIncludes = (text: string): boolean => TXT_READ.test(text) && INCLUDE_SYNTAX.test(text);
export const buildsIpTermsFromDns = (text: string): boolean => IP_TERM_BUILT.test(text) && DNS_READ.test(text);
export const flattensSpf = (text: string): boolean => resolvesIncludes(text) || buildsIpTermsFromDns(text);

/** The one engine and the one TXT codec. */
export const BEHAVIOUR_OWNERS = ['packages/dns-checks/src/spf-flatten.ts', 'packages/dns-checks/src/txt.ts'];

export interface AllowBehaviour { file: string; reason: string; by: string; date: string }
/** Modules that match and are not a second flattener. Each says why; an entry for a file that no longer matches fails, so it cannot outlive its reason. */
export const ALLOW_BEHAVIOUR: AllowBehaviour[] = [
  {
    file: 'packages/dns-checks/src/spf.ts',
    reason: 'The SPF check: follows include and redirect to count lookups and report problems (RFC 7208 §4.6.4). It reads and reports; it never builds a record.',
    by: 'coordinator, round 2 of PR 189', date: '2026-11-16',
  },
  {
    file: 'src/public-reports/check.ts',
    reason: 'The free check: runs the analyzer over a public domain and reads the include and redirect chain to show what the analyzer found. It builds no record.',
    by: 'coordinator, round 2 of PR 189', date: '2026-11-16',
  },
  {
    file: 'src/hosted/pointers.ts',
    reason: 'Reads the customer\'s own SPF record to see whether it carries our include (pointer status). It resolves no include target and builds no record.',
    by: 'coordinator, round 2 of PR 189', date: '2026-11-16',
  },
  {
    file: 'tools/audit-fleet/lib/checker.ts',
    reason: 'An operator tool that audits a list of domains: walks include and redirect to count the lookup budget and name the providers. It writes no record.',
    by: 'coordinator, round 2 of PR 189', date: '2026-11-16',
  },
];
