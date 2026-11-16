// TEST CODE, not product code: an independent RFC 7208 check_host evaluator over a fake DNS, used by the property test of
// the flattening engine (spf-flatten.property.test.ts). It is deliberately separate from src/ (the engine must not share
// code with the thing that judges it) and it only models IPv4 senders. Origin: the independent review of PR 189.

export interface World {
  txt: Map<string, string[] | 'SERVFAIL'>;
  a: Map<string, string[]>;
  mx: Map<string, string[]>;
  ptr: Map<string, string[]>;
}

export type SpfResult = 'pass' | 'fail' | 'softfail' | 'neutral' | 'none' | 'permerror' | 'temperror';
const QR: Record<string, SpfResult> = { '+': 'pass', '-': 'fail', '~': 'softfail', '?': 'neutral' };

const ipToInt = (ip: string) => ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
function inCidr(ip: string, net: string, bits: number): boolean {
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : ~((1 << (32 - bits)) - 1) >>> 0;
  return ((ipToInt(ip) & mask) >>> 0) === ((ipToInt(net) & mask) >>> 0);
}

class Err extends Error {
  constructor(readonly r: SpfResult) { super(r); }
}

/** RFC 7208 §4.6.4: 10 terms that cause lookups (include, a, mx, ptr, exists, redirect); at most 2 lookups that return nothing. */
export class SpfEval {
  lookups = 0;
  voids = 0;
  /**
   * @param enforceLookups apply the 10-lookup limit (the original is evaluated without it: that limit is what flattening escapes)
   * The void-lookup limit of 2 (§4.6.4) is always applied.
   */
  constructor(private w: World, private ip: string, private enforceLookups: boolean, private sender = 'sender.test') {}

  private count(): void {
    this.lookups++;
    if (this.enforceLookups && this.lookups > 10) throw new Err('permerror');
  }
  private void_(empty: boolean): void {
    if (!empty) return;
    this.voids++;
    if (this.voids > 2) throw new Err('permerror');
  }
  /** RFC 7208 §7: macro letters; `d` is the CURRENT domain (§7.3), the others do not depend on it. */
  private expand(spec: string, d: string): string {
    return spec
      .replace(/%\{([a-z])\}/gi, (_, c: string) => {
        const k = c.toLowerCase();
        if (k === 'i') return this.ip;
        if (k === 'd') return d;
        if (k === 'o') return this.sender;
        if (k === 'h') return 'helo.test';
        return 'x';
      })
      .replace(/%%/g, '%');
  }
  private aOf(name: string): string[] { return this.w.a.get(name.toLowerCase()) ?? []; }

  /** check_host for `domain`; `override` replaces its TXT record (the flattened record is checked this way). */
  check(domain: string, override?: string): SpfResult {
    try {
      return this.run(domain.toLowerCase(), override);
    } catch (e) {
      if (e instanceof Err) return e.r;
      throw e;
    }
  }

  private run(d: string, override?: string): SpfResult {
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
    let seenExp = false;
    let hasAll = false;
    const mechs: { q: string; name: string; arg: string | null; c4: number | null }[] = [];
    for (const tok of toks) {
      const mm = tok.match(/^([a-z][a-z0-9._-]*)=(.*)$/i);
      if (mm) {
        const k = mm[1]!.toLowerCase();
        if (k === 'redirect') { if (redirect !== null) throw new Err('permerror'); redirect = mm[2]!; }
        if (k === 'exp') { if (seenExp) throw new Err('permerror'); seenExp = true; }
        continue; // unknown modifiers are ignored (§6)
      }
      let q = '+';
      let r = tok;
      if ('+-~?'.includes(r[0]!)) { q = r[0]!; r = r.slice(1); }
      const m = r.match(/^([a-z0-9]+)(?::([^/]*))?(?:\/(\d+))?(?:\/\/(\d+))?$/i);
      if (!m) {
        const m6 = r.match(/^(ip6):(.*)$/i);
        if (m6) { mechs.push({ q, name: 'ip6', arg: m6[2]!, c4: null }); continue; }
        throw new Err('permerror');
      }
      const name = m[1]!.toLowerCase();
      if (name === 'all') hasAll = true;
      if (name === 'ip4') {
        const [net, bits] = r.slice(4).split('/');
        mechs.push({ q, name, arg: net!, c4: bits === undefined ? 32 : Number(bits) });
        continue;
      }
      mechs.push({ q, name, arg: m[2] ?? null, c4: m[3] !== undefined ? Number(m[3]) : null });
    }
    for (const mc of mechs) {
      let match = false;
      switch (mc.name) {
        case 'all': match = true; break;
        case 'ip4': match = inCidr(this.ip, mc.arg!, mc.c4!); break;
        case 'ip6': match = false; break;
        case 'include': {
          this.count();
          const r = this.run(this.expand(mc.arg!, d).toLowerCase());
          if (r === 'pass') match = true;
          else if (r === 'temperror') throw new Err('temperror');
          else if (r === 'permerror' || r === 'none') throw new Err('permerror');
          break;
        }
        case 'a': {
          this.count();
          const ips = this.aOf(this.expand(mc.arg ?? d, d));
          this.void_(ips.length === 0);
          match = ips.some(x => inCidr(this.ip, x, mc.c4 ?? 32));
          break;
        }
        case 'mx': {
          this.count();
          const hosts = this.w.mx.get(this.expand(mc.arg ?? d, d).toLowerCase()) ?? [];
          this.void_(hosts.length === 0);
          for (const h of hosts) {
            const ips = this.aOf(h);
            this.void_(ips.length === 0);
            if (ips.some(x => inCidr(this.ip, x, mc.c4 ?? 32))) { match = true; break; }
          }
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
          const ips = this.aOf(this.expand(mc.arg!, d));
          this.void_(ips.length === 0);
          match = ips.length > 0;
          break;
        }
        default: throw new Err('permerror');
      }
      if (match) return QR[mc.q]!;
    }
    if (redirect !== null && !hasAll) {
      this.count();
      const r = this.run(this.expand(redirect, d).toLowerCase());
      return r === 'none' ? 'permerror' : r;
    }
    return 'neutral';
  }
}

/** Lookups a record needs when read statically (every term that costs one, through include and redirect), as a receiver counts them. */
export function staticLookups(w: World, rec: string, depth = 0): number {
  if (depth > 20) return 999;
  let n = 0;
  const toks = rec.split(/\s+/).slice(1);
  const hasAll = toks.some(t => /^[+\-~?]?all$/i.test(t));
  const spfOf = (name: string): string | undefined => {
    const x = w.txt.get(name.toLowerCase());
    return Array.isArray(x) ? x.find(v => /^v=spf1(\s|$)/i.test(v)) : undefined;
  };
  for (const t of toks) {
    if (/^[+\-~?]?all$/i.test(t)) break;
    const m = t.match(/^[+\-~?]?(include|a|mx|ptr|exists)(?=$|[:/])(?::([^/]*))?/i);
    const r = t.match(/^redirect=(.*)$/i);
    if (m) {
      n++;
      if (m[1]!.toLowerCase() === 'include') {
        const s = spfOf(m[2]!);
        if (s) n += staticLookups(w, s, depth + 1);
      }
    } else if (r && !hasAll) {
      n++;
      const s = spfOf(r[1]!);
      if (s) n += staticLookups(w, s, depth + 1);
    }
  }
  return n;
}
