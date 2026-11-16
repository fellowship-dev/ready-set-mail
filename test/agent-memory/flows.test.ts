import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
// FlowChad's own map reader (vendored skill, .agents/skills/flow-walk), so the test judges maps the way /flow-walk --map does.
import { mapResults } from '../../.agents/skills/flow-walk/scripts/flowmap.mjs';
// The CI check's own record rules (scripts/check-flows.mjs), tested here without git.
import { coversOf as checkCovers, globMatches, notAffectedName, notAffectedProblems, walkRecordName, walkRecordProblems } from '../../scripts/check-flows.mjs';
import { RULES_VERSION } from '../../.agents/skills/flow-gate/scripts/gate.mjs';

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
  const block = text.match(/^covers:\n((?:[ \t]+-[^\n]*\n|[ \t]*#[^\n]*\n)+)/m);
  return block ? [...block[1].matchAll(/^[ \t]+-[ \t]+(\S+)/gm)].map(m => m[1]) : [];
};

describe('protected value flows', () => {
  it('there are six, one per value flow on main', () => {
    expect(protectedFlows.map(f => f.id).sort()).toEqual([
      'agent-connects-and-reads-report',
      'buy-fix-one-domain',
      'connect-reports-cloudflare',
      'enable-mta-sts',
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
        const records = readdirSync(WALKS).filter(f => walkRecordName(flow.id).test(f));
        expect(records.length, `walk record for ${flow.id}`).toBeGreaterThan(0);
        const latest = readFileSync(join(WALKS, records.sort().at(-1)!), 'utf8');
        expect(latest).toMatch(/^- \*\*Commit:\*\* [0-9a-f]{7,40}$/m);
      });
    });
  }
});

describe('AGENTS.md lists every protected flow with exactly its covers', () => {
  const agents = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
  for (const flow of protectedFlows) {
    it(flow.id, () => {
      const line = agents.split('\n').find(l => l.startsWith(`- **${flow.id}**:`));
      expect(line, `a "- **${flow.id}**: …" line in AGENTS.md`).toBeTruthy();
      expect([...line!.matchAll(/`([^`]+)`/g)].map(m => m[1]).sort()).toEqual(coversOf(flow.text).sort());
      expect(checkCovers(flow.text).sort()).toEqual(coversOf(flow.text).sort());
    });
  }
});

describe('scripts/check-flows.mjs: record names', () => {
  const walk = walkRecordName('buy-fix-one-domain');
  it('a walk record is <date>-<id>.md, or <date>-<id>.<tag>.md with a tag of [a-z0-9-]+', () => {
    expect(walk.test('2026-11-16-buy-fix-one-domain.md')).toBe(true);
    expect(walk.test('2026-11-16-buy-fix-one-domain.pr177.md')).toBe(true);
    expect(walk.test('2026-11-16-buy-fix-one-domain.round-3.md')).toBe(true);
  });
  it('not-affected is never a tag: it keeps its own meaning', () => {
    expect(walk.test('2026-11-16-buy-fix-one-domain.not-affected.md')).toBe(false);
    expect(notAffectedName('buy-fix-one-domain').test('2026-11-16-buy-fix-one-domain.not-affected.md')).toBe(true);
    expect(notAffectedName('buy-fix-one-domain').test('2026-11-16-buy-fix-one-domain.pr177.md')).toBe(false);
  });
  it('a not-affected record may carry a tag before .not-affected (tag [a-z0-9-]+), so a name already taken that day can be filed again', () => {
    const na = notAffectedName('buy-fix-one-domain');
    expect(na.test('2026-11-16-buy-fix-one-domain.mta-sts.not-affected.md')).toBe(true);
    expect(na.test('2026-11-16-buy-fix-one-domain.round-3.not-affected.md')).toBe(true);
    for (const n of ['2026-11-16-buy-fix-one-domain.MTA.not-affected.md', '2026-11-16-buy-fix-one-domain..not-affected.md', '2026-11-16-buy-fix-one-domain.a.b.not-affected.md', '2026-11-16-other-flow.mta-sts.not-affected.md', '2026-11-16-buy-fix-one-domain.mta-sts.not-affected.txt']) expect(na.test(n), n).toBe(false);
    // and a tagged not-affected name is never taken for a walk record
    expect(walk.test('2026-11-16-buy-fix-one-domain.mta-sts.not-affected.md')).toBe(false);
  });
  it('other names, other flows and bad tags do not match', () => {
    for (const n of ['2026-11-16-buy-fix-one-domain.PR177.md', '2026-11-16-buy-fix-one-domain..md', '2026-11-16-buy-fix-one-domain.a.b.md', '2026-11-16-buy-fix-one-domain.pr177.txt', '2026-11-16-other-flow.pr177.md', '2026-1-16-buy-fix-one-domain.md', 'x2026-11-16-buy-fix-one-domain.md']) expect(walk.test(n), n).toBe(false);
  });
});

describe('scripts/check-flows.mjs: which records count', () => {
  const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
  const states: Record<string, string> = { aaaa: 'in-base', cccc: 'not-ancestor', dddd: 'unknown' };
  const ctx = { id: 'buy-fix-one-domain', newFlow: false, commitState: (sha: string) => states[sha.slice(0, 4)] ?? 'new', coveredChangedSince: (sha: string) => (sha.startsWith('eeee') ? ['src/billing/orders.ts'] : []) };
  const gateRecord = (o: Record<string, string> = {}) => {
    const f = { Flow: 'Hosted owner buys Fix one domain', 'Value moment': 'Fix ordered', Walked: at(3600_000), Target: 'http://127.0.0.1:8787/ (local-copy)', Commit: 'bbbbbbb', Kind: 'screens', Gate: 'PASS', Rules: RULES_VERSION, ...o };
    return `# Walk record: buy-fix-one-domain\n\n${Object.entries(f).map(([k, v]) => `- **${k}:** ${v}`).join('\n')}\n`;
  };
  it('a record the gate wrote, at a commit in this change with no covered file changed since, counts', () => {
    expect(walkRecordProblems(gateRecord(), ctx)).toEqual([]);
  });
  it('a hand-written record without the gate fields does not', () => {
    expect(walkRecordProblems('- **Commit:** abc1234\n', ctx).length).toBeGreaterThan(3);
  });
  it('an old walk, a walk at a commit already in the base, a failed gate or another rules version does not', () => {
    expect(walkRecordProblems(gateRecord({ Walked: at(-3600_000) }), ctx).join()).toMatch(/in the future/);
    expect(walkRecordProblems(gateRecord({ Commit: 'aaaaaaa' }), ctx).join()).toMatch(/already in the base/);
    expect(walkRecordProblems(gateRecord({ Gate: 'FAIL' }), ctx).join()).toMatch(/Gate is FAIL/);
    expect(walkRecordProblems(gateRecord({ Rules: '0.0.1' }), ctx).join()).toMatch(/Rules/);
    expect(walkRecordProblems(gateRecord({ Kind: 'baseline', Walked: '2026-11-15 (date)' }), ctx).length).toBeGreaterThan(0);
  });
  it('a walk older than the base still counts when the base moved only in files the flow does not cover', () => {
    expect(walkRecordProblems(gateRecord({ Walked: at(30 * 86400_000) }), ctx)).toEqual([]);
  });
  it('a covered file changed after the walked commit, a commit outside HEAD or a commit that is not there does not count', () => {
    expect(walkRecordProblems(gateRecord({ Commit: 'eeeeeee' }), ctx).join()).toMatch(/src\/billing\/orders\.ts changed after the walked commit/);
    expect(walkRecordProblems(gateRecord({ Commit: 'ccccccc' }), ctx).join()).toMatch(/not an ancestor of HEAD/);
    expect(walkRecordProblems(gateRecord({ Commit: 'ddddddd' }), ctx).join()).toMatch(/not in this repository/);
  });
  it('a thin record (no gate fields, an undeclared value moment, an unknown target) still does not count', () => {
    expect(walkRecordProblems('# Walk record: buy-fix-one-domain\n\n- **Commit:** bbbbbbb\n- **Gate:** PASS\n', ctx).length).toBeGreaterThan(4);
    expect(walkRecordProblems(gateRecord({ 'Value moment': 'not declared', Target: 'unknown' }), ctx).length).toBe(2);
  });
  it('a baseline counts only for a flow this change adds', () => {
    expect(walkRecordProblems(gateRecord({ Kind: 'baseline', Walked: '2026-11-15 (date)' }), { ...ctx, newFlow: true })).toEqual([]);
    expect(walkRecordProblems(gateRecord({ Kind: 'baseline', Walked: '2026-11-15 (date)', Commit: 'aaaaaaa' }), { ...ctx, newFlow: true })).toEqual([]);
    expect(walkRecordProblems(gateRecord({ Kind: 'baseline', Commit: 'aaaaaaa' }), ctx).length).toBeGreaterThan(0);
  });
  const na = (o: Record<string, string> = {}) => Object.entries({ Flow: 'buy-fix-one-domain', Changed: '`src/billing/webhook.ts`', Reason: 'Renames a private helper; no screen, request or state the buyer meets changes.', By: 'reviewer', Date: '2026-11-16', ...o }).map(([k, v]) => `- **${k}:** ${v}`).join('\n');
  const nctx = { id: 'buy-fix-one-domain', baseDate: '2026-11-15', today: '2026-11-17', hits: ['src/billing/webhook.ts'], flowChanged: false };
  it('a "not affected" record needs the flow, every changed file, a reason, who and a date; never when the flow itself changed', () => {
    expect(notAffectedProblems(na(), nctx)).toEqual([]);
    expect(notAffectedProblems(na({ Reason: 'typo' }), nctx).join()).toMatch(/Reason/);
    expect(notAffectedProblems(na({ Changed: '' }), nctx).join()).toMatch(/src\/billing\/webhook\.ts/);
    expect(notAffectedProblems(na({ Date: '2026-11-01' }), nctx).join()).toMatch(/Date/);
    expect(notAffectedProblems(na({ By: '' }), nctx).join()).toMatch(/By/);
    expect(notAffectedProblems(na(), { ...nctx, flowChanged: true }).join()).toMatch(/walk it/);
  });
  it('a record is filed under the day it happened: the date in the name is the Date line (not-affected) or the walk\'s own timestamp', () => {
    expect(notAffectedProblems(na(), { ...nctx, nameDate: '2026-11-16' })).toEqual([]);
    expect(notAffectedProblems(na(), { ...nctx, nameDate: '2026-11-18' }).join()).toMatch(/file name says 2026-11-18 but Date is 2026-11-16/);
    expect(walkRecordProblems(gateRecord({ Walked: '2026-11-16T22:00:00Z' }), { ...ctx, nameDate: '2026-11-16' })).toEqual([]);
    expect(walkRecordProblems(gateRecord({ Walked: '2026-11-16T22:00:00Z' }), { ...ctx, nameDate: '2026-11-18' }).join()).toMatch(/file name says 2026-11-18, but the walk ran on 2026-11-16/);
    // a walk written with an offset may carry either its own day or the UTC day
    expect(walkRecordProblems(gateRecord({ Walked: '2026-11-17T01:05:00+02:00' }), { ...ctx, nameDate: '2026-11-16' })).toEqual([]);
    expect(walkRecordProblems(gateRecord({ Walked: '2026-11-17T01:05:00+02:00' }), { ...ctx, nameDate: '2026-11-17' })).toEqual([]);
  });
  it('reads covers globs as the shell does', () => {
    expect(globMatches('src/billing/*', 'src/billing/webhook.ts')).toBe(true);
    expect(globMatches('src/mcp/*', 'src/mcp/tools/index.ts')).toBe(true);
    expect(globMatches('web/src/app.tsx', 'web/src/app.tsx.bak')).toBe(false);
  });
});

