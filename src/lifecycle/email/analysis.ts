// What a week of reports says, as facts: pure functions over rows the queries return (packages/db/src/queries/lifecycle-email.ts).
//
// Two kinds of number, never mixed up:
//  - EXACT: the totals of a report (messages, and how many passed DMARC as the reporter evaluated them). Pass rates and "every message passed" use only these.
//  - ESTIMATED: which SOURCE failed. The database keeps each record's raw SPF and DKIM result and domain, not the report's own aligned verdict, so a
//    source's failing messages are derived the way the sender inventory derives them (src/analytics/senders.ts `recordAlignment`, relaxed
//    alignment). An estimate never exceeds the exact failing total, and when the reporter said nothing failed, no source failed.

import type { WeekSourceRow } from '@ready-set-mail/db';
import { recordAlignment } from '../../analytics/senders';
import { TIP_MIN_MESSAGES } from './kinds';

export interface SourceStat {
  /** Lowercase `org`, else `base_domain`, else the IP: what "the same source" means across weeks. */
  key: string;
  /** How a person would name it: the organisation, else the reverse DNS name, else the base domain; null when only the address is known. */
  name: string | null;
  /** Addresses it sent from, the busiest first. */
  ips: string[];
  messages: number;
  /** Messages that did not pass DMARC (estimated, see above). */
  failing: number;
  /** What the failing messages DID pass, for another domain: DKIM first. Null when they passed nothing. */
  other: { by: 'DKIM' | 'SPF'; domain: string } | null;
}

export const sourceKey = (r: Pick<WeekSourceRow, 'org' | 'base_domain' | 'source_ip'>): string => (r.org || r.base_domain || r.source_ip).trim().toLowerCase();

/** "Google Workspace (209.85.220.41)", "o1.email.sendgrid.net (192.0.2.7 and 2 more addresses)", or the bare address. */
export function sourceLabel(s: Pick<SourceStat, 'name' | 'ips'>): string {
  const ip = s.ips[0] ?? 'unknown';
  if (!s.name) return s.ips.length > 1 ? `${ip} and ${s.ips.length - 1} more` : ip;
  return s.ips.length > 1 ? `${s.name} (${ip} and ${s.ips.length - 1} more)` : `${s.name} (${ip})`;
}
/** The short name of a source in running text: its name, else its address. */
export const sourceName = (s: Pick<SourceStat, 'name' | 'ips'>): string => s.name ?? s.ips[0] ?? 'an unknown source';

/**
 * Rolls rows up per source. `exactFailed`: the exact number of messages that did not pass in the same reports; no source is credited with more
 * than that, and 0 (or an unknown count of 0) means every message passed.
 */
export function sourceStats(rows: readonly WeekSourceRow[], exactFailed: number | null = null): SourceStat[] {
  interface Acc { stat: SourceStat; byIp: Map<string, number>; passedFor: Map<string, number>; name: Map<string, number> }
  const acc = new Map<string, Acc>();
  for (const r of rows) {
    const key = sourceKey(r);
    const a = acc.get(key) ?? { stat: { key, name: null, ips: [], messages: 0, failing: 0, other: null }, byIp: new Map(), passedFor: new Map(), name: new Map() };
    acc.set(key, a);
    a.stat.messages += r.messages;
    a.byIp.set(r.source_ip, (a.byIp.get(r.source_ip) ?? 0) + r.messages);
    const n = r.org || r.reverse_dns || r.base_domain;
    if (n) a.name.set(n, (a.name.get(n) ?? 0) + r.messages);
    const al = recordAlignment(r);
    if (al.spf || al.dkim) continue;
    a.stat.failing += r.messages;
    const other = r.dkim_result === 'pass' && r.dkim_domain ? (['DKIM', r.dkim_domain] as const) : r.spf_result === 'pass' && r.spf_domain ? (['SPF', r.spf_domain] as const) : null;
    if (other) a.passedFor.set(`${other[0]}|${other[1].trim().toLowerCase()}`, (a.passedFor.get(`${other[0]}|${other[1].trim().toLowerCase()}`) ?? 0) + r.messages);
  }
  const top = (m: Map<string, number>) => [...m.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0]?.[0] ?? null;
  return [...acc.values()].map((a) => {
    const passedFor = top(a.passedFor);
    const [by, domain] = passedFor ? passedFor.split('|') : [];
    return {
      ...a.stat,
      name: top(a.name),
      ips: [...a.byIp.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map(([ip]) => ip),
      failing: exactFailed === null ? a.stat.failing : Math.min(a.stat.failing, Math.max(0, exactFailed)),
      other: passedFor ? { by: by as 'DKIM' | 'SPF', domain } : null,
    };
  }).sort((x, y) => y.messages - x.messages || x.key.localeCompare(y.key));
}

/** A source that is failing and, once it passes, stops being one. */
export const failingSources = (stats: readonly SourceStat[]): SourceStat[] => stats.filter((s) => s.failing > 0).sort((a, b) => b.failing - a.failing || a.key.localeCompare(b.key));

/** Tip (i): sources whose DKIM or SPF passed for another domain while most of their messages did not pass DMARC for this one, at least TIP_MIN_MESSAGES. */
export function tipFixSources(stats: readonly SourceStat[]): SourceStat[] {
  return failingSources(stats).filter((s) => s.other && s.failing >= TIP_MIN_MESSAGES && s.failing * 2 >= s.messages);
}

// ── Weeks ────────────────────────────────────────────────────

export interface Totals { total: number; passed: number; reports: number }
export const noTotals = (): Totals => ({ total: 0, passed: 0, reports: 0 });

/** Every counted message of the week passed DMARC (the reporters' own totals), and there was at least one. */
export const allPassed = (t: Totals): boolean => t.total > 0 && t.passed >= t.total;

/** Whole-number pass rate, 0 when there is nothing. */
export const passRate = (t: Pick<Totals, 'total' | 'passed'>): number => (t.total > 0 ? Math.round((t.passed / t.total) * 100) : 0);

// ── The weekly summary ───────────────────────────────────────

export interface SummaryDomain {
  id: number;
  domain: string;
  /** `p=none`, or null when no DMARC record has been read. */
  policy: string | null;
  this: Totals;
  last: Totals;
  /** Sources by week: this week, last week, and the four weeks before this one (keys only; with messages). */
  sources: SourceStat[];
  lastSources: SourceStat[];
  earlierKeys: ReadonlySet<string>;
}

export type Change =
  | { kind: 'new_source'; domain: string; source: SourceStat }
  | { kind: 'started_failing'; domain: string; source: SourceStat }
  | { kind: 'no_reports'; domain: string };

export interface SummaryFacts {
  domains: SummaryDomain[];
  totals: Totals;
  changes: Change[];
  /** The one thing to do, chosen in this order: a source that started failing, a new source that fails, a domain that stopped getting reports. */
  todo: Change | null;
}

/** What changed since the week before, per domain. The week's sources are matched to last week's and the four weeks before by key. */
export function summarise(domains: readonly SummaryDomain[]): SummaryFacts {
  const changes: Change[] = [];
  for (const d of domains) {
    const lastBy = new Map(d.lastSources.map((s) => [s.key, s]));
    for (const s of d.sources) {
      if (s.messages <= 0) continue;
      const before = lastBy.get(s.key);
      if (before && before.messages > 0 && before.failing === 0 && s.failing > 0) changes.push({ kind: 'started_failing', domain: d.domain, source: s });
      else if (!before && !d.earlierKeys.has(s.key)) changes.push({ kind: 'new_source', domain: d.domain, source: s });
    }
    if (d.last.total > 0 && d.this.total === 0) changes.push({ kind: 'no_reports', domain: d.domain });
  }
  const rank = (c: Change) => (c.kind === 'started_failing' ? 0 : c.kind === 'new_source' && c.source.failing > 0 ? 1 : c.kind === 'no_reports' ? 2 : 3);
  const size = (c: Change) => (c.kind === 'no_reports' ? 0 : c.source.failing);
  const todo = [...changes].filter((c) => rank(c) < 3).sort((a, b) => rank(a) - rank(b) || size(b) - size(a) || a.domain.localeCompare(b.domain))[0] ?? null;
  const totals = domains.reduce<Totals>((t, d) => ({ total: t.total + d.this.total, passed: t.passed + d.this.passed, reports: t.reports + d.this.reports }), noTotals());
  return { domains: [...domains], totals, changes, todo };
}

/** Nothing to say: no counted reports and nothing changed. */
export const quietWeek = (f: Pick<SummaryFacts, 'totals' | 'changes'>): boolean => f.totals.total === 0 && f.changes.length === 0;
