import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// The agent-memory docs break the build when the code moves (AGENTS.md rule 6). Every file path, and every code symbol,
// named in back-quotes in these docs must exist; "`symbol` in `path`" must name a symbol that path really contains.

const ROOT = join(__dirname, '../..');
const ADR = join(ROOT, 'docs/adr');
export const MEMORY_DOCS = [
  'AGENTS.md',
  'CONTEXT.md',
  'docs/single-sources.md',
  ...readdirSync(ADR).filter(f => f.endsWith('.md')).map(f => `docs/adr/${f}`),
];

const SOURCE_DIRS = ['src', 'web/src', 'packages/db/src', 'packages/dns-checks/src', 'packages/report/src', 'packages/ui/src', 'scripts', 'test', 'e2e', 'web/test', 'packages/ui/test'];
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    if (name === 'node_modules' || name === 'dist') return [];
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx|mts|mjs|js|sh)$/.test(name) ? [p] : [];
  });
}
const corpus = [...SOURCE_DIRS.flatMap(d => walk(join(ROOT, d))), join(ROOT, 'wrangler.jsonc')].map(p => readFileSync(p, 'utf8')).join('\n');

const quoted = (text: string): string[] => [...text.matchAll(/`([^`\n]+)`/g)].map(m => m[1]);

/** A repo path: has a slash or a known top-level file name, no spaces, placeholders, URLs or globs. */
const TOP_FILES = /^(AGENTS|CLAUDE|CONTEXT|README|DESIGN|PRODUCT|CHANGELOG)\.md$|^(wrangler\.jsonc|package\.json)$/;
export function pathLike(token: string): boolean {
  if (/[\s<>*{}$]|:\/\/|^\/|@/.test(token)) return false;
  if (TOP_FILES.test(token)) return true;
  return /^(\.?[\w.-]+\/)+[\w.-]*$/.test(token) && /^(\.agents|\.flowchad|\.github|docs|e2e|migrations|packages|plugins|scripts|src|test|tools|web)\//.test(token);
}

/** A code symbol: camelCase, PascalCase with an inner capital, or UPPER_SNAKE (env vars and constants). */
export function symbolLike(token: string): boolean {
  return /^[a-z]+[A-Z]\w*$/.test(token) || /^[A-Z][a-z]+[A-Z]\w*$/.test(token) || /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(token);
}

describe('the matchers', () => {
  it('recognize paths and symbols, and skip prose, placeholders and addresses', () => {
    expect(pathLike('src/domains/ownership.ts')).toBe(true);
    expect(pathLike('web/src/pages/auth/')).toBe(true);
    expect(pathLike('CONTEXT.md')).toBe(true);
    expect(pathLike('rua@<INTAKE_DOMAIN>')).toBe(false);
    expect(pathLike('.flowchad/flows/<id>.map.md')).toBe(false);
    expect(pathLike('POST /api/onboarding/dns-apply')).toBe(false);
    expect(pathLike('p=none')).toBe(false);
    expect(symbolLike('fixedReportAddress')).toBe(true);
    expect(symbolLike('CfClient')).toBe(true);
    expect(symbolLike('INTAKE_DOMAIN')).toBe(true);
    expect(symbolLike('owner')).toBe(false);
    expect(symbolLike('Protected')).toBe(false);
  });
});

describe('agent-memory docs name only things that exist', () => {
  for (const doc of MEMORY_DOCS) {
    const text = readFileSync(join(ROOT, doc), 'utf8');
    it(`${doc}: every path exists`, () => {
      const missing = quoted(text).filter(pathLike).filter(p => !existsSync(join(ROOT, p)));
      expect(missing).toEqual([]);
    });
    it(`${doc}: every symbol exists in the code`, () => {
      const missing = [...new Set(quoted(text).filter(symbolLike))].filter(s => !new RegExp(`\\b${s}\\b`).test(corpus));
      expect(missing).toEqual([]);
    });
    it(`${doc}: "\`symbol\` in \`path\`" names a symbol that file contains`, () => {
      const wrong: string[] = [];
      for (const m of text.matchAll(/((?:`\w+`(?:\s*\([^)]*\))?(?:,\s*|\s+and\s+|\s+or\s+)?)+)\s+in\s+`([^`]+)`/g)) {
        const file = join(ROOT, m[2]);
        if (!pathLike(m[2]) || !existsSync(file) || statSync(file).isDirectory()) continue;
        const body = readFileSync(file, 'utf8');
        for (const s of [...m[1].matchAll(/`(\w+)`/g)].map(x => x[1]).filter(symbolLike)) {
          if (!new RegExp(`\\b${s}\\b`).test(body)) wrong.push(`${s} not in ${m[2]}`);
        }
      }
      expect(wrong).toEqual([]);
    });
  }
});

describe('ADR index', () => {
  const files = readdirSync(ADR).filter(f => /^\d{4}-.+\.md$/.test(f));
  const index = readFileSync(join(ADR, 'README.md'), 'utf8');
  it('lists every ADR, and every ADR has status, date and who decided', () => {
    for (const f of files) {
      expect(index, f).toContain(`(${f})`);
      const head = readFileSync(join(ADR, f), 'utf8').split('---')[1] ?? '';
      expect(head, f).toMatch(/^status: \S/m);
      expect(head, f).toMatch(/^date: \d{4}-\d{2}-\d{2}$/m);
      expect(head, f).toMatch(/^decided-by: \S/m);
    }
  });
  it('numbers ADRs without gaps or repeats', () => {
    const nums = files.map(f => Number(f.slice(0, 4)));
    expect(nums).toEqual(nums.map((_, i) => i + 1));
  });
});
