// The RFC 7208 term parser: pure, so the dashboard and the one SPF record validator (spf-record.ts) import it without the
// resolver. spf.ts re-exports it.

export type SpfQualifier = '+' | '-' | '~' | '?';

export interface SpfTerm {
  raw: string;
  kind: 'mechanism' | 'modifier';
  /** all | include | a | mx | ptr | ip4 | ip6 | exists | redirect | exp | <unknown> */
  name: string;
  qualifier: SpfQualifier;
  /** domain-spec / network / modifier value (without cidr for a/mx) */
  value: string | null;
  cidr4?: number;
  cidr6?: number;
}

/** True when a TXT string is an SPF record: `v=spf1` followed by a space or end. */
export function isSpfRecord(txt: string): boolean {
  return /^v=spf1(\s|$)/i.test(txt.trim());
}

function parseCidr(s: string): { host: string; cidr4?: number; cidr6?: number } {
  // a/24, a//64, a/24//64, a:domain/24
  const m = s.match(/^([^/]*)(?:\/(\d+))?(?:\/\/(\d+))?$/);
  if (!m) return { host: s };
  return {
    host: m[1] ?? '',
    ...(m[2] !== undefined ? { cidr4: parseInt(m[2], 10) } : {}),
    ...(m[3] !== undefined ? { cidr6: parseInt(m[3], 10) } : {}),
  };
}

export function parseSpfTerms(raw: string): SpfTerm[] {
  const tokens = raw.trim().split(/\s+/).slice(1); // drop v=spf1
  const terms: SpfTerm[] = [];
  for (const token of tokens) {
    if (!token) continue;
    // A modifier is name=value where name is alpha-start [alnum._-]* and not a qualifier-prefixed mechanism
    const mod = token.match(/^([A-Za-z][A-Za-z0-9._-]*)=(.*)$/);
    if (mod) {
      terms.push({ raw: token, kind: 'modifier', name: mod[1]!.toLowerCase(), qualifier: '+', value: mod[2] ?? '' });
      continue;
    }
    let qualifier: SpfQualifier = '+';
    let rest = token;
    if (rest[0] && '+-~?'.includes(rest[0])) {
      qualifier = rest[0] as SpfQualifier;
      rest = rest.slice(1);
    }
    const m = rest.match(/^([A-Za-z0-9]+)(?:([:/])(.*))?$/);
    if (!m) {
      terms.push({ raw: token, kind: 'mechanism', name: rest.toLowerCase(), qualifier, value: null });
      continue;
    }
    const name = m[1]!.toLowerCase();
    const term: SpfTerm = { raw: token, kind: 'mechanism', name, qualifier, value: null };
    if (m[2] === ':') {
      if (name === 'a' || name === 'mx') {
        const { host, cidr4, cidr6 } = parseCidr(m[3] ?? '');
        term.value = host;
        if (cidr4 !== undefined) term.cidr4 = cidr4;
        if (cidr6 !== undefined) term.cidr6 = cidr6;
      } else {
        term.value = m[3] ?? '';
      }
    } else if (m[2] === '/' && (name === 'a' || name === 'mx')) {
      const { cidr4, cidr6 } = parseCidr('/' + m[3]);
      if (cidr4 !== undefined) term.cidr4 = cidr4;
      if (cidr6 !== undefined) term.cidr6 = cidr6;
    }
    terms.push(term);
  }
  return terms;
}
