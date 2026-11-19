// One DMARC verdict per stored record: the SQL (`verdictSql`) and its TS twin (`dmarcVerdict`) give the same answer for every combination
// of {1 aligned, 0 not, NULL stored before 0022, -1 not recoverable by the backfill} on both identifiers.
import { describe, expect, it } from 'vitest';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { verdictSql } from '@ready-set-mail/db';
import { dmarcVerdict } from '@ready-set-mail/dns-checks/alignment';
import { createMigratedD1 } from '@ready-set-mail/db/testing';

const VALUES = [0, 1, null, -1] as const;

describe('the DMARC verdict of a stored record', () => {
  const sqlite = createMigratedD1().sqlite;
  const { sql: verdict } = new SQLiteSyncDialect().sqlToQuery(verdictSql('rr'));
  const run = (spf: number | null, dkim: number | null) =>
    (sqlite.prepare(`SELECT ${verdict} AS v FROM (SELECT ? AS spf_aligned, ? AS dkim_aligned) rr`).get(spf, dkim) as { v: string }).v;
  for (const spf of VALUES) {
    for (const dkim of VALUES) {
      it(`spf_aligned=${spf} dkim_aligned=${dkim}`, () => expect(run(spf, dkim)).toBe(dmarcVerdict({ spf_aligned: spf, dkim_aligned: dkim })));
    }
  }
  it('the rules', () => {
    expect(dmarcVerdict({ spf_aligned: 0, dkim_aligned: 0 })).toBe('failed');
    expect(dmarcVerdict({ spf_aligned: 1, dkim_aligned: 1 })).toBe('passed');
    expect(dmarcVerdict({ spf_aligned: 1, dkim_aligned: 0 })).toBe('passed-one');
    expect(dmarcVerdict({ spf_aligned: null, dkim_aligned: 1 })).toBe('passed-one');
    expect(dmarcVerdict({ spf_aligned: -1, dkim_aligned: -1 })).toBe('not-recorded');
    expect(dmarcVerdict({})).toBe('not-recorded');
    expect(dmarcVerdict({ spf_aligned: 0, dkim_aligned: null })).toBe('not-recorded');
  });
});
