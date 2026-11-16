// Whether a name exists in DNS (RFC 9989 section 3.2.13: NXDOMAIN means the name and every name below it do not exist).
// The one existence test: the DMARC `np=` rule (./effective-policy) and the public checker's "this domain does not exist" use it.

import type { Resolver } from './doh';

/**
 * `false` only on a clear NXDOMAIN for an A query on the name; a name with only TXT records answers NODATA, which is "exists". A name
 * that is a CNAME to a missing target also answers NXDOMAIN, but the name itself has a record, so it exists. A failed lookup is `null`:
 * unknown, never "does not exist".
 */
export async function nameExists(resolver: Resolver, name: string): Promise<boolean | null> {
  const r = await resolver.resolve(name, 'A');
  if (r.status === 'nxdomain') return r.hasCname ? true : false;
  return r.status === 'error' ? null : true;
}
