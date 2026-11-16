// The words of every lifecycle email, as blocks: one list of blocks becomes both the HTML (src/email/html-templates.ts `buildLetterHtml`, the
// brand header and one column) and the plain text (`buildLetterText`), so the two cannot say different things.
//
// Rules for this copy (tested in test/lifecycle/email/copy.test.ts): no emoji; none of the scare words (no "could not be authenticated", "claims to
// be", "spoof", "attack", "at risk", "exposed", "action needed"); say what is known; dates in UTC; one button-styled link per email.

import { dmarcRecordFor, inForceSentence, type DmarcStep, type InForce, type Policy } from '@ready-set-mail/dns-checks/dmarc-next-step';
import { buildLetterHtml, buildLetterText, type LetterBlock } from '../../email/html-templates';
import { OFFER_NAME, REFUND_RULE } from '../../billing/offer';
import { OFFER_SUMMARY } from './offer';
import { uncountedNotice } from '../../reports/visibility';
import { sourceLabel, sourceName, passRate, type Change, type SourceStat, type SummaryFacts } from './analysis';
import type { LifecycleKind } from './kinds';
import { dayAtText, dayText, rangeText } from './time';
import { greeting } from './preferences';

export interface Mail { kind: LifecycleKind; subject: string; blocks: LetterBlock[] }
export interface Rendered { subject: string; text: string; html: string }

export function render(mail: Mail): Rendered {
  return { subject: mail.subject, text: buildLetterText(mail.blocks), html: buildLetterHtml({ title: mail.subject, blocks: mail.blocks }) };
}

const n = (x: number): string => x.toLocaleString('en-US');
const messages = (x: number): string => `${n(x)} ${x === 1 ? 'message' : 'messages'}`;
const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

/** Why the person gets this, and the links that go with it. Milestone emails have no off link (transactional). */
export interface Footer {
  why: string;
  settingsUrl: string | null;
  off?: { label: string; url: string };
}
function footer(f: Footer): LetterBlock[] {
  const links = [...(f.off ? [f.off] : []), ...(f.settingsUrl ? [{ label: 'Email settings', url: f.settingsUrl }] : [])];
  return [{ small: f.why }, ...(links.length ? [{ links }] : [])];
}

export interface Who { name: string | null; footer: Footer }

// ── b. Records live ──────────────────────────────────────────

export interface LiveItem { domain: string; seenAt: number }

/** One domain: the exact email. Several domains of one workspace in the same run: one email that lists each. */
export function recordsLive(p: Who & { items: LiveItem[]; domainUrl: string }): Mail {
  const one = p.items.length === 1 ? p.items[0] : null;
  const after = `Mail providers send these reports about once a day, for the days they received mail from ${one ? one.domain : 'these domains'}. First reports usually arrive within a day or two. We will email you when the first one arrives.`;
  return {
    kind: 'records_live',
    subject: one ? `${one.domain} is set up: reports are on their way` : `${p.items.length} domains are set up: reports are on their way`,
    blocks: [
      greeting(p.name),
      ...(one
        ? [`The DMARC record of ${one.domain} now sends its reports to Ready Set Mail. We saw it in public DNS on ${dayAtText(one.seenAt)}.`]
        : ['The DMARC records of these domains now send their reports to Ready Set Mail. We saw each in public DNS:', { list: p.items.map((i) => `${i.domain}: ${dayAtText(i.seenAt)}`) }]),
      after,
      { cta: { label: one ? `Open ${one.domain}` : 'Open Ready Set Mail', url: p.domainUrl } },
      ...footer(p.footer),
    ],
  };
}

// ── c. First report ──────────────────────────────────────────

export interface FirstReportData {
  reporter: string;
  begin: number;
  end: number;
  total: number;
  passed: number;
  /** Distinct sending sources in the report. */
  sources: number;
  /** The largest source that did not pass, when one can be named. */
  failing: SourceStat | null;
  /** The domain's stored DMARC policy. */
  policy: string | null;
}

export interface FirstReportItem { domain: string; data: FirstReportData }

/** `domainUrl` is null only on self-host with no public origin configured: the email goes without its button rather than with a guessed address. */
export function firstReport(p: Who & { items: FirstReportItem[]; domainUrl: string | null }): Mail {
  if (p.items.length > 1) return firstReports(p);
  const { domain, data: d } = p.items[0];
  const failed = Math.max(0, d.total - d.passed);
  const allPassed = failed === 0;
  const span = dayText(d.begin) === dayText(d.end - 1) ? dayText(d.begin) : `${dayText(d.begin)} – ${dayText(d.end - 1)}`;
  const blocks: LetterBlock[] = [
    greeting(p.name),
    `${d.reporter} sent the first DMARC report for ${domain}. It covers mail ${d.reporter} received from the domain on ${span} (UTC).`,
    { table: { head: ['Messages', 'Passed DMARC', 'Did not pass', 'Sending sources'], rows: [{ cells: [n(d.total), n(d.passed), n(failed), n(d.sources)] }] } },
  ];
  if (allPassed) {
    blocks.push(`Every message passed DMARC: each one was sent by a service that ${domain}'s SPF or DKIM records cover.`);
  } else if (d.failing) {
    const f = d.failing;
    const lead = `Worth a look: ${messages(f.failing)} from ${sourceLabel(f)} did not pass DMARC.`;
    const need = `If you use that service, it needs SPF or DKIM set up for ${domain}.`;
    blocks.push(f.other
      ? `${lead} They passed ${f.other.by} for ${f.other.domain}, but not for ${domain}. ${need}`
      : `${lead} ${need}${d.policy === 'none' ? " If you don't recognise it, there is nothing to do while the policy is p=none." : ''}`);
  } else {
    blocks.push(`Worth a look: ${messages(failed)} did not pass DMARC. The domain page lists each source with its numbers.`);
  }
  blocks.push(
    'Reports from other mail providers will follow, usually once a day each.',
    ...(p.domainUrl ? [{ cta: { label: `See who sends as ${domain}`, url: p.domainUrl } }] : []),
    ...footer(p.footer),
  );
  return {
    kind: 'first_report',
    subject: `First DMARC report for ${domain}: ${messages(d.total)}, ${allPassed ? 'all passed' : `${n(d.passed)} passed`}`,
    blocks,
  };
}

/** Several domains whose first report arrived in the same run. */
function firstReports(p: Who & { items: FirstReportItem[]; domainUrl: string | null }): Mail {
  return {
    kind: 'first_report',
    subject: `First DMARC reports for ${p.items.length} domains`,
    blocks: [
      greeting(p.name),
      'The first DMARC report has arrived for each of these domains:',
      { table: { head: ['Domain', 'Reporter', 'Messages', 'Passed DMARC'], rows: p.items.map((i) => ({ cells: [i.domain, i.data.reporter, n(i.data.total), n(i.data.passed)] })) } },
      'Each domain page lists who sends as that domain, with their numbers. Reports from other mail providers will follow, usually once a day each.',
      ...(p.domainUrl ? [{ cta: { label: 'Open Ready Set Mail', url: p.domainUrl } }] : []),
      ...footer(p.footer),
    ],
  };
}

// ── d. No reports yet ────────────────────────────────────────

export type LiveCheck =
  | { outcome: 'names_us' }
  | { outcome: 'does_not'; record: string | null; address: string }
  | { outcome: 'failed' };

export interface NoReportsItem { domain: string; liveAt: number; check: LiveCheck }

function checkLines(domain: string, c: LiveCheck): LetterBlock[] {
  if (c.outcome === 'names_us') return ['It still names Ready Set Mail. Nothing needs changing: the first report will come after the domain sends mail to one of these providers.'];
  if (c.outcome === 'failed') return ['We could not read it just now. The domain page checks it again when you open it.'];
  return [
    ...(c.record ? ['It no longer names Ready Set Mail. Today it reads:', { code: c.record }] as LetterBlock[] : [`It no longer names Ready Set Mail: public DNS shows no DMARC record for ${domain}.`]),
    `Add rua=mailto:${c.address} back to it, or set it again from the domain page.`,
  ];
}

export function noReports(p: Who & { items: NoReportsItem[]; domainUrl: string; emailCheck: boolean }): Mail {
  const one = p.items.length === 1 ? p.items[0] : null;
  // Only when the record still names us (or could not be read) is "no mail has reached a large provider" a reason; a record that dropped us explains itself.
  const why = (d: string) => (p.items.every((i) => i.check.outcome === 'does_not') ? [] : [`That usually means no mail from ${d} has reached a large mail provider since then: providers such as Google, Microsoft and Yahoo send a report only for days when they received mail from the domain. A domain that sends little mail can take a few more days.`]);
  const blocks: LetterBlock[] = [greeting(p.name)];
  if (one) {
    blocks.push(
      `The DMARC record of ${one.domain} has named Ready Set Mail as its report address since ${dayText(one.liveAt)} (UTC), and no report has arrived yet.`,
      ...why(one.domain),
      'We checked the record again just now:',
      ...checkLines(one.domain, one.check),
    );
  } else {
    blocks.push('The DMARC records of these domains have named Ready Set Mail as their report address for at least three days, and no report has arrived yet:', { list: p.items.map((i) => `${i.domain}, since ${dayText(i.liveAt)}`) }, ...why('these domains'), 'We checked each record again just now:');
    for (const i of p.items) blocks.push(`${i.domain}:`, ...checkLines(i.domain, i.check));
  }
  blocks.push({ cta: { label: one ? `Open ${one.domain}` : 'Open Ready Set Mail', url: p.domainUrl } });
  if (p.emailCheck) blocks.push(`To see a result now, send any email from ${one ? one.domain : 'one of these domains'} to the email check on the dashboard.`);
  blocks.push(...footer(p.footer));
  return { kind: 'no_reports', subject: one ? `No DMARC reports yet for ${one.domain}` : `No DMARC reports yet for ${p.items.length} domains`, blocks };
}

// ── e. Weekly summary ────────────────────────────────────────

/** A domain row of the summary table, subdomains nested under their registrable domain. */
export interface SummaryRow { domain: string; indent: boolean; messages: number; passed: number; policy: string | null }

function changeLine(c: Change): string {
  if (c.kind === 'no_reports') return `${c.domain} had reports last week and none this week.`;
  const s = c.source;
  if (c.kind === 'started_failing') return `${sourceName(s)} on ${c.domain} started failing: ${n(s.failing)} of ${messages(s.messages)} did not pass DMARC.`;
  return `New source on ${c.domain}: ${sourceName(s)} sent ${messages(s.messages)}${s.failing > 0 ? `, ${n(s.failing)} did not pass DMARC` : ', all passed'}.`;
}

function todoLine(c: Change | null): string {
  if (!c) return 'Nothing to do this week.';
  if (c.kind === 'no_reports') return `${c.domain} got no reports this week. Check that its DMARC record still names Ready Set Mail.`;
  return `Look at ${sourceName(c.source)} on ${c.domain}${c.kind === 'new_source' ? ' (new this week)' : ''}: ${n(c.source.failing)} of its messages did not pass DMARC this week.`;
}

const MAX_CHANGES = 8;

export function weeklySummary(p: Who & { week: { start: number; end: number }; facts: SummaryFacts; rows: SummaryRow[]; uncounted: number; domainUrl: string; domainName: string | null }): Mail {
  const f = p.facts;
  const label = rangeText(p.week.start, p.week.end);
  const names = f.domains.map((d) => d.domain);
  const subject = f.totals.total > 0
    ? `Week of ${label}: ${names.length === 1 ? names[0] : `${names.length} domains`}, ${messages(f.totals.total)}, ${passRate(f.totals)}% passed`
    : `Week of ${label}: ${names.length === 1 ? names[0] : `${names.length} domains`}, no reports`;
  const changes = f.changes.slice(0, MAX_CHANGES).map(changeLine);
  if (f.changes.length > MAX_CHANGES) changes.push(`and ${f.changes.length - MAX_CHANGES} more.`);
  const blocks: LetterBlock[] = [
    greeting(p.name),
    `Here is what DMARC reports said about your domains last week (${rangeText(p.week.start, p.week.end, true)}, UTC).`,
    {
      table: {
        head: ['Domain', 'Messages', 'Passed', 'Rate', 'Policy'],
        rows: p.rows.map((r) => ({ indent: r.indent, cells: [r.domain, n(r.messages), n(r.passed), r.messages > 0 ? `${passRate({ total: r.messages, passed: r.passed })}%` : '-', r.policy ? `p=${r.policy}` : 'not read'] })),
      },
    },
  ];
  if (p.uncounted > 0) blocks.push(uncountedNotice(p.uncounted));
  blocks.push(changes.length ? 'What changed since the week before:' : 'Nothing changed since the week before.');
  if (changes.length) blocks.push({ list: changes });
  blocks.push('The one thing to do:', todoLine(f.todo), { cta: { label: p.domainName ? `Open ${p.domainName}` : 'Open Ready Set Mail', url: p.domainUrl } }, ...footer(p.footer));
  return { kind: 'summary', subject, blocks };
}

// ── f. Tips ──────────────────────────────────────────────────

/** The offer paragraph of the fix tip, with what it needs: the price as the dashboard writes it. Absent when any of its conditions fails. */
export interface OfferParagraph { price: string; orderUrl: string }

export function tipFix(p: Who & { domain: string; domainUrl: string; source: SourceStat; offer: OfferParagraph | null }): Mail {
  const s = p.source;
  const blocks: LetterBlock[] = [
    greeting(p.name),
    `Last week ${messages(s.failing)} came from ${sourceLabel(s)}. They passed ${s.other!.by} for ${s.other!.domain}, but not for ${p.domain}, so they did not pass DMARC.`,
    `This usually means a service you use sends mail as ${p.domain} and has not been set up with the domain's DNS yet.`,
    "What to do: in that service's settings, find its domain authentication (it gives you DNS records to add) and add them. The next reports will show whether it passes. The domain page lists this source with its numbers.",
    { cta: { label: `Open ${p.domain}`, url: p.domainUrl } },
  ];
  if (p.offer) {
    blocks.push(`Prefer we do it? ${OFFER_NAME}, ${p.offer.price} per domain: ${OFFER_SUMMARY} ${REFUND_RULE}`, { links: [{ label: 'See it on the domain page', url: p.offer.orderUrl }] });
  }
  blocks.push(...footer(p.footer));
  return { kind: 'tip_fix', subject: `One service sending as ${p.domain} needs SPF or DKIM`, blocks };
}

/** "Its policy is p=none, so mail from X that fails DMARC is still delivered." The meaning is the rule module's own sentence (inForceSentence); an inherited policy keeps all of it, because where the policy comes from is part of the story. */
function policySentence(f: InForce): string {
  const policy = `Its policy is p=${f.policy}${f.pct < 100 ? ` at pct=${f.pct}` : ''}`;
  const full = inForceSentence(f);
  const cut = full.lastIndexOf(', so ');
  return f.kind === 'own' && cut >= 0 ? `${policy}, so ${full.slice(cut + 5)}` : `${policy}. ${full}`;
}

export function tipNext(p: Who & { domain: string; domainUrl: string; weeks: { start: number; end: number }; messages: number; sources: number; inForce: InForce; step: DmarcStep; target: Policy; ruaAddress: string | null }): Mail {
  const record = p.step.record ?? dmarcRecordFor({ policy: p.target, pct: 100 }, p.ruaAddress);
  const at = p.step.recordAt ?? `_dmarc.${p.step.at ?? p.domain}`;
  const f = p.inForce;
  const blocks: LetterBlock[] = [
    greeting(p.name),
    `For the last two weeks (${rangeText(p.weeks.start, p.weeks.end)}, UTC), every message in ${p.domain}'s reports passed DMARC: ${messages(p.messages)} from ${p.sources} ${p.sources === 1 ? 'source' : 'sources'}. ${policySentence(f)}`,
    `The next step, when you're ready: ${lowerFirst(p.step.do)}. The record, to publish at ${at}:`,
    { code: record },
    'Mail that passes DMARC is not affected by this change.',
  ];
  if (p.target === 'reject') blocks.push('Moving to p=reject is done in stages; the domain page shows each step when the reports support it.');
  blocks.push({ cta: { label: `Open ${p.domain}`, url: p.domainUrl } }, ...footer(p.footer));
  return { kind: 'tip_next', subject: `${p.domain}: every message passed DMARC for two weeks`, blocks };
}

export function tipDone(p: Who & { domain: string; domainUrl: string; messages: number; sources: number }): Mail {
  return {
    kind: 'tip_done',
    subject: `${p.domain}: nothing to do`,
    blocks: [
      greeting(p.name),
      `${p.domain} is at p=reject, and every message in its reports passed DMARC for the last two weeks (${messages(p.messages)} from ${p.sources} ${p.sources === 1 ? 'source' : 'sources'}). There is nothing to do. Your weekly summary will say if a source starts failing.`,
      { cta: { label: `Open ${p.domain}`, url: p.domainUrl } },
      ...footer(p.footer),
    ],
  };
}
