// The DNS-over-HTTPS resolver for a request, with one testing override.
//
// DOH_BASE_URL points the lookups at a local fake (e2e/support/fake-cloudflare.mjs also answers DoH), so local runs never
// read public DNS for made-up names that may belong to strangers. It is honoured ONLY when it is exactly
// http://127.0.0.1:<port> or http://localhost:<port> (no path, credentials, query or fragment); anything else is ignored
// and the public resolver is used.
import { createResolver, DEFAULT_DOH_ENDPOINT, DOH_ENDPOINTS, type Resolver } from '@ready-set-mail/dns-checks';

export function dohEndpoint(override?: string | null): string {
  const raw = override?.trim();
  if (!raw || !/^http:\/\/(127\.0\.0\.1|localhost):[0-9]{1,5}\/?$/.test(raw)) return DEFAULT_DOH_ENDPOINT;
  const u = new URL(raw);
  return Number(u.port) > 0 ? `http://${u.hostname}:${u.port}/dns-query` : DEFAULT_DOH_ENDPOINT;
}

export const resolverFor = (env: { DOH_BASE_URL?: string }): Resolver => createResolver({ endpoint: dohEndpoint(env.DOH_BASE_URL) });

/**
 * The resolver for the second of two reads that must agree (a proof withdrawn on a rival claim): another operator (dns.google), because the same
 * resolver asked again 2 s later usually returns the same cached answer. A local DOH_BASE_URL (testing) stays in force for both reads.
 */
export const confirmResolverFor = (env: { DOH_BASE_URL?: string }): Resolver =>
  createResolver({ endpoint: dohEndpoint(env.DOH_BASE_URL) !== DEFAULT_DOH_ENDPOINT ? dohEndpoint(env.DOH_BASE_URL) : DOH_ENDPOINTS.google });
