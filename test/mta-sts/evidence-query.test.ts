// The enforce decision reads ONE query (`tlsEvidence`): counted reports only. enforceReadiness filters by tier too, so only a test of the query itself fails when the
// tier filter is dropped from the SQL: without it a flood of strangers' reports fills the query's LIMIT and pushes the one real report out of the evidence.
// And the page's sentence and its table are one set: the counted reports (tlsRecent, tlsSummary(countedOnly)); the rest is one separate count.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetSchemaReadyCache } from '@ready-set-mail/db';
import { scope } from '../../src/db/scope';
import { mtaWorld, quietLogs } from './world';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));
beforeEach(() => { quietLogs(); resetSchemaReadyCache(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const DAY = 86400;
const T = Math.floor(Date.now() / 1000);

async function seeded(strangers: number) {
  const w = await mtaWorld();
  const ins = w.db.sqlite.prepare("INSERT INTO tls_reports (domain_id, org_name, date_begin, date_end, total_success, total_failure, sts_success, sts_failure, sts_failure_types, workspace_id, reporter_tier, reporter_identity) VALUES (1, ?, ?, ?, ?, 0, ?, 0, '[]', ?, ?, ?)");
  // The real report is the OLDEST: a flood of newer strangers' reports would fill a LIMIT-ed query without the tier filter.
  ins.run('Google', T - 6 * DAY, T - 5 * DAY, 40, 40, w.A.ws, 'counted', 'google');
  w.db.sqlite.exec('BEGIN');
  for (let i = 0; i < strangers; i++) ins.run('Google', T - 3 * DAY + i, T - 2 * DAY + i, 900, 900, w.A.ws, i % 2 ? 'unauthenticated' : 'unknown', i % 2 ? '~unauth' : 'example.org');
  w.db.sqlite.exec('COMMIT');
  ins.run('Legacy', T - 4 * DAY, T - 3 * DAY, 5, 5, w.A.ws, null, null);
  return w;
}

describe('tlsEvidence (what the enforce decision reads) is counted reports only', () => {
  it('returns the counted report, and nothing from strangers, unauthenticated senders or rows from before tiers existed', async () => {
    const w = await seeded(8);
    const rows = await scope(w.db, w.A.ws).reports.tlsEvidence(1, T - 14 * DAY);
    expect(rows.map((r) => r.reporter_tier)).toEqual(['counted']);
  });

  it('600 newer reports from strangers cannot push the one counted report out of it', async () => {
    const w = await seeded(600);
    const rows = await scope(w.db, w.A.ws).reports.tlsEvidence(1, T - 14 * DAY);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reporter_tier: 'counted', sts_success: 40 });
  });
});

describe('the page: one count source', () => {
  it('the table and the summary are the counted reports (whatever REPORT_COUNTING says); the others are a count of their own', async () => {
    const w = await mtaWorld({ REPORT_COUNTING: 'all' });
    await w.mta(w.A.token, 'POST', 1);
    const ins = w.db.sqlite.prepare("INSERT INTO tls_reports (domain_id, org_name, date_begin, date_end, total_success, total_failure, sts_success, sts_failure, sts_failure_types, workspace_id, reporter_tier, reporter_identity) VALUES (1, ?, ?, ?, ?, 0, ?, 0, '[]', ?, ?, ?)");
    ins.run('Google', T - 2 * DAY, T - DAY, 40, 40, w.A.ws, 'counted', 'google');
    ins.run('Google', T - 2 * DAY + 5, T - DAY, 900, 900, w.A.ws, 'unauthenticated', '~unauth'); // claims Google, no verified signature
    const body = await w.json(await w.mta(w.A.token, 'GET', 1));
    expect(body.reports).toHaveLength(1);
    expect(body.reports[0]).toMatchObject({ counted: true, reporter: 'Google' });
    expect(body.summary).toMatchObject({ report_count: 1, sts_success: 40 });
    expect(body.evidence).toMatchObject({ counted_reports: 1, uncounted_reports: 1, reporters: ['Google', 'Microsoft'] });
  });

  it('the enforce rule comes with each line met or missing, and says what an operator added', async () => {
    const w = await mtaWorld({ INTAKE_KNOWN_REPORTERS: 'acme|Acme receiver|acme-mail.com|dmarc@acme-mail.com|dmarc@acme-mail.com|tls@acme-mail.com|tls@acme-mail.com' });
    await w.mta(w.A.token, 'POST', 1);
    const body = await w.json(await w.mta(w.A.token, 'GET', 1));
    expect(body.evidence.reporters).toEqual(['Google', 'Microsoft', 'Acme receiver']);
    expect(body.enforce.checks.map((c: any) => c.key)).toEqual(['days', 'report', 'failures', 'mx', 'served']);
    expect(body.enforce.checks.find((c: any) => c.key === 'report').label).toBe('A report signed by Google, Microsoft or Acme receiver about this policy, with successful sessions');
  });
});
