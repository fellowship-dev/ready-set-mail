import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

// The agent-memory docs break the build when the code moves (AGENTS.md rule 6). Every repository path and every code symbol
// named in back-quotes in these docs must exist, wherever it points; "`symbol` in `path`" must name a symbol that path contains.

const ROOT = join(__dirname, '../..');
const ADR = join(ROOT, 'docs/adr');
const FLOWS = '.flowchad/flows';
export const MEMORY_DOCS = [
  'AGENTS.md',
  'CONTEXT.md',
  'docs/single-sources.md',
  '.github/pull_request_template.md',
  ...readdirSync(ADR).filter(f => f.endsWith('.md')).map(f => `docs/adr/${f}`),
  ...readdirSync(join(ROOT, FLOWS)).filter(f => f.endsWith('.map.md')).map(f => `${FLOWS}/${f}`),
];

/** Every tracked file, and every folder that holds one. */
const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
const trackedBasenames = new Set(tracked.map(f => basename(f)));

const CORPUS_DIRS = ['src', 'web/src', 'packages/db/src', 'packages/dns-checks/src', 'packages/report/src', 'packages/ui/src', 'scripts', 'tools', 'test', 'e2e', 'web/test', 'packages/ui/test', 'packages/db/migrations', 'migrations'];
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    if (name === 'node_modules' || name === 'dist') return [];
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx|mts|mjs|js|sh|sql)$/.test(name) ? [p] : [];
  });
}
const corpus = [...CORPUS_DIRS.flatMap(d => walk(join(ROOT, d))), join(ROOT, 'wrangler.jsonc')].map(p => readFileSync(p, 'utf8')).join('\n');

/** Back-quoted tokens; a trailing `:line` or `:from-to` is dropped so `path:12` is checked as a path. */
const quoted = (text: string): string[] => [...text.matchAll(/`([^`\n]+)`/g)].map(m => m[1].replace(/:\d+(-\d+)?$/, ""));

/**
 * A repository path: a token with a slash made only of path characters, or a bare file name with a source or document
 * extension. Not a path: anything with a space, placeholder, glob, URL, address, leading slash (a route) or a dotted host.
 */
export function pathLike(token: string): boolean {
  if (/[\s<>*{}$?#=:@,;()'"]|^\//.test(token)) return false;
  if (/^[\w.-]+\.(md|ts|tsx|mts|mjs|cjs|js|json|jsonc|ya?ml|sh|toml|sql)$/.test(token)) return true;
  return /^\.?[\w-][\w.-]*(\/[\w.-]+)*\/?$/.test(token) && token.includes('/');
}
/** Exists: a path from the repository root, or a bare file name that some tracked file has. */
export function pathExists(token: string): boolean {
  if (!token.includes('/')) return existsSync(join(ROOT, token)) || trackedBasenames.has(token);
  return existsSync(join(ROOT, token.replace(/\/$/, '')));
}

/** A code symbol: camelCase, PascalCase with an inner capital, UPPER_SNAKE (env vars, constants) or snake_case (columns, codes). */
export function symbolLike(token: string): boolean {
  return /^[a-z]+[A-Z]\w*$/.test(token) || /^[A-Z][a-z]+[A-Z]\w*$/.test(token) || /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(token) || /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(token);
}

describe('the matchers', () => {
  it('recognize paths anywhere in the repository, and skip prose, placeholders, routes and addresses', () => {
    for (const p of ['src/domains/ownership.ts', 'web/src/pages/auth/', 'CONTEXT.md', 'design/SYSTEM.md', 'stripe-client.ts', '.flowchad/walks', 'docs/code-structure-gone.md']) expect(pathLike(p), p).toBe(true);
    for (const p of ['rua@<INTAKE_DOMAIN>', '.flowchad/flows/<id>.map.md', 'POST /api/onboarding/dns-apply', '/api/billing/webhook', 'p=none', 'invoice.paid', 'web/src/pages/auth/*', 'https://example.com/x']) expect(pathLike(p), p).toBe(false);
    expect(pathExists('design/SYSTEM.md')).toBe(false);
    expect(pathExists('stripe-client.ts')).toBe(true);
    for (const s of ['fixedReportAddress', 'CfClient', 'INTAKE_DOMAIN', 'verified_via']) expect(symbolLike(s), s).toBe(true);
    for (const s of ['owner', 'Protected', 'rua']) expect(symbolLike(s), s).toBe(false);
  });
});

describe('agent-memory docs name only things that exist', () => {
  for (const doc of MEMORY_DOCS) {
    const text = readFileSync(join(ROOT, doc), 'utf8');
    it(`${doc}: every path exists`, () => {
      const missing = [...new Set(quoted(text).filter(pathLike))].filter(p => !pathExists(p));
      expect(missing, `${doc} names paths that do not exist: fix the doc (or the path) in the same change`).toEqual([]);
    });
    it(`${doc}: every symbol exists in the code`, () => {
      const missing = [...new Set(quoted(text).filter(symbolLike))].filter(s => !new RegExp(`\\b${s}\\b`).test(corpus));
      expect(missing, `${doc} names symbols no code contains`).toEqual([]);
    });
    it(`${doc}: "\`symbol\` in \`path\`" names a symbol that file contains`, () => {
      const wrong: string[] = [];
      for (const m of text.matchAll(/((?:`\w+`(?:\s*\([^)]*\))?(?:,\s*|\s+and\s+|\s+or\s+)?)+)\s+in\s+`([^`]+)`/g)) {
        const file = join(ROOT, m[2]);
        if (!pathLike(m[2]) || !m[2].includes('/') || !existsSync(file) || statSync(file).isDirectory()) continue;
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
  it('lists no ADR that does not exist', () => {
    for (const m of index.matchAll(/\((\d{4}-[^)]+\.md)\)/g)) expect(files, m[1]).toContain(m[1]);
  });
  it('numbers ADRs without repeats; a gap only for a number reserved for an open pull request, listed in the index as reserved', () => {
    const nums = files.map(f => Number(f.slice(0, 4)));
    expect(new Set(nums).size).toBe(nums.length);
    const reserved = [...index.matchAll(/^\| (\d{4}) \| reserved/gm)].map(m => Number(m[1]));
    const all = [...nums, ...reserved].sort((a, b) => a - b);
    expect(all).toEqual(all.map((_, i) => i + 1));
  });
});
