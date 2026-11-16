#!/usr/bin/env node
// The pull request body declares what the independent reviewer verifies: every `## ` section of .github/pull_request_template.md,
// filled in. The template is the single source of the sections; this script only reads it.
//
//   node scripts/check-pr-body.mjs              # CI: the body of the pull request in $GITHUB_EVENT_PATH (pull_request.body)
//   node scripts/check-pr-body.mjs <body.md>    # a body saved in a file
//
// A section fails when it is missing, or when what is left after removing HTML comments is only whitespace or a placeholder
// (TODO, TBD, -, ..., or a bare "None": "None" needs a reason) or checkbox lines: the template's checklist, ticked or not, is not
// an answer. Headings match ignoring case and spacing.
//
// Exit: 0 every section filled, 1 a section missing or empty, 2 usage.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const TEMPLATE = new URL('../.github/pull_request_template.md', import.meta.url);

const PLACEHOLDERS = new Set(['', 'todo', 'tbd', 'tbc', 'wip', 'xxx', 'none', 'n/a', 'na', '-', '--', '—', '–', '...', '…', '?']);

const key = (heading) => heading.trim().replace(/\s+/g, ' ').toLowerCase();
const withoutComments = (text) => String(text ?? '').replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?(-->|$)/g, '');

/** The `## ` sections of a markdown text, outside HTML comments and code fences, in order: [{ heading, text }]. */
export function sections(markdown) {
  const out = [];
  let fence = null;
  for (const line of withoutComments(markdown).split('\n')) {
    const f = line.match(/^\s*(```|~~~)/);
    if (f) fence = fence === f[1] ? null : (fence ?? f[1]);
    const h = !fence && line.match(/^##\s+(.+?)\s*#*\s*$/);
    if (h) out.push({ heading: h[1], text: '' });
    else if (out.length) out[out.length - 1].text += `${line}\n`;
  }
  return out;
}

/** The required headings: the template's own `## ` headings, in order. */
export function requiredSections(template = readFileSync(TEMPLATE, 'utf8')) {
  return sections(template).map((s) => s.heading);
}

const CHECKBOX = /^([-*+]|\d+\.)\s+\[[ xX]?\]/;

/**
 * True when a section's text says nothing: whitespace, placeholder lines, or checklist lines only. A checkbox line, ticked or not,
 * is the template's checklist, not an answer: the section still needs a line of its own text.
 */
export function isEmpty(text) {
  return withoutComments(text)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => !CHECKBOX.test(l))
    .map((l) => l.replace(/^([-*+]|\d+\.)\s+/, '').replace(/[.:;!]+$/, '').trim().toLowerCase())
    .every((l) => PLACEHOLDERS.has(l));
}

/**
 * The problems with a pull request body: one entry per required section that is missing or empty.
 * @param {string | null | undefined} body the pull request body
 * @param {string[]} required the headings it must carry (default: the template's)
 * @returns {{ section: string, problem: 'missing' | 'empty' }[]}
 */
export function checkPrBody(body, required = requiredSections()) {
  const found = new Map();
  for (const s of sections(body)) found.set(key(s.heading), (found.get(key(s.heading)) ?? '') + s.text);
  return required.flatMap((section) => {
    if (!found.has(key(section))) return [{ section, problem: 'missing' }];
    return isEmpty(found.get(key(section))) ? [{ section, problem: 'empty' }] : [];
  });
}

function main(args) {
  let body;
  if (args.length > 1) {
    console.error('usage: node scripts/check-pr-body.mjs [<body.md>]');
    return 2;
  }
  if (args[0]) body = readFileSync(args[0], 'utf8');
  else {
    const path = process.env.GITHUB_EVENT_PATH;
    const pr = path ? JSON.parse(readFileSync(path, 'utf8')).pull_request : undefined;
    if (!pr) {
      console.error('No pull request: set GITHUB_EVENT_PATH to a pull_request event, or pass a body file.');
      return 2;
    }
    body = pr.body ?? '';
  }
  const problems = checkPrBody(body);
  if (!problems.length) {
    console.log(`Pull request body: all ${requiredSections().length} sections of .github/pull_request_template.md are filled.`);
    return 0;
  }
  console.error('Pull request body: fill these sections of .github/pull_request_template.md ("None" needs a reason):');
  for (const p of problems) console.error(`  ${p.problem === 'missing' ? 'missing' : 'empty  '}  ## ${p.section}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
