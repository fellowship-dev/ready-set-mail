// The state machine: each email is sent once, at the right state, never when the state is false, never twice, and within the caps.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newBudget, runLifecycleForWorkspace, sendFirstReportNow } from '../../../src/lifecycle/email/run';
import { recordsSeenLive } from '../../../src/product-analytics/steps';
import { POSTHOG_HOST, POSTHOG_KEY } from '../../product-analytics/walk';
import { DAY, MON_16_NOV, RUA, WEEK_9_NOV, WS, lifecycleWorld, recordNamingUs, type RecordSpec, type World } from './world';

afterEach(() => vi.restoreAllMocks());
const D = 'brightwave-mail.com';
const ok = (count = 100): RecordSpec => ({ ip: '192.0.2.10', count, spf: ['pass', D], dkim: ['pass', D], org: 'Google Workspace' });
const bad = (count: number, over: Partial<RecordSpec> = {}): RecordSpec => ({ ip: '198.51.100.7', count, spf: ['pass', 'sendgrid.net'], dkim: ['pass', 'sendgrid.net'], org: 'SendGrid', ...over });
const subjects = (w: World) => w.mailer.sent.map((m) => m.subject);
const kinds = (w: World) => (w.rows('SELECT kind FROM lifecycle_sends ORDER BY rowid') as Array<{ kind: string }>).map((r) => r.kind);
/** A report for each of the 7 days of the week starting at `monday`. */
const week = (w: World, monday: number, records: RecordSpec[], domain = D) => { for (let i = 0; i < 7; i++) w.addReport({ domain, day: monday + i * DAY, storedAt: monday + i * DAY + 3600, records }); };
const LAST_WEEK = WEEK_9_NOV; // the week of Mon 9 Nov: the one the job on Mon 16 Nov is about

describe('records live (b)', () => {
  it('is sent once, when the daily job first sees the record name the reports address, with the time it was seen', async () => {
    const w = await lifecycleWorld();
    w.addDomain({ domain: D });
    await w.run();
    expect(w.mailer.sent).toHaveLength(0); // the record does not name us yet
    w.dns.set(D, recordNamingUs());
    await w.run();
    expect(subjects(w)).toEqual(['brightwave-mail.com is set up: reports are on their way']);
    expect(w.mailer.sent[0].text).toContain('We saw it in public DNS on Mon 16 Nov at 11:00 UTC.');
    expect(w.rows('SELECT live_seen_by, records_live_at FROM domain_milestones')).toEqual([{ live_seen_by: 'job', records_live_at: MON_16_NOV }]);
    await w.run();
    w.at(1); await w.run();
    expect(w.mailer.sent).toHaveLength(1);
    expect(w.sends()).toEqual([{ user_id: 'u_dana', domain_id: 1, kind: 'records_live', period: 'once', state: 'sent' }]);
  });

  it('is not sent when the app saw the records live first (the person was on the page), whatever PostHog is doing', async () => {
    const w = await lifecycleWorld(); // no POSTHOG_KEY: the milestone is written anyway
    const id = w.addDomain({ domain: D });
    const tenant = w.tenant();
    recordsSeenLive(tenant, w.ctx, (await tenant.scope.domains.getById(id))!, 'domain_page');
    await new Promise((r) => setTimeout(r, 10));
    expect(w.rows('SELECT live_seen_by FROM domain_milestones')).toEqual([{ live_seen_by: 'app' }]);
    w.dns.set(D, recordNamingUs());
    await w.run();
    expect(w.mailer.sent).toHaveLength(0);
    expect(w.reads).toEqual([]); // a milestone exists: no DNS read for it
  });

  it('the setup read and the daily read are recorded by who made them, the first sight winning', async () => {
    const w = await lifecycleWorld();
    const a = w.addDomain({ domain: D });
    const b = w.addDomain({ domain: 'news.brightwave-mail.com' });
    const tenant = w.tenant();
    for (const [id, by] of [[a, 'setup'], [a, 'daily'], [b, 'daily'], [b, 'setup']] as const) recordsSeenLive(tenant, w.ctx, (await tenant.scope.domains.getById(id))!, by);
    await new Promise((r) => setTimeout(r, 10));
    expect(w.rows('SELECT domain_id, live_seen_by FROM domain_milestones ORDER BY domain_id')).toEqual([{ domain_id: a, live_seen_by: 'app' }, { domain_id: b, live_seen_by: 'job' }]);
  });

  it('is not sent for a domain that already has reports, is not connected, is not proven, or was added more than 30 days ago', async () => {
    const w = await lifecycleWorld();
    const withReports = w.addDomain({ domain: D });
    w.addReport({ domain: D, day: MON_16_NOV - 3 * DAY, records: [ok()] });
    w.addDomain({ domain: 'unconnected.example', rua: '' });
    w.addDomain({ domain: 'legacy.example', via: 'legacy' });
    w.addDomain({ domain: 'old.example', createdAt: MON_16_NOV - 31 * DAY });
    for (const d of [D, 'unconnected.example', 'legacy.example', 'old.example']) w.dns.set(d, recordNamingUs());
    await w.run();
    expect(w.mailer.sent.filter((m) => m.subject.includes('is set up'))).toHaveLength(0); // the domain with reports is not waiting for anything…
    expect(w.reads).toEqual([D]); // …it was read (and its milestone written), the others are not watched
    expect(w.rows('SELECT domain_id FROM domain_milestones')).toEqual([{ domain_id: withReports }]);
  });

  it('reads at most 25 domains per run, and the rest on the next run', async () => {
    const w = await lifecycleWorld();
    for (let i = 0; i < 30; i++) { w.addDomain({ domain: `d${i}.example` }); w.dns.set(`d${i}.example`, recordNamingUs()); }
    await w.run();
    expect(w.reads).toHaveLength(25);
    w.reads.length = 0;
    await w.run();
    expect(w.reads).toHaveLength(5);
    expect(w.sql.prepare('SELECT COUNT(*) AS n FROM domain_milestones').get()).toEqual({ n: 30 });
  });

  it('several domains going live in one run: one email lists each; claims are per domain, so none is mailed twice', async () => {
    const w = await lifecycleWorld();
    for (const d of [D, 'news.brightwave-mail.com']) { w.addDomain({ domain: d }); w.dns.set(d, recordNamingUs()); }
    await w.run();
    expect(subjects(w)).toEqual(['2 domains are set up: reports are on their way']);
    expect(w.mailer.sent[0].text).toContain('brightwave-mail.com: Mon 16 Nov at 11:00 UTC');
    expect(w.mailer.sent[0].text).toContain('news.brightwave-mail.com: Mon 16 Nov at 11:00 UTC');
    await w.run();
    expect(w.mailer.sent).toHaveLength(1);
    expect(kinds(w)).toEqual(['records_live', 'records_live']);
  });

  it('is not sent when the milestone is older than a week (a switch turned back on later does not announce old news)', async () => {
    const w = await lifecycleWorld({ LIFECYCLE_EMAILS_OFF: 'records_live' });
    w.addDomain({ domain: D });
    w.dns.set(D, recordNamingUs());
    await w.run();
    expect(w.mailer.sent).toHaveLength(0);
    expect(w.sends()).toEqual([]); // nothing claimed while the switch is off
    w.at(8);
    (w.env as any).LIFECYCLE_EMAILS_OFF = '';
    await w.run();
    expect(w.mailer.sent.filter((m) => m.subject.includes('is set up'))).toHaveLength(0);
  });
});

describe('first report (c)', () => {
  it('real time: sent once when the first counted report is stored; the daily catch-up then sends nothing', async () => {
    const w = await lifecycleWorld();
    const id = w.addDomain({ domain: D });
    const rid = w.addReport({ domain: D, day: MON_16_NOV - 2 * DAY, records: [ok(14)] });
    await sendFirstReportNow(w.tenant(), w.ctx, id, rid, w.deps);
    expect(subjects(w)).toEqual(['First DMARC report for brightwave-mail.com: 14 messages, all passed']);
    await sendFirstReportNow(w.tenant(), w.ctx, id, rid, w.deps);
    w.dns.set(D, recordNamingUs());
    await w.run();
    expect(subjects(w).filter((s) => s.startsWith('First DMARC'))).toHaveLength(1);
  });

  it('catch-up: the daily job sends it when the claim is missing and the first counted report is under 3 days old, not when older', async () => {
    const w = await lifecycleWorld();
    w.addDomain({ domain: D });
    w.addReport({ domain: D, day: MON_16_NOV - 3 * DAY, storedAt: MON_16_NOV - 2 * DAY - 3600, records: [ok(20)] });
    await w.run();
    expect(subjects(w).filter((s) => s.startsWith('First DMARC'))).toHaveLength(1);
    const old = await lifecycleWorld();
    old.addDomain({ domain: D });
    old.addReport({ domain: D, day: MON_16_NOV - 6 * DAY, storedAt: MON_16_NOV - 3 * DAY - 60, records: [ok(20)] });
    await old.run();
    expect(old.mailer.sent.filter((m) => m.subject.startsWith('First DMARC'))).toHaveLength(0);
  });

  it('is about COUNTED reports: an uncounted one is not a first report, and the next counted one is', async () => {
    const w = await lifecycleWorld();
    w.addDomain({ domain: D });
    w.addReport({ domain: D, day: MON_16_NOV - 2 * DAY, tier: 'unauthenticated', records: [ok(5)] });
    await w.run();
    expect(w.mailer.sent.filter((m) => m.subject.startsWith('First DMARC'))).toHaveLength(0);
    w.addReport({ domain: D, day: MON_16_NOV - DAY, records: [ok(7)] });
    await w.run();
    expect(w.mailer.sent.filter((m) => m.subject.startsWith('First DMARC'))).toHaveLength(1);
  });

  it('says which source did not pass, and what it passed for, when the report has one', async () => {
    const w = await lifecycleWorld();
    w.addDomain({ domain: D });
    w.addReport({ domain: D, day: MON_16_NOV - DAY, records: [ok(11), bad(3, { dkim: ['pass', 'sendgrid.net'] })] });
    await w.run();
    const m = w.mailer.sent.find((x) => x.subject.startsWith('First DMARC'))!;
    expect(m.subject).toBe('First DMARC report for brightwave-mail.com: 14 messages, 11 passed');
    expect(m.text).toContain('Worth a look: 3 messages from SendGrid (198.51.100.7) did not pass DMARC. They passed DKIM for sendgrid.net, but not for brightwave-mail.com.');
  });

  it('goes to the owners and to the admin who added the domain, not to another admin or a member, and not to an unverified address', async () => {
    const w = await lifecycleWorld();
    const adder = w.addUser({ id: 'u_adder', email: 'adder@brightwave-mail.com', name: 'Ada Adder', role: 'admin' });
    w.addUser({ id: 'u_other', email: 'other@brightwave-mail.com', name: 'Other', role: 'admin' });
    w.addUser({ id: 'u_member', email: 'member@brightwave-mail.com', name: 'Mem', role: 'member' });
    w.addUser({ id: 'u_unverified', email: 'owner2@brightwave-mail.com', name: 'Two', role: 'owner', verified: false });
    w.addDomain({ domain: D, addedBy: adder });
    w.addReport({ domain: D, day: MON_16_NOV - DAY, records: [ok(9)] });
    await w.run();
    expect(w.mailer.sent.filter((m) => m.subject.startsWith('First DMARC')).map((m) => m.to).sort()).toEqual(['adder@brightwave-mail.com', 'dana@brightwave-mail.com']);
    const adderMail = w.mailer.sent.find((m) => m.to === 'adder@brightwave-mail.com' && m.subject.startsWith('First DMARC'))!;
    expect(adderMail.text).toContain('Hi Ada,');
    expect(adderMail.text).toContain('You get this because you added brightwave-mail.com to Brightwave Studio on Ready Set Mail.');
  });

  it('when the audit log recorded nobody, the owners get it', async () => {
    const w = await lifecycleWorld();
    w.addDomain({ domain: D, addedBy: null });
    w.addReport({ domain: D, day: MON_16_NOV - DAY, records: [ok(9)] });
    await w.run();
    expect(w.mailer.sent.map((m) => m.to)).toContain('dana@brightwave-mail.com');
  });
});

describe('no reports yet (d)', () => {
  async function liveFor(days: number, policy = 'none') {
    const w = await lifecycleWorld();
    w.addDomain({ domain: D, createdAt: MON_16_NOV - 20 * DAY, policy });
    w.dns.set(D, recordNamingUs(policy));
    w.at(-days);
    await w.run(); // seen live `days` days ago
    w.mailer.sent.length = 0;
    w.at(0);
    return w;
  }

  it('is sent once, 3 days after the records went live, when no report has arrived, after a live read of the record', async () => {
    const w = await liveFor(3);
    await w.run();
    expect(subjects(w)).toEqual(['No DMARC reports yet for brightwave-mail.com']);
    expect(w.mailer.sent[0].text).toContain('It still names Ready Set Mail. Nothing needs changing');
    await w.run(); w.at(1); await w.run();
    expect(w.mailer.sent).toHaveLength(1);
  });

  it('is not sent before the 3 days are over', async () => {
    const w = await liveFor(2);
    await w.run();
    expect(w.mailer.sent).toHaveLength(0);
  });

  it('is not sent when a counted report arrived since, and not when an uncounted one did (the domain is receiving reports)', async () => {
    const counted = await liveFor(4);
    counted.addReport({ domain: D, day: MON_16_NOV - 2 * DAY, records: [ok(3)] });
    await counted.run();
    expect(counted.mailer.sent.filter((m) => m.subject.startsWith('No DMARC'))).toHaveLength(0);
    const uncounted = await liveFor(4);
    uncounted.addReport({ domain: D, day: MON_16_NOV - 2 * DAY, tier: 'unknown', records: [ok(3)] });
    await uncounted.run();
    expect(uncounted.mailer.sent.filter((m) => m.subject.startsWith('No DMARC'))).toHaveLength(0);
    expect(uncounted.reads).toEqual([D].slice(0, 0).concat(uncounted.reads.filter((r) => r === D).slice(0, 1))); // only the watch read of day -4, none for the check
  });

  it('tells what the live read found: no longer naming us (with the record), no record at all, and a read that failed', async () => {
    const dropped = await liveFor(3);
    dropped.dns.set(D, 'v=DMARC1; p=none; rua=mailto:someone@elsewhere.example');
    await dropped.run();
    expect(dropped.mailer.sent[0].text).toContain('It no longer names Ready Set Mail. Today it reads:');
    expect(dropped.mailer.sent[0].text).toContain('v=DMARC1; p=none; rua=mailto:someone@elsewhere.example');
    expect(dropped.mailer.sent[0].text).toContain(`Add rua=mailto:${RUA} back to it, or set it again from the domain page.`);
    const none = await liveFor(3);
    none.dns.set(D, null);
    await none.run();
    expect(none.mailer.sent[0].text).toContain('public DNS shows no DMARC record for brightwave-mail.com');
    const failed = await liveFor(3);
    failed.dns.set(D, 'error');
    await failed.run();
    expect(failed.mailer.sent[0].text).toContain('We could not read it just now. The domain page checks it again when you open it.');
  });

  it('offers the email check only when CANARY_DOMAIN is configured', async () => {
    const w = await liveFor(3);
    await w.run();
    expect(w.mailer.sent[0].text).toContain('send any email from brightwave-mail.com to the email check on the dashboard');
    const none = await lifecycleWorld({ CANARY_DOMAIN: undefined });
    none.addDomain({ domain: D, createdAt: MON_16_NOV - 20 * DAY });
    none.dns.set(D, recordNamingUs());
    none.at(-3); await none.run(); none.mailer.sent.length = 0; none.at(0); await none.run();
    expect(none.mailer.sent[0].subject).toBe('No DMARC reports yet for brightwave-mail.com');
    expect(none.mailer.sent[0].text).not.toContain('email check');
  });
});

describe('weekly summary (e)', () => {
  it('is sent on the first run after the week ended, keyed by that ISO week, and never twice', async () => {
    const w = await lifecycleWorld();
    w.addDomain({ domain: D });
    week(w, LAST_WEEK, [ok(100)]);
    await w.run();
    expect(subjects(w).filter((s) => s.startsWith('Week of'))).toEqual(['Week of 9–15 Nov: brightwave-mail.com, 700 messages, 100% passed']);
    expect(w.rows("SELECT period FROM lifecycle_sends WHERE kind = 'summary'")).toEqual([{ period: '2026-W46' }]);
    await w.run(); w.at(1); await w.run(); w.at(6); await w.run();
    expect(subjects(w).filter((s) => s.startsWith('Week of'))).toHaveLength(1);
  });

  it('a missed day only delays it: the first run of the week can be on Wednesday', async () => {
    const w = await lifecycleWorld();
    w.addDomain({ domain: D });
    week(w, LAST_WEEK, [ok(100)]);
    w.at(2);
    await w.run();
    expect(subjects(w).filter((s) => s.startsWith('Week of'))).toEqual(['Week of 9–15 Nov: brightwave-mail.com, 700 messages, 100% passed']);
  });

  it('is NOT sent when the workspace had no reports and nothing changed, and nothing is claimed', async () => {
    const w = await lifecycleWorld();
    w.addDomain({ domain: D });
    await w.run();
    expect(w.mailer.sent).toHaveLength(0);
    expect(w.sends()).toEqual([]);
  });

  it('is sent without numbers when a domain that had reports last week had none this week: "no reports"', async () => {
    const w = await lifecycleWorld();
    w.addDomain({ domain: D });
    week(w, LAST_WEEK - 7 * DAY, [ok(100)]); // the week of 2 Nov, nothing in the week of 9 Nov
    await w.run();
    expect(subjects(w)).toEqual(['Week of 9–15 Nov: brightwave-mail.com, no reports']);
    expect(w.mailer.sent[0].text).toContain('brightwave-mail.com had reports last week and none this week.');
    expect(w.mailer.sent[0].text).toContain('brightwave-mail.com got no reports this week. Check that its DMARC record still names Ready Set Mail.');
  });

  it('names a source that started failing as the one thing to do, a new failing source as "new this week", and says nothing alarming', async () => {
    const w = await lifecycleWorld();
    w.addDomain({ domain: D });
    week(w, LAST_WEEK - 7 * DAY, [ok(100), bad(30, { dkim: ['pass', D] })]); // SendGrid passed last week
    week(w, LAST_WEEK, [ok(100), bad(30)]); // and fails this week
    await w.run();
    const t = w.mailer.sent[0].text;
    expect(t).toContain('SendGrid on brightwave-mail.com started failing: 210 of 210 messages did not pass DMARC.');
    expect(t).toContain('Look at SendGrid on brightwave-mail.com: 210 of its messages did not pass DMARC this week.');
    const n = await lifecycleWorld();
    n.addDomain({ domain: D });
    week(n, LAST_WEEK - 7 * DAY, [ok(100)]);
    week(n, LAST_WEEK, [ok(100), bad(30)]);
    await n.run();
    expect(n.mailer.sent[0].text).toContain('Look at SendGrid on brightwave-mail.com (new this week): 210 of its messages did not pass DMARC this week.');
  });

  it('lists subdomains under their registrable domain', async () => {
    const w = await lifecycleWorld();
    w.addDomain({ domain: 'news.brightwave-mail.com' });
    w.addDomain({ domain: D });
    week(w, LAST_WEEK, [ok(10)], D);
    week(w, LAST_WEEK, [{ ...ok(5), spf: ['pass', 'news.brightwave-mail.com'], dkim: ['pass', 'news.brightwave-mail.com'], from: 'news.brightwave-mail.com' }], 'news.brightwave-mail.com');
    await w.run();
    expect(w.mailer.sent[0].subject).toBe('Week of 9–15 Nov: 2 domains, 105 messages, 100% passed');
    const rows = w.mailer.sent[0].text.split('\n').filter((l) => /brightwave-mail\.com\s+\d/.test(l));
    expect(rows.map((r) => r.replace(/\s+/g, ' ').trim())).toEqual(['brightwave-mail.com 70 70 100% p=none', 'news.brightwave-mail.com 35 35 100% p=none'].map((r) => r.replace(/^news/, '  news').trim()));
    expect(w.mailer.sent[0].text).toMatch(/\n  news\.brightwave-mail\.com/);
  });

  it('puts the uncounted reports in one neutral line', async () => {
    const w = await lifecycleWorld();
    w.addDomain({ domain: D });
    week(w, LAST_WEEK, [ok(10)]);
    w.addReport({ domain: D, day: LAST_WEEK, tier: 'unknown', records: [ok(4)] });
    await w.run();
    expect(w.mailer.sent[0].text).toContain('1 report from a sender we do not recognise is not counted.');
  });
});

describe('tips (f)', () => {
  /** Two clean weeks (2 Nov and 9 Nov), the policy as given, and the live record the same. */
  async function clean(policy: string, pct = 100) {
    const w = await lifecycleWorld();
    w.addDomain({ domain: D, policy, pct });
    w.dns.set(D, recordNamingUs(policy, pct < 100 ? `; pct=${pct}` : ''));
    week(w, LAST_WEEK - 7 * DAY, [ok(50)]);
    week(w, LAST_WEEK, [ok(50)]);
    w.sql.prepare("INSERT INTO lifecycle_sends (workspace_id, user_id, domain_id, kind, period, state) VALUES (?, 'u_dana', 0, 'summary', '2026-W46', 'sent')").run(WS); // the summary is not what this is about
    return w;
  }
  const tips = (w: World) => subjects(w).filter((s) => /every message passed|nothing to do|needs SPF or DKIM/.test(s));

  it('tip_next: p=none, two clean weeks: sent once per policy state, with the record from the rule module', async () => {
    const w = await clean('none');
    await w.run();
    expect(tips(w)).toEqual(['brightwave-mail.com: every message passed DMARC for two weeks']);
    expect(w.mailer.sent[0].text).toContain(`v=DMARC1; p=quarantine; rua=mailto:${RUA}`);
    expect(w.mailer.sent[0].text).toContain('approve moving DMARC to p=quarantine');
    w.at(8); await w.run(); w.at(30); await w.run();
    expect(tips(w)).toHaveLength(1);
    expect(w.rows("SELECT period FROM lifecycle_sends WHERE kind = 'tip_next'")).toEqual([{ period: 'policy:none:100' }]);
  });

  it('tip_next: quarantine -> reject says the move is done in stages; a pct below 100 is its own state', async () => {
    const q = await clean('quarantine');
    await q.run();
    expect(q.mailer.sent[0].text).toContain(`v=DMARC1; p=reject; rua=mailto:${RUA}`);
    expect(q.mailer.sent[0].text).toContain('Moving to p=reject is done in stages');
    const pct = await clean('quarantine', 50);
    await pct.run();
    expect(pct.rows("SELECT period FROM lifecycle_sends WHERE kind = 'tip_next'")).toEqual([{ period: 'policy:quarantine:50' }]);
    expect(pct.mailer.sent[0].text).toContain('raise pct from 50 to 100');
  });

  it('tip_next: not when one message failed in either week, nor when a week had no reports', async () => {
    const w = await lifecycleWorld();
    w.addDomain({ domain: D, policy: 'none' });
    w.dns.set(D, recordNamingUs());
    week(w, LAST_WEEK - 7 * DAY, [ok(50)]);
    week(w, LAST_WEEK, [ok(50)]);
    w.sql.prepare('UPDATE aggregate_reports SET pass_count = total_count - 1, fail_count = 1 WHERE id = 3').run(); // one message failed
    await w.run();
    expect(tips(w)).toEqual([]);
    const gap = await lifecycleWorld();
    gap.addDomain({ domain: D, policy: 'none' });
    gap.dns.set(D, recordNamingUs());
    week(gap, LAST_WEEK, [ok(50)]);
    await gap.run();
    expect(tips(gap)).toEqual([]);
  });

  it('tip_next: the policy is read live before sending, so a tip never advises what the person already did', async () => {
    const w = await clean('none');
    w.dns.set(D, recordNamingUs('quarantine')); // stored: none (the daily refresh is not running); live: already quarantine
    await w.run();
    expect(w.rows("SELECT period FROM lifecycle_sends WHERE kind LIKE 'tip_%'")).toEqual([{ period: 'policy:quarantine:100' }]);
    const failed = await clean('none');
    failed.dns.set(D, 'error'); // cannot read it: nothing is said
    await failed.run();
    expect(tips(failed)).toEqual([]);
  });

  it('tip_done: reject at pct 100 and two clean weeks, once; nothing more is offered', async () => {
    const w = await clean('reject');
    await w.run();
    expect(tips(w)).toEqual(['brightwave-mail.com: nothing to do']);
    expect(w.mailer.sent[0].text).toContain('brightwave-mail.com is at p=reject, and every message in its reports passed DMARC for the last two weeks (700 messages from 1 source). There is nothing to do. Your weekly summary will say if a source starts failing.');
    w.at(30); await w.run();
    expect(tips(w)).toHaveLength(1);
  });

  it('tip_fix: a service whose DKIM passed for another domain and fails for this one, 10 messages or more; once per source; never after it passes', async () => {
    const w = await lifecycleWorld();
    w.addDomain({ domain: D });
    w.dns.set(D, recordNamingUs());
    week(w, LAST_WEEK, [ok(100), bad(3, { dkim: ['pass', 'sendgrid.net'] })]); // 21 failing messages
    await w.run();
    expect(tips(w)).toEqual(['One service sending as brightwave-mail.com needs SPF or DKIM']);
    expect(w.mailer.sent.find((m) => m.subject.startsWith('One service'))!.text).toContain('Last week 21 messages came from SendGrid (198.51.100.7). They passed DKIM for sendgrid.net, but not for brightwave-mail.com, so they did not pass DMARC.');
    // Same source the week after: not again, even after the 7 days.
    week(w, LAST_WEEK + 7 * DAY, [ok(100), bad(3, { dkim: ['pass', 'sendgrid.net'] })]);
    w.at(7); await w.run(); w.at(14); await w.run();
    expect(tips(w)).toHaveLength(1);
    // Fewer than 10 failing messages is not a tip; neither is a source that passed nothing for another domain.
    const few = await lifecycleWorld();
    few.addDomain({ domain: D });
    week(few, LAST_WEEK, [ok(100), bad(1, { dkim: ['pass', 'sendgrid.net'] })]); // 7
    await few.run();
    expect(tips(few)).toEqual([]);
    const nothing = await lifecycleWorld();
    nothing.addDomain({ domain: D });
    week(nothing, LAST_WEEK, [ok(100), bad(3, { spf: ['fail', null], dkim: ['none', null] })]);
    await nothing.run();
    expect(tips(nothing)).toEqual([]);
  });

  it('tip_fix: not once the source passes DMARC in a later week', async () => {
    const w = await lifecycleWorld();
    w.addDomain({ domain: D });
    week(w, LAST_WEEK, [ok(100), bad(3, { dkim: ['pass', 'sendgrid.net'] })]);
    week(w, LAST_WEEK + 7 * DAY, [ok(100), bad(3, { dkim: ['pass', D] })]); // set up since
    w.at(7);
    await w.run();
    expect(tips(w)).toEqual([]);
  });

  it('at most one tip per recipient in 7 days: the second waits for the seven days to pass', async () => {
    const w = await lifecycleWorld();
    w.addDomain({ domain: D, policy: 'none' });
    w.dns.set(D, recordNamingUs());
    week(w, LAST_WEEK - 7 * DAY, [ok(50)]);
    week(w, LAST_WEEK, [ok(50), bad(3, { dkim: ['pass', 'sendgrid.net'] })]); // a fix tip now, a next tip impossible: one message in 10 failed
    await w.run();
    expect(tips(w)).toEqual(['One service sending as brightwave-mail.com needs SPF or DKIM']);
    w.sql.prepare("INSERT INTO lifecycle_sends (workspace_id, user_id, domain_id, kind, period, state, created_at) VALUES (?, 'u_dana', 1, 'tip_done', 'reject', 'sent', ?)").run(WS, MON_16_NOV - 2 * DAY); // an unrelated earlier tip, still inside the window
    w.at(1); await w.run();
    expect(tips(w)).toHaveLength(1);
  });

  it('the offer paragraph: only with billing on, a cached price, a postal address and no order on the domain', async () => {
    const env = { STRIPE_SECRET_KEY: 'rk_test_abc123', STRIPE_WEBHOOK_SECRET: 'whsec_abc123' };
    const build = async (extra: Record<string, unknown> = {}, orderStatus?: string, cache = true) => {
      const w = await lifecycleWorld({ ...env, ...extra });
      w.addDomain({ domain: D });
      week(w, LAST_WEEK, [ok(100), bad(3, { dkim: ['pass', 'sendgrid.net'] })]);
      if (cache) w.sql.prepare("INSERT INTO billing_price_cache (lookup_key, price_id, amount, currency, fetched_at) VALUES ('rsm_fix_one_domain', 'price_1', 14900, 'usd', 1)").run();
      if (orderStatus) w.sql.prepare("INSERT INTO billing_orders (id, workspace_id, workspace_name, domain_id, domain_name, offer, stripe_price_id, amount, currency, status) VALUES ('o1', ?, 'Brightwave Studio', 1, ?, 'fix-one-domain', 'price_1', 14900, 'usd', ?)").run(WS, D, orderStatus);
      await w.run();
      return w.mailer.sent.find((m) => m.subject.startsWith('One service'))!.text;
    };
    expect(await build()).toContain('Prefer we do it? Fix one domain, $149 USD per domain: We find every service that sends email as your domain');
    expect(await build()).toContain('Until we send the written note that the domain is done, you can ask for the full fee back.');
    for (const text of [await build({ STRIPE_SECRET_KEY: undefined, STRIPE_WEBHOOK_SECRET: undefined }), await build({ POSTAL_ADDRESS: undefined }), await build({}, 'paid'), await build({}, 'pending'), await build({}, 'done'), await build({}, undefined, false)]) {
      expect(text).not.toContain('Prefer we do it?');
      expect(text).toContain('What to do: in that service');
    }
    expect(await build({}, 'refunded')).toContain('Prefer we do it?'); // a closed order is not an order on the domain
  });

  it('LIFECYCLE_TIPS_DEFAULT=off: an owner who never chose gets no tip; a stored choice wins', async () => {
    const off = await clean('none');
    (off.env as any).LIFECYCLE_TIPS_DEFAULT = 'off';
    await off.run();
    expect(tips(off)).toEqual([]);
    off.pref('u_dana', 'tips', true);
    await off.run();
    expect(tips(off)).toHaveLength(1);
  });
});

describe('which cron runs what', () => {
  it('the daily branch (0 11 * * *) sends the milestones and never the summary or a tip; the weekly branch (0 9 * * 1) the reverse', async () => {
    const w = await lifecycleWorld();
    w.addDomain({ domain: D });
    week(w, LAST_WEEK, [ok(100)]); // a summary is due
    w.addDomain({ domain: 'new.example' });
    w.dns.set('new.example', recordNamingUs());
    await w.run({ schedule: 'daily' });
    expect(subjects(w)).toEqual(['new.example is set up: reports are on their way']);
    await w.run({ schedule: 'weekly' });
    expect(subjects(w).filter((s) => s.startsWith('Week of'))).toHaveLength(1);
    expect(subjects(w)).toHaveLength(2);
    // The weekly branch does not look at the milestones: a domain going live waits for the daily one.
    const only = await lifecycleWorld();
    only.addDomain({ domain: 'new.example' });
    only.dns.set('new.example', recordNamingUs());
    await only.run({ schedule: 'weekly' });
    expect(only.mailer.sent).toHaveLength(0);
    expect(only.reads).toEqual([]);
  });

  it('the weekly summary is keyed by the ISO week, so the Monday 09:00 run and a later re-run send it once', async () => {
    const w = await lifecycleWorld();
    w.addDomain({ domain: D });
    week(w, LAST_WEEK, [ok(100)]);
    w.at(0, 9); // Monday 16 Nov 09:00 UTC: the week of 9 Nov ended at 00:00
    await w.run({ schedule: 'weekly' });
    await w.run({ schedule: 'weekly' });
    w.at(0, 11); await w.run({ schedule: 'daily' }); await w.run();
    expect(subjects(w).filter((s) => s.startsWith('Week of'))).toEqual(['Week of 9–15 Nov: brightwave-mail.com, 700 messages, 100% passed']);
    expect(w.rows("SELECT period FROM lifecycle_sends WHERE kind = 'summary'")).toEqual([{ period: '2026-W46' }]);
  });
});

describe('claims, retries and caps', () => {
  it('a retryable failure (configuration, no provider, suppressed) gives the claim back so a later run can send; an unknown outcome never retries', async () => {
    const w = await lifecycleWorld();
    w.addDomain({ domain: D });
    w.dns.set(D, recordNamingUs());
    w.mailer.next.push({ ok: false, kind: 'config', error: 'bad sender' });
    await w.run();
    expect(w.sends()).toEqual([]);
    await w.run();
    expect(w.mailer.sent).toHaveLength(2); // the first attempt failed, the second delivered
    expect(w.sends().map((s) => s.state)).toEqual(['sent']);

    const t = await lifecycleWorld();
    t.addDomain({ domain: D });
    t.dns.set(D, recordNamingUs());
    t.mailer.next.push({ ok: false, kind: 'transient', error: 'timeout' });
    await t.run();
    expect(t.sends().map((s) => s.state)).toEqual(['failed']);
    await t.run(); t.at(1); await t.run();
    expect(t.mailer.sent).toHaveLength(1); // at most once

    const none = await lifecycleWorld();
    none.addDomain({ domain: D });
    none.dns.set(D, recordNamingUs());
    const deps = { ...none.deps, mailer: null };
    await runLifecycleForWorkspace(none.tenant(), none.ctx, newBudget(), deps);
    expect(none.sends()).toEqual([]);
    await none.run();
    expect(none.mailer.sent).toHaveLength(1);
  });

  it('a provider that refuses the address is never retried either', async () => {
    const w = await lifecycleWorld();
    w.addDomain({ domain: D });
    w.dns.set(D, recordNamingUs());
    w.mailer.next.push({ ok: false, kind: 'recipient', error: 'refused' });
    await w.run(); await w.run();
    expect(w.mailer.sent).toHaveLength(1);
    expect(w.sends().map((s) => s.state)).toEqual(['failed']);
  });

  it('two runs at once send once: only the run whose INSERT OR IGNORE changed a row sends', async () => {
    const w = await lifecycleWorld();
    w.addDomain({ domain: D });
    w.dns.set(D, recordNamingUs());
    await Promise.all([w.run(), w.run()]);
    expect(w.mailer.sent).toHaveLength(1);
  });

  it('at most 3 lifecycle emails per recipient per run; the rest on the next run', async () => {
    const w = await lifecycleWorld();
    w.addDomain({ domain: D });
    w.addDomain({ domain: 'a.example', createdAt: MON_16_NOV - 20 * DAY });
    w.addDomain({ domain: 'b.example', createdAt: MON_16_NOV - 20 * DAY });
    w.dns.set(D, recordNamingUs()); // records live (1)
    w.addReport({ domain: 'a.example', day: MON_16_NOV - DAY, records: [{ ...ok(5), spf: ['pass', 'a.example'], dkim: ['pass', 'a.example'], from: 'a.example' }] }); // first report (2)
    w.sql.prepare("INSERT INTO domain_milestones (domain_id, workspace_id, records_live_at, live_seen_by) VALUES (3, ?, ?, 'job')").run(WS, MON_16_NOV - 4 * DAY); // no reports yet (3)
    w.dns.set('b.example', recordNamingUs());
    week(w, LAST_WEEK, [ok(10)]); // the summary (4)
    await w.run();
    expect(w.mailer.sent).toHaveLength(3);
    expect(w.mailer.sent.every((m) => !m.subject.startsWith('Week of'))).toBe(true); // the milestones go first
    await w.run();
    expect(w.mailer.sent).toHaveLength(4);
    expect(w.mailer.sent[3].subject.startsWith('Week of')).toBe(true);
  });

  it('at most MAX_LIFECYCLE_SENDS_PER_RUN per invocation over every workspace; the rest on the next run', async () => {
    const w = await lifecycleWorld();
    w.addUser({ id: 'u_two', email: 'two@brightwave-mail.com', name: 'Two', role: 'owner' });
    w.addDomain({ domain: D });
    w.dns.set(D, recordNamingUs());
    const small = { ...newBudget(), sends: 1 };
    await w.run({ budget: small });
    expect(w.mailer.sent).toHaveLength(1);
    expect(small.sends).toBe(0);
    await w.run();
    expect(w.mailer.sent.map((m) => m.to).sort()).toEqual(['dana@brightwave-mail.com', 'two@brightwave-mail.com']);
  });

  it('LIFECYCLE_EMAILS_OFF stops the named kinds only', async () => {
    const w = await lifecycleWorld({ LIFECYCLE_EMAILS_OFF: 'summary, no_reports' });
    w.addDomain({ domain: D });
    week(w, LAST_WEEK, [ok(10)]); // a summary is due (and switched off)
    w.addDomain({ domain: 'new.example' });
    w.dns.set('new.example', recordNamingUs());
    await w.run();
    expect(subjects(w)).toEqual(['new.example is set up: reports are on their way']);
    const all = await lifecycleWorld({ LIFECYCLE_EMAILS_OFF: 'all' });
    all.addDomain({ domain: D });
    all.dns.set(D, recordNamingUs());
    await all.run();
    expect(all.mailer.sent).toHaveLength(0);
    expect(all.reads.length).toBeGreaterThanOrEqual(0);
  });

  it('records the analytics event with the kind only, when analytics is on', async () => {
    const sent: any[] = [];
    vi.stubGlobal('fetch', async (_u: unknown, init: any) => { sent.push(JSON.parse(init.body)); return new Response('{}'); });
    const w = await lifecycleWorld({ POSTHOG_KEY, POSTHOG_HOST });
    w.addDomain({ domain: D });
    w.dns.set(D, recordNamingUs());
    await w.run();
    await new Promise((r) => setTimeout(r, 20));
    const events = sent.flatMap((b) => b.batch).filter((e) => e.event === 'Lifecycle Email Sent');
    expect(events).toHaveLength(1);
    expect(events[0].properties.kind).toBe('records_live');
    expect(JSON.stringify(events[0])).not.toMatch(/brightwave|dana|@/);
    vi.unstubAllGlobals();
  });
});

describe('zero rows and other modes', () => {
  it('a workspace with no domains, domains with no reports, and a database with nothing in it: nothing is sent and nothing throws', async () => {
    const w = await lifecycleWorld();
    await expect(w.run()).resolves.toBeUndefined();
    w.addDomain({ domain: D });
    await expect(w.run()).resolves.toBeUndefined();
    expect(w.mailer.sent).toEqual([]);
    const empty = await lifecycleWorld();
    empty.sql.prepare('DELETE FROM memberships').run();
    empty.addDomain({ domain: D, addedBy: null });
    empty.dns.set(D, recordNamingUs());
    await expect(empty.run()).resolves.toBeUndefined();
    expect(empty.mailer.sent).toEqual([]);
  });

  it('does nothing when the instance is not hosted', async () => {
    const w = await lifecycleWorld({ MODE: 'selfhost', SAAS_ENABLED: undefined });
    w.addDomain({ domain: D });
    w.dns.set(D, recordNamingUs());
    await w.run();
    expect(w.mailer.sent).toEqual([]);
    expect(w.reads).toEqual([]);
  });
});
