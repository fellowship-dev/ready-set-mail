// The fetch cap holds on a diamond lattice of includes (the reviewer's probe of PR 189, made a bounded test): 2^depth paths, 2*depth names.
import { describe, it, expect } from 'vitest';
import { flattenFromSource, SPF_FLAT_MAX_FETCHES } from '../src/spf-flatten';
import type { Resolver } from '../src/doh';

describe('a lattice of includes', () => {
  for (const depth of [10, 14, 16, 18, 20]) {
    it(`diamond lattice depth ${depth} (${2 * depth} names) stays within the fetch cap and answers fast`, async () => {
      const txt = new Map<string, string>();
      for (let l = 0; l < depth; l++) {
        for (const s of ['x', 'y']) {
          txt.set(`${s}${l}.evil.test`, l === depth - 1 ? `v=spf1 ip4:192.0.2.${l} -all` : `v=spf1 include:x${l + 1}.evil.test include:y${l + 1}.evil.test -all`);
        }
      }
      let reads = 0;
      const resolver = {
        txt: async (n: string) => { reads++; return txt.has(n) ? { status: 'ok', records: [txt.get(n)] } : { status: 'nxdomain', records: [] }; },
        resolve: async () => { throw new Error('only TXT is read'); },
        fetch: async () => { throw new Error('no fetch'); },
      } as unknown as Resolver;
      const t0 = Date.now();
      const r = await flattenFromSource('victim.test', 'v=spf1 include:x0.evil.test -all', resolver);
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(reads).toBeLessThanOrEqual(SPF_FLAT_MAX_FETCHES);
      if (2 * depth > SPF_FLAT_MAX_FETCHES) expect(r.ok).toBe(false);
      else expect(r.ok).toBe(true);
    });
  }
});
