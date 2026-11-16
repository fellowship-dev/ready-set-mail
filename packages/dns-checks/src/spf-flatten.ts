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
import { decodeTxtData } from './txt';
import { isSpfRecord, parseSpfTerms, type SpfTerm } from './spf-terms';

/** RFC 7208 §4.6.4. */
export const SPF_FLAT_MAX_LOOKUPS = 10;
/** RFC 7208 §3.4. */
export const SPF_FLAT_MAX_BYTES = 450;
/** DNS reads one flatten may make (our own bound; the RFC's 10 is what flattening escapes). */
export const SPF_FLAT_MAX_FETCHES = 40;
/** Top-level includes tried in subsets (2^12 at most). */
export const SPF_FLAT_MAX_CANDIDATES = 12;

/** The terms an inlined top-level include contributes (`ip4:`/`ip6:` entries and the lookup terms it keeps), by include target. */
export type SpfProviderEntries = Record<string, string[]>;

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
  /** What each inlined include contributes now. */
  providers: SpfProviderEntries;
  /**
   * With `previous` given: what the published record authorises for an include that is inlined now and was before, and the new resolution no longer
   * does (an old address no new entry covers). Empty: nothing would be taken away. An include kept as an include is authorised live, so it is never here.
   */
  removed: SpfProviderEntries;
  /** When something is `removed`: the record that keeps those entries (everything new, nothing taken away), and whether it fits both limits. */
  held: { record: string; bytes: number; ipCount: number; lookups: number; fits: boolean; providers: SpfProviderEntries } | null;
}

export type SpfFlatResult = { ok: true; flat: SpfFlat } | { ok: false; problems: SpfProblem[]; fetches: number };

export interface SpfFlatOptions {
  maxBytes?: number;
  maxLookups?: number;
  maxFetches?: number;
  maxCandidates?: number;
  /** `fewest` (default): as few includes inlined as the limits allow. `most`: as many as fit (an owner who flattens a record that is already within the limits). */
  inline?: 'fewest' | 'most';
  /** What the published record authorises per inlined include (`SpfFlat.providers` of the run that wrote it): turns on `removed` and `held`. */
  previous?: SpfProviderEntries;
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
  /** `+ip4:`/`+ip6:` entries (qualifier omitted) the include matches, once each, in the order they are met. */
  ips: Set<string>;
  /** Lookup terms copied when the include is inlined (a, mx, ptr, exists, pinned to the include's domain), once each, in order. */
  kept: Set<string>;
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
  /** Includes read to the end without a refusal: what one says does not depend on how we got to it, so a lattice of includes is read once. */
  private nodes = new Map<string, Node>();
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

  /**
   * The terms of a record, after the checks a receiver makes on the WHOLE record before it evaluates a term (RFC 7208 §4.6: a syntax
   * error anywhere, also after `all`, is a permanent error for everyone). We refuse such a record instead of turning it into a valid one.
   */
  private checked(domain: string, raw: string): SpfTerm[] {
    const terms = parseSpfTerms(raw);
    const seen = new Set<string>();
    for (const t of terms) {
      if (t.kind === 'modifier') {
        // §6: redirect and exp may appear once each
        if (t.name === 'redirect' || t.name === 'exp') {
          if (seen.has(t.name)) refuse('include_unresolved', domain, `The SPF record of ${domain} has more than one ${t.name}=, which receivers treat as an error, so we left it as it is.`);
          seen.add(t.name);
        }
        continue;
      }
      if (t.name === 'ip4' || t.name === 'ip6') {
        if (ipProblem(t.name, t.value ?? '')) refuse('include_unresolved', domain, `The SPF record of ${domain} lists ${t.raw}, which is not an address.`);
      } else if (t.name === 'include' || t.name === 'exists') {
        if (!t.value) refuse('include_unresolved', domain, `${t.raw} in the record of ${domain} has no domain.`);
      } else if (!['all', 'a', 'mx', 'ptr'].includes(t.name)) {
        refuse('include_unresolved', domain, `The SPF record of ${domain} uses ${t.raw}, which is not an SPF mechanism.`);
      }
    }
    return terms;
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
    const done = this.nodes.get(domain);
    if (done) return done;
    const n: Node = { ips: new Set(), kept: new Set(), inlinedCost: 0, fullCost: 0, safe: true };
    await this.walkIncluded(domain, await this.record(domain), path, n);
    this.nodes.set(domain, n);
    return n;
  }

  private async walkIncluded(domain: string, raw: string, path: string[], n: Node): Promise<void> {
    const terms = this.checked(domain, raw);
    const hasAll = terms.some(t => t.kind === 'mechanism' && t.name === 'all');
    // `redirect=` is evaluated after every mechanism, wherever the modifier stands in the record (§6.1): the order of the lookups we keep follows.
    let redirect: SpfTerm | null = null;
    for (const t of terms) {
      if (t.kind === 'modifier') {
        if (t.name === 'redirect' && !hasAll) redirect = t;
        continue;
      }
      if (t.name === 'all') {
        if (t.qualifier === '+') n.safe = false; // the include would match every sender
        return; // anything after `all` is never evaluated
      }
      if (t.name === 'ip4' || t.name === 'ip6') {
        if (t.qualifier === '+') n.ips.add(ipEntry(t).replace(/^\+/, ''));
        else n.safe = false; // a fail/softfail/neutral term decides the include: copying it as a pass would widen it
        continue;
      }
      if (t.name === 'include') {
        const target = this.target(t, domain, path);
        const child = await this.node(target, [...path, target]);
        n.fullCost += 1 + child.fullCost;
        if (t.qualifier === '+') {
          for (const ip of child.ips) n.ips.add(ip);
          for (const k of child.kept) n.kept.add(k);
          n.inlinedCost += child.inlinedCost;
          if (!child.safe) n.safe = false;
        } else n.safe = false;
        continue;
      }
      // a, mx, ptr, exists (checked() refused anything else)
      n.fullCost += 1;
      // A copied term is evaluated for the customer's domain: macros (%{d}) and a qualifier other than + change what it means.
      if (t.qualifier !== '+' || hasMacro(t.raw)) { n.safe = false; continue; }
      n.kept.add(this.pin(t, domain));
      n.inlinedCost += 1;
    }
    if (redirect) {
      const target = this.target(redirect, domain, path);
      n.fullCost += 1;
      await this.walkIncluded(target, await this.record(target), [...path, target], n);
    }
  }

  /** A bare a/mx/ptr means "the current domain": copied out of an include it would point at the customer's domain, so name the include's. */
  private pin(t: SpfTerm, domain: string): string {
    if (t.value !== null && t.value !== '') return lower(t.raw);
    const cidr = (t.cidr4 !== undefined ? `/${t.cidr4}` : '') + (t.cidr6 !== undefined ? `//${t.cidr6}` : '');
    return `${qual(t)}${t.name}:${domain}${cidr}`;
  }

  /**
   * Walk the original and its redirect chain, in order. `before` counts what the source costs as written.
   *
   * After `redirect=`, the target is the CURRENT domain (RFC 7208 §6.1) and the macro letter `d` means it (§7.3). Copying a term of the
   * target into the customer's record would make `d` the customer's domain, so a macro in a term reached through a redirect is refused.
   * A bare `a`, `mx` or `ptr` means the current domain too: it is written with the target's name.
   */
  async root(domain: string, raw: string, path: string[], items: RootItem[], st: { all: string | null; exp: string | null; before: number }): Promise<void> {
    const terms = this.checked(domain, raw);
    const inChain = domain !== this.rootName;
    const hasAll = terms.some(t => t.kind === 'mechanism' && t.name === 'all');
    let redirect: SpfTerm | null = null;
    let ended = false; // `all` was seen: no later mechanism is evaluated, a later modifier still counts
    for (const t of terms) {
      if (t.kind === 'modifier') {
        if (t.name === 'redirect' && !hasAll) redirect = t;
        // exp= only changes the explanation a receiver shows, never the result. The customer's own is kept; a redirect target's is
        // carried when the customer has none and it has no macro (its `d` would be the customer's domain).
        else if (t.name === 'exp' && t.value && (!inChain || !hasMacro(t.raw))) st.exp = st.exp ?? lower(t.raw);
        continue;
      }
      if (ended) continue;
      if (t.name === 'all') { st.all = `${qual(t)}all`; ended = true; continue; }
      if (t.name === 'ip4' || t.name === 'ip6') {
        items.push({ t: 'text', text: ipEntry(t), ip: true, cost: 0 });
      } else if (t.name === 'include') {
        const target = this.target(t, domain, path);
        const node = await this.node(target, [...path, target]);
        st.before += 1 + node.fullCost;
        items.push({ t: 'inc', target, text: `${qual(t)}include:${target}`, node, inlineable: t.qualifier === '+' && node.safe });
      } else {
        if (inChain && hasMacro(t.raw)) {
          refuse('macro', domain, `The record of ${domain}, which your record hands over to with redirect=, uses a macro that depends on that name, so it cannot be copied into your record.`);
        }
        st.before += 1;
        items.push({ t: 'text', text: inChain ? this.pin(t, domain) : lower(t.raw), ip: false, cost: 1 });
      }
    }
    if (redirect) {
      const target = this.target(redirect, domain, path);
      st.before += 1;
      await this.root(target, await this.record(target), [...path, target], items, st);
    }
  }
}

/** An address as a number with its size in bits, or null when it is not one we can read. */
function parseAddress(v: string): { n: bigint; bits: 32 | 128 } | null {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) {
    const o = v.split('.').map(Number);
    return o.some(x => x > 255) ? null : { n: o.reduce((a, x) => (a << 8n) | BigInt(x), 0n), bits: 32 };
  }
  if (!/^[0-9a-f:.]+$/i.test(v) || !v.includes(':')) return null;
  let head = v;
  let tail4: bigint[] = [];
  const dot = v.lastIndexOf('.');
  if (dot >= 0) { // ::ffff:1.2.3.4
    const colon = v.lastIndexOf(':');
    const four = parseAddress(v.slice(colon + 1));
    if (!four) return null;
    tail4 = [(four.n >> 16n) & 0xffffn, four.n & 0xffffn];
    head = v.slice(0, colon + 1) + '0:0'; // placeholders, replaced below
  }
  const halves = head.split('::');
  if (halves.length > 2) return null;
  const groups = (x: string) => (x === '' ? [] : x.split(':'));
  const a = groups(halves[0]!);
  const b = halves.length === 2 ? groups(halves[1]!) : [];
  if (halves.length === 1 ? a.length !== 8 : a.length + b.length > 7) return null;
  const all = halves.length === 1 ? a : [...a, ...Array(8 - a.length - b.length).fill('0'), ...b];
  if (tail4.length) { all[6] = tail4[0]!.toString(16); all[7] = tail4[1]!.toString(16); }
  let n = 0n;
  for (const g of all) { if (!/^[0-9a-f]{1,4}$/i.test(g)) return null; n = (n << 16n) | BigInt(parseInt(g, 16)); }
  return { n, bits: 128 };
}

function parseEntry(e: string): { family: 4 | 6; n: bigint; bits: number; prefix: number } | null {
  const m = e.match(/^ip([46]):([^/]+)(?:\/(\d+))?$/i);
  if (!m) return null;
  const a = parseAddress(m[2]!);
  if (!a) return null;
  return { family: m[1] === '4' ? 4 : 6, n: a.n, bits: a.bits, prefix: m[3] === undefined ? a.bits : Number(m[3]) };
}

/** Does one of `entries` authorise every address `old` does? An address or range is covered by an equal or wider range of its kind; any other term, by the same term. */
export function entryCovered(entries: readonly string[], old: string): boolean {
  const o = parseEntry(old);
  if (!o) return entries.some(e => e.toLowerCase() === old.toLowerCase());
  return entries.some(e => {
    const c = parseEntry(e);
    if (!c || c.family !== o.family || c.prefix > o.prefix) return false;
    const shift = BigInt(c.bits - c.prefix);
    return c.n >> shift === o.n >> shift;
  });
}

/** Old entries of the includes inlined both before and now that nothing now covers. */
function removedEntries(previous: SpfProviderEntries, now: SpfProviderEntries): SpfProviderEntries {
  const out: SpfProviderEntries = {};
  for (const [target, old] of Object.entries(previous)) {
    const current = now[target];
    if (!current) continue; // kept as an include now (authorised live) or no longer inlined: we remove nothing
    const gone = old.filter(e => !entryCovered(current, e));
    if (gone.length) out[target] = gone;
  }
  return out;
}

function render(items: RootItem[], inlined: ReadonlySet<number>, all: string | null, exp: string | null, hold: SpfProviderEntries = {}) {
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
      for (const e of hold[it.target] ?? []) add(e, /^ip[46]:/i.test(e), /^ip[46]:/i.test(e) ? 0 : 1);
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
    const providers: SpfProviderEntries = {};
    items.forEach((it, i) => {
      if (it.t === 'inc' && chosen.has(i)) providers[it.target] = [...new Set([...(providers[it.target] ?? []), ...it.node.ips, ...it.node.kept])];
    });
    const removed = opts.previous ? removedEntries(opts.previous, providers) : {};
    let held: SpfFlat['held'] = null;
    if (Object.keys(removed).length) {
      const h = render(items, chosen, st.all, st.exp, removed);
      const withHeld: SpfProviderEntries = {};
      for (const [t, es] of Object.entries(providers)) withHeld[t] = [...new Set([...es, ...(removed[t] ?? [])])];
      held = { record: h.record, bytes: h.bytes, ipCount: h.ipCount, lookups: h.lookups, fits: h.lookups <= maxLookups && h.bytes <= maxBytes, providers: withHeld };
    }
    if (r.mechanisms === 0 && items.some(it => it.t === 'inc')) {
      refuse('no_addresses', name, 'The includes in your record returned no addresses, so there is nothing to flatten to.');
    }
    return {
      ok: true,
      flat: {
        record: r.record, bytes: r.bytes, ipCount: r.ipCount,
        inlined: incs.filter(x => chosen.has(x.i)).map(x => x.target),
        keptIncludes: incs.filter(x => !chosen.has(x.i)).map(x => x.target),
        lookupsBefore: st.before, lookupsAfter: r.lookups, all: st.all, fetches: w.fetches, providers, removed, held,
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

/** Decode the quoted strings (decodeTxtData), collapse spaces, lowercase everything but macros. */
export function normalizeSpfRecord(raw: string): string {
  return decodeTxtData(raw).trim().split(/\s+/).map(lower).join(' ');
}

/**
 * Same record regardless of case, quotes and spacing, and of the order of addresses that stand next to each other. The order of every
 * other term is kept: `-ip4:1.2.3.4 ip4:1.2.0.0/16` and the same terms the other way round give different results (RFC 7208 §4.6.2:
 * the first term that matches decides), so a reordered record is a different record.
 */
export function sameSpfRecord(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return false;
  const canonical = (s: string): string => {
    const out: string[] = [];
    let run: string[] = [];
    const flush = () => { out.push(...run.sort()); run = []; };
    for (const t of normalizeSpfRecord(s).split(' ')) {
      if (/^\+?ip[46]:/.test(t)) run.push(t);
      else { flush(); out.push(t); }
    }
    flush();
    return out.join(' ');
  };
  return canonical(a) === canonical(b);
}
