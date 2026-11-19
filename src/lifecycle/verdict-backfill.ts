// Daily backfill of the receiver's alignment verdict (report_records.spf_aligned / dkim_aligned) for rows stored before migration 0022.
// Runs before retention (which clears raw XML). Bounded (a few reports per run, newest first) and idempotent: only NULL rows are written,
// and a report that cannot be read back exactly gets -1/-1 ("verdict not recorded") and is never retried.
// The verdict itself is computed by toTuple (src/dmarc/store-report.ts), the same expressions intake uses.

import { lifecycleQueries, sweepLimits } from '@ready-set-mail/db';
import { parseAggregateReportXml } from '../dmarc/parse-aggregate';
import { toTuple } from '../dmarc/store-report';

const REPORTS_PER_RUN = 20;
const MAX_RECORDS_PER_RUN = 1000;

export async function backfillVerdicts(env: { DB: D1Database }): Promise<Record<string, number>> {
  const q = lifecycleQueries(env.DB);
  const allFailed = await q.backfillAllFailed(sweepLimits({ statements: 20 }));
  const out = { allFailed, reports: 0, matched: 0, unrecoverable: 0, records: 0 };
  const rows: Array<[number, number, number]> = [];
  for (const rep of await q.reportsToBackfill(REPORTS_PER_RUN)) {
    if (rows.length > MAX_RECORDS_PER_RUN) break;
    out.reports++;
    const todo = rep.records.filter((r) => r.unset);
    let verdicts: Array<[number, number]> | null = null;
    try {
      const parsed = await parseAggregateReportXml(rep.raw_xml, true);
      if (parsed.records.length === rep.records.length) {
        const tuples = parsed.records.map(toTuple);
        if (tuples.every((t, i) => t[0] === rep.records[i].source_ip && t[1] === rep.records[i].count)) {
          verdicts = tuples.map((t) => [t[12] as number, t[13] as number]);
        }
      }
    } catch { /* unreadable: not recoverable */ }
    if (verdicts) out.matched++; else out.unrecoverable++;
    for (const r of todo) {
      const i = rep.records.indexOf(r);
      rows.push([r.id, verdicts ? verdicts[i][0] : -1, verdicts ? verdicts[i][1] : -1]);
    }
  }
  out.records = await q.setVerdicts(rows);
  console.log(JSON.stringify({ event: 'verdict_backfill', ...out }));
  return out;
}
