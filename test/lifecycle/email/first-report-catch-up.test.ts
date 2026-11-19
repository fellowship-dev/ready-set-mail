// The first-report catch-up, for the owner whose first counted report was stored by code that could not send the email (no lifecycle_sends row).
// The rule: on the daily `0 11 * * *` run, send the first-report email ONCE for a domain that (i) has a first COUNTED report whose storage time
// (`aggregate_reports.created_at`, not the report's date_end) is before FIRST_REPORT_EMAIL_LEGACY_UNTIL (when the real-time email went live) and
// (ii) has no first_report claim. No upper time window; the claim is what makes it once. A first counted report stored later is the real-time path's.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { storeReport } from '../../../src/dmarc/store-report';
import { FIRST_REPORT_EMAIL_LEGACY_UNTIL } from '../../../src/lifecycle/email/kinds';
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
  w.catchUp();
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

describe('the rule: a first counted report stored before the legacy instant, no claim, any later 0 11 run', () => {
  const utc = (day: number, h: number, m = 0, sec = 0) => Date.UTC(2026, 10, day, h, m, sec) / 1000;
  const at11 = (d: number) => utc(d, 11);

  it('the legacy instant is 2026-11-16 12:06:00 UTC (09:06 in Chile)', () => {
    expect(new Date(FIRST_REPORT_EMAIL_LEGACY_UNTIL * 1000).toISOString()).toBe('2026-11-16T12:06:00.000Z');
  });

  /** One proven domain, one counted report stored at `storedAt` (none when null), no email for it; then a daily run on each of the days given. */
  async function story(storedAt: number | null, runDays: number[], claimed = false) {
    const w = await lifecycleWorld();
    w.catchUp();
    w.clock.now = storedAt ?? utc(16, 10);
    const id = w.addDomain({ domain: D, createdAt: utc(14, 10), connectedAt: utc(14, 10) });
    const reportId = storedAt === null ? 0 : w.addReport({ domain: D, day: utc(15, 0), storedAt, records: [google, sendgrid] });
    if (claimed) w.sql.prepare("INSERT INTO lifecycle_sends (workspace_id, user_id, domain_id, kind, period, state) VALUES (?, ?, ?, 'first_report', 'once', 'sent')").run(WS, w.dana, id);
    w.dns.set(D, recordNamingUs());
    for (const d of runDays) { w.clock.now = at11(d); await w.run(); }
    return { w, reportId };
  }

  it('(a) stored 2026-11-16 10:52 UTC, no claim, run on 2026-11-20 11:00 UTC: exactly one first-report email', async () => {
    const { w } = await story(utc(16, 10, 52), [20]);
    expect(firstReports(w)).toHaveLength(1);
    expect(firstReports(w)[0].to).toBe('dana@brightwave-mail.com');
    expect(claim(w)).toHaveLength(1);
    // Only that: no records-live and no no-reports email for this owner.
    expect(w.mailer.sent.map((m) => m.subject).filter((s) => !s.startsWith('First DMARC report') && !s.startsWith('Week of'))).toEqual([]);
  });

  it('(b) the next day\'s run and 40 more daily runs send nothing more', async () => {
    const { w } = await story(utc(16, 10, 52), [20, 21]);
    expect(firstReports(w)).toHaveLength(1);
    for (let i = 0; i < 40; i++) { w.clock.now += DAY; await w.run(); }
    expect(firstReports(w)).toHaveLength(1);
    expect(claim(w)).toHaveLength(1);
  });

  it('(c) stored 2026-11-16 13:00 UTC (after the legacy instant): nothing on any run, no claim written', async () => {
    const { w } = await story(utc(16, 13), [17, 20, 21]);
    expect(firstReports(w)).toEqual([]);
    expect(claim(w)).toEqual([]);
  });

  it('(c) the boundary: one second before the instant is sent, exactly at it and after it is not', async () => {
    expect(firstReports((await story(FIRST_REPORT_EMAIL_LEGACY_UNTIL - 1, [20])).w)).toHaveLength(1);
    expect(firstReports((await story(FIRST_REPORT_EMAIL_LEGACY_UNTIL, [20])).w)).toEqual([]);
    expect(firstReports((await story(FIRST_REPORT_EMAIL_LEGACY_UNTIL + 1, [20])).w)).toEqual([]);
  });

  it('(d) a domain that already has a first_report claim gets nothing', async () => {
    const { w } = await story(utc(16, 10, 52), [20, 21], true);
    expect(firstReports(w)).toEqual([]);
    expect(claim(w)).toHaveLength(1);
  });

  it('(e) a domain with no counted report gets nothing', async () => {
    const { w } = await story(null, [20, 21]);
    expect(firstReports(w)).toEqual([]);
    const un = await lifecycleWorld();
    un.catchUp();
    un.clock.now = utc(16, 10);
    un.addDomain({ domain: D });
    un.addReport({ domain: D, day: utc(15, 0), tier: 'unauthenticated', org: 'test.example', knownAs: null, storedAt: utc(16, 10), records: [google] });
    un.dns.set(D, recordNamingUs());
    un.clock.now = at11(20);
    await un.run();
    expect(firstReports(un)).toEqual([]);
  });

  it('the report\'s own date does not matter, only when it was stored', async () => {
    const w = await lifecycleWorld();
    w.catchUp();
    w.clock.now = utc(16, 10, 52);
    w.addDomain({ domain: D, createdAt: utc(14, 10), connectedAt: utc(14, 10) });
    w.addReport({ domain: D, day: utc(1, 0), storedAt: utc(16, 10, 52), records: [google] });
    w.dns.set(D, recordNamingUs());
    w.clock.now = at11(20);
    await w.run();
    expect(firstReports(w)).toHaveLength(1);
  });

  it('the real-time path still works for a report stored after the instant: one email, then the daily runs add none', async () => {
    const { w, reportId } = await story(utc(16, 13), [16]);
    w.clock.now = utc(16, 13, 0, 5);
    await w.realtimeFirstReport(1, reportId);
    expect(firstReports(w)).toHaveLength(1);
    expect(claim(w)).toHaveLength(1);
    for (const d of [17, 18, 19, 20]) { w.clock.now = at11(d); await w.run(); }
    expect(firstReports(w)).toHaveLength(1);
  });
});
