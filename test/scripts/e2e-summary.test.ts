// scripts/e2e-summary.mjs: the per-spec summary of scripts/e2e-devbox.sh never says "ok" for a spec that did not run.
import { describe, expect, it } from 'vitest';
import { countTests, specRow, summarize } from '../../scripts/e2e-summary.mjs';

const test = (status: string) => ({ specs: [{ tests: [{ status }] }] });
const report = (statuses: string[], extra: object = {}) => ({ suites: [{ suites: [{ specs: statuses.map((s) => ({ tests: [{ status: s }] })) }] }], errors: [], ...extra });
const SYNTAX = "\x1b[31mSyntaxError\x1b[39m: e2e/x.spec.ts: Unexpected identifier 's'\n\n   at line 78";

describe('specRow', () => {
  it('counts nested suites and every outcome', () => {
    expect(countTests({ suites: [{ suites: [test('expected'), test('unexpected')], ...test('flaky') }, test('skipped')] })).toEqual({ passed: 1, failed: 1, skipped: 1, flaky: 1 });
  });

  it('is ok only when tests ran, none failed and Playwright exited 0', () => {
    expect(specRow('e2e/a.spec.ts', 0, report(['expected', 'expected']))).toMatchObject({ ok: true, passed: 2, line: expect.stringMatching(/^ {2}ok {2} {2}e2e\/a\.spec\.ts\s+2 passed$/) });
    expect(specRow('e2e/a.spec.ts', 0, report(['expected', 'skipped']))).toMatchObject({ ok: true, skipped: 1 });
    expect(specRow('e2e/a.spec.ts', 0, report(['flaky']))).toMatchObject({ ok: true, flaky: 1 });
  });

  it('a file that failed to load did not run: the first line of the error is the reason (no colour codes)', () => {
    const row = specRow('e2e/x.spec.ts', 1, { suites: [], errors: [{ message: SYNTAX }] });
    expect(row.ok).toBe(false);
    expect(row.line).toMatch(/^ {2}FAIL {2}e2e\/x\.spec\.ts\s+did not run: 0 tests \(load error: SyntaxError: e2e\/x\.spec\.ts: Unexpected identifier 's'\) \(playwright exited 1\)$/);
    expect(row.line).not.toContain('\x1b');
  });

  it('a load error is a FAIL even when Playwright exited 0 or other tests ran', () => {
    expect(specRow('e2e/x.spec.ts', 0, { suites: [], errors: [{ message: 'boom' }] })).toMatchObject({ ok: false, line: expect.stringContaining('did not run: 0 tests (load error: boom)') });
    expect(specRow('e2e/x.spec.ts', 0, report(['expected'], { errors: [{ message: 'boom' }] }))).toMatchObject({ ok: false, line: expect.stringContaining('1 tests ran but Playwright reported a load error: boom') });
  });

  it('zero tests, or only skipped ones, did not run', () => {
    expect(specRow('e2e/z.spec.ts', 0, { suites: [], errors: [] })).toMatchObject({ ok: false, line: expect.stringContaining('did not run: 0 tests') });
    expect(specRow('e2e/z.spec.ts', 1, { suites: [] })).toMatchObject({ ok: false, line: expect.stringContaining('did not run: 0 tests (playwright exited 1)') });
    expect(specRow('e2e/z.spec.ts', 0, report(['skipped', 'skipped']))).toMatchObject({ ok: false, line: expect.stringContaining('did not run: 0 tests (2 skipped)') });
  });

  it('missing or unreadable results are a FAIL, with the exit code when there is one', () => {
    expect(specRow('e2e/m.spec.ts', 0, null)).toMatchObject({ ok: false, line: expect.stringMatching(/no results$/) });
    expect(specRow('e2e/m.spec.ts', 137, null)).toMatchObject({ ok: false, line: expect.stringContaining('no results (playwright exited 137)') });
  });

  it('a non-zero exit with no failed test is a FAIL that says so; an unrecorded exit is a FAIL', () => {
    expect(specRow('e2e/p.spec.ts', 1, report(['expected']))).toMatchObject({ ok: false, line: expect.stringMatching(/playwright exited 1 with no failed test$/) });
    expect(specRow('e2e/p.spec.ts', null, report(['expected']))).toMatchObject({ ok: false, line: expect.stringContaining('exit code not recorded') });
  });

  it('failed tests are counted next to the passed ones', () => {
    expect(specRow('e2e/f.spec.ts', 1, report(['expected', 'unexpected']))).toMatchObject({ ok: false, passed: 1, failed: 1, line: expect.stringMatching(/1 passed, 1 failed$/) });
  });
});

describe('summarize', () => {
  it('totals the rows and is not ok when any spec did not run', () => {
    const good = specRow('e2e/a.spec.ts', 0, report(['expected']));
    const bad = specRow('e2e/b.spec.ts', 1, { suites: [], errors: [{ message: 'x' }] });
    expect(summarize([good])).toEqual({ ok: true, lines: [good.line, '  total: 1 spec files, 1 passed, 0 failed, 0 skipped, 0 flaky'] });
    const s = summarize([good, bad]);
    expect(s.ok).toBe(false);
    expect(s.lines.at(-1)).toBe('  total: 2 spec files, 1 passed, 0 failed, 0 skipped, 0 flaky; 1 spec file FAILED');
  });
});
