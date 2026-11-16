import { describe, it, expect } from 'vitest';
import { entryCovered, flattenFromSource, type SpfFlatOptions, normalizeSpfRecord, sameSpfRecord, SPF_FLAT_MAX_BYTES } from '../src/spf-flatten';
import { fakeResolver, type Zone } from './helpers';
import { SpfEval, type World } from './spf-eval';

const txt = (...v: string[]) => v;
const ips = (n: number, pre: string) => Array.from({ length: n }, (_, i) => `ip4:${pre}.${i}.0/24`);
const flat = async (source: string, zone: Zone, opts: SpfFlatOptions = {}) => flattenFromSource('x.com', source, fakeResolver(zone), { inline: 'most', ...opts });
const okFlat = async (source: string, zone: Zone, opts: SpfFlatOptions = {}) => {
  const r = await flat(source, zone, opts);
  if (!r.ok) throw new Error(`refused: ${r.problems[0]!.message}`);
  return r.flat;
};
const refused = async (source: string, zone: Zone, opts: SpfFlatOptions = {}) => {
  const r = await flat(source, zone, opts);
  if (r.ok) throw new Error(`flattened to ${r.flat.record}`);
  return r.problems[0]!;
};

describe('flattening from the stored original (the atlas case)', () => {
  const source = 'v=spf1 include:mail.test -all';
  it('a provider changing its IPs changes the record; the same IPs give a record that compares equal', async () => {
    const before = await okFlat(source, { 'TXT mail.test': txt('v=spf1 ip4:198.51.100.0/28 -all') });
    expect(before.record).toBe('v=spf1 ip4:198.51.100.0/28 -all');
    const after = await okFlat(source, { 'TXT mail.test': txt('v=spf1 ip4:203.0.113.9 ip4:198.51.100.0/28 -all') });
    expect(after.record).toBe('v=spf1 ip4:203.0.113.9 ip4:198.51.100.0/28 -all');
    expect(sameSpfRecord(before.record, after.record)).toBe(false);
    const reordered = await okFlat(source, { 'TXT mail.test': txt('v=spf1 ip4:198.51.100.0/28 ip4:203.0.113.9 -all') });
    expect(sameSpfRecord(after.record, reordered.record)).toBe(true);
  });
  it('never reads a published record: the source answers for TXT at the domain', async () => {
    const f = await okFlat(source, { 'TXT x.com': txt('v=spf1 ip4:1.1.1.1 -all'), 'TXT mail.test': txt('v=spf1 ip4:2.2.2.2 -all') });
    expect(f.record).toBe('v=spf1 ip4:2.2.2.2 -all');
  });
});

describe('what is resolved', () => {
  it('follows nested includes, dedupes, keeps ip6 and the source\'s all', async () => {
    const f = await okFlat('v=spf1 include:a.test include:b.test mx ip4:9.9.9.9 -all', {
      'TXT a.test': txt('v=spf1 ip4:1.1.1.1 ip4:1.1.1.2 ip6:2001:db8::/32 ~all'),
      'TXT b.test': txt('v=spf1 ip4:1.1.1.1 include:c.test -all'),
      'TXT c.test': txt('v=spf1 ip4:3.3.3.3 -all'),
    });
    expect(f.record).toBe('v=spf1 ip4:1.1.1.1 ip4:1.1.1.2 ip6:2001:db8::/32 ip4:3.3.3.3 mx ip4:9.9.9.9 -all');
    expect(f.all).toBe('-all');
    expect(f.lookupsAfter).toBe(1);
    expect(f.lookupsBefore).toBe(4);
    expect(f.inlined).toEqual(['a.test', 'b.test']);
  });
  it('follows redirect= and takes its all (and ignores it when the record has an all)', async () => {
    const z: Zone = { 'TXT y.test': txt('v=spf1 ip4:2.2.2.2 -all') };
    expect((await okFlat('v=spf1 ip4:1.1.1.1 redirect=y.test', z)).record).toBe('v=spf1 ip4:1.1.1.1 ip4:2.2.2.2 -all');
    expect((await okFlat('v=spf1 ip4:1.1.1.1 ~all redirect=y.test', z)).record).toBe('v=spf1 ip4:1.1.1.1 ~all');
  });
  it('pins a bare a/mx taken from an include to the include\'s domain and keeps its cost', async () => {
    const f = await okFlat('v=spf1 include:vendor.test a -all', { 'TXT vendor.test': txt('v=spf1 a mx/24 ip4:1.1.1.1 -all') });
    expect(f.record).toBe('v=spf1 ip4:1.1.1.1 a:vendor.test mx:vendor.test/24 a -all');
    expect(f.lookupsAfter).toBe(3);
  });
  it('strips /32 and /128 and lowercases, so equal addresses dedupe', async () => {
    const f = await okFlat('v=spf1 ip4:1.1.1.1 include:a.test -all', { 'TXT a.test': txt('v=spf1 ip4:1.1.1.1/32 IP4:1.1.1.2 -all') });
    expect(f.record).toBe('v=spf1 ip4:1.1.1.1 ip4:1.1.1.2 -all');
  });
});

describe('never widens authorization', () => {
  it('an include with a non-+ ip term is kept as an include, not inlined as a pass (was: copied with its qualifier)', async () => {
    const z: Zone = { 'TXT a.test': txt('v=spf1 -ip4:1.1.1.4 ip4:1.1.1.0/24 -all'), 'TXT b.test': txt('v=spf1 ~ip4:2.2.2.2 ip4:2.2.0.0/16 -all') };
    const f = await okFlat('v=spf1 include:a.test include:b.test -all', z);
    expect(f.record).toBe('v=spf1 include:a.test include:b.test -all');
    expect(f.inlined).toEqual([]);
    expect(f.keptIncludes).toEqual(['a.test', 'b.test']);
  });
  it('an include that matches every sender (+all) or fails on a qualified term is kept', async () => {
    const f = await okFlat('v=spf1 include:a.test include:b.test ip4:9.9.9.9 -all', { 'TXT a.test': txt('v=spf1 ip4:1.1.1.1 +all'), 'TXT b.test': txt('v=spf1 -a ip4:2.2.2.2') });
    expect(f.keptIncludes).toEqual(['a.test', 'b.test']);
  });
  it('a ~include inside an include keeps the outer include; a non-+ include at the root stays as written', async () => {
    const f = await okFlat('v=spf1 include:a.test ~include:b.test -all', { 'TXT a.test': txt('v=spf1 ip4:1.1.1.1 ~include:c.test -all'), 'TXT b.test': txt('v=spf1 ip4:2.2.2.2 -all'), 'TXT c.test': txt('v=spf1 ip4:3.3.3.3 -all') });
    expect(f.record).toBe('v=spf1 include:a.test ~include:b.test -all');
  });
  it('a macro in a term that would be copied keeps the include (exists:%{d} means another domain once copied)', async () => {
    const f = await okFlat('v=spf1 include:a.test -all', { 'TXT a.test': txt('v=spf1 exists:%{i}._spf.a.test ip4:1.1.1.1 -all') });
    expect(f.record).toBe('v=spf1 include:a.test -all');
    expect(f.lookupsAfter).toBe(2);
  });
  it('a record with no all keeps no all (it is neutral; ~all would change that), and ?all stays ?all (was: ~all added)', async () => {
    const z: Zone = { 'TXT a.test': txt('v=spf1 ip4:1.1.1.1') };
    const none = await okFlat('v=spf1 include:a.test', z);
    expect(none.record).toBe('v=spf1 ip4:1.1.1.1');
    expect(none.all).toBeNull();
    expect((await okFlat('v=spf1 include:a.test ?all', z)).record).toBe('v=spf1 ip4:1.1.1.1 ?all');
  });
  it('root terms keep their qualifier and their place', async () => {
    const f = await okFlat('v=spf1 -ip4:1.1.1.4 include:a.test -all', { 'TXT a.test': txt('v=spf1 ip4:1.1.1.0/24 -all') });
    expect(f.record).toBe('v=spf1 -ip4:1.1.1.4 ip4:1.1.1.0/24 -all');
  });
});

describe('a resolution that fails is never a smaller record', () => {
  const source = 'v=spf1 include:a.test include:b.test -all';
  const good: Zone = { 'TXT a.test': txt('v=spf1 ip4:1.1.1.1 -all'), 'TXT b.test': txt('v=spf1 ip4:2.2.2.2 -all') };
  it.each([
    ['SERVFAIL', 'SERVFAIL' as const],
    ['no record', 'NODATA' as const],
    ['two records', txt('v=spf1 -all', 'v=spf1 -all')],
    ['a truncated answer (TC bit)', { tc: txt('v=spf1 ip4:2.2.2.2 -all') }],
  ])('%s: names the include and refuses', async (_n, v) => {
    const p = await refused(source, { ...good, 'TXT b.test': v });
    expect(p.kind).toBe('include_unresolved');
    expect(p.domain).toBe('b.test');
    expect(p.message).toMatch(/b\.test/);
  });
  it('loops, a bad address and a fetch bound are refused', async () => {
    expect((await refused('v=spf1 include:a.test -all', { 'TXT a.test': txt('v=spf1 include:x.com -all') })).message).toMatch(/include each other/);
    expect((await refused('v=spf1 include:a.test -all', { 'TXT a.test': txt('v=spf1 ip4:999.1.1.1 -all') })).message).toMatch(/not an address/);
    const wide: Zone = {};
    const names = Array.from({ length: 5 }, (_, i) => `n${i}.test`);
    for (const n of names) wide[`TXT ${n}`] = txt('v=spf1 ip4:1.1.1.1 -all');
    const p = await refused(`v=spf1 ${names.map(n => `include:${n}`).join(' ')} -all`, wide, { maxFetches: 3 });
    expect(p.message).toMatch(/nested too deeply/);
  });
  it('macros in an include or redirect target are refused plainly', async () => {
    const p = await refused('v=spf1 include:%{d}.spf.test -all', {});
    expect(p).toMatchObject({ kind: 'macro' });
    expect(p.message).toMatch(/macro/);
    expect((await refused('v=spf1 redirect=%{d}.spf.test', {})).kind).toBe('macro');
  });
  it('an include with no addresses at all is refused, never an empty record', async () => {
    expect((await refused('v=spf1 include:a.test -all', { 'TXT a.test': txt('v=spf1 -all') })).kind).toBe('no_addresses');
  });
  it('a record with no includes and no senders is left as it is', async () => {
    expect((await okFlat('v=spf1 ~all', {})).record).toBe('v=spf1 ~all');
  });
  it('a source that is not an SPF record is refused', async () => {
    expect((await refused('hello', {})).kind).toBe('include_unresolved');
  });
});

describe('selective flattening: within 10 lookups and 450 bytes', () => {
  // Google-like (3 nested netblocks), Outlook-like, SendGrid-like, Mailgun-like, and seven small providers: 14 lookups as written.
  const zone: Zone = {
    'TXT g.test': txt('v=spf1 include:g1.test include:g2.test include:g3.test ~all'),
    'TXT g1.test': txt(`v=spf1 ${ips(4, '10.1').join(' ')} ~all`),
    'TXT g2.test': txt(`v=spf1 ${ips(4, '10.2').join(' ')} ~all`),
    'TXT g3.test': txt(`v=spf1 ${ips(4, '10.3').join(' ')} ~all`),
    'TXT o.test': txt(`v=spf1 ${ips(14, '10.4').join(' ')} -all`),
    'TXT s.test': txt(`v=spf1 ${ips(20, '10.5').join(' ')} -all`),
    'TXT m.test': txt(`v=spf1 ${ips(29, '10.6').join(' ')} ~all`),
  };
  const smalls = Array.from({ length: 7 }, (_, i) => `x${i}.test`);
  for (const n of smalls) zone[`TXT ${n}`] = txt('v=spf1 ip4:192.0.2.1 -all');
  const source = `v=spf1 include:g.test include:o.test include:s.test include:m.test ${smalls.map(n => `include:${n}`).join(' ')} -all`;

  it('a full flatten of these providers is over 450 bytes; a selective one fits both limits', async () => {
    const full = await okFlat(source, zone, { inline: 'most', maxBytes: 100_000 });
    expect(full.bytes).toBeGreaterThan(SPF_FLAT_MAX_BYTES);
    expect(full.lookupsBefore).toBe(14);
    const f = await okFlat(source, zone, { inline: 'fewest' });
    expect(f.bytes).toBeLessThanOrEqual(SPF_FLAT_MAX_BYTES);
    expect(f.lookupsAfter).toBeLessThanOrEqual(10);
    expect(f.inlined).toEqual(['g.test']); // the fewest inlined: g.test alone saves 4 lookups
    expect(f.keptIncludes).toContain('m.test');
    expect(f.record).toContain('include:m.test');
    expect(f.record.startsWith('v=spf1 ip4:10.1.0.0/24')).toBe(true);
    expect(f.record.endsWith(' -all')).toBe(true);
  });
  it('among subsets of the same size it takes the one with the fewest bytes', async () => {
    // 11 lookups as written; inlining any one include saves at least 1: the smallest provider wins.
    const f = await okFlat(`v=spf1 include:o.test include:s.test ${[...smalls, 'x7.test', 'x8.test'].map(n => `include:${n}`).join(' ')} -all`,
      { ...zone, 'TXT x7.test': txt('v=spf1 ip4:192.0.2.1 -all'), 'TXT x8.test': txt('v=spf1 ip4:192.0.2.1 -all') }, { inline: 'fewest' });
    expect(f.lookupsAfter).toBeLessThanOrEqual(10);
    expect(f.inlined.length).toBe(1);
    expect(f.inlined[0]).toMatch(/^x\d\.test$/);
  });
  it('nothing fits: refused with one sentence naming what the best choice would need', async () => {
    const big = (pre: string) => txt(`v=spf1 ${ips(30, pre).join(' ')} -all`);
    const z: Zone = { 'TXT p1.test': big('10.7'), 'TXT p2.test': big('10.8'), 'TXT p3.test': big('10.9') };
    const p = await refused('v=spf1 include:p1.test include:p2.test include:p3.test mx a ptr exists:x.test a:y.test mx:z.test a:w.test mx:v.test a:u.test -all', z);
    expect(p.kind).toBe('too_large');
    expect(p.message).toMatch(/lookups? and \d+ bytes/);
    expect(p.message).toMatch(/left it as it is/);
  });
  it('an include that cannot be inlined keeps its lookups, and when they exceed 10 nothing fits', async () => {
    const z: Zone = {};
    const names = Array.from({ length: 11 }, (_, i) => `u${i}.test`);
    for (const n of names) z[`TXT ${n}`] = txt('v=spf1 -ip4:1.1.1.1 ip4:1.1.1.0/24 -all');
    expect((await refused(`v=spf1 ${names.map(n => `include:${n}`).join(' ')} -all`, z)).kind).toBe('too_large');
  });
  it('more than 12 flattenable includes is refused', async () => {
    const z: Zone = {};
    const names = Array.from({ length: 13 }, (_, i) => `v${i}.test`);
    for (const n of names) z[`TXT ${n}`] = txt('v=spf1 ip4:1.1.1.1 -all');
    const p = await refused(`v=spf1 ${names.map(n => `include:${n}`).join(' ')} -all`, z);
    expect(p.message).toMatch(/13 includes/);
  });
  it('a record already within both limits is left as it is (no include inlined)', async () => {
    const f = await okFlat('v=spf1 include:a.test -all', { 'TXT a.test': txt('v=spf1 ip4:1.1.1.1 -all') }, { inline: 'fewest' });
    expect(f.record).toBe('v=spf1 include:a.test -all');
    expect(f.inlined).toEqual([]);
    expect((await okFlat('v=spf1 include:a.test -all', { 'TXT a.test': txt('v=spf1 ip4:1.1.1.1 -all') }, { inline: 'most' })).record).toBe('v=spf1 ip4:1.1.1.1 -all');
  });
  it('the choice is recomputed from the original: a kept include that grows changes it', async () => {
    const small = (n: number): Zone => ({ ...zone, 'TXT m.test': txt(`v=spf1 ${ips(n, '10.6').join(' ')} ~all`) });
    const src = `v=spf1 include:g.test include:o.test include:m.test ${smalls.slice(0, 7).map(n => `include:${n}`).join(' ')} -all`; // 4+1+1+7 = 13 lookups
    const a = await okFlat(src, small(3), { inline: 'fewest' });
    expect(a.inlined).toEqual(['g.test']);
    const b = await okFlat(src, { ...small(3), 'TXT g1.test': txt(`v=spf1 ${ips(60, '10.1').join(' ')} ~all`) }, { inline: 'fewest' });
    expect(b.inlined).not.toEqual(['g.test']);
  });
});

describe('comparing records', () => {
  it('ignores order, case, quotes and spacing', () => {
    expect(sameSpfRecord('v=spf1 ip4:1.1.1.1 ip4:2.2.2.2 -all', '"V=SPF1  IP4:2.2.2.2 ip4:1.1.1.1 -all"')).toBe(true);
    expect(sameSpfRecord('v=spf1 ip4:1.1.1.1 -all', 'v=spf1 ip4:1.1.1.1 ~all')).toBe(false);
    expect(sameSpfRecord(null, 'v=spf1 -all')).toBe(false);
    expect(normalizeSpfRecord('"v=spf1 exists:%{I}.X.test -all"')).toBe('v=spf1 exists:%{I}.X.test -all');
  });
});

// What flattening never changes: one test per case in docs/spf-flattening.md ("What flattening never changes").
describe('audit: what a term means once it moves into the customer\'s record', () => {
  const macroRefusal = (domain: string) => `The record of ${domain}, which your record hands over to with redirect=, uses a macro that depends on that name, so it cannot be copied into your record.`;

  it('a macro in a term of a redirect target is refused, for every mechanism that takes one (RFC 7208 §6.1, §7.3: %{d} is the target)', async () => {
    for (const term of ['exists:%{i}._spf.%{d}', 'a:%{d}', 'mx:%{d}/24', '-exists:%{i}._e.%{d}', 'ptr:%{d}', 'a:%{l}.%{d}']) {
      const p = await refused('v=spf1 ip4:1.1.1.1 redirect=t.test', { 'TXT t.test': txt(`v=spf1 ${term} -all`) });
      expect([term, p.kind]).toEqual([term, 'macro']);
      expect(p.message).toBe(macroRefusal('t.test'));
    }
  });
  it('...at any depth of the redirect chain, and in a bare include target there', async () => {
    const z: Zone = { 'TXT t1.test': txt('v=spf1 ip4:2.2.2.2 redirect=t2.test'), 'TXT t2.test': txt('v=spf1 ip4:3.3.3.3 redirect=t3.test'), 'TXT t3.test': txt('v=spf1 a:%{d} -all') };
    expect(await refused('v=spf1 redirect=t1.test', z)).toMatchObject({ kind: 'macro', domain: 't3.test', message: macroRefusal('t3.test') });
    expect(await refused('v=spf1 redirect=t.test', { 'TXT t.test': txt('v=spf1 include:%{d}.x.test -all') })).toMatchObject({ kind: 'macro' });
  });
  it('a macro in the customer\'s own record stays as written: %{d} is the customer\'s domain there', async () => {
    const f = await okFlat('v=spf1 exists:%{i}._spf.%{d} include:a.test -all', { 'TXT a.test': txt('v=spf1 ip4:1.1.1.1 -all') });
    expect(f.record).toBe('v=spf1 exists:%{i}._spf.%{d} ip4:1.1.1.1 -all');
  });
  it('a macro in an included record keeps the include (its %{d} is the include\'s domain, never ours)', async () => {
    const f = await okFlat('v=spf1 include:a.test -all', { 'TXT a.test': txt('v=spf1 ip4:1.1.1.1 exists:%{i}.%{d} -all') });
    expect(f.record).toBe('v=spf1 include:a.test -all');
  });
  it('a bare a, mx or ptr in a redirect target is written with the target\'s name (§5.3 to §5.5 default to the current domain, §6.1)', async () => {
    const f = await okFlat('v=spf1 ip4:1.1.1.1 redirect=t.test', { 'TXT t.test': txt('v=spf1 a mx/24 ptr -a//64 -all') });
    expect(f.record).toBe('v=spf1 ip4:1.1.1.1 a:t.test mx:t.test/24 ptr:t.test -a:t.test//64 -all');
  });
  it('a bare a, mx or ptr in an included record is written with the include\'s name, also when it is reached through that record\'s redirect', async () => {
    const f = await okFlat('v=spf1 include:v.test -all', { 'TXT v.test': txt('v=spf1 a ip4:1.1.1.1 redirect=w.test'), 'TXT w.test': txt('v=spf1 mx ptr -all') });
    expect(f.record).toBe('v=spf1 ip4:1.1.1.1 a:v.test mx:w.test ptr:w.test -all');
  });
  it('exists always names its domain (§5.7); without a macro it moves unchanged, without a domain the record is refused', async () => {
    const f = await okFlat('v=spf1 redirect=t.test', { 'TXT t.test': txt('v=spf1 exists:check.vendor.test -all') });
    expect(f.record).toBe('v=spf1 exists:check.vendor.test -all');
    expect((await refused('v=spf1 redirect=t.test', { 'TXT t.test': txt('v=spf1 exists -all') })).kind).toBe('include_unresolved');
  });
  it('a redirect target\'s +all, qualified terms and own all keep their order and qualifier at the top', async () => {
    const f = await okFlat('v=spf1 ~ip4:9.9.9.9 redirect=t.test', { 'TXT t.test': txt('v=spf1 -ip4:1.1.1.1 ip4:1.1.0.0/16 ?mx +all') });
    expect(f.record).toBe('v=spf1 ~ip4:9.9.9.9 -ip4:1.1.1.1 ip4:1.1.0.0/16 ?mx:t.test all');
  });
  it('the customer\'s redirect is ignored when the record has an all anywhere, also after it (§6.1)', async () => {
    const f = await okFlat('v=spf1 redirect=t.test ip4:1.1.1.1 -all', { 'TXT t.test': txt('v=spf1 ip4:2.2.2.2 -all') });
    expect(f.record).toBe('v=spf1 ip4:1.1.1.1 -all');
  });
  it('terms after all are never evaluated and are dropped; a modifier after all still counts', async () => {
    const f = await okFlat('v=spf1 ip4:1.1.1.1 -all ip4:2.2.2.2 include:nope.test exp=why.example.test', {});
    expect(f.record).toBe('v=spf1 ip4:1.1.1.1 -all exp=why.example.test');
  });
  it('a record with a syntax error anywhere, also after all, is refused: receivers give a permanent error for the whole record (§4.6)', async () => {
    expect((await refused('v=spf1 ip4:1.1.1.1 -all foo:bar', {})).kind).toBe('include_unresolved');
    expect((await refused('v=spf1 ip4:1.1.1.1 -all ip4:300.1.1.1', {})).kind).toBe('include_unresolved');
    expect((await refused('v=spf1 include:a.test -all', { 'TXT a.test': txt('v=spf1 ip4:1.1.1.1 -all bogus:x') })).kind).toBe('include_unresolved');
    expect((await refused('v=spf1 ip4:1.1.1.1 redirect=a.test redirect=b.test', {})).message).toMatch(/more than one redirect=/);
    expect((await refused('v=spf1 ip4:1.1.1.1 exp=a.test exp=b.test -all', {})).message).toMatch(/more than one exp=/);
  });
  it('exp= changes only the explanation: the customer\'s is kept, a redirect target\'s is carried when the customer has none and it has no macro', async () => {
    expect((await okFlat('v=spf1 redirect=t.test exp=mine.test', { 'TXT t.test': txt('v=spf1 ip4:2.2.2.2 -all exp=theirs.test') })).record).toBe('v=spf1 ip4:2.2.2.2 -all exp=mine.test');
    expect((await okFlat('v=spf1 redirect=t.test', { 'TXT t.test': txt('v=spf1 ip4:2.2.2.2 -all exp=theirs.test') })).record).toBe('v=spf1 ip4:2.2.2.2 -all exp=theirs.test');
    expect((await okFlat('v=spf1 redirect=t.test', { 'TXT t.test': txt('v=spf1 ip4:2.2.2.2 -all exp=%{d}.theirs.test') })).record).toBe('v=spf1 ip4:2.2.2.2 -all');
  });
  it('an include\'s own redirect is followed after its mechanisms, wherever the modifier stands (§6.1), so the lookups keep their order', async () => {
    const f = await okFlat('v=spf1 include:v.test -all', { 'TXT v.test': txt('v=spf1 redirect=w.test a:good.test ip4:1.1.1.1'), 'TXT w.test': txt('v=spf1 a:void.test -all') });
    expect(f.record).toBe('v=spf1 ip4:1.1.1.1 a:good.test a:void.test -all');
  });
  it('pinned lookups use the names the original used, in the original order, so the flattened record never makes a void lookup the original would not (§4.6.4)', async () => {
    const zone = {
      'customer.test': 'v=spf1 include:v.test -all',
      'v.test': 'v=spf1 redirect=w.test a:good.test',
      'w.test': 'v=spf1 a:v1.test a:v2.test a:v3.test -all',
    };
    const world: World = { txt: new Map(Object.entries(zone).map(([k, v]) => [k, [v]])), a: new Map([['good.test', ['192.0.2.7']]]), mx: new Map(), ptr: new Map() };
    const f = await okFlat(zone['customer.test'], Object.fromEntries(Object.entries(zone).map(([k, v]) => [`TXT ${k}`, [v]])));
    const o = new SpfEval(world, '192.0.2.7', false);
    const n = new SpfEval(world, '192.0.2.7', true);
    expect([o.check('customer.test'), n.check('customer.test', f.record)]).toEqual(['pass', 'pass']);
    expect(n.voids).toBeLessThanOrEqual(o.voids);
  });
  it('void lookups: a pinned a:/mx: whose name has no record is looked up where, and only if, the original looked it up', async () => {
    const f = await okFlat('v=spf1 ip4:1.1.1.1 include:v.test -all', { 'TXT v.test': txt('v=spf1 ip4:2.2.2.2 mx a -all') });
    expect(f.record).toBe('v=spf1 ip4:1.1.1.1 ip4:2.2.2.2 mx:v.test a:v.test -all');
    expect(f.lookupsAfter).toBe(2); // the same two lookups the include cost, minus the include itself
  });
});

describe('what a refresh would take away (previous, removed, held)', () => {
  const zone = (a: string, b = 'v=spf1 ip4:2.2.2.2 -all'): Zone => ({ 'TXT a.test': txt(a), 'TXT b.test': txt(b) });
  const src = 'v=spf1 include:a.test include:b.test -all';
  const first = async (z: Zone) => okFlat(src, z);

  it('reports what each inlined include contributes', async () => {
    const f = await first(zone('v=spf1 ip4:1.1.1.1 ip6:2001:db8::/32 a -all'));
    expect(f.providers).toEqual({ 'a.test': ['ip4:1.1.1.1', 'ip6:2001:db8::/32', 'a:a.test'], 'b.test': ['ip4:2.2.2.2'] });
    expect(f.removed).toEqual({});
    expect(f.held).toBeNull();
  });
  it('an address the provider stopped listing is removed; the held record keeps it and the new ones', async () => {
    const before = await first(zone('v=spf1 ip4:1.1.1.1 ip4:1.1.1.2 -all'));
    const f = await okFlat(src, zone('v=spf1 ip4:1.1.1.2 ip4:9.9.9.9 -all'), { previous: before.providers });
    expect(f.removed).toEqual({ 'a.test': ['ip4:1.1.1.1'] });
    expect(f.record).toBe('v=spf1 ip4:1.1.1.2 ip4:9.9.9.9 ip4:2.2.2.2 -all');
    expect(f.held).toMatchObject({ record: 'v=spf1 ip4:1.1.1.2 ip4:9.9.9.9 ip4:1.1.1.1 ip4:2.2.2.2 -all', fits: true });
    expect(f.held!.providers['a.test']).toEqual(['ip4:1.1.1.2', 'ip4:9.9.9.9', 'ip4:1.1.1.1']);
  });
  it('a provider that lists nothing now loses every address: all of them are removed', async () => {
    const before = await first(zone('v=spf1 ip4:1.1.1.1 ip4:1.1.1.2 -all'));
    const f = await okFlat(src, zone('v=spf1 -all'), { previous: before.providers });
    expect(f.removed).toEqual({ 'a.test': ['ip4:1.1.1.1', 'ip4:1.1.1.2'] });
    expect(f.record).toBe('v=spf1 ip4:2.2.2.2 -all');
    expect(f.held!.record).toBe('v=spf1 ip4:1.1.1.1 ip4:1.1.1.2 ip4:2.2.2.2 -all');
  });
  it('an address a new range covers is not removed (equal or wider range, same kind)', async () => {
    const before = await first(zone('v=spf1 ip4:10.0.1.0/24 ip4:10.0.1.5 ip6:2001:db8:1::/48 -all'));
    const f = await okFlat(src, zone('v=spf1 ip4:10.0.0.0/23 ip6:2001:db8::/32 -all'), { previous: before.providers });
    expect(f.removed).toEqual({});
    const g = await okFlat(src, zone('v=spf1 ip4:10.0.1.0/25 ip6:2001:db8:1::/48 -all'), { previous: before.providers });
    expect(g.removed).toEqual({ 'a.test': ['ip4:10.0.1.0/24'] }); // half of a /24 does not cover it; 10.0.1.5 is inside the /25
  });
  it('an include that is kept as an include is authorised live: nothing of it is removed', async () => {
    const before = await okFlat(src, zone('v=spf1 ip4:1.1.1.1 -all'));
    const f = await okFlat(src, zone('v=spf1 ip4:1.1.1.1 -all'), { previous: { ...before.providers, 'c.test': ['ip4:3.3.3.3'] } });
    expect(f.removed).toEqual({}); // c.test is not in the source: nothing to take away from it
    const kept = await okFlat('v=spf1 include:a.test -include:b.test -all', zone('v=spf1 ip4:7.7.7.7 -all'), { previous: { 'b.test': ['ip4:2.2.2.2'], 'a.test': ['ip4:1.1.1.1'] } });
    expect(kept.keptIncludes).toEqual(['b.test']);
    expect(kept.removed).toEqual({ 'a.test': ['ip4:1.1.1.1'] }); // a.test is inlined and changed; b.test is kept
  });
  it('held says when the combined record does not fit', async () => {
    const old = Array.from({ length: 12 }, (_, i) => `ip4:10.1.${i}.0/24`);
    const before = await first(zone(`v=spf1 ${old.join(' ')} -all`));
    const fresh = Array.from({ length: 20 }, (_, i) => `ip4:10.2.${i}.0/24`);
    const f = await okFlat(src, zone(`v=spf1 ${fresh.join(' ')} -all`), { previous: before.providers });
    expect(f.removed).toEqual({ 'a.test': old });
    expect(f.bytes).toBeLessThanOrEqual(450);
    expect(f.held!.fits).toBe(false);
    expect(f.held!.bytes).toBeGreaterThan(450);
  });
});

describe('entryCovered', () => {
  it('reads IPv4 and IPv6 ranges, including :: and a dotted tail', () => {
    expect(entryCovered(['ip4:10.0.0.0/8'], 'ip4:10.2.3.4')).toBe(true);
    expect(entryCovered(['ip4:10.2.3.4'], 'ip4:10.2.3.0/24')).toBe(false);
    expect(entryCovered(['ip4:10.2.3.0/24'], 'ip4:10.2.3.0/24')).toBe(true);
    expect(entryCovered(['ip6:2001:db8::/32'], 'ip6:2001:db8:ffff::1')).toBe(true);
    expect(entryCovered(['ip6:2001:db8::/32'], 'ip6:2001:db9::')).toBe(false);
    expect(entryCovered(['ip6:::ffff:1.2.3.4'], 'ip6:0:0:0:0:0:ffff:102:304')).toBe(true);
    expect(entryCovered(['ip6:::/0'], 'ip6:fe80::1')).toBe(true);
    expect(entryCovered(['ip4:0.0.0.0/0'], 'ip6:fe80::1')).toBe(false); // another kind
    expect(entryCovered(['a:v.test'], 'a:v.test')).toBe(true);
    expect(entryCovered(['a:v.test'], 'mx:v.test')).toBe(false);
  });
});
