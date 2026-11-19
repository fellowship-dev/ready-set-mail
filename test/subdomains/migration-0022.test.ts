// F: migration 0022 follows the repo's migration rules (packages/db/SCHEMA.md "Changing the schema"): a new numbered file, additive only, the newest
// migration the Worker requires, the columns in schema.ts, the export decision made for each, the drizzle baseline regenerated.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXPORT_COLUMNS, REQUIRED_MIGRATION } from '@ready-set-mail/db';
import { createMigratedD1 } from '@ready-set-mail/db/testing';

const ROOT = join(import.meta.dirname, '../..');
const sql = readFileSync(join(ROOT, 'migrations/0022_report_alignment.sql'), 'utf8');

describe('migration 0022_report_alignment', () => {
  const db = createMigratedD1().sqlite;
  const info = (t: string) => db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string; notnull: number; dflt_value: unknown }>;
  it('exists, and REQUIRED_MIGRATION names the newest migration file', () => {
    const files = readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
    expect(files).toContain('0022_report_alignment.sql');
    expect(REQUIRED_MIGRATION).toBe(files[files.length - 1]);
  });
  it('is additive: four ADD COLUMN statements, nothing dropped, rewritten or deleted', () => {
    const statements = sql.split('\n').filter((l) => !l.startsWith('--') && l.trim()).join(' ').split(';').map((s) => s.trim()).filter(Boolean);
    expect(statements).toHaveLength(4);
    for (const s of statements) expect(s).toMatch(/^ALTER TABLE (report_records|aggregate_reports) ADD COLUMN \w+ (INTEGER|TEXT)$/);
    expect(sql).not.toMatch(/\bDROP\b|\bDELETE\b|\bUPDATE\b|\bRENAME\b|NOT NULL/i);
  });
  it('the four columns are nullable with no default, so old rows and the old Worker are unaffected', () => {
    for (const [table, cols] of [['report_records', ['spf_aligned', 'dkim_aligned']], ['aggregate_reports', ['aspf', 'adkim']]] as const) {
      for (const c of cols) expect(info(table).find((x) => x.name === c), `${table}.${c}`).toMatchObject({ notnull: 0, dflt_value: null });
    }
  });
  it('the export lists each new column (the export-columns test requires a decision for every column)', () => {
    expect(EXPORT_COLUMNS.report_records).toEqual(expect.arrayContaining(['spf_aligned', 'dkim_aligned']));
    expect(EXPORT_COLUMNS.aggregate_reports).toEqual(expect.arrayContaining(['aspf', 'adkim']));
  });
  it('the drizzle baseline and snapshot carry the columns', () => {
    const baseline = readFileSync(join(ROOT, 'packages/db/drizzle/0000_baseline.sql'), 'utf8');
    for (const c of ['spf_aligned', 'dkim_aligned', 'aspf', 'adkim']) expect(baseline).toContain(`\`${c}\``);
    expect(readFileSync(join(ROOT, 'packages/db/drizzle/meta/0000_snapshot.json'), 'utf8')).toContain('"spf_aligned"');
  });
  it('UPGRADING.md and the changelog name it', () => {
    expect(readFileSync(join(ROOT, 'packages/db/UPGRADING.md'), 'utf8')).toContain('## Report alignment (0022)');
    expect(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')).toContain('Migration `0022`');
  });
});
