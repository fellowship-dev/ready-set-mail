// The first-report catch-up, for the owner whose first counted report was stored by code that could not send the email (no lifecycle_sends row).
// Window: the daily job (`0 11 * * *`) sends it for a first counted report whose `aggregate_reports.created_at` (when it was STORED, not the report's
// date_end) is at most FIRST_REPORT_CATCHUP_SECONDS (3 days) before the run: created_at >= run - 3 days. After that, never.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { storeReport } from '../../../src/dmarc/store-report';
import { FIRST_REPORT_CATCHUP_SECONDS, FIRST_REPORT_EMAIL_LEGACY_UNTIL } from '../../../src/lifecycle/email/kinds';
import { DAY, MON_16_NOV, lifecycleWorld, recordNamingUs, BASE, WS, type World } from './world';

const D = 'brightwave-mail.com';
const T0 = MON_16_NOV - 25 * 3600; // Sun 15 Nov 10:00 UTC: the counted report is stored; the next 0 11 run is 25 hours later
const google = { ip: '192.0.2.10', count: 40, spf: ['pass', D] as [string, string], dkim: ['pass', D] as [string, string], org: 'Google Workspace' };
const sendgrid = { ip: '198.51.100.7', count: 8, spf: ['pass', 'sendgrid.net'] as [string, string], dkim: ['pass', 'sendgrid.net'] as [string, string], org: 'SendGrid' };

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const firstReports = (w: World) => w.mailer.sent.filter((m) => m.subject.startsWith('First DMARC report'));
const claim = (w: World) => w.rows("SELECT * FROM lifecycle_sends WHERE kind = 'first_report'");
const setNow = (w: World, t: number) => { w.clock.now = t; vi.setSystemTime(t * 1000); };

/** The owner's instance: one proven domain, reports connected, ONE counted report (Google, with a source that did not pass) stored at T0 without the email, two TEST (uncounted) reports before it. */
async function owner(milestone: 'seen-by-app' | 'seen-by-job' | 'none') {
  const w = await lifecycleWorld();
  setNow(w, T0);
  const id = w.addDomain({ domain: D, createdAt: T0 - 3 * DAY, connectedAt: T0 - 3 * DAY });
  w.addReport({ domain: D, day: T0 - 9 * DAY, tier: 'unauthenticated', org: 'test.example', knownAs: null, storedAt: T0 - 8 * DAY, records: [google] });
  w.addReport({ domain: D, day: T0 - 5 * DAY, tier: 'unknown', org: 'test.example', knownAs: null, storedAt: T0 - 4 * DAY, records: [google] });
  w.addReport({ domain: D, day: T0 - DAY - 3600, storedAt: T0, records: [google, sendgrid] });
  if (milestone !== 'none') w.sql.prepare('INSERT INTO domain_milestones (domain_id, workspace_id, records_live_at, live_seen_by) VALUES (?, ?, ?, ?)').run(id, WS, T0 - 2 * DAY, milestone === 'seen-by-app' ? 'app' : 'job');
  w.dns.set(D, recordNamingUs());
  setNow(w, T0 + 25 * 3600);
  return { w, id };
}

describe.each(['seen-by-app', 'seen-by-job', 'none'] as const)('first-report catch-up, records seen live before T0: %s', (milestone) => {
  it('(a) the 0 11 run 25 h later sends it once, to the verified owner, with that report\'s numbers and the public origin', async () => {
    const { w, id } = await owner(milestone);
    expect(claim(w)).toEqual([]);
    await w.run();
    const sent = firstReports(w);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('dana@brightwave-mail.com');
    expect(sent[0].subject).toBe(`First DMARC report for ${D}: 48 messages, 40 passed`);
    expect(JSON.stringify(sent[0])).toContain('Google');
    expect(JSON.stringify(sent[0])).toContain(`${BASE}/#/w/${WS}/domains/${id}`);
    expect(JSON.stringify(sent[0])).not.toContain('workers.dev');
    expect(claim(w)).toHaveLength(1);
  });

  it('(b) a second 0 11 run the same day, and every later one, send nothing more', async () => {
    const { w } = await owner(milestone);
    await w.run();
    await w.run();
    for (let day = 1; day <= 40; day++) { setNow(w, w.clock.now + DAY); await w.run(); }
    expect(firstReports(w)).toHaveLength(1);
  });

  it('(e) no records-live and no no-reports email goes to this owner: a report exists', async () => {
    const { w } = await owner(milestone);
    await w.run();
    for (let day = 1; day <= 40; day++) { setNow(w, w.clock.now + DAY); await w.run(); }
    // (The weekly summaries are another matter: the daily run sends those too.)
    expect(w.mailer.sent.map((m) => m.subject).filter((s) => !s.startsWith('First DMARC report') && !s.startsWith('Week of'))).toEqual([]);
    expect((w.rows("SELECT kind FROM lifecycle_sends WHERE kind != 'summary'") as Array<{ kind: string }>).map((r) => r.kind)).toEqual(['first_report']);
  });

  it('(c) a SECOND counted report through the intake path (storeReport) sends no first-report email', async () => {
    const { w, id } = await owner(milestone);
    await w.run();
    expect(firstReports(w)).toHaveLength(1);
    const waited: Promise<unknown>[] = [];
    const report = {
      xml_schema: 'draft' as const,
      report_metadata: { org_name: 'google.com', org_email: 'noreply@google.com', org_extra_contact_info: null, report_id: 'second', begin_date: '2026-11-15T00:00:00Z', end_date: '2026-11-15T23:59:59Z', errors: [] },
      policy_published: { domain: D, adkim: 'r' as const, aspf: 'r' as const, p: 'none' as const, sp: 'none' as const, pct: 100, fo: '0' },
      records: [{
        source: { ip: '192.0.2.10', reverse_dns: null, base_domain: null, country_code: null, country_name: null, subdivision: null, city: null },
        count: 5, alignment: { spf: true, dkim: true, dmarc: true },
        policy_evaluated: { disposition: 'none' as const, dkim: 'pass' as const, spf: 'pass' as const, policy_override_reasons: [] },
        identifiers: { header_from: D, envelope_from: null, envelope_to: null },
        auth_results: { dkim: [{ domain: D, selector: 's', result: 'pass' as const }], spf: [{ domain: D, scope: 'mfrom' as const, result: 'pass' as const }] },
      }],
    };
    const stored = await storeReport(w.tenant(), id, report, null, true, { tier: 'counted', identity: 'google.com', auth: 'dkim', domain: 'google.com', reason: null, knownAs: 'Google' } as any, { waitUntil: (p) => { waited.push(p); } });
    expect(stored.stored).toBe(true);
    await Promise.all(waited);
    expect(waited).toHaveLength(0);
    expect(firstReports(w)).toHaveLength(1);
  });
});

describe('(d) the window: created_at >= run time - 3 days (when the report was STORED, not its date_end)', () => {
  const run = async (storedAgo: number, dayAgo = 0) => {
    const w = await lifecycleWorld();
    setNow(w, MON_16_NOV);
    w.addDomain({ domain: D });
    w.addReport({ domain: D, day: MON_16_NOV - dayAgo - DAY, storedAt: MON_16_NOV - storedAgo, records: [google] });
    await w.run();
    return firstReports(w).length;
  };
  it('is 3 days', () => expect(FIRST_REPORT_CATCHUP_SECONDS).toBe(3 * DAY));
  it('stored exactly 3 days before the run (and one second inside it): sent', async () => {
    expect(await run(FIRST_REPORT_CATCHUP_SECONDS)).toBe(1);
    expect(await run(FIRST_REPORT_CATCHUP_SECONDS - 1)).toBe(1);
  });
  it('stored one second beyond 3 days: never', async () => {
    expect(await run(FIRST_REPORT_CATCHUP_SECONDS + 1)).toBe(0);
  });
  it('the report\'s own date does not matter: an old report stored just now is sent, a recent one stored long ago is not', async () => {
    expect(await run(60, 30 * DAY)).toBe(1);
    expect(await run(FIRST_REPORT_CATCHUP_SECONDS + 1, 0)).toBe(0);
  });
});

describe('(f) the legacy instant: the catch-up is only for a first report stored before the real-time email existed', () => {
  const utc = (day: number, h: number, m = 0, sec = 0) => Date.UTC(2026, 10, day, h, m, sec) / 1000;
  const nextDay = (d: number) => utc(d, 11);

  it('is 2026-11-16 12:06:00 UTC (09:06 in Chile)', () => {
    expect(new Date(FIRST_REPORT_EMAIL_LEGACY_UNTIL * 1000).toISOString()).toBe('2026-11-16T12:06:00.000Z');
  });

  /** One proven domain, one counted report stored at `storedAt`, no email for it; then a daily run on each of the days given. */
  async function story(storedAt: number, runDays: number[]) {
    const w = await lifecycleWorld();
    w.clock.now = storedAt;
    w.addDomain({ domain: D, createdAt: storedAt - 2 * DAY, connectedAt: storedAt - 2 * DAY });
    const reportId = w.addReport({ domain: D, day: utc(15, 0), storedAt, records: [google, sendgrid] });
    w.dns.set(D, recordNamingUs());
    for (const d of runDays) { w.clock.now = nextDay(d); await w.run(); }
    return { w, reportId };
  }

  it('the owner: a first counted report stored 2026-11-16 10:52 UTC gets exactly one first-report email on the next 11:00 run, and none on the later ones', async () => {
    const { w } = await story(utc(16, 10, 52), [17]);
    expect(firstReports(w)).toHaveLength(1);
    expect(firstReports(w)[0].to).toBe('dana@brightwave-mail.com');
    expect(claim(w)).toHaveLength(1);
    for (const d of [18, 19, 20, 21]) { w.clock.now = nextDay(d); await w.run(); }
    expect(firstReports(w)).toHaveLength(1);
  });

  it('a report stored 2026-11-16 13:00 UTC (after the legacy instant) gets nothing from the catch-up, on any of several daily runs; no claim is written', async () => {
    const { w } = await story(utc(16, 13), [16, 17, 18, 19]);
    expect(firstReports(w)).toEqual([]);
    expect(claim(w)).toEqual([]);
  });

  it('the boundary: stored one second before the instant is caught up, at the instant or later is not', async () => {
    expect(firstReports((await story(FIRST_REPORT_EMAIL_LEGACY_UNTIL - 1, [17])).w)).toHaveLength(1);
    expect(firstReports((await story(FIRST_REPORT_EMAIL_LEGACY_UNTIL, [17])).w)).toEqual([]);
    expect(firstReports((await story(FIRST_REPORT_EMAIL_LEGACY_UNTIL + 1, [17])).w)).toEqual([]);
  });

  it('the real-time path still works for a report stored after the instant: one email, then the daily runs add none', async () => {
    const { w, reportId } = await story(utc(16, 13), [16]);
    w.clock.now = utc(16, 13, 0, 5);
    await w.realtimeFirstReport(1, reportId);
    expect(firstReports(w)).toHaveLength(1);
    expect(claim(w)).toHaveLength(1);
    for (const d of [17, 18, 19]) { w.clock.now = nextDay(d); await w.run(); }
    expect(firstReports(w)).toHaveLength(1);
  });
});
