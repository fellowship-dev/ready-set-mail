// Reviewer's property test for PR 189 (not committed). An independent RFC 7208 check_host evaluator over a fake DNS,
// random SPF trees, and the PR's engine. For every flatten the engine returns as ok, the flattened record evaluated for
// random sender IPs must give the same result as the original (evaluated without the 10-lookup limit, which is what
// flattening exists to escape), and must stay within 10 lookups / 2 void lookups / 450 bytes.
import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { flattenFromSource } from '../packages/dns-checks/src/spf-flatten';

// ── PRNG ──
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

// ── fake DNS ──
interface World {
  txt: Map<string, string[] | 'SERVFAIL'>;
  a: Map<string, string[]>;
  mx: Map<string, string[]>;
  ptr: Map<string, string[]>;
}
const ipToInt = (ip: string) => ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
function inCidr(ip: string, net: string, bits: number) {
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
  return ((ipToInt(ip) & mask) >>> 0) === ((ipToInt(net) & mask) >>> 0);
}

type Result = 'pass' | 'fail' | 'softfail' | 'neutral' | 'none' | 'permerror' | 'temperror';
const QR: Record<string, Result> = { '+': 'pass', '-': 'fail', '~': 'softfail', '?': 'neutral' };

class Eval {
  lookups = 0; voids = 0;
  constructor(private w: World, private ip: string, private enforce: boolean, private sender = 'sender.test') {}
  private count() { this.lookups++; if (this.enforce && this.lookups > 10) throw new Err('permerror'); }
  private void_(empty: boolean) { if (empty) { this.voids++; } }
  private expand(spec: string, d: string) {
    return spec.replace(/%\{([a-z])\}/gi, (_, c: string) => {
      const k = c.toLowerCase();
      if (k === 'i') return this.ip; if (k === 'd') return d; if (k === 'o') return this.sender; if (k === 'h') return 'helo.test';
      return 'x';
    }).replace(/%%/g, '%');
  }
  private aOf(name: string): string[] { const r = this.w.a.get(name.toLowerCase()) ?? []; return r; }
  check(domain: string, override?: string): Result {
    try { return this.run(domain.toLowerCase(), override); } catch (e) { if (e instanceof Err) return e.r; throw e; }
  }
  run(d: string, override?: string): Result {
    let rec: string;
    if (override !== undefined) rec = override;
    else {
      const t = this.w.txt.get(d);
      if (t === 'SERVFAIL') throw new Err('temperror');
      const spf = (t ?? []).filter(x => /^v=spf1( |$)/i.test(x));
      if (spf.length === 0) return 'none';
      if (spf.length > 1) throw new Err('permerror');
      rec = spf[0]!;
    }
    const toks = rec.trim().split(/\s+/).slice(1);
    let redirect: string | null = null;
    let hasAll = false;
    const mechs: { q: string; name: string; arg: string | null; c4: number | null }[] = [];
    for (const tok of toks) {
      const mm = tok.match(/^([a-z][a-z0-9._-]*)=(.*)$/i);
      if (mm) { if (mm[1]!.toLowerCase() === 'redirect') { if (redirect !== null) throw new Err('permerror'); redirect = mm[2]!; } continue; }
      let q = '+', r = tok;
      if ('+-~?'.includes(r[0]!)) { q = r[0]!; r = r.slice(1); }
      const m = r.match(/^([a-z0-9]+)(?::([^/]*))?(?:\/(\d+))?(?:\/\/(\d+))?$/i);
      if (!m) { // ip6 with ':' inside; or other
        const m6 = r.match(/^(ip6):(.*)$/i);
        if (m6) { mechs.push({ q, name: 'ip6', arg: m6[2]!, c4: null }); continue; }
        throw new Err('permerror');
      }
      const name = m[1]!.toLowerCase();
      if (name === 'all') hasAll = true;
      if (name === 'ip4') { const [net, bits] = (r.slice(4)).split('/'); mechs.push({ q, name, arg: net!, c4: bits === undefined ? 32 : Number(bits) }); continue; }
      mechs.push({ q, name, arg: m[2] ?? null, c4: m[3] !== undefined ? Number(m[3]) : null });
    }
    for (const mc of mechs) {
      let match = false;
      switch (mc.name) {
        case 'all': match = true; break;
        case 'ip4': match = inCidr(this.ip, mc.arg!, mc.c4!); break;
        case 'ip6': match = false; break; // IPv4 senders only
        case 'include': {
          this.count();
          const tgt = this.expand(mc.arg!, d).toLowerCase();
          const r = this.run(tgt);
          if (r === 'pass') match = true;
          else if (r === 'temperror') throw new Err('temperror');
          else if (r === 'permerror' || r === 'none') throw new Err('permerror');
          break;
        }
        case 'a': {
          this.count();
          const tgt = this.expand(mc.arg ?? d, d).toLowerCase();
          const ips = this.aOf(tgt); this.void_(ips.length === 0);
          match = ips.some(x => inCidr(this.ip, x, mc.c4 ?? 32));
          break;
        }
        case 'mx': {
          this.count();
          const tgt = this.expand(mc.arg ?? d, d).toLowerCase();
          const hosts = this.w.mx.get(tgt) ?? []; this.void_(hosts.length === 0);
          match = hosts.some(h => this.aOf(h).some(x => inCidr(this.ip, x, mc.c4 ?? 32)));
          break;
        }
        case 'ptr': {
          this.count();
          const tgt = this.expand(mc.arg ?? d, d).toLowerCase();
          const names = this.w.ptr.get(this.ip) ?? [];
          match = names.filter(n => this.aOf(n).includes(this.ip)).some(n => n === tgt || n.endsWith('.' + tgt));
          break;
        }
        case 'exists': {
          this.count();
          const tgt = this.expand(mc.arg!, d).toLowerCase();
          const ips = this.aOf(tgt); this.void_(ips.length === 0);
          match = ips.length > 0;
          break;
        }
        default: throw new Err('permerror');
      }
      if (match) return QR[mc.q]!;
    }
    if (redirect !== null && !hasAll) {
      this.count();
      const tgt = this.expand(redirect, d).toLowerCase();
      const r = this.run(tgt);
      return r === 'none' ? 'permerror' : r;
    }
    return 'neutral';
  }
}
class Err extends Error { constructor(readonly r: Result) { super(r); } }

// ── generator ──
function gen(seed: number) {
  const R = rng(seed);
  const pick = <T,>(a: T[]) => a[Math.floor(R() * a.length)]!;
  const chance = (p: number) => R() < p;
  const w: World = { txt: new Map(), a: new Map(), mx: new Map(), ptr: new Map() };
  const ip = () => `10.0.${Math.floor(R() * 4)}.${Math.floor(R() * 256)}`;
  const nProv = 2 + Math.floor(R() * 7);
  const provs = Array.from({ length: nProv }, (_, i) => `p${i}.prov.test`);
  const hosts = Array.from({ length: 6 }, (_, i) => `h${i}.prov.test`);
  for (const h of hosts) w.a.set(h, Array.from({ length: 1 + Math.floor(R() * 2) }, ip));
  for (const p of provs) {
    if (chance(0.5)) w.a.set(p, [ip()]);
    if (chance(0.4)) w.mx.set(p, [pick(hosts), pick(hosts)]);
  }
  // exists targets: some ips under _e.<prov> and _e.customer.test
  const qual = () => (chance(0.82) ? pick(['', '', '+']) : pick(['-', '~', '?']));
  const allQ = () => pick(['-all', '~all', '?all', '+all', '', '-all', '~all']);
  const term = (self: string, idx: number, provIdx: number): string => {
    const k = R();
    const q = qual();
    if (k < 0.45) { const bits = pick([32, 32, 32, 30, 28, 24]); return `${q}ip4:${ip()}${bits === 32 ? pick(['', '/32']) : '/' + bits}`; }
    if (k < 0.52) return `${q}ip6:2001:db8:${Math.floor(R() * 99)}::/48`;
    if (k < 0.70 && provIdx + 1 < provs.length) { // include a later provider (acyclic), rarely an earlier one (cycle)
      const later = provs.slice(provIdx + 1);
      const tgt = chance(0.03) && provIdx > 0 ? provs[0]! : pick(later);
      return `${q}include:${tgt}`;
    }
    if (k < 0.76) return `${q}a${pick(['', '', ':' + pick(hosts), ':' + self])}${pick(['', '', '/24', '/30'])}`;
    if (k < 0.81) return `${q}mx${pick(['', ':' + self])}${pick(['', '/24'])}`;
    if (k < 0.86) return `${q}exists:%{i}._e.${pick(['%{d}', self, '%{d}'])}`;
    if (k < 0.88) return `${q}ptr${pick(['', ':' + self])}`;
    return `${q}ip4:${ip()}`;
  };
  provs.forEach((p, i) => {
    const n = 1 + Math.floor(R() * 5);
    const terms = Array.from({ length: n }, (_, j) => term(p, j, i));
    let rec = `v=spf1 ${terms.join(' ')}`;
    if (chance(0.15) && i + 1 < provs.length) rec += ` redirect=${pick(provs.slice(i + 1))}`;
    else { const a = allQ(); if (a) rec += ` ${a}`; }
    if (chance(0.05)) { const r2 = rec.split(' '); const j = 1 + Math.floor(R() * (r2.length - 1)); r2.splice(j, 0, '-all'); rec = r2.join(' '); }
    w.txt.set(p, [rec, ...(chance(0.2) ? ['google-site-verification=xyz'] : [])]);
  });
  // exists hits
  for (let k = 0; k < 60; k++) { const x = ip(); w.a.set(`${x}._e.${pick([...provs, 'customer.test'])}`, ['127.0.0.2']); }
  // ptr
  for (let k = 0; k < 30; k++) { const x = ip(); const h = `mail${k}.${pick([...provs, 'customer.test'])}`; w.ptr.set(x, [h]); if (chance(0.7)) w.a.set(h, [x]); }
  w.a.set('customer.test', [ip()]);
  w.mx.set('customer.test', [pick(hosts)]);
  // root
  const rootTerms: string[] = [];
  const nInc = 1 + Math.floor(R() * Math.min(6, provs.length));
  const shuffled = [...provs].sort(() => R() - 0.5).slice(0, nInc);
  for (const p of shuffled) rootTerms.push(`${chance(0.9) ? '' : pick(['-', '~', '?'])}include:${p}`);
  for (let k = 0; k < Math.floor(R() * 3); k++) rootTerms.splice(Math.floor(R() * rootTerms.length), 0, term('customer.test', k, -1).replace(/include:.*/, `ip4:${ip()}`));
  rootTerms.sort(() => R() - 0.5);
  let root = `v=spf1 ${rootTerms.join(' ')}`;
  if (chance(0.15)) root = `v=spf1 ${rootTerms.slice(0, 1).join(' ')} redirect=${pick(provs)}`;
  else { const a = pick(['-all', '~all', '?all', '', '+all', '~all', '-all']); if (a) root += ` ${a}`; }
  if (chance(0.05)) root += ' foo=bar';
  if (chance(0.05)) root += ' exp=explain.customer.test';
  w.txt.set('customer.test', [root]);
  return { w, root, R };
}

function resolverOf(w: World) {
  return {
    async txt(name: string) {
      const t = w.txt.get(name.toLowerCase().replace(/\.$/, ''));
      if (t === 'SERVFAIL') return { status: 'error' as const, records: [], error: 'SERVFAIL' };
      if (!t) return { status: 'nxdomain' as const, records: [] };
      return { status: 'ok' as const, records: t };
    },
    async resolve() { throw new Error('engine should only read TXT'); },
    fetch: async () => { throw new Error('no fetch'); },
  } as any;
}

function staticLookups(w: World, rec: string, depth = 0): number {
  // RFC 7208 4.6.4 terms that cost a lookup, nested through include/redirect.
  if (depth > 20) return 999;
  let n = 0;
  const toks = rec.split(/\s+/).slice(1);
  const hasAll = toks.some(t => /^[+\-~?]?all$/i.test(t));
  for (const t of toks) {
    if (/^[+\-~?]?all$/i.test(t)) break;
    const m = t.match(/^[+\-~?]?(include|a|mx|ptr|exists)(?=$|[:/])(?::([^/]*))?/i);
    const r = t.match(/^redirect=(.*)$/i);
    if (m) {
      n++;
      if (m[1]!.toLowerCase() === 'include') { const x = w.txt.get(m[2]!.toLowerCase()); const s = Array.isArray(x) ? x.find(v => v.startsWith('v=spf1')) : undefined; if (s) n += staticLookups(w, s, depth + 1); }
    } else if (r && !hasAll) { n++; const x = w.txt.get(r[1]!.toLowerCase()); const s = Array.isArray(x) ? x.find(v => v.startsWith('v=spf1')) : undefined; if (s) n += staticLookups(w, s, depth + 1); }
  }
  return n;
}

describe('PR 189 flattening property test (reviewer)', () => {
  it('flattened record evaluates like the original for random senders', async () => {
    const CASES = Number(process.env.PROP_CASES ?? 3000);
    const SENDERS = 120;
    const stats = { cases: 0, ok: 0, refused: 0, evals: 0, wider: 0, narrower: 0, other: 0, overLimit: 0, overBytes: 0, overVoid: 0, origErr: 0 } as Record<string, number>;
    const failures: unknown[] = [];
    const refusedKinds: Record<string, number> = {};
    for (let seed = 1; seed <= CASES; seed++) {
      const { w, root, R } = gen(seed);
      const modes: { name: string; opts: any }[] = [
        { name: 'default', opts: {} },
        { name: 'most-unbounded', opts: { inline: 'most', maxBytes: 1e9, maxLookups: 1e9 } },
        { name: 'most', opts: { inline: 'most' } },
        { name: 'tight', opts: { maxLookups: 1 + Math.floor(R() * 9), maxBytes: 1e9 } },
        { name: 'include', opts: { inline: 'most', maxLookups: 9, publishedAs: 'include' } },
      ];
      for (const mode of modes) {
        stats.cases++;
        const res = await flattenFromSource('customer.test', root, resolverOf(w), mode.opts);
        if (!res.ok) { stats.refused++; const k = res.problems[0]!.kind; refusedKinds[k] = (refusedKinds[k] ?? 0) + 1; continue; }
        stats.ok++;
        let flat = res.flat.record;
        w.txt.delete('hosted.test');
        if (mode.name === 'include') { w.txt.set('hosted.test', [flat]); flat = `v=spf1 include:hosted.test${res.flat.all ? ' ' + res.flat.all : ''}`; }
        const unbounded = mode.name === 'most-unbounded';
        if (!unbounded && mode.name !== 'tight') {
          if (mode.name !== 'include' && res.flat.bytes > 450) { stats.overBytes++; failures.push({ seed, mode: mode.name, why: 'bytes', root, flat }); }
        }
        const sl = staticLookups(w, flat);
        if (!unbounded && sl > (mode.opts.maxLookups ?? 10)) { stats.overLimit++; failures.push({ seed, mode: mode.name, why: `lookups ${sl} (engine said ${res.flat.lookupsAfter})`, root, flat }); }
        const senders = new Set<string>();
        // senders from the address space plus every listed address
        for (let k = 0; k < SENDERS; k++) senders.add(`10.0.${Math.floor(R() * 4)}.${Math.floor(R() * 256)}`);
        for (const [, v] of w.txt) if (Array.isArray(v)) for (const s of v) for (const m of s.matchAll(/ip4:([\d.]+)/g)) senders.add(m[1]!);
        for (const [, v] of w.a) for (const x of v) senders.add(x);
        for (const ip of senders) {
          stats.evals++;
          const o = new Eval(w, ip, false).check('customer.test');
          const fe = new Eval(w, ip, !unbounded);
          const f = fe.check('customer.test', flat);
          if (!unbounded && fe.voids > 2) stats.overVoid++;
          if (o === 'permerror' || o === 'temperror') { stats.origErr++; continue; }
          if (o !== f) {
            const kind = f === 'pass' ? 'wider' : o === 'pass' ? 'narrower' : 'other';
            stats[kind]++;
            if (failures.length < 400) failures.push({ seed, mode: mode.name, kind, ip, orig: o, flat: f, root, flatRecord: flat, tree: Object.fromEntries([...w.txt].map(([k, v]) => [k, v])) });
          }
        }
      }
    }
    const out = { stats, refusedKinds, failures };
    writeFileSync(process.env.PROP_OUT ?? 'prop-result.json', JSON.stringify(out, null, 1));
    console.log(JSON.stringify({ stats, refusedKinds, firstFailures: failures.slice(0, 5) }, null, 1));
    expect(failures.length).toBe(0);
  }, 1_800_000);
});
