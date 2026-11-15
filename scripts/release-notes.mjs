#!/usr/bin/env node
// Prints one version's section of CHANGELOG.md (without its "## [x.y.z] - date" heading), for the GitHub release body.
// Steps: docs/releasing.md.
//
//   node scripts/release-notes.mjs 2.0.0                    # print the 2.0.0 section
//   node scripts/release-notes.mjs 2.0.0 --strict           # also fail while its date is still the YYYY-MM-DD placeholder
//   node scripts/release-notes.mjs 2.0.0 --set-date 2026-11-20   # write that date into the heading, then print
//
// Exit 1 when the version has no section, the section is empty, or (--strict) it is undated. Reads no network.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DATE_PLACEHOLDER = 'YYYY-MM-DD';
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const headingRe = version => new RegExp(`^## \\[${escape(version)}\\](?: - (\\S+))?\\s*$`, 'm');

/** { date, body } of the version's section, or null. The section ends at the next "## " heading or the link references. */
export function extractSection(changelog, version) {
  const m = headingRe(version).exec(changelog);
  if (!m) return null;
  const rest = changelog.slice(m.index + m[0].length);
  const end = rest.search(/^## |^\[[^\]]+\]: /m);
  const body = (end === -1 ? rest : rest.slice(0, end)).trim();
  return { date: m[1] ?? null, body };
}

/** The changelog with the version's heading dated. Throws when the heading is missing. */
export function setDate(changelog, version, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`not a date: ${date} (use YYYY-MM-DD)`);
  const re = headingRe(version);
  if (!re.test(changelog)) throw new Error(`CHANGELOG.md has no "## [${version}]" section`);
  return changelog.replace(re, `## [${version}] - ${date}`);
}

function main(argv) {
  const [version, ...flags] = argv;
  if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    console.error('usage: node scripts/release-notes.mjs <version> [--strict] [--set-date YYYY-MM-DD]');
    return 2;
  }
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'CHANGELOG.md');
  let text = readFileSync(file, 'utf8');
  const at = flags.indexOf('--set-date');
  if (at !== -1) {
    try { text = setDate(text, version, flags[at + 1] ?? ''); } catch (e) { console.error(e.message); return 1; }
    writeFileSync(file, text);
  }
  const section = extractSection(text, version);
  if (!section) { console.error(`CHANGELOG.md has no "## [${version}]" section`); return 1; }
  if (!section.body) { console.error(`CHANGELOG.md's ${version} section is empty`); return 1; }
  if (!section.date || section.date === DATE_PLACEHOLDER) {
    console.error(`note: ${version} is not dated yet (${section.date ?? 'no date'}); set it with --set-date YYYY-MM-DD`);
    if (flags.includes('--strict')) return 1;
  }
  process.stdout.write(section.body + '\n');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
