// TEST CODE: runs the flattening engine over seeded random worlds and compares it with the independent evaluator.
//
// What is asserted, and why (RFC 7208 §4.6.4). The processing limits (10 terms that cause lookups, 2 void lookups) are what flattening escapes, so:
//  - the original gives a result: the flattened record gives the same, never wider (a `pass` the original did not give);
//  - the original errors BECAUSE of a processing limit (it errors with the limits on and does not with both off): the flattened record must give the
//    result the original gives WITHOUT those limits (and means the same without them, with no more void lookups than the original made); an include the engine
//    keeps as an include still spends the receiver's limits, so there the flattened record may give the same limit error the original gives, but never another result;
//  - the original errors for any other reason (a syntax permerror, a temperror, an include of a name with no record): the flattened record must never be
//    `pass`, and the engine must have refused (an `ok` result for a record that errors for a reason that is not a limit is a failure).
// No sender is skipped silently: each is counted (`origErrLimit`, `origErrOther`: the errors of a record the engine accepted, which is the failure when it is not 0 for `other`;
// `refusedOrigErrLimit`, `refusedOrigErrOther`, `refusedOrigLoop`: what the engine refused, by the kind of error the original gives one sender, so the counts show the rules are reached).
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

const HOSTED_NAME = 'hosted.test';

const MODES: { name: string; opts: (R: () => number) => SpfFlatOptions }[] = [
  { name: 'default', opts: () => ({}) },
  { name: 'most-unbounded', opts: () => ({ inline: 'most', maxBytes: 1e9, maxLookups: 1e9 }) },
  { name: 'most', opts: () => ({ inline: 'most' }) },
  { name: 'tight', opts: R => ({ maxLookups: 1 + Math.floor(R() * 9), maxBytes: 1e9 }) },
  // The hosted record: published as the target of `include:` in the customer's pointer record `v=spf1 include:<hosted name> <the original's all>`; the pointer is evaluated against the original.
  { name: 'include', opts: () => ({ inline: 'most', maxLookups: 9, publishedAs: 'include' }) },
];

export async function runProperty(run: PropertyRun): Promise<PropertySummary> {
  const seedStart = run.seedStart ?? 1;
  const SENDERS = run.senders ?? 60;
  const maxFailures = run.maxFailures ?? 200;
  const stats: Record<string, number> = { cases: 0, ok: 0, refused: 0, evals: 0, overLimit: 0, overBytes: 0, overVoid: 0, origErrLimit: 0, origErrOther: 0, origErrStillLimited: 0, refusedOrigErrLimit: 0, refusedOrigErrOther: 0, refusedOrigLoop: 0, errorPasses: 0, errorNotRefused: 0, wider: 0, narrower: 0, other: 0 };
  const refusedKinds: Record<string, number> = {};
  const failureKinds: Record<string, number> = {};
  const failures: unknown[] = [];
  const notedRefusable = new Set<string>();
  const fail = (kind: string, detail: Record<string, unknown>) => {
    failureKinds[kind] = (failureKinds[kind] ?? 0) + 1;
    if (failures.length < maxFailures) failures.push({ kind, ...detail });
  };

  for (let seed = seedStart; seed < seedStart + run.trees; seed++) {
    const { w, root, R } = gen(seed);
    for (const mode of MODES) {
      const opts = mode.opts(R);
      stats.cases!++;
      w.txt.delete(HOSTED_NAME);
      const res = await flattenFromSource('customer.test', root, resolverOf(w), opts);
      if (!res.ok) {
        stats.refused!++; const k = res.problems[0]!.kind; refusedKinds[k] = (refusedKinds[k] ?? 0) + 1;
        // What the engine refused, by what the original does for one sender: the proof that the "any other error" rule is reached, not only passed over.
        try {
          const probe = new SpfEval(w, '10.0.0.1', false).check('customer.test');
          if (probe === 'permerror' || probe === 'temperror') {
            const free = new SpfEval(w, '10.0.0.1', false, 'sender.test', false).check('customer.test');
            stats[free === 'permerror' || free === 'temperror' ? 'refusedOrigErrOther' : 'refusedOrigErrLimit']!++;
          }
        } catch (e) {
          if (!(e instanceof RangeError)) throw e;
          stats.refusedOrigLoop!++; // an include that leads back to itself: with the limits off the evaluator never ends; a receiver stops it at the lookup limit
        }
        continue;
      }
      stats.ok!++;
      const hostedRecord = res.flat.record;
      // In `include` mode what a receiver evaluates is the customer's pointer record, with the hosted record published at its own name.
      const asInclude = mode.name === 'include';
      if (asInclude) w.txt.set(HOSTED_NAME, [hostedRecord]);
      const flat = asInclude ? `v=spf1 include:${HOSTED_NAME}${res.flat.all ? ` ${res.flat.all}` : ''}` : hostedRecord;
      const unbounded = mode.name === 'most-unbounded';
      const ctx = { seed, mode: mode.name, root, flatRecord: flat, hostedRecord };

      // (ii) limits hold for every ok result in the bounded modes
      if (!unbounded) {
        if (mode.name !== 'tight' && res.flat.bytes > 450) { stats.overBytes!++; fail('bytes', { ...ctx, bytes: res.flat.bytes }); }
        const sl = staticLookups(w, flat); // the pointer: the include costs one
        if (sl > (opts.maxLookups ?? 10) + (asInclude ? 1 : 0)) { stats.overLimit!++; fail('lookups', { ...ctx, static: sl, engine: res.flat.lookupsAfter }); }
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
        const fe = new SpfEval(w, ip, !unbounded);
        const f = fe.check('customer.test', flat);
        if (o === 'permerror' || o === 'temperror') {
          const freeEval = new SpfEval(w, ip, false, 'sender.test', false);
          const free = freeEval.check('customer.test'); // the original with both processing limits off
          if (free !== 'permerror' && free !== 'temperror') {
            // (a) the error is the limits': flattening escapes them. The flattened record gives the result the original gives without them, or, where
            // it keeps an include whose own record still spends the limits, the same error the original gives; never another result, and it means the
            // same without the limits, and spends no more void lookups than the original did.
            stats.origErrLimit!++;
            const flatFree = new SpfEval(w, ip, false, 'sender.test', false);
            const ff = flatFree.check('customer.test', flat);
            const bad = (f !== 'permerror' && f !== 'temperror' ? f !== free : false) || ff !== free;
            if (bad) {
              const kind = (f === 'pass' || ff === 'pass') && free !== 'pass' ? 'wider' : free === 'pass' ? 'narrower' : 'other';
              stats[kind]!++;
              fail(kind, { ...ctx, ip, orig: o, origWithoutLimits: free, flat: f, flatWithoutLimits: ff, why: 'the original errors on a processing limit', tree: Object.fromEntries(w.txt) });
            } else if (flatFree.voids > freeEval.voids) { stats.overVoid!++; fail('void', { ...ctx, ip, flatVoids: flatFree.voids, origVoids: freeEval.voids, why: 'the original errors on a processing limit' }); }
            else if (f !== free) stats.origErrStillLimited!++; // an include that is kept still spends the limits, as it did in the original
          } else {
            // (b) any other error: never a pass, and the engine should have refused this record
            stats.origErrOther!++;
            if (f === 'pass') { stats.errorPasses!++; fail('error-passes', { ...ctx, ip, orig: o, flat: f, tree: Object.fromEntries(w.txt) }); }
            if (!notedRefusable.has(`${seed}:${mode.name}`)) { notedRefusable.add(`${seed}:${mode.name}`); stats.errorNotRefused!++; fail('error-not-refused', { ...ctx, ip, orig: o, why: 'the original errors for a reason that is not a processing limit, and the engine returned a record', tree: Object.fromEntries(w.txt) }); }
          }
          continue;
        }
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
