// Reviewer probe (not committed): a diamond lattice of includes within the 40-fetch cap.
import { it } from 'vitest';
import { flattenFromSource } from '../packages/dns-checks/src/spf-flatten';

for (const depth of [10, 14, 16, 18, 20]) {
  it(`diamond lattice depth ${depth} (${2 * depth} names)`, async () => {
    const txt = new Map<string, string>();
    for (let l = 0; l < depth; l++) for (const s of ['x', 'y']) {
      const self = `${s}${l}.evil.test`;
      txt.set(self, l === depth - 1 ? `v=spf1 ip4:192.0.2.${l} -all` : `v=spf1 include:x${l + 1}.evil.test include:y${l + 1}.evil.test -all`);
    }
    const resolver = { txt: async (n: string) => (txt.has(n) ? { status: 'ok', records: [txt.get(n)] } : { status: 'nxdomain', records: [] }), resolve: async () => { throw new Error('x'); }, fetch: async () => { throw new Error('x'); } } as any;
    const t0 = Date.now();
    let mem0 = process.memoryUsage().heapUsed;
    const r = await flattenFromSource('victim.test', 'v=spf1 include:x0.evil.test -all', resolver);
    console.log(JSON.stringify({ depth, ms: Date.now() - t0, heapMB: Math.round((process.memoryUsage().heapUsed - mem0) / 1e6), ok: r.ok, fetches: (r as any).fetches ?? (r as any).flat?.fetches, problem: r.ok ? null : r.problems[0]!.message }));
  }, 600_000);
}
