import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ALLOW, LIST_FILE, MUST_NOT_GROW, SINGLE, type Allow } from './single-sources.lists';

// "There is exactly one of these" (docs/single-sources.md), enforced. The lists and the escape hatch are in
// test/agent-memory/single-sources.lists.ts; this file scans the code and explains every failure.

const ROOT = join(__dirname, '../..');
const MAP = 'docs/single-sources.md';

/** Production code: these folders, without tests, fixtures, mocks or build output. Nothing else is scanned. */
export const DIRS = ['src', 'web/src', 'packages/db/src', 'packages/dns-checks/src', 'packages/report/src', 'packages/ui/src', 'scripts', 'tools', 'plugins'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'test', 'tests', '__tests__', '__fixtures__', 'fixtures', '__mocks__', 'e2e']);
export const isProduction = (name: string): boolean => /\.(ts|tsx|mts|mjs|js|cjs)$/.test(name) && !/\.(test|spec|stories|fixture)\./.test(name) && !name.endsWith('.d.ts');

function sources(dir: string): string[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  return names.flatMap(name => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return SKIP_DIRS.has(name) ? [] : sources(p);
    return isProduction(name) ? [p] : [];
  });
}

/** Blanks full-line comments, block comments that start a line, and trailing `// …` comments (not `https://`). Keeps line numbers. */
export function stripComments(text: string): string {
  let inBlock = false;
  return text.split('\n').map(line => {
    const s = line.trim();
    if (inBlock) { if (s.includes('*/')) inBlock = false; return ''; }
    if (s.startsWith('/*') && !s.includes('*/')) { inBlock = true; return ''; }
    if (s.startsWith('//') || s.startsWith('*') || (s.startsWith('/*') && s.endsWith('*/'))) return '';
    return line.replace(/(^|\s)\/\/(\s.*)?$/, '');
  }).join('\n');
}

const files = DIRS.flatMap(d => sources(join(ROOT, d))).map(p => ({ path: relative(ROOT, p).split('\\').join('/'), text: stripComments(readFileSync(p, 'utf8')) }));

/** The first line of `text` the signature matches, as `path:line: code`, or null. Multi-line signatures report the match start. */
function firstHit(path: string, text: string, signature: RegExp): string | null {
  const re = new RegExp(signature.source, signature.flags.replace('g', ''));
  const m = re.exec(text);
  if (!m) return null;
  const line = text.slice(0, m.index).split('\n').length;
  return `${path}:${line}: ${text.split('\n')[line - 1].trim().slice(0, 140)}`;
}
const sitesOf = (signature: RegExp) => files.flatMap(f => { const hit = firstHit(f.path, f.text, signature); return hit ? [{ path: f.path, hit }] : []; });
const allowed = (concept: string) => new Set(ALLOW.filter(a => a.concept === concept).map(a => a.file));
const ownedBy = (owners: string[], p: string) => owners.some(o => (o.endsWith('/') ? p.startsWith(o) : p === o));

const fail = (lines: string[]) => { if (lines.length) throw new Error(`\n${lines.join('\n')}\n`); };

describe('the comment stripper', () => {
  it('drops comments, keeps URLs in code and keeps line numbers', () => {
    const out = stripComments('// api.stripe.com\nconst a = 1; // api.stripe.com\n/* x\n api.stripe.com */\n * api.stripe.com');
    expect(out).not.toMatch(/stripe/);
    expect(out.split('\n')).toHaveLength(5);
    expect(stripComments("const u = 'https://api.stripe.com';")).toMatch(/api\.stripe\.com/);
  });
  it('scans production code only', () => {
    expect(isProduction('charge.ts')).toBe(true);
    expect(isProduction('charge.test.ts')).toBe(false);
    expect(isProduction('charge.spec.tsx')).toBe(false);
    expect(isProduction('env.d.ts')).toBe(false);
    expect(files.some(f => /(^|\/)(test|tests|__fixtures__|fixtures|__mocks__)\//.test(f.path))).toBe(false);
  });
});

describe('production code does not import tests, fixtures or mocks (so skipping them hides nothing that ships)', () => {
  it('no import from a test, fixture or mock folder', () => {
    const bad = files.flatMap(f => {
      const hit = firstHit(f.path, f.text, /(?:from\s+|import\(\s*|require\(\s*)['"][^'"]*\/(?:test|tests|__tests__|__fixtures__|fixtures|__mocks__)\/[^'"]*['"]/);
      return hit ? [`${hit}\n  production code imports a test-only folder; the guards do not scan those folders, so move the code into production source.`] : [];
    });
    fail(bad);
  });
});

describe('single sources: one module each', () => {
  for (const s of SINGLE) {
    it(s.concept, () => {
      const ok = allowed(s.concept);
      const strays = sitesOf(s.signature).filter(x => !ownedBy(s.owners, x.path) && !ok.has(x.path));
      fail(strays.map(x => [
        `NEW site of "${s.concept}": ${x.hit}`,
        `  This concept has one module: ${s.owners.join(', ')}. Call it or extend it there instead.`,
        `  If this file really is a second owner, add it to \`owners\` of "${s.concept}" in ${LIST_FILE} and to the "One module each" row in ${MAP}, in this pull request;`,
        `  for a reviewed exception, add an ALLOW entry ({ concept, file, reason, by, date }) in ${LIST_FILE}.`,
      ].join('\n')));
    });
  }
});

describe('known duplicates: must not grow (docs/single-sources.md)', () => {
  for (const d of MUST_NOT_GROW) {
    it(d.concept, () => {
      const ok = allowed(d.concept);
      const found = sitesOf(d.signature).filter(x => !ok.has(x.path));
      const added = found.filter(x => !d.sites.includes(x.path));
      const gone = d.sites.filter(p => !found.some(x => x.path === p));
      const out: string[] = [];
      for (const x of added) {
        out.push(
          `NEW site of "${d.concept}": ${x.hit}`,
          `  Do not add another copy: call or extend the authoritative one (${d.authoritative}).`,
          gone.length ? `  If this is ${gone.join(' or ')} renamed or moved, replace that path with ${x.path} in \`sites\` of "${d.concept}" in ${LIST_FILE} and in "Sites, by concept" in ${MAP}.`
            : `  If the change is the consolidation itself, update \`sites\` of "${d.concept}" in ${LIST_FILE}, and the count and "Sites, by concept" in ${MAP}; for a reviewed exception, add an ALLOW entry in ${LIST_FILE}.`,
        );
      }
      for (const p of gone) {
        if (added.length) continue; // reported with the new site as a likely rename
        out.push(
          `GONE: ${p} no longer contains "${d.concept}" (or no longer exists).`,
          `  If it moved, put the new path in \`sites\` in ${LIST_FILE}; if it was consolidated, delete it there. Update the count and "Sites, by concept" in ${MAP} to match.`,
        );
      }
      fail(out);
    });
  }
});

describe('the signatures catch every spelling', () => {
  const registrable = SINGLE.find(x => x.concept === 'Registrable domain (never "last two labels")')!.signature;
  for (const code of ["labels.slice(-2).join('.')", 'labels.slice(-2).join(".")', 'labels.slice(-2).join(`.`)', 'labels.slice(-2).join( "." )']) {
    it(`registrable domain: ${code}`, () => expect(registrable.test(code)).toBe(true));
  }
  it('registrable domain: a join by another character is not the construct', () => expect(registrable.test('labels.slice(-2).join("-")')).toBe(false));
  const verdict = SINGLE.find(x => x.concept === 'DMARC verdict of a stored record')!.signature;
  it('DMARC verdict: both columns 0, with or without an alias', () => {
    expect(verdict.test('rr.spf_aligned = 0 AND rr.dkim_aligned = 0')).toBe(true);
    expect(verdict.test('spf_aligned = 0 AND dkim_aligned = 0')).toBe(true);
  });
});

describe('the effective-policy and alignment signatures catch every spelling', () => {
  const eff = MUST_NOT_GROW.find(x => x.concept.startsWith('Effective DMARC policy rule'))!.signature;
  for (const code of ["t['sp'] ?? t['p']", "const policy = sp ?? p;", "tags.get('sp') || tags.get('p')", "(d.sp || policy).toLowerCase()", "const x = sp ? sp : p;", "pol['sp'] ?? pol['p']"]) {
    it(`sp then p: ${code}`, () => expect(eff.test(code)).toBe(true));
  }
  it('sp= read on its own is not the fallback', () => {
    for (const code of ["set.dmarc_sp = r.dmarc.sp ?? null;", "sp?: string | null", "broken.sp ?? ''"]) expect(eff.test(code), code).toBe(false);
  });
  const align = SINGLE.find(x => x.concept.startsWith('Alignment rule'))!.signature;
  for (const code of ['sameOrganizationalDomain(a, b)', 'organizationalDomain(a) === organizationalDomain(b)', 'organizationalDomain(x) !== organizationalDomain(y)']) {
    it(`copied alignment: ${code}`, () => expect(align.test(code)).toBe(true));
  }
  it('aligned() is the way', () => expect(align.test("aligned(a, b, 'r')")).toBe(false));
});

describe('the escape hatch (ALLOW)', () => {
  const concepts = new Map([...SINGLE.map(s => [s.concept, s.signature] as const), ...MUST_NOT_GROW.map(d => [d.concept, d.signature] as const)]);
  const today = new Date().toISOString().slice(0, 10);
  const realDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
  const problems = (a: Allow): string[] => {
    const out: string[] = [];
    const sig = concepts.get(a.concept);
    if (!sig) out.push(`concept "${a.concept}" is not a guarded concept`);
    if (a.reason.trim().length < 20 || a.reason.trim().split(/\s+/).length < 4) out.push('reason must say why in at least 20 characters and four words');
    if (!/[\p{L}\p{N}]/u.test(a.by)) out.push('by must name who agreed');
    if (!realDate(a.date) || a.date > today) out.push(`date ${a.date} is not a real date on or before today`);
    const f = files.find(x => x.path === a.file);
    if (!f) out.push(`${a.file} is not a production file`);
    else if (sig && !firstHit(f.path, f.text, sig)) out.push(`${a.file} no longer matches: delete this entry`);
    const s = SINGLE.find(x => x.concept === a.concept);
    if (s && ownedBy(s.owners, a.file)) out.push(`${a.file} is an owner already: delete this entry`);
    if (MUST_NOT_GROW.find(x => x.concept === a.concept)?.sites.includes(a.file)) out.push(`${a.file} is listed in sites already: delete this entry`);
    return out;
  };
  it('every entry is complete, dated, and still needed', () => {
    fail(ALLOW.flatMap(a => problems(a).map(p => `ALLOW ${a.file} (${a.concept}) in ${LIST_FILE}: ${p}`)));
  });
  it('rejects an entry without a reason or date, and one that is no longer needed', () => {
    expect(problems({ concept: 'Stripe API calls', file: 'src/index.ts', reason: 'ok', by: '', date: '2099-01-01' }).length).toBeGreaterThanOrEqual(4);
  });
});

describe('the map and the guards agree', () => {
  const map = readFileSync(join(ROOT, MAP), 'utf8');
  const rows = map.split('\n').filter(l => l.startsWith('|')).map(l => l.split('|').slice(1, -1).map(c => c.trim()));
  it('docs/single-sources.md names every single-source concept in "One module each"', () => {
    for (const s of SINGLE) expect(rows.some(r => r[0] === s.concept), s.concept).toBe(true);
  });
  for (const d of MUST_NOT_GROW) {
    it(`"${d.concept}": the count, the authoritative module and the listed sites match the guard`, () => {
      const row = rows.find(r => r[1] === d.concept);
      expect(row, `a "Known duplicates" row whose Concept cell is exactly "${d.concept}"`).toBeTruthy();
      expect(Number.parseInt(row![2], 10), `Sites count of "${d.concept}" in ${MAP}`).toBe(d.sites.length);
      expect(row![3], `Authoritative cell of "${d.concept}" in ${MAP}`).toContain(d.authoritative);
      const listed = map.split('\n').find(l => l.startsWith(`- **${d.concept}** (`));
      expect(listed, `a "- **${d.concept}** (N): …" line under "Sites, by concept" in ${MAP}`).toBeTruthy();
      expect([...listed!.matchAll(/`([^`]+)`/g)].map(m => m[1]).sort(), `sites of "${d.concept}" in ${MAP}`).toEqual([...d.sites].sort());
      expect(Number.parseInt(listed!.match(/\((\d+)\)/)![1], 10)).toBe(d.sites.length);
    });
  }
  it('every listed site exists', () => {
    fail(MUST_NOT_GROW.flatMap(d => d.sites.filter(p => !existsSync(join(ROOT, p))).map(p => `${p} (${d.concept}) does not exist: take it off ${LIST_FILE} and ${MAP}`)));
  });
});
