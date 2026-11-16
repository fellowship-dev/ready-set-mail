#!/usr/bin/env node
// Protected value flows (ADR 0012): fail a change that touches a protected flow and brings no fresh record for it.
//
//   node scripts/check-flows.mjs [<base ref>]    # default base: the merge base with origin/main (also for an all-zero ref)
//
// A protected flow is a .flowchad/flows/<id>.yml whose `tags:` include `protected`. FlowChad's changed.sh
// (.agents/skills/flow-gate/scripts/changed.sh) says which flows the change touches since <base>: the flow's `covers:` globs
// (its dashboard pages AND the server files that implement its steps), the flow file and the flow map. Each touched protected
// flow needs ONE of these, ADDED by this change (editing an older record does not count):
//
//   .flowchad/walks/<date>-<id>.md               the walk record FlowChad's gate writes (/flow-gate <id> --record .flowchad/walks).
//       It may carry a tag after the id, <date>-<id>.<tag>.md (tag [a-z0-9-]+, for example 2026-11-16-<id>.pr177.md), so two pull
//       requests that each walk the same flow on the same day do not add the same file name. `not-affected` is never a tag: it is the
//       next record's own suffix.
//       It must carry the gate's fields: Flow, Value moment, Walked (a full timestamp), Target, Commit, Kind, Gate and Rules;
//       Gate PASS or PASS-WITH-OVERRIDES; Rules equal to the vendored gate's RULES_VERSION; a Walked time that is not in the future; and a Commit that exists,
//       is an ancestor of HEAD, is not already in the base, and after which no file the flow covers (its `covers:` files, the flow
//       file and the flow map) changed up to HEAD. So a base that moves in files the flow does not cover leaves a walk valid, and a
//       change to a covered file after the walked commit (in this pull request or in main) asks for a new walk. On a pull request
//       HEAD is GitHub's merge of it into main. A new flow's first record may be its baseline (Kind: baseline).
//   .flowchad/walks/<date>-<id>.not-affected.md  a reviewed "not affected" record, for a change to a mapped file that does not
//       change what the person sees or does on the flow. Fields: Flow, Changed (every mapped file this change touches, in
//       back-quotes), Reason (why the flow is unchanged), By, Date. Not accepted when the flow file or its map changed.
//
// What this proves: the record is new, complete and fresh. What it cannot prove: that a walk took place. A hand-written record
// with the right fields passes; the pull request review is the check that it is real (FlowChad's gate says the same of itself).
//
// Exit: 0 nothing to do, 1 a protected flow changed without a valid record, 2 usage.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { RULES_VERSION } from '../.agents/skills/flow-gate/scripts/gate.mjs';

const FLOWS = '.flowchad/flows';
const WALKS = '.flowchad/walks';
const CHANGED = '.agents/skills/flow-gate/scripts/changed.sh';
const PASSING = new Set(['PASS', 'PASS-WITH-OVERRIDES']);
const CLOCK_SLACK_MS = 5 * 60 * 1000;

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const gitOk = (...args) => spawnSync('git', args, { stdio: 'ignore' }).status === 0;
const usage = (msg) => { console.error(`check-flows: ${msg}`); process.exit(2); };

export function fields(text) {
  const out = {};
  for (const m of text.matchAll(/^- \*\*([A-Za-z ]+):\*\* ?(.*)$/gm)) if (!(m[1] in out)) out[m[1]] = m[2].trim();
  return out;
}
export const coversOf = (yml) => {
  const block = yml.match(/^covers:\n((?:[ \t]+-[^\n]*\n|[ \t]*#[^\n]*\n)+)/m);
  return block ? [...block[1].matchAll(/^[ \t]+-[ \t]+([^\s#]+)/gm)].map((m) => m[1].replace(/^["']|["']$/g, '')) : [];
};
/** A `covers:` glob as the shell `case` in changed.sh reads it: `*` matches any characters, slashes included. */
export const globMatches = (glob, file) => new RegExp(`^${glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(file);
/** The names a record may have: `<date>-<id>.md`, or `<date>-<id>.<tag>.md` with a tag of [a-z0-9-]+ other than `not-affected`. */
export const walkRecordName = (id) => new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${id}(?:\\.(?!not-affected\\.md$)[a-z0-9-]+)?\\.md$`);
export const notAffectedName = (id) => new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${id}\\.not-affected\\.md$`);
const realDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/** Problems with a walk record, or [] when it is valid for this change. */
export function walkRecordProblems(text, { id, newFlow, commitState, coveredChangedSince }) {
  const p = [];
  const f = fields(text);
  if (!new RegExp(`^# Walk record: ${id}\\s*$`, 'm').test(text)) p.push(`first line is not "# Walk record: ${id}"`);
  for (const k of ['Flow', 'Value moment', 'Walked', 'Target', 'Commit', 'Kind', 'Gate', 'Rules']) if (!f[k]) p.push(`no "- **${k}:**" line`);
  if (!/^[0-9a-f]{7,40}$/i.test(f.Commit ?? '')) p.push(`Commit is not a commit id: ${f.Commit ?? 'missing'}`);
  // The first record of a flow this change adds may be its baseline, measured on the base itself; reviewed in the PR.
  if (newFlow && f.Kind === 'baseline') return p;
  if (p.length === 0) {
    const state = commitState(f.Commit);
    if (state === 'unknown') p.push(`Commit ${f.Commit} is not in this repository (fetch the full history, or the record names a commit that was never pushed)`);
    else if (state === 'in-base') p.push(`Commit ${f.Commit} is already in the base: the walk is older than this change`);
    else if (state === 'not-ancestor') p.push(`Commit ${f.Commit} is not an ancestor of HEAD: the walk is of a commit this change does not contain`);
    else {
      const moved = coveredChangedSince(f.Commit);
      if (moved.length) p.push(`${moved.join(', ')} changed after the walked commit ${f.Commit}: walk the flow again at the current commit`);
    }
  }
  const t = Date.parse(f.Walked ?? '');
  if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})$/.test(f.Walked ?? '') || !Number.isFinite(t)) p.push(`Walked is not the gate's timestamp: ${f.Walked ?? 'missing'}`);
  else if (t > Date.now() + CLOCK_SLACK_MS) p.push(`Walked ${f.Walked} is in the future`);
  if (f['Value moment'] === 'not declared') p.push('Value moment is "not declared"');
  if (f.Target === 'unknown') p.push('Target is "unknown"');
  if (/^(map|baseline)$/.test(f.Kind ?? '')) p.push(`Kind is ${f.Kind}: a protected flow needs a walk of its screens or calls, not a ${f.Kind}`);
  if (f.Gate && !PASSING.has(f.Gate)) p.push(`Gate is ${f.Gate}: only PASS or PASS-WITH-OVERRIDES lets the change through`);
  if (f.Rules && f.Rules !== RULES_VERSION) p.push(`Rules ${f.Rules} is not the vendored gate's ${RULES_VERSION}`);
  return p;
}

/** Problems with a "not affected" record, or []. */
export function notAffectedProblems(text, { id, baseDate, today, hits, flowChanged }) {
  const p = [];
  const f = fields(text);
  if (flowChanged) p.push('the flow file or its map changed in this change, so the flow did change: walk it');
  if (f.Flow !== id) p.push(`Flow is not ${id}`);
  const reason = f.Reason ?? '';
  if (reason.length < 20 || reason.split(/\s+/).length < 4) p.push('Reason must say why the flow is unchanged (at least 20 characters, four words)');
  if (!/[\p{L}\p{N}]/u.test(f.By ?? '')) p.push('By must name who judged it');
  if (!realDate(f.Date ?? '') || f.Date < baseDate || f.Date > today) p.push(`Date ${f.Date ?? 'missing'} is not a real date between the base commit (${baseDate}) and today`);
  const listed = new Set([...(f.Changed ?? '').matchAll(/`([^`]+)`/g)].map((m) => m[1]));
  const unlisted = hits.filter((h) => !listed.has(h));
  if (unlisted.length) p.push(`Changed does not name ${unlisted.map((h) => `\`${h}\``).join(', ')}`);
  return p;
}

function main(argv) {
  if (!existsSync(CHANGED)) usage(`${CHANGED} is missing (FlowChad flow-gate skill)`);
  let base = argv[0] ?? '';
  if (/^0+$/.test(base)) base = '';
  if (!base) {
    try { base = git('merge-base', 'HEAD', 'origin/main'); } catch { usage('no base: pass a ref or fetch origin/main'); }
  }
  if (!gitOk('rev-parse', '--verify', '--quiet', `${base}^{commit}`)) usage(`unknown base: ${base}`);
  const short = git('rev-parse', '--short', base);
  const baseDate = new Date(Date.parse(git('show', '-s', '--format=%cI', base))).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  const changed = [...new Set([...git('diff', '--name-only', base).split('\n'), ...git('ls-files', '--others', '--exclude-standard').split('\n')].filter(Boolean))];
  const added = new Set([...git('diff', '--name-only', '--diff-filter=A', base, '--', WALKS).split('\n'), ...git('ls-files', '--others', '--exclude-standard', '--', WALKS).split('\n')].filter(Boolean));
  const commitState = (sha) => {
    if (!gitOk('rev-parse', '--verify', '--quiet', `${sha}^{commit}`)) return 'unknown';
    if (gitOk('merge-base', '--is-ancestor', sha, base)) return 'in-base';
    return gitOk('merge-base', '--is-ancestor', sha, 'HEAD') ? 'new' : 'not-ancestor';
  };

  const verdicts = spawnSync('bash', [CHANGED, '--base', base], { encoding: 'utf8' });
  if (verdicts.status === 2) usage(verdicts.stderr.trim());
  const failures = [];
  for (const line of verdicts.stdout.split('\n').filter(Boolean)) {
    const [verdict, id, reason] = line.split('\t');
    const flowPath = `${FLOWS}/${id}.yml`;
    if (!existsSync(flowPath)) continue;
    const yml = readFileSync(flowPath, 'utf8');
    if (!/^tags:.*[[, ]protected[\], ]/m.test(yml)) continue;
    if (verdict === 'maybe') { console.log(`maybe  ${id}: ${reason} (not enforced; read it)`); continue; }
    if (verdict !== 'walk') continue;

    const mapPath = `${FLOWS}/${id}.map.md`;
    const flowChanged = changed.includes(flowPath) || changed.includes(mapPath);
    const hits = changed.filter((f) => coversOf(yml).some((g) => globMatches(g, f)));
    const newFlow = !gitOk('cat-file', '-e', `${base}:${flowPath}`);
    const covered = (f) => f === flowPath || f === mapPath || coversOf(yml).some((g) => globMatches(g, f));
    const coveredChangedSince = (sha) => git('diff', '--name-only', sha, 'HEAD').split('\n').filter((f) => f && covered(f));
    const walkRe = walkRecordName(id);
    const naRe = notAffectedName(id);
    const tried = [];
    let ok = null;
    for (const file of [...added].filter((f) => f.startsWith(`${WALKS}/`) && walkRe.test(f.slice(WALKS.length + 1))).sort().reverse()) {
      const problems = walkRecordProblems(readFileSync(file, 'utf8'), { id, newFlow, commitState, coveredChangedSince });
      if (!problems.length) { ok = `walked (${file})`; break; }
      tried.push(`${file}:\n      - ${problems.join('\n      - ')}`);
    }
    if (!ok) for (const file of [...added].filter((f) => f.startsWith(`${WALKS}/`) && naRe.test(f.slice(WALKS.length + 1))).sort().reverse()) {
      const problems = notAffectedProblems(readFileSync(file, 'utf8'), { id, baseDate, today, hits, flowChanged });
      if (!problems.length) { ok = `not affected (${file}, reviewed)`; break; }
      tried.push(`${file}:\n      - ${problems.join('\n      - ')}`);
    }
    const old = readdirSync(WALKS).filter((f) => walkRecordName(id).test(f) || notAffectedName(id).test(f)).map((f) => `${WALKS}/${f}`).filter((f) => changed.includes(f) && !added.has(f));
    if (ok) { console.log(`ok     ${id}: ${ok}`); continue; }
    failures.push([
      `REWALK ${id}: ${reason}`,
      `    files on this flow changed since ${short}: ${hits.length ? hits.join(', ') : '(the flow file or its map)'}`,
      ...(tried.length ? ['    records in this change that do not count:', ...tried.map((t) => `    ${t}`)] : [`    no new ${WALKS}/<date>-${id}.md or ${WALKS}/<date>-${id}.not-affected.md in this change`]),
      ...(old.length ? [`    edited, not added (an edit to an older record does not count): ${old.join(', ')}`] : []),
    ].join('\n'));
  }

  if (failures.length) {
    console.log(failures.join('\n'));
    console.error(`
A protected value flow changed (ADR 0012). For each flow above, add ONE record to this pull request:
  - it changed what a person sees or does: walk it on a local copy of the current commit (a covered file that changes after the walked commit, here or in main, asks for a new walk) and commit the gate's record:
      /flow-walk <id>   then   /flow-gate <id> --target <url> --record ${WALKS}
    (if the flow itself changed, update ${FLOWS}/<id>.map.md first: map before building)
  - it did not (a refactor, a log line, a fix the person cannot see): add ${WALKS}/<YYYY-MM-DD>-<id>.not-affected.md
      - **Flow:** <id>
      - **Changed:** \`<every file listed above>\`
      - **Reason:** <why the flow is unchanged>
      - **By:** <who judged it>
      - **Date:** <YYYY-MM-DD>
    The reviewer accepts or rejects that reason. See AGENTS.md and scripts/check-flows.mjs.`);
    return 1;
  }
  console.log(`check-flows: no protected flow needs a new record since ${short}`);
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) process.exit(main(process.argv.slice(2)));
