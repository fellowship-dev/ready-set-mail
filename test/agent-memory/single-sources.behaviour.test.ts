import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ALLOW_BEHAVIOUR, BEHAVIOUR_OWNERS, buildsIpTermsFromDns, flattensSpf, resolvesIncludes } from './single-sources.behaviour';
import { DIRS, ROOT, sources, stripComments } from './single-sources.scan';

// The behaviour guard (docs/single-sources.md, "SPF flattening: what a module does"): a module outside the engine that resolves the targets of
// include: / redirect= or builds ip4: / ip6: terms from DNS answers fails, whatever it is called. The signatures are in single-sources.behaviour.ts.

const MAP = 'docs/single-sources.md';
const LIST_FILE = 'test/agent-memory/single-sources.behaviour.ts';
const files = DIRS.flatMap(d => sources(join(ROOT, d))).map(p => ({ path: relative(ROOT, p).split('\\').join('/'), text: stripComments(readFileSync(p, 'utf8')) }));

describe('the signatures', () => {
  const second = [
    // the reviewer's second flattener: resolves include targets and builds address terms
    `export async function flattenSpf2(d: string, r: Resolver) { for (const t of parseSpfTerms(rec)) { if (t.name === 'include') { const x = await r.txt(t.value!); out.push(...x.records) } } }`,
    // by pattern, with another resolver
    `const m = /include:(\\S+)/i.exec(rec); const answer = await doh.txt(m![1]);`,
    // builds terms from addresses a DNS read returned
    'const addrs = await resolver.resolve(host, "A"); return addrs.map(a => `ip4:${a}`).join(" ");',
    `const answers = await queryTxt(name); return "ip6:" + answers[0];`,
  ];
  it('match a second flattener, however it is spelled', () => {
    for (const code of second) expect(flattensSpf(code), code).toBe(true);
  });
  it('do not match the record parser, display code, a fixed example or a record that is only built from a known address', () => {
    const parser = `export function parseSpfTerms(raw: string) { for (const token of raw.split(' ')) { if (name === 'a' || name === 'mx') { /* ... */ } if (m[1] === 'ip4') {} } }`;
    const display = 'const note = `add include:${host} to your record`; const row = { type: "TXT", value: "v=spf1 include:_spf.google.com ~all" };';
    const limiter = 'return { client: `ip4:${v4.join(".")}`, network: `ip4:${v4.slice(0, 3).join(".")}.0/24` };';
    const include = `const has = parseSpfTerms(raw).filter(t => t.name === 'include');`;
    for (const code of [parser, display, limiter, include]) expect(flattensSpf(code), code).toBe(false);
    expect(resolvesIncludes(limiter)).toBe(false);
    expect(buildsIpTermsFromDns(display)).toBe(false);
  });
});

describe('single source: SPF flattening is what the engine does, not what a name says', () => {
  const owners = new Set(BEHAVIOUR_OWNERS);
  const allowed = new Set(ALLOW_BEHAVIOUR.map(a => a.file));
  it('no module outside the engine and the TXT codec resolves include targets or builds address terms from DNS', () => {
    const strays = files.filter(f => flattensSpf(f.text) && !owners.has(f.path) && !allowed.has(f.path));
    if (strays.length) throw new Error('\n' + strays.map(f => [
      `NEW module that ${resolvesIncludes(f.text) ? 'resolves the targets of include:/redirect=' : 'builds ip4:/ip6: terms from DNS answers'}: ${f.path}`,
      '  SPF flattening has one engine: packages/dns-checks/src/spf-flatten.ts (flattenFromSource), called by src/spf/refresh.ts. Call it or extend it there.',
      `  If this module reads and reports but never builds a record, add an ALLOW_BEHAVIOUR entry ({ file, reason, by, date }) in ${LIST_FILE} and say so in "${MAP}".`,
    ].join('\n')).join('\n') + '\n');
  });
  it('every allowance is complete and still needed', () => {
    const today = new Date().toISOString().slice(0, 10);
    const problems = ALLOW_BEHAVIOUR.flatMap(a => {
      const f = files.find(x => x.path === a.file);
      const out: string[] = [];
      if (!f) out.push(`${a.file} is not a production file`);
      else if (!flattensSpf(f.text)) out.push(`${a.file} no longer matches: delete this entry`);
      if (BEHAVIOUR_OWNERS.includes(a.file)) out.push(`${a.file} is an owner already: delete this entry`);
      if (a.reason.trim().split(/\s+/).length < 8) out.push('reason must say why in at least eight words');
      if (!/[\p{L}\p{N}]/u.test(a.by)) out.push('by must name who agreed');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(a.date) || a.date > today) out.push(`date ${a.date} is not a real date on or before today`);
      return out.map(p => `ALLOW_BEHAVIOUR ${a.file} in ${LIST_FILE}: ${p}`);
    });
    if (problems.length) throw new Error('\n' + problems.join('\n') + '\n');
  });
  it('the owners exist and are named in docs/single-sources.md together with every allowance', () => {
    const map = readFileSync(join(ROOT, MAP), 'utf8');
    for (const o of BEHAVIOUR_OWNERS) expect(files.some(f => f.path === o), o).toBe(true);
    for (const a of ALLOW_BEHAVIOUR) expect(map, `${a.file} in ${MAP}`).toContain(a.file);
    expect(map).toContain('SPF flattening: what a module does');
  });
});
