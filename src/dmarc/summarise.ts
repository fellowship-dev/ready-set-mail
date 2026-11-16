// A report with more rows than a report is stored with is ACCEPTED, never refused whole (docs/adr/0016).
//
//   passing rows   every row that passes DMARC for the customer's own domain (aligned SPF or aligned DKIM: the parser's own judgement,
//                  `alignment.dmarc`, not decided again here). All kept, always.
//   failing rows   the ones with the most messages are kept as they are (up to `keepFailing`); the rest are folded into one summary row per source
//                  NETWORK (an IPv4 /24, an IPv6 /48; ASN needs a database we do not ship, so the network is the unit), disposition and results. Message
//                  totals stay exact: a summary row's count is the sum of the rows it replaces, and it says how many source addresses it stands for.
//
// A spoofing run produces failing rows from many addresses; folding them keeps the evidence (who sends as you, from which networks, how often) and
// keeps the storage bounded without ever deciding that a customer's own mail did not fit.
import type { ReportRecord } from './types';

/** The parser's judgement of one row: did the mail pass DMARC (aligned SPF or aligned DKIM)? */
export const passes = (r: Pick<ReportRecord, 'alignment'>): boolean => r.alignment.dmarc === true;

/** At most this many summary rows are written for one report when the room allows; when it does not, one row per result combination. */
export const SUMMARY_ROWS_MAX = 200;
export const SUMMARY_ROWS_MIN = 12;

export interface Shaped {
  records: ReportRecord[];
  /** Failing rows folded into summary rows, and how many distinct source addresses they came from. Zero: nothing was folded. */
  summarisedRows: number;
  summarisedSources: number;
}

/** The network a source address belongs to, at `coarse` = 0 (/24 or /48), 1 (/16 or /32) or 2 (no network: one bucket). */
export function networkOf(ip: string, coarse: 0 | 1 | 2): string {
  if (coarse === 2) return '*';
  if (ip.includes(':')) {
    const groups = expandV6(ip);
    if (!groups) return ip;
    const n = coarse === 0 ? 3 : 2;
    return `${groups.slice(0, n).map((g) => g.toString(16)).join(':')}::/${n * 16}`;
  }
  const o = ip.split('.');
  if (o.length !== 4) return ip;
  return coarse === 0 ? `${o[0]}.${o[1]}.${o[2]}.0/24` : `${o[0]}.${o[1]}.0.0/16`;
}

/** Eight 16-bit groups of an IPv6 address (with `::` and an embedded IPv4 tail handled), or null when it is not one. */
function expandV6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const v4 = s.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) s = `${v4[1]}${((+v4[2]! << 8) | +v4[3]!).toString(16)}:${((+v4[4]! << 8) | +v4[5]!).toString(16)}`;
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

const resultKey = (r: ReportRecord) => `${r.policy_evaluated.disposition}|${r.policy_evaluated.dkim}|${r.policy_evaluated.spf}|${r.identifiers.header_from}`;

/**
 * Keep every passing row and the `keepFailing` failing rows with the most messages (ties: the lower address first, so the choice is the same on every
 * run); fold the rest. `groupMax` bounds the summary rows (coarser networks are tried when there would be more).
 */
export function shapeRecords(records: ReportRecord[], opts: { keepFailing: number; groupMax?: number }): Shaped {
  const failing = records.filter((r) => !passes(r));
  const keep = Math.max(0, Math.floor(opts.keepFailing));
  if (failing.length <= keep) return { records, summarisedRows: 0, summarisedSources: 0 };
  const groupMax = Math.max(1, opts.groupMax ?? (keep >= SUMMARY_ROWS_MAX ? SUMMARY_ROWS_MAX : SUMMARY_ROWS_MIN));
  const ranked = [...failing].sort((a, b) => b.count - a.count || (a.source.ip < b.source.ip ? -1 : a.source.ip > b.source.ip ? 1 : 0));
  const kept = new Set(ranked.slice(0, keep));
  const folded = ranked.slice(keep);
  let coarse: 0 | 1 | 2 = 0;
  let groups = group(folded, coarse);
  while (groups.size > groupMax && coarse < 2) { coarse = (coarse + 1) as 1 | 2; groups = group(folded, coarse); }
  const summary: ReportRecord[] = [...groups.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([key, rows]) => {
    const first = rows[0]!;
    const network = key.split('|')[0]!;
    return {
      source: { ip: network === '*' ? '*' : network, reverse_dns: null, base_domain: null, country_code: null, country_name: null, subdivision: null, city: null, org: null, asn: null },
      count: rows.reduce((n, r) => n + r.count, 0),
      alignment: first.alignment,
      policy_evaluated: { ...first.policy_evaluated, policy_override_reasons: [] },
      identifiers: { header_from: first.identifiers.header_from, envelope_from: null, envelope_to: null },
      auth_results: { dkim: [], spf: [] },
      summarised_sources: new Set(rows.map((r) => r.source.ip)).size,
    } satisfies ReportRecord;
  });
  return {
    records: [...records.filter((r) => passes(r) || kept.has(r)), ...summary],
    summarisedRows: folded.length,
    summarisedSources: new Set(folded.map((r) => r.source.ip)).size,
  };
}

function group(rows: ReportRecord[], coarse: 0 | 1 | 2): Map<string, ReportRecord[]> {
  const m = new Map<string, ReportRecord[]>();
  for (const r of rows) {
    const k = `${networkOf(r.source.ip, coarse)}|${resultKey(r)}`;
    m.set(k, [...(m.get(k) ?? []), r]);
  }
  return m;
}
