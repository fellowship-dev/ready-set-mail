// What the single-source guards scan: production code only (these folders, without tests, fixtures, mocks or build output), comments removed.
// Shared by single-sources.test.ts (names and shapes) and single-sources.behaviour.test.ts (what a module does).
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const ROOT = join(__dirname, '../..');

/** Production code: these folders, without tests, fixtures, mocks or build output. Nothing else is scanned. */
export const DIRS = ['src', 'web/src', 'packages/db/src', 'packages/dns-checks/src', 'packages/report/src', 'packages/ui/src', 'scripts', 'tools', 'plugins'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'test', 'tests', '__tests__', '__fixtures__', 'fixtures', '__mocks__', 'e2e']);
export const isProduction = (name: string): boolean => /\.(ts|tsx|mts|mjs|js|cjs)$/.test(name) && !/\.(test|spec|stories|fixture)\./.test(name) && !name.endsWith('.d.ts');

export function sources(dir: string): string[] {
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

