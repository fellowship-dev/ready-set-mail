// A fixture walk: one person (Dana), one domain, simulated days with the test clock. Every day's job runs twice: the second run sends nothing new.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DAY, MON_16_NOV, lifecycleWorld, recordNamingUs, type RecordSpec, type World } from './world';

afterEach(() => vi.restoreAllMocks());

const DOMAIN = 'brightwave-mail.com';
const googleOk = (count = 100): RecordSpec => ({ ip: '192.0.2.10', count, spf: ['pass', DOMAIN], dkim: ['pass', DOMAIN], org: 'Google Workspace', rdns: 'mail-a.google.test' });
/** A service that signs for its own domain (not aligned with brightwave-mail.com), and, once it is set up, for brightwave-mail.com. */
const sendgrid = (count: number, setUp: boolean): RecordSpec => ({ ip: '198.51.100.7', count, spf: ['pass', 'sendgrid.net'], dkim: ['pass', setUp ? DOMAIN : 'sendgrid.net'], org: 'SendGrid', rdns: 'o1.email.sendgrid.test' });

/** What went out, in order: (day offset from Mon 16 Nov, kind, subject). Each day's job is run twice and the second run must change nothing. */
function journal(w: World) {
  const seen: Array<[number, string, string]> = [];
  let sent = 0;
  const kinds = () => (w.rows('SELECT kind FROM lifecycle_sends ORDER BY rowid') as Array<{ kind: string }>).map((r) => r.kind);
  return {
    seen,
    async day(d: number, beforeRun?: () => Promise<void>) {
      w.at(d);
      const before = kinds().length;
      await beforeRun?.();
      await w.run();
      const fresh = kinds().slice(before);
      const mail = w.mailer.sent.slice(sent);
      expect(mail.length, `day ${d}: one claim per email`).toBe(fresh.length);
      mail.forEach((m, i) => seen.push([d, fresh[i], m.subject]));
      sent = w.mailer.sent.length;
      const rows = kinds().length;
      await w.run();
      expect(w.mailer.sent.length, `a second run on day ${d} sent something`).toBe(sent);
      expect(kinds().length).toBe(rows);
    },
  };
}

/** Yesterday's report from Google (and SendGrid from the week of 23 Nov), stored this morning. */
function reportFor(w: World, d: number, sendgridFrom = 1, setUpFrom = 2) {
  const day = Math.floor(w.clock.now / DAY) * DAY - DAY;
  const wk = Math.floor((d - 1) / 7);
  return w.addReport({ domain: DOMAIN, day, storedAt: w.clock.now - 6 * 3600, records: [googleOk(100), ...(wk >= sendgridFrom ? [sendgrid(40, wk >= setUpFrom)] : [])] });
}

describe('the walk', () => {
  it('records live, the first report on day 1 (no "no reports" email), weekly summaries, a service that needs setting up, two clean weeks, a stricter policy, reject', async () => {
    const w = await lifecycleWorld({ LIFECYCLE_EMAILS_ON: 'tips' });
    w.pref(w.dana, 'tips', true); // tips are off until the instance and the person both turn them on
    const j = journal(w);
    w.addDomain({ domain: DOMAIN, createdAt: MON_16_NOV - 2 * DAY, policy: 'none' });
    const setPolicy = (p: string) => { w.dns.set(DOMAIN, recordNamingUs(p)); w.sql.prepare('UPDATE domains SET dmarc_policy = ?, dmarc_p = ? WHERE domain = ?').run(p, p, DOMAIN); };
    for (let d = 0; d <= 70; d++) {
      w.at(d);
      if (d === 0) w.dns.set(DOMAIN, recordNamingUs('none'));
      if (d === 29) setPolicy('quarantine'); // Dana acted on the tip of day 28
      if (d === 50) setPolicy('reject'); // and on the one of day 49
      // The first counted report goes through the real-time path (the catch-up only covers reports stored before it existed).
      const id = d >= 1 ? reportFor(w, d) : 0;
      await j.day(d, async () => { if (d === 1) await w.realtimeFirstReport(1, id); });
    }
    expect(j.seen).toEqual([
      [0, 'records_live', 'brightwave-mail.com is set up: reports are on their way'],
      [1, 'first_report', 'First DMARC report for brightwave-mail.com: 100 messages, all passed'],
      [7, 'summary', 'Week of 16–22 Nov: brightwave-mail.com, 700 messages, 100% passed'],
      [14, 'summary', 'Week of 23–29 Nov: brightwave-mail.com, 980 messages, 71% passed'],
      [14, 'tip_fix', 'One service sending as brightwave-mail.com needs SPF or DKIM'],
      [21, 'summary', 'Week of 30 Nov – 6 Dec: brightwave-mail.com, 980 messages, 100% passed'],
      [28, 'summary', 'Week of 7–13 Dec: brightwave-mail.com, 980 messages, 100% passed'],
      [28, 'tip_next', 'brightwave-mail.com: every message passed DMARC for two weeks'],
      [35, 'summary', 'Week of 14–20 Dec: brightwave-mail.com, 980 messages, 100% passed'],
      [42, 'summary', 'Week of 21–27 Dec: brightwave-mail.com, 980 messages, 100% passed'],
      [49, 'summary', 'Week of 28 Dec 2026 – 3 Jan 2027: brightwave-mail.com, 980 messages, 100% passed'],
      [49, 'tip_next', 'brightwave-mail.com: every message passed DMARC for two weeks'],
      [56, 'summary', 'Week of 4–10 Jan: brightwave-mail.com, 980 messages, 100% passed'],
      // Reject at pct 100: nothing more is ever sent but the weekly summary.
      [63, 'summary', 'Week of 11–17 Jan: brightwave-mail.com, 980 messages, 100% passed'],
      [70, 'summary', 'Week of 18–24 Jan: brightwave-mail.com, 980 messages, 100% passed'],
    ]);
    // Every kind is recorded once with the period that makes it the same email: the tip for a policy state is not sent again for that state.
    expect(w.rows("SELECT kind, period FROM lifecycle_sends WHERE kind LIKE 'tip_%' OR kind IN ('records_live', 'first_report') ORDER BY rowid").map((r) => `${r.kind} ${r.period}`)).toEqual([
      'records_live once', 'first_report once', 'tip_fix src:sendgrid', 'tip_next policy:none:100', 'tip_next policy:quarantine:100',
    ]);
    // The stricter policy (seen on day 29) needed two full weeks after it: its tip came on day 49, not 35. Never within 7 days of the last tip.
    expect(j.seen.filter(([, k]) => k.startsWith('tip_')).map(([d]) => d)).toEqual([14, 28, 49]);
    const tipDays = j.seen.filter(([, k]) => k.startsWith('tip_')).map(([d]) => d);
    expect(tipDays.slice(1).every((d, i) => d - tipDays[i] >= 7)).toBe(true);
    // The mail of the walk is all to Dana, from the platform sender.
    expect(new Set(w.mailer.sent.map((m) => m.to))).toEqual(new Set(['dana@brightwave-mail.com']));
    expect(new Set(w.mailer.sent.map((m) => m.from.email))).toEqual(new Set(['noreply@app.readysetmail.com']));
  }, 60_000);

  it('records live on day 1, no report by day 4 (one "no reports" email, with the live check), the first report on day 6', async () => {
    const w = await lifecycleWorld();
    const j = journal(w);
    w.addDomain({ domain: DOMAIN, createdAt: MON_16_NOV - 2 * DAY, policy: 'none' });
    for (let d = 0; d <= 9; d++) {
      w.at(d);
      if (d === 1) w.dns.set(DOMAIN, recordNamingUs('none'));
      const id = d === 6 ? w.addReport({ domain: DOMAIN, day: Math.floor(w.clock.now / DAY) * DAY - DAY, storedAt: w.clock.now - 3600, records: [googleOk(12)] }) : 0;
      await j.day(d, async () => { if (d === 6) await w.realtimeFirstReport(1, id); });
    }
    expect(j.seen).toEqual([
      [1, 'records_live', 'brightwave-mail.com is set up: reports are on their way'],
      [4, 'no_reports', 'No DMARC reports yet for brightwave-mail.com'],
      [6, 'first_report', 'First DMARC report for brightwave-mail.com: 12 messages, all passed'],
      [7, 'summary', 'Week of 16–22 Nov: brightwave-mail.com, 12 messages, 100% passed'],
    ]);
    const noReports = w.mailer.sent[1].text;
    expect(noReports).toContain('has named Ready Set Mail as its report address since Tue 17 Nov (UTC), and no report has arrived yet');
    expect(noReports).toContain('It still names Ready Set Mail. Nothing needs changing');
    expect(w.reads.filter((x) => x === DOMAIN).length).toBeGreaterThan(0);
  }, 60_000);
});
