// scripts/check-pr-body.mjs: a pull request body carries every section of .github/pull_request_template.md, filled in.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { checkPrBody, isEmpty, requiredSections, TEMPLATE } from '../../scripts/check-pr-body.mjs';

const template = readFileSync(TEMPLATE, 'utf8');
const required = requiredSections();
const body = (fill: (heading: string) => string) => required.map((h) => `## ${h}\n<!-- what to write -->\n${fill(h)}\n`).join('\n');
const filled = body((h) => `Something real about ${h.toLowerCase()}.`);

describe('the template and the checker agree', () => {
  it("the required sections are the template's own `## ` headings, in order", () => {
    const headings = [...template.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
    expect(required).toEqual(headings);
    expect(required).toContain('Walk records');
    expect(required).toContain('Decisions made by the implementer: confirm');
  });

  it('every template section explains itself in one HTML comment line and asks a reason for "None"', () => {
    for (const h of required) expect(template, h).toMatch(new RegExp(`^## ${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n<!-- .*"None" needs a reason.* -->$`, 'm'));
  });

  it('the unfilled template fails on every section, with its checklist ticked or not', () => {
    const all = required.map((section) => ({ section, problem: 'empty' }));
    expect(checkPrBody(template)).toEqual(all);
    expect(template).toMatch(/^- \[ \] /m);
    expect(checkPrBody(template.replace(/^- \[ \] /gm, '- [x] '))).toEqual(all);
  });
});

describe('checkPrBody', () => {
  it('passes a filled body, with Windows line ends, other headings and any heading case', () => {
    expect(checkPrBody(filled)).toEqual([]);
    expect(checkPrBody(filled.replace(/\n/g, '\r\n'))).toEqual([]);
    expect(checkPrBody(`Intro line.\n\n${filled.replace('## What changes for whom', '##  what changes  FOR whom')}\n## Extra\nmore`)).toEqual([]);
  });

  it('fails a missing section, and an empty or absent body on every section', () => {
    expect(checkPrBody(filled.replace('## Walk records', '### Walk records'))).toEqual([{ section: 'Walk records', problem: 'missing' }]);
    expect(checkPrBody('')).toHaveLength(required.length);
    expect(checkPrBody(null)).toEqual(required.map((section) => ({ section, problem: 'missing' })));
  });

  it('fails a section that holds only HTML comments, including a multi-line one', () => {
    expect(checkPrBody(body((h) => (h === 'Vocabulary' ? '<!-- later -->\n<!--\nstill later\n-->' : 'Filled.')))).toEqual([{ section: 'Vocabulary', problem: 'empty' }]);
  });

  it('fails TODO and other placeholders, and a bare "None"', () => {
    for (const p of ['TODO', 'todo.', '- TODO', '-', '- [ ]', 'TBD', 'N/A', '...', 'None', 'None.', '* none']) {
      expect(checkPrBody(body((h) => (h === 'Design system' ? p : 'Filled.'))), p).toEqual([{ section: 'Design system', problem: 'empty' }]);
    }
  });

  it('fails a section of checkbox lines only, ticked or not, and passes one with text of its own', () => {
    const only = '- [x] Extends the module listed for every concept it touches.\n- [ ] Contradicts no ADR.';
    expect(checkPrBody(body((h) => (h === 'Walk records' ? only : 'Filled.')))).toEqual([{ section: 'Walk records', problem: 'empty' }]);
    expect(isEmpty(`${only}\nNone: no file on a protected flow changes.`)).toBe(false);
  });

  it('passes "None" with its reason', () => {
    expect(isEmpty('None: no screen changes; the change is a CI script.')).toBe(false);
    expect(isEmpty('- None (no new terms)')).toBe(false);
  });

  it('does not take a heading inside a code fence or an HTML comment as a section', () => {
    expect(checkPrBody(body((h) => (h === 'Docs updated' ? '```\n## Walk records\n```' : 'Filled.')).replace(/## Walk records\n<!-- what to write -->\nFilled\.\n/, ''))).toEqual([
      { section: 'Walk records', problem: 'missing' },
    ]);
    expect(checkPrBody(filled.replace('## Tests and evidence', '<!-- ## Tests and evidence -->'))).toEqual([{ section: 'Tests and evidence', problem: 'missing' }]);
  });
});
