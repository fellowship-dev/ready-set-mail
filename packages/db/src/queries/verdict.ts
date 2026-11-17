import { sql, type SQL } from 'drizzle-orm';
import type { DmarcVerdict } from '@ready-set-mail/dns-checks/alignment';

export type { DmarcVerdict };

/**
 * The DMARC verdict of one stored report record, in SQL: THE one rule every query that judges a record uses. Its TS twin is `dmarcVerdict`
 * (packages/dns-checks/src/alignment.ts), and a test runs both over every combination.
 *
 * `spf_aligned` / `dkim_aligned` are the receiver's policy_evaluated results (RFC 9990 section 3.1.1.9): 1 aligned, 0 not aligned.
 * NULL: the record was stored before migration 0022. -1: the daily backfill could not recover it (both columns). RFC 9989 section 5.3.5:
 * a message passes DMARC when SPF or DKIM passes and aligns, so one aligned identifier is enough.
 *   failed        both 0
 *   passed        both 1
 *   passed-one    exactly one is 1 (DMARC passed, with no backup)
 *   not-recorded  anything else: never counted as failed or as passing
 * `alias` is the table alias of report_records in the statement (a trusted literal, never user input).
 */
export function verdictSql(alias: string): SQL {
	const s = sql.raw(`${alias}.spf_aligned`);
	const d = sql.raw(`${alias}.dkim_aligned`);
	return sql`CASE WHEN ${s} = 0 AND ${d} = 0 THEN 'failed' WHEN ${s} = 1 AND ${d} = 1 THEN 'passed' WHEN ${s} = 1 OR ${d} = 1 THEN 'passed-one' ELSE 'not-recorded' END`;
}
