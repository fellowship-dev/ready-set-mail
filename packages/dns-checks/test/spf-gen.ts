// TEST CODE: seeded random SPF worlds for the flattening property test (see spf-eval.ts).
import type { World } from './spf-eval';
import type { Resolver } from '../src/doh';

/** Deterministic xorshift32: the same seed gives the same world on every machine. */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

export interface Gen {
  w: World;
  root: string;
  R: () => number;
}

export function gen(seed: number): Gen {
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
  const qual = () => (chance(0.82) ? pick(['', '', '+']) : pick(['-', '~', '?']));
  const allQ = () => pick(['-all', '~all', '?all', '+all', '', '-all', '~all']);
  // some worlds are full of names nobody published: lookups that return nothing (void lookups, RFC 7208 §4.6.4, limit 2)
  const voidy = chance(0.2);
  const term = (self: string, _idx: number, provIdx: number): string => {
    const k = R();
    const q = qual();
    if (voidy && chance(0.45)) {
      const name = `void${Math.floor(R() * 4)}.prov.test`;
      return pick([`${q}a:${name}`, `${q}mx:${name}`, `${q}exists:%{i}.${name}`]);
    }
    if (k < 0.45) { const bits = pick([32, 32, 32, 30, 28, 24]); return `${q}ip4:${ip()}${bits === 32 ? pick(['', '/32']) : '/' + bits}`; }
    if (k < 0.52) return `${q}ip6:2001:db8:${Math.floor(R() * 99)}::/48`;
    if (k < 0.70 && provIdx + 1 < provs.length) {
      const later = provs.slice(provIdx + 1);
      const tgt = chance(0.03) && provIdx > 0 ? provs[0]! : pick(later);
      return `${q}include:${tgt}`;
    }
    // a, mx, ptr and exists: bare (the CURRENT domain), with a host, with a macro of the current domain, with a name nobody published (a void lookup)
    if (k < 0.74) return `${q}a${pick(['', '', ':' + pick(hosts), ':' + self, ':%{d}', ':void' + Math.floor(R() * 3) + '.prov.test'])}${pick(['', '', '/24', '/30'])}`;
    if (k < 0.79) return `${q}mx${pick(['', ':' + self, ':%{d}', ':void' + Math.floor(R() * 3) + '.prov.test'])}${pick(['', '/24'])}`;
    if (k < 0.85) return `${q}exists:%{i}._e.${pick(['%{d}', self, '%{d}', pick(provs), 'void.prov.test'])}`;
    if (k < 0.87) return `${q}ptr${pick(['', ':' + self, ':%{d}'])}`;
    if (k < 0.88) return `${q}include:%{d}`;
    return `${q}ip4:${ip()}`;
  };
  provs.forEach((p, i) => {
    const n = 1 + Math.floor(R() * 5);
    const tokens = Array.from({ length: n }, (_, j) => term(p, j, i));
    const later = provs.slice(i + 1);
    const mods: string[] = [];
    if (chance(0.25) && later.length) mods.push(`redirect=${pick(later)}`);
    else { const a = allQ(); if (a) mods.push(a); }
    if (chance(0.15)) mods.push(`exp=${pick(['explain.' + p, '%{d}.explain.prov.test', 'explain.prov.test'])}`);
    if (chance(0.03) && later.length) mods.push(`redirect=${pick(later)}`); // twice: a permanent error for receivers
    if (chance(0.03)) mods.push('-all'); // an all next to a redirect, or a second all
    if (chance(0.02)) mods.push('foo:bar'); // not a mechanism: the record is invalid wherever it stands
    // modifiers and `all` stand anywhere in the record, not only at the end
    for (const m of mods) tokens.splice(chance(0.5) ? tokens.length : Math.floor(R() * (tokens.length + 1)), 0, m);
    w.txt.set(p, [`v=spf1 ${tokens.join(' ')}`, ...(chance(0.2) ? ['google-site-verification=xyz'] : [])]);
  });
  // The order of the lookups an included record makes: `redirect=` is evaluated after every mechanism, wherever it stands in the record
  // (RFC 7208 §6.1). The first provider answers from its own host; its redirect target only makes void lookups.
  const ordered = chance(0.1);
  if (ordered) {
    const tail = provs[provs.length - 1]!;
    w.txt.set(tail, [`v=spf1 a:void0.prov.test a:void1.prov.test mx:void2.prov.test ${pick(['', '-all', '~all'])}`.trim()]);
    const tokens = [`a:${pick(hosts)}`, `ip4:${ip()}`];
    tokens.splice(Math.floor(R() * 3), 0, `redirect=${tail}`);
    w.txt.set(provs[0]!, [`v=spf1 ${tokens.join(' ')}`]);
  }
  for (let k = 0; k < 60; k++) { const x = ip(); w.a.set(`${x}._e.${pick([...provs, 'customer.test'])}`, ['127.0.0.2']); }
  for (let k = 0; k < 30; k++) { const x = ip(); const h = `mail${k}.${pick([...provs, 'customer.test'])}`; w.ptr.set(x, [h]); if (chance(0.7)) w.a.set(h, [x]); }
  w.a.set('customer.test', [ip()]);
  w.mx.set('customer.test', [pick(hosts)]);
  const rootTerms: string[] = [];
  const nInc = 1 + Math.floor(R() * Math.min(6, provs.length));
  const shuffled = [...provs].sort(() => R() - 0.5).slice(0, nInc);
  if (ordered && !shuffled.includes(provs[0]!)) shuffled.push(provs[0]!);
  for (const p of shuffled) rootTerms.push(`${chance(0.9) ? '' : pick(['-', '~', '?'])}include:${p}`);
  for (let k = 0; k < Math.floor(R() * 3); k++) rootTerms.splice(Math.floor(R() * rootTerms.length), 0, term('customer.test', k, -1).replace(/include:.*/, `ip4:${ip()}`));
  rootTerms.sort(() => R() - 0.5);
  let root = `v=spf1 ${rootTerms.join(' ')}`;
  if (chance(0.3)) {
    // the customer hands over with redirect=, a chain of providers (they redirect on, see above); macros and bare a/mx/ptr are in their records
    const own = rootTerms.slice(0, Math.floor(R() * 3));
    own.splice(chance(0.5) ? own.length : Math.floor(R() * (own.length + 1)), 0, `redirect=${pick(provs)}`);
    root = `v=spf1 ${own.join(' ')}`;
  } else { const a = pick(['-all', '~all', '?all', '', '+all', '~all', '-all']); if (a) root += ` ${a}`; }
  if (chance(0.05)) root += ' foo=bar';
  if (chance(0.05)) root += ' exp=explain.customer.test';
  w.txt.set('customer.test', [root]);
  return { w, root, R };
}

/** The engine's resolver, answering TXT from the fake world (the engine reads nothing else). */
export function resolverOf(w: World): Resolver {
  return {
    async txt(name: string) {
      const t = w.txt.get(name.toLowerCase().replace(/\.$/, ''));
      if (t === 'SERVFAIL') return { status: 'error' as const, records: [], error: 'SERVFAIL' };
      if (!t) return { status: 'nxdomain' as const, records: [] };
      return { status: 'ok' as const, records: t };
    },
    async resolve() { throw new Error('the engine should only read TXT'); },
    fetch: async () => { throw new Error('no fetch'); },
  } as unknown as Resolver;
}
