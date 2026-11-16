// The per-spec summary of scripts/e2e-devbox.sh, as pure functions: one row from what Playwright left behind for a spec (its exit
// code and its results.json). A spec never reads "ok" unless tests really ran and passed: a file that failed to load (a syntax
// error), that holds no test, whose tests were all skipped, whose results are missing, or that made Playwright exit non-zero is a FAIL
// that says why.
//
//   node scripts/e2e-summary.mjs <work dir> <spec>...   reads <work dir>/run-<n>/{exit,results.json} for the n-th spec; exits 1 on any FAIL
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ANSI = /\x1b\[[0-9;]*m/g;
const firstLine = (s) => String(s ?? '').replace(ANSI, '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';

/** Counts of each outcome over every test in a Playwright JSON report (a test is one project's run of a spec). */
export function countTests(results) {
  const n = { passed: 0, failed: 0, skipped: 0, flaky: 0 };
  const walk = (suite) => {
    for (const s of suite.specs ?? []) for (const t of s.tests ?? []) n[t.status === 'expected' ? 'passed' : t.status === 'unexpected' ? 'failed' : t.status] += 1;
    for (const c of suite.suites ?? []) walk(c);
  };
  for (const s of results?.suites ?? []) walk(s);
  return n;
}

/**
 * @param {string} spec the spec file
 * @param {number | null} exitCode Playwright's exit code (null: not recorded)
 * @param {object | null} results the parsed results.json (null: missing or unreadable)
 * @returns {{ spec: string, ok: boolean, passed: number, failed: number, skipped: number, flaky: number, why: string, line: string }}
 */
export function specRow(spec, exitCode, results) {
  const n = results && typeof results === 'object' ? countTests(results) : { passed: 0, failed: 0, skipped: 0, flaky: 0 };
  const ran = n.passed + n.failed + n.flaky;
  const loadError = results && Array.isArray(results.errors) && results.errors.length > 0 ? firstLine(results.errors[0]?.message ?? results.errors[0]) : null;
  const counts = `${n.passed} passed${n.failed ? `, ${n.failed} failed` : ''}${n.skipped ? `, ${n.skipped} skipped` : ''}${n.flaky ? `, ${n.flaky} flaky` : ''}`;
  let why = '';
  if (!results || typeof results !== 'object') why = `no results${exitCode ? ` (playwright exited ${exitCode})` : ''}`;
  else if (ran === 0) why = `did not run: 0 tests${loadError !== null ? ` (load error: ${loadError})` : n.skipped ? ` (${n.skipped} skipped)` : ''}${exitCode ? ` (playwright exited ${exitCode})` : ''}`;
  else if (loadError !== null) why = `${ran} tests ran but Playwright reported a load error: ${loadError}`;
  else if (n.failed) why = counts;
  else if (exitCode !== 0) why = exitCode === null ? 'playwright exit code not recorded' : `playwright exited ${exitCode} with no failed test`;
  const ok = why === '';
  return { spec, ok, ...n, why, line: `  ${ok ? 'ok  ' : 'FAIL'}  ${spec.padEnd(42)} ${ok ? counts : why}` };
}

/** The whole summary: the rows' lines, the total line, and whether every spec is ok. */
export function summarize(rows) {
  const total = { passed: 0, failed: 0, skipped: 0, flaky: 0 };
  for (const r of rows) for (const k in total) total[k] += r[k];
  const bad = rows.filter((r) => !r.ok).length;
  return {
    ok: bad === 0,
    lines: [...rows.map((r) => r.line), `  total: ${rows.length} spec files, ${total.passed} passed, ${total.failed} failed, ${total.skipped} skipped, ${total.flaky} flaky${bad ? `; ${bad} spec file${bad === 1 ? '' : 's'} FAILED` : ''}`],
  };
}

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const readExit = (p) => { try { const n = Number.parseInt(readFileSync(p, 'utf8'), 10); return Number.isInteger(n) ? n : null; } catch { return null; } };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [work, ...specs] = process.argv.slice(2);
  const rows = specs.map((spec, i) => specRow(spec, readExit(`${work}/run-${i + 1}/exit`), readJson(`${work}/run-${i + 1}/results.json`)));
  const s = summarize(rows);
  console.log(s.lines.join('\n'));
  process.exit(s.ok ? 0 : 1);
}
