// TEST CODE: runs the flattening engine over seeded random worlds and compares it with the independent evaluator.
import { flattenFromSource, type SpfFlatOptions } from '../src/spf-flatten';
import { SpfEval, staticLookups } from './spf-eval';
import { gen, resolverOf } from './spf-gen';

export interface PropertyRun {
  /** Trees (seeds 1..trees, or seedStart..). Every tree is flattened in four modes. */
  trees: number;
  seedStart?: number;
  /** Random senders per case, besides every listed address. */
  senders?: number;
  /** Keep at most this many failure examples. */
  maxFailures?: number;
}

export interface PropertySummary {
  trees: number;
  seedStart: number;
  stats: Record<string, number>;
  refusedKinds: Record<string, number>;
  failureKinds: Record<string, number>;
  failures: unknown[];
}

const MODES: { name: string; opts: (R: () => number) => SpfFlatOptions }[] = [
  { name: 'default', opts: () => ({}) },
  { name: 'most-unbounded', opts: () => ({ inline: 'most', maxBytes: 1e9, maxLookups: 1e9 }) },
  { name: 'most', opts: () => ({ inline: 'most' }) },
  { name: 'tight', opts: R => ({ maxLookups: 1 + Math.floor(R() * 9), maxBytes: 1e9 }) },
];

export async function runProperty(run: PropertyRun): Promise<PropertySummary> {
  const seedStart = run.seedStart ?? 1;
  const SENDERS = run.senders ?? 60;
  const maxFailures = run.maxFailures ?? 200;
  const stats: Record<string, number> = { cases: 0, ok: 0, refused: 0, evals: 0, origErr: 0, overLimit: 0, overBytes: 0, overVoid: 0, wider: 0, narrower: 0, other: 0 };
  const refusedKinds: Record<string, number> = {};
  const failureKinds: Record<string, number> = {};
  const failures: unknown[] = [];
  const fail = (kind: string, detail: Record<string, unknown>) => {
    failureKinds[kind] = (failureKinds[kind] ?? 0) + 1;
    if (failures.length < maxFailures) failures.push({ kind, ...detail });
  };

  for (let seed = seedStart; seed < seedStart + run.trees; seed++) {
    const { w, root, R } = gen(seed);
    for (const mode of MODES) {
      const opts = mode.opts(R);
      stats.cases!++;
      const res = await flattenFromSource('customer.test', root, resolverOf(w), opts);
      if (!res.ok) { stats.refused!++; const k = res.problems[0]!.kind; refusedKinds[k] = (refusedKinds[k] ?? 0) + 1; continue; }
      stats.ok!++;
      const flat = res.flat.record;
      const unbounded = mode.name === 'most-unbounded';
      const ctx = { seed, mode: mode.name, root, flatRecord: flat };

      // (ii) limits hold for every ok result in the bounded modes
      if (!unbounded) {
        if (mode.name !== 'tight' && res.flat.bytes > 450) { stats.overBytes!++; fail('bytes', { ...ctx, bytes: res.flat.bytes }); }
        const sl = staticLookups(w, flat);
        if (sl > (opts.maxLookups ?? 10)) { stats.overLimit!++; fail('lookups', { ...ctx, static: sl, engine: res.flat.lookupsAfter }); }
      }

      // senders: random addresses plus every listed address (ip4 terms, a/mx hosts, exists hits)
      const senders = new Set<string>();
      for (let k = 0; k < SENDERS; k++) senders.add(`10.0.${Math.floor(R() * 4)}.${Math.floor(R() * 256)}`);
      for (const [, v] of w.txt) if (Array.isArray(v)) for (const s of v) for (const m of s.matchAll(/ip4:([\d.]+)/g)) senders.add(m[1]!);
      for (const [, v] of w.a) for (const x of v) senders.add(x);
      for (const [name] of w.a) { const m = name.match(/^(\d+\.\d+\.\d+\.\d+)\._e\./); if (m) senders.add(m[1]!); }
      for (const [x] of w.ptr) senders.add(x);

      for (const ip of senders) {
        stats.evals!++;
        const oe = new SpfEval(w, ip, false);
        const o = oe.check('customer.test');
        if (o === 'permerror' || o === 'temperror') { stats.origErr!++; continue; }
        const fe = new SpfEval(w, ip, !unbounded);
        const f = fe.check('customer.test', flat);
        // (ii) void lookups: at most 2, or no more than the original made for this sender
        if (!unbounded && fe.voids > 2 && fe.voids > oe.voids) { stats.overVoid!++; fail('void', { ...ctx, ip, flatVoids: fe.voids, origVoids: oe.voids }); }
        // (i) the same result; never wider
        if (o !== f) {
          const kind = f === 'pass' ? 'wider' : o === 'pass' ? 'narrower' : 'other';
          stats[kind]!++;
          fail(kind, { ...ctx, ip, orig: o, flat: f, tree: Object.fromEntries(w.txt) });
        }
      }
    }
  }
  return { trees: run.trees, seedStart, stats, refusedKinds, failureKinds, failures };
}
