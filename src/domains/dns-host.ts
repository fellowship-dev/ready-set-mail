// Who hosts a domain's DNS: read from its public NS records, so the setup screens can say "you manage this in Namecheap" and link
// to that provider's own "add a TXT record" page. Public DNS only; nothing of any workspace goes in, so answers are cached per
// domain for an hour and shared by every workspace this isolate serves.
//
// Every claim in DNS_PROVIDERS (a pattern, a help page, a host-field convention) was checked against the provider's own
// documentation; what could not be confirmed is left out (see /home/devbox/work/dns-hosts.md for the record of that).
import { normalizeName, organizationalDomain, type Resolver } from '@ready-set-mail/dns-checks';

export interface DnsProviderInfo {
  id: string;
  name: string;
  /** The provider's own page for adding a TXT record. Present only when confirmed. */
  help_url?: string;
  /** Does the provider's record form want `_readysetmail` (relative), the full name, or accept either? Present only when confirmed. */
  host_field?: 'relative' | 'fqdn' | 'either';
  /** The form adds the domain to what is typed. Present only when confirmed. */
  appends_domain?: boolean;
}

/** The ONE table. First provider whose pattern matches a nameserver wins; patterns run against normalized (lowercase, no trailing dot) hosts. */
export const DNS_PROVIDERS: ReadonlyArray<DnsProviderInfo & { pattern: RegExp }> = [
  { id: 'cloudflare', name: 'Cloudflare', pattern: /^[a-z0-9-]+\.ns\.cloudflare\.com$/ },
  { id: 'godaddy', name: 'GoDaddy', pattern: /^(ns|pdns)\d+\.domaincontrol\.com$/, help_url: 'https://www.godaddy.com/help/add-a-txt-record-19232', host_field: 'relative' },
  { id: 'porkbun', name: 'Porkbun', pattern: /^[a-z0-9-]+\.(ns\.)?porkbun\.com$/ },
  { id: 'namecheap', name: 'Namecheap', pattern: /^[a-z0-9-]+\.registrar-servers\.com$/, help_url: 'https://www.namecheap.com/support/knowledgebase/article.aspx/317/2237/how-do-i-add-txtspfdkimdmarc-records-for-my-domain/', host_field: 'relative' },
  { id: 'route53', name: 'AWS Route 53', pattern: /^ns-\d+\.awsdns-\d+\.(com|net|org|co\.uk)$/ },
  { id: 'google-cloud-dns', name: 'Google Cloud DNS', pattern: /^ns-cloud-[a-z0-9]+\.googledomains\.com$/, host_field: 'relative' },
  { id: 'squarespace', name: 'Squarespace', pattern: /^[a-z0-9-]+\.squarespacedns\.com$/, help_url: 'https://support.squarespace.com/hc/en-us/articles/31120980444429-Adding-TXT-records', host_field: 'relative', appends_domain: true },
  { id: 'digitalocean', name: 'DigitalOcean', pattern: /^ns\d+\.digitalocean\.com$/ },
  { id: 'vercel', name: 'Vercel', pattern: /^[a-z0-9-]+\.vercel-dns\.com$/ },
  { id: 'ns1', name: 'NS1 or Netlify DNS', pattern: /^[a-z0-9.-]+\.nsone\.net$/ },
];

export type DnsHostStatus = 'known' | 'unknown' | 'mixed' | 'error';

export interface DnsHostResult {
  provider: DnsProviderInfo | null;
  nameservers: string[];
  status: DnsHostStatus;
  /** Set only when `status` is `mixed`: the providers the nameservers belong to. */
  providers?: Array<{ id: string; name: string }>;
}

const publicInfo = ({ pattern: _pattern, ...info }: DnsProviderInfo & { pattern: RegExp }): DnsProviderInfo => info;

/** Pure: what the nameservers say. */
export function classifyNameservers(nameservers: readonly string[]): DnsHostResult {
  const ns = [...new Set(nameservers.map(normalizeName))].sort();
  const hits = new Map<string, (typeof DNS_PROVIDERS)[number]>();
  for (const host of ns) {
    const p = DNS_PROVIDERS.find(d => d.pattern.test(host));
    if (p) hits.set(p.id, p);
  }
  if (hits.size === 0) return { provider: null, nameservers: ns, status: 'unknown' };
  if (hits.size > 1) return { provider: null, nameservers: ns, status: 'mixed', providers: [...hits.values()].map(p => ({ id: p.id, name: p.name })) };
  return { provider: publicInfo([...hits.values()][0]), nameservers: ns, status: 'known' };
}

export const DNS_HOST_TTL_MS = 60 * 60 * 1000;
export const DNS_HOST_CACHE_MAX = 500;

/** In-isolate cache, deliberately shared across workspaces (public NS records only). Held in one instance, as in claim-preview.ts. */
class DnsHostState {
  readonly cache = new Map<string, { at: number; result: DnsHostResult }>();
}
const state = new DnsHostState();
const { cache } = state;

export function __resetDnsHostCacheForTests(): void { cache.clear(); }

/** The domain, then each parent up to its organizational domain: the names whose NS records can say who hosts this one. */
function candidates(domain: string): string[] {
  const out = [domain];
  const org = organizationalDomain(domain);
  let rest = domain;
  while (org && rest !== org && rest.endsWith(`.${org}`)) {
    rest = rest.slice(rest.indexOf('.') + 1);
    out.push(rest);
  }
  return out;
}

async function lookup(domain: string, resolver: Resolver): Promise<DnsHostResult> {
  try {
    for (const name of candidates(domain)) {
      const r = await resolver.resolve(name, 'NS');
      if (r.status === 'error') return { provider: null, nameservers: [], status: 'error' };
      const hosts = r.status === 'ok' ? r.answers.map(a => a.data) : [];
      if (hosts.length > 0) return classifyNameservers(hosts);
    }
    return { provider: null, nameservers: [], status: 'unknown' };
  } catch {
    return { provider: null, nameservers: [], status: 'error' };
  }
}

/** Is a fresh answer for this domain cached? Such a request costs no DNS. */
export function hasFreshDnsHost(domain: string, now = Date.now()): boolean {
  const hit = cache.get(normalizeName(domain));
  return !!hit && now - hit.at < DNS_HOST_TTL_MS;
}

/** Who hosts this domain's DNS. Never throws; a failed lookup is `error` (and is not cached), never `unknown`. */
export async function detectDnsHostFor(domain: string, resolver: Resolver, now = Date.now()): Promise<DnsHostResult> {
  const name = normalizeName(domain);
  const hit = cache.get(name);
  if (hit && now - hit.at < DNS_HOST_TTL_MS) return hit.result;
  const result = await lookup(name, resolver);
  if (result.status !== 'error') {
    cache.delete(name);
    cache.set(name, { at: now, result });
    while (cache.size > DNS_HOST_CACHE_MAX) cache.delete(cache.keys().next().value as string);
  }
  return result;
}
