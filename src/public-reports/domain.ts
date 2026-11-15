// What a public report may be about: a public, registrable domain (or a name under one). The shared rule (normalizeDomainName, the
// one the dashboard and MCP use) refuses URLs, IP addresses, special-use and internal names; then, as on the website's checker, a
// leading www. is dropped when a registrable domain remains, and a bare public suffix (co.uk) is refused.

import { isPublicSuffix, normalizeDomainName, organizationalDomain } from '@ready-set-mail/dns-checks';

export type ReportDomain = { ok: true; domain: string } | { ok: false; error: string };

const INVALID = 'Enter a domain name such as example.com.';

export function reportDomain(raw: unknown): ReportDomain {
  if (typeof raw !== 'string' || raw.trim() === '' || raw.length > 253) return { ok: false, error: INVALID };
  const n = normalizeDomainName(raw);
  if (!n.ok) {
    return n.reason === 'special_use'
      ? { ok: false, error: `${n.name} is a special-use name: it has no public DNS to check.` }
      : { ok: false, error: INVALID };
  }
  let domain = n.domain;
  if (domain.startsWith('www.')) {
    const rest = domain.slice(4);
    if (rest.includes('.') && !isPublicSuffix(rest)) domain = rest;
  }
  if (isPublicSuffix(domain) || organizationalDomain(domain) === null) {
    return { ok: false, error: `${domain} is a public suffix, not a domain anyone registers. Enter a domain such as example.com.` };
  }
  return { ok: true, domain };
}
