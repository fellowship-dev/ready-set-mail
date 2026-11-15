// scripts/release-notes.mjs: the GitHub release body is exactly one version's CHANGELOG section.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractSection, setDate, DATE_PLACEHOLDER } from '../scripts/release-notes.mjs';
import pkg from '../package.json';

const SAMPLE = `# Changelog

## [Unreleased]

## [2.0.0] - YYYY-MM-DD

### Upgrading from 1.x

Text.

## [1.2.0] - 2026-03-10

### Added

- Old thing.

[2.0.0]: https://example.com/v2
`;

describe('release notes', () => {
  it('extracts one section without its heading, stopping at the next version', () => {
    expect(extractSection(SAMPLE, '2.0.0')).toEqual({ date: DATE_PLACEHOLDER, body: '### Upgrading from 1.x\n\nText.' });
    expect(extractSection(SAMPLE, '1.2.0')).toEqual({ date: '2026-03-10', body: '### Added\n\n- Old thing.' });
    expect(extractSection(SAMPLE, '9.9.9')).toBeNull();
    expect(extractSection(SAMPLE, '2.0')).toBeNull();
  });

  it('dates a section', () => {
    const dated = setDate(SAMPLE, '2.0.0', '2026-11-20');
    expect(extractSection(dated, '2.0.0')?.date).toBe('2026-11-20');
    expect(() => setDate(SAMPLE, '2.0.0', 'tomorrow')).toThrow();
    expect(() => setDate(SAMPLE, '3.0.0', '2026-11-20')).toThrow();
  });

  it('CHANGELOG.md has a non-empty section for the package version, plus Unreleased, 1.2.0 and 0.6.0', () => {
    const changelog = readFileSync('CHANGELOG.md', 'utf8');
    const current = extractSection(changelog, pkg.version);
    expect(current?.body).toMatch(/Upgrading from 1\.x/);
    expect(changelog).toMatch(/^## \[Unreleased\]/m);
    for (const v of ['1.2.0', '0.6.0']) expect(extractSection(changelog, v)?.body.length).toBeGreaterThan(0);
  });
});

describe('docs/public.json', () => {
  const manifest = JSON.parse(readFileSync('docs/public.json', 'utf8')) as { public: { slug: string; path: string; section?: string }[]; internal: { path: string }[] };

  it('every public doc exists (and its section, when named); slugs are unique', () => {
    const slugs = manifest.public.map(d => d.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const doc of manifest.public) {
      const text = readFileSync(doc.path, 'utf8');
      if (doc.section) expect(text, doc.slug).toMatch(new RegExp(`^##+ ${doc.section}\\s*$`, 'm'));
    }
    expect(slugs).toEqual(expect.arrayContaining(['changelog', 'self-hosting', 'permissions', 'upgrading', 'agents', 'workspaces', 'data-retention']));
  });

  it('internal docs exist and are never public', () => {
    const pub = new Set(manifest.public.map(d => d.path));
    for (const doc of manifest.internal) {
      expect(() => readFileSync(doc.path, 'utf8'), doc.path).not.toThrow();
      expect(pub.has(doc.path), doc.path).toBe(false);
    }
  });
});
