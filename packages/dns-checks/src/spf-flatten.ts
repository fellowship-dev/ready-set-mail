// SPF flattening: the one engine (docs/single-sources.md, "SPF flattening").
//
// It resolves the ORIGINAL record (the one the owner published before flattening, kept by the caller) into a record that lists
// addresses instead of includes, so receivers need fewer DNS lookups (RFC 7208 §4.6.4: more than 10 is a permanent error).
// It never reads a published record: the caller hands over the original as `source`, and the resolver answers it for TXT at `domain`.
//
// Selective: a full flatten of three or more providers is nearly always over 450 bytes (RFC 7208 §3.4: keep a record under
// 450 bytes so the answer fits one UDP packet). So it inlines only as many top-level includes as it takes to land within BOTH
// limits and keeps the others verbatim: first the fewest inlined, then the fewest bytes. No subset fits: refused, with one sentence.
//
// Never widens authorization: only `+` ip mechanisms of an included record are inlined; an included record that has any other
// qualified mechanism, a `+all`, or a macro in a term that is copied is kept as an include; the original's `all` is kept
// (none stays none); no mechanism is added. Anything unreadable is a problem, never a smaller record.

import { normalizeName, type Resolver } from './doh';
import { ipProblem } from './spf-record';
import { isSpfRecord, parseSpfTerms, type SpfTerm } from './spf-terms';

/** RFC 7208 §4.6.4. */
export const SPF_FLAT_MAX_LOOKUPS = 10;
/** RFC 7208 §3.4. */
export const SPF_FLAT_MAX_BYTES = 450;
/** DNS reads one flatten may make (our own bound; the RFC's 10 is what flattening escapes). */
export const SPF_FLAT_MAX_FETCHES = 40;
/** Top-level includes tried in subsets (2^12 at most). */
export const SPF_FLAT_MAX_CANDIDATES = 12;

export type SpfProblemKind = 'include_unresolved' | 'too_large' | 'macro' | 'no_addresses';

export interface SpfProblem {
  kind: SpfProblemKind;
  /** The name the problem is about, when there is one. */
  domain: string | null;
  /** One plain sentence. */
  message: string;
}

export interface SpfFlat {
  /** The flattened record, ready to publish. */
  record: string;
  bytes: number;
  /** ip4:/ip6: terms in the record. */
  ipCount: number;
  /** Includes replaced by their addresses (top level). */
  inlined: string[];
  /** Includes left as includes (top level), by choice or because inlining them would not be safe. */
  keptIncludes: string[];
  /** Lookups the source needs as written (RFC 7208 §4.6.4). */
  lookupsBefore: number;
  /** Lookups the flattened record needs. */
  lookupsAfter: number;
  /** The source's own `all` as written, or null: none (the record is neutral and stays so). */
  all: string | null;
  fetches: number;
}

export type SpfFlatResult = { ok: true; flat: SpfFlat } | { ok: false; problems: SpfProblem[]; fetches: number };

export interface SpfFlatOptions {
  maxBytes?: number;
  maxLookups?: number;
  maxFetches?: number;
  maxCandidates?: number;
  /** `fewest` (default): as few includes inlined as the limits allow. `most`: as many as fit (an owner who flattens a record that is already within the limits). */
  inline?: 'fewest' | 'most';
}

class Refuse extends Error {
  constructor(readonly problem: SpfProblem) { super(problem.message); }
}
const refuse = (kind: SpfProblemKind, domain: string | null, message: string): never => { throw new Refuse({ kind, domain, message }); };

const hasMacro = (s: string | null | undefined): boolean => !!s && s.includes('%');
/** Case-insensitive except macros (%{i} and %{I} differ). */
const lower = (s: string): string => (s.includes('%') ? s : s.toLowerCase());
const qual = (t: SpfTerm): string => (t.qualifier === '+' ? '' : t.qualifier);

/** The resolver, but TXT at `domain` answers with `record`. */
function withSource(resolver: Resolver, domain: string, record: string): Resolver {
  const d = normalizeName(domain);
  return { ...resolver, txt: async name => (normalizeName(name) === d ? { status: 'ok' as const, records: [record] } : resolver.txt(name)) };
}

function ipEntry(t: SpfTerm): string {
  const name = t.name as 'ip4' | 'ip6';
  let v = (t.value ?? '').toLowerCase();
  if (name === 'ip4' && v.endsWith('/32')) v = v.slice(0, -3);
  if (name === 'ip6' && v.endsWith('/128')) v = v.slice(0, -4);
  return `${qual(t)}${name}:${v}`;
}

interface Node {
  /** `+ip4:`/`+ip6:` entries (qualifier omitted) the include matches. */
  ips: string[];
  /** Lookup terms copied when the include is inlined (a, mx, ptr, exists, pinned to the include's domain). */
  kept: string[];
  /** Lookups the inlined form still costs (one per kept term). */
  inlinedCost: number;
  /** Lookups the include's record costs when kept as an include (not counting the include term itself). */
  fullCost: number;
  /** May the include be replaced by `ips` + `kept` without changing who passes. */
  safe: boolean;
}

type RootItem =
  | { t: 'text'; text: string; ip: boolean; cost: number }
  | { t: 'inc'; target: string; text: string; node: Node; inlineable: boolean };

class Flattener {
  fetches = 0;
  private cache = new Map<string, Promise<string>>();
  constructor(private resolver: Resolver, private rootName: string, private maxFetches: number) {}

  private async record(domain: string): Promise<string> {
    const key = normalizeName(domain);
    let p = this.cache.get(key);
    if (!p) {
      if (++this.fetches > this.maxFetches) refuse('include_unresolved', null, `Your includes are nested too deeply to read: more than ${this.maxFetches} lookups are needed.`);
      p = this.resolver.txt(key).then(r => {
        const why = (what: string): never => refuse('include_unresolved', key, `We could not read the SPF record of ${key} (${what}).`);
        if (r.status === 'error') return why(r.error ?? 'DNS error');
        if (r.truncated) return why('the answer was cut short');
        const spf = r.records.filter(isSpfRecord);
        if (spf.length === 0) return why('it publishes no SPF record');
        if (spf.length > 1) return why('it publishes more than one SPF record');
        return spf[0]!.trim();
      });
      this.cache.set(key, p);
    }
    return p;
  }

  private target(t: SpfTerm, domain: string, path: string[]): string {
    const target = t.value ? normalizeName(t.value) : '';
    if (!target) return refuse('include_unresolved', domain, `${t.raw} in the record of ${domain} has no domain.`);
    if (hasMacro(target)) return refuse('macro', domain, `${t.raw} uses a macro, so the addresses depend on who is sending and cannot be flattened.`);
    if (path.includes(target)) return refuse('include_unresolved', domain, `The SPF records of ${[...path, target].join(' and ')} include each other.`);
    return target;
  }

  /** An included record, with include semantics: only a `pass` matches. */
  async node(domain: string, path: string[]): Promise<Node> {
    const n: Node = { ips: [], kept: [], inlinedCost: 0, fullCost: 0, safe: true };
    await this.walkIncluded(domain, await this.record(domain), path, n);
    return n;
  }

  private async walkIncluded(domain: string, raw: string, path: string[], n: Node): Promise<void> {
    const terms = parseSpfTerms(raw);
    const hasAll = terms.some(t => t.kind === 'mechanism' && t.name === 'all');
    for (const t of terms) {
      if (t.kind === 'modifier') {
        if (t.name === 'redirect' && !hasAll) {
          const target = this.target(t, domain, path);
          n.fullCost += 1;
          await this.walkIncluded(target, await this.record(target), [...path, target], n);
        }
        continue;
      }
      if (t.name === 'all') {
        if (t.qualifier === '+') n.safe = false; // the include would match every sender
        return; // anything after `all` is never evaluated
      }
      if (t.name === 'ip4' || t.name === 'ip6') {
        if (ipProblem(t.name, t.value ?? '')) refuse('include_unresolved', domain, `The SPF record of ${domain} lists ${t.raw}, which is not an address.`);
        if (t.qualifier === '+') n.ips.push(ipEntry(t).replace(/^\+/, ''));
        else n.safe = false; // a fail/softfail/neutral term decides the include: copying it as a pass would widen it
        continue;
      }
      if (t.name === 'include') {
        const target = this.target(t, domain, path);
        const child = await this.node(target, [...path, target]);
        n.fullCost += 1 + child.fullCost;
        if (t.qualifier === '+') {
          n.ips.push(...child.ips);
          n.kept.push(...child.kept);
          n.inlinedCost += child.inlinedCost;
          if (!child.safe) n.safe = false;
        } else n.safe = false;
        continue;
      }
      if (t.name === 'a' || t.name === 'mx' || t.name === 'ptr' || t.name === 'exists') {
        n.fullCost += 1;
        // A copied term is evaluated for the customer's domain: macros (%{d}) and a qualifier other than + change what it means.
        if (t.qualifier !== '+' || hasMacro(t.raw)) { n.safe = false; continue; }
        n.kept.push(this.pin(t, domain));
        n.inlinedCost += 1;
        continue;
      }
      refuse('include_unresolved', domain, `The SPF record of ${domain} uses ${t.raw}, which is not an SPF mechanism.`);
    }
  }

  /** A bare a/mx/ptr means "the current domain": copied out of an include it would point at the customer's domain, so name the include's. */
  private pin(t: SpfTerm, domain: string): string {
    if (t.value !== null && t.value !== '') return lower(t.raw);
    const cidr = (t.cidr4 !== undefined ? `/${t.cidr4}` : '') + (t.cidr6 !== undefined ? `//${t.cidr6}` : '');
    return `${qual(t)}${t.name}:${domain}${cidr}`;
  }

  /** Walk the original and its redirect chain, in order. `before` counts what the source costs as written. */
  async root(domain: string, raw: string, path: string[], items: RootItem[], st: { all: string | null; exp: string | null; before: number }): Promise<void> {
    const terms = parseSpfTerms(raw);
    const hasAll = terms.some(t => t.kind === 'mechanism' && t.name === 'all');
    let redirect: SpfTerm | null = null;
    for (const t of terms) {
      if (t.kind === 'modifier') {
        if (t.name === 'redirect' && !hasAll && !redirect) redirect = t;
        else if (t.name === 'exp' && domain === this.rootName && t.value) st.exp = lower(t.raw);
        continue;
      }
      if (t.name === 'all') { st.all = `${qual(t)}all`; break; }
      if (t.name === 'ip4' || t.name === 'ip6') {
        if (ipProblem(t.name, t.value ?? '')) refuse('include_unresolved', domain, `The SPF record of ${domain} lists ${t.raw}, which is not an address.`);
        items.push({ t: 'text', text: ipEntry(t), ip: true, cost: 0 });
      } else if (t.name === 'include') {
        const target = this.target(t, domain, path);
        const node = await this.node(target, [...path, target]);
        st.before += 1 + node.fullCost;
        items.push({ t: 'inc', target, text: `${qual(t)}include:${target}`, node, inlineable: t.qualifier === '+' && node.safe });
      } else if (t.name === 'a' || t.name === 'mx' || t.name === 'ptr' || t.name === 'exists') {
        st.before += 1;
        items.push({ t: 'text', text: domain === this.rootName ? lower(t.raw) : this.pin(t, domain), ip: false, cost: 1 });
      } else refuse('include_unresolved', domain, `The SPF record of ${domain} uses ${t.raw}, which is not an SPF mechanism.`);
    }
    if (redirect && !st.all) {
      const target = this.target(redirect, domain, path);
      st.before += 1;
      await this.root(target, await this.record(target), [...path, target], items, st);
    }
  }
}

function render(items: RootItem[], inlined: ReadonlySet<number>, all: string | null, exp: string | null) {
  const out: string[] = ['v=spf1'];
  const seen = new Set<string>();
  let lookups = 0;
  let ipCount = 0;
  let mechanisms = 0;
  const add = (text: string, ip: boolean, cost: number) => {
    const k = text.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(text);
    lookups += cost;
    mechanisms++;
    if (ip) ipCount++;
  };
  items.forEach((it, i) => {
    if (it.t === 'text') return add(it.text, it.ip, it.cost);
    if (inlined.has(i)) {
      for (const ip of it.node.ips) add(ip, true, 0);
      for (const k of it.node.kept) add(k, false, 1);
    } else {
      if (!seen.has(it.text.toLowerCase())) lookups += 1 + it.node.fullCost;
      add(it.text, false, 0);
    }
  });
  if (all) out.push(all);
  if (exp) out.push(exp);
  const record = out.join(' ');
  return { record, bytes: new TextEncoder().encode(record).length, lookups, ipCount, mechanisms };
}

/**
 * Flatten `source`, the original record as published at `domain`. Incomplete or unsafe results are never returned as a record.
 * Deterministic: the same source and the same DNS answers give the same record, so an unchanged result can be told by `sameSpfRecord`.
 */
export async function flattenFromSource(domain: string, source: string, resolver: Resolver, opts: SpfFlatOptions = {}): Promise<SpfFlatResult> {
  const name = normalizeName(domain);
  const maxBytes = opts.maxBytes ?? SPF_FLAT_MAX_BYTES;
  const maxLookups = opts.maxLookups ?? SPF_FLAT_MAX_LOOKUPS;
  const maxCandidates = opts.maxCandidates ?? SPF_FLAT_MAX_CANDIDATES;
  const w = new Flattener(withSource(resolver, name, source), name, opts.maxFetches ?? SPF_FLAT_MAX_FETCHES);
  try {
    if (!isSpfRecord(source)) refuse('include_unresolved', name, 'The record does not start with v=spf1.');
    const items: RootItem[] = [];
    const st = { all: null as string | null, exp: null as string | null, before: 0 };
    await w.root(name, source.trim(), [name], items, st);

    const cands = items.flatMap((it, i) => (it.t === 'inc' && it.inlineable ? [i] : []));
    if (cands.length > maxCandidates) refuse('too_large', name, `Your record has ${cands.length} includes that could be flattened; we handle up to ${maxCandidates}.`);
    const masks = Array.from({ length: 1 << cands.length }, (_, m) => m);
    const pop = (m: number) => { let c = 0; for (; m; m &= m - 1) c++; return c; };
    const order = opts.inline === 'most' ? (a: number, b: number) => pop(b) - pop(a) : (a: number, b: number) => pop(a) - pop(b);
    masks.sort((a, b) => order(a, b) || a - b);
    const setOf = (m: number) => new Set(cands.filter((_, j) => m & (1 << j)));

    let best: { m: number; r: ReturnType<typeof render> } | null = null;
    for (const m of masks) {
      if (best && pop(m) !== pop(best.m)) break; // the next size class is not wanted once one fits
      const r = render(items, setOf(m), st.all, st.exp);
      if (r.lookups <= maxLookups && r.bytes <= maxBytes && (!best || r.bytes < best.r.bytes)) best = { m, r };
    }
    if (!best) {
      const r = render(items, setOf((1 << cands.length) - 1), st.all, st.exp);
      return refuseResult(w, 'too_large', name,
        `Even with every include replaced by its addresses, your record would need ${r.lookups} ${r.lookups === 1 ? 'lookup' : 'lookups'} and ${r.bytes} bytes. A record should stay within ${maxLookups} lookups and ${maxBytes} bytes, so we left it as it is.`);
    }
    const chosen = setOf(best.m);
    const incs = items.flatMap((it, i) => (it.t === 'inc' ? [{ i, target: it.target }] : []));
    const r = best.r;
    if (r.mechanisms === 0 && items.some(it => it.t === 'inc')) {
      refuse('no_addresses', name, 'The includes in your record returned no addresses, so there is nothing to flatten to.');
    }
    return {
      ok: true,
      flat: {
        record: r.record, bytes: r.bytes, ipCount: r.ipCount,
        inlined: incs.filter(x => chosen.has(x.i)).map(x => x.target),
        keptIncludes: incs.filter(x => !chosen.has(x.i)).map(x => x.target),
        lookupsBefore: st.before, lookupsAfter: r.lookups, all: st.all, fetches: w.fetches,
      },
    };
  } catch (e) {
    if (e instanceof Refuse) return { ok: false, problems: [e.problem], fetches: w.fetches };
    throw e;
  }
}

function refuseResult(w: Flattener, kind: SpfProblemKind, domain: string | null, message: string): SpfFlatResult {
  return { ok: false, problems: [{ kind, domain, message }], fetches: w.fetches };
}

/** Unquote, collapse spaces, lowercase everything but macros. */
export function normalizeSpfRecord(raw: string): string {
  return raw.trim().replace(/^"|"$/g, '').trim().split(/\s+/).map(lower).join(' ');
}

/** Same record regardless of the order of its terms, case, quotes and spacing. */
export function sameSpfRecord(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return false;
  const norm = (s: string) => normalizeSpfRecord(s).split(' ').sort().join(' ');
  return norm(a) === norm(b);
}
