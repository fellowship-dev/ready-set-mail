import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
// FlowChad's own map reader (vendored skill, .agents/skills/flow-walk), so the test judges maps the way /flow-walk --map does.
import { mapResults } from '../../.agents/skills/flow-walk/scripts/flowmap.mjs';

// Protected value flows (ADR 0012): every flow tagged `protected` has a map whose value moment is declared and reachable with
// no dead end, covers the pages it depends on, and has a walk record the CI check (scripts/check-flows.sh) can compare against.

const ROOT = join(__dirname, '../..');
const FLOWS = join(ROOT, '.flowchad/flows');
const WALKS = join(ROOT, '.flowchad/walks');

const protectedFlows = readdirSync(FLOWS)
  .filter(f => f.endsWith('.yml'))
  .map(f => ({ id: f.replace(/\.yml$/, ''), text: readFileSync(join(FLOWS, f), 'utf8') }))
  .filter(f => /^tags:.*[[, ]protected[\], ]/m.test(f.text));

const coversOf = (text: string): string[] => {
  const block = text.match(/^covers:\n((?:[ \t]+-[^\n]*\n)+)/m);
  return block ? [...block[1].matchAll(/-\s+(\S+)/g)].map(m => m[1]) : [];
};

describe('protected value flows', () => {
  it('there are five, one per value flow on main', () => {
    expect(protectedFlows.map(f => f.id).sort()).toEqual([
      'agent-connects-and-reads-report',
      'buy-fix-one-domain',
      'invited-teammate-joins',
      'signup-to-records-live-cloudflare',
      'signup-to-records-live-manual',
    ]);
  });

  for (const flow of protectedFlows) {
    describe(flow.id, () => {
      it('declares a value moment and marks the step that reaches it', () => {
        expect(flow.text).toMatch(/^value_moment: \S/m);
        expect(flow.text).toMatch(/first_value: true/);
      });

      it('has a map whose value moment is reachable, with no dead end or unreachable screen', () => {
        const map = join(FLOWS, `${flow.id}.map.md`);
        expect(existsSync(map), `${flow.id}.map.md`).toBe(true);
        const r = mapResults(readFileSync(map, 'utf8'), flow.id);
        expect(r.value_moment).toBeTruthy();
        expect(r.value_reachable).toBe(true);
        expect(r.measures.dead_ends).toBe(0);
        expect(r.measures.unreachable).toBe(0);
      });

      it('covers only files that exist (a glob needs at least one match)', () => {
        const globs = coversOf(flow.text);
        expect(globs.length).toBeGreaterThan(0);
        for (const g of globs) {
          if (g.endsWith('/*')) expect(existsSync(join(ROOT, g.slice(0, -2))), g).toBe(true);
          else expect(existsSync(join(ROOT, g)), g).toBe(true);
        }
      });

      it('has a walk record with the commit it was walked at', () => {
        const records = readdirSync(WALKS).filter(f => new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${flow.id}\\.md$`).test(f));
        expect(records.length, `walk record for ${flow.id}`).toBeGreaterThan(0);
        const latest = readFileSync(join(WALKS, records.sort().at(-1)!), 'utf8');
        expect(latest).toMatch(/^- \*\*Commit:\*\* [0-9a-f]{7,40}$/m);
      });
    });
  }
});
