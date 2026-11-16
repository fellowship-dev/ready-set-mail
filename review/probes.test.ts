// PART B: probes. Each prints facts to ~/rev/probes.out; an expectation that fails is a finding, not something to fix.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { handleApi } from '../src/api/router';
import { sendFirstReportNow, newBudget } from '../src/lifecycle/email/run';
import { sendChangeNotification, notifyConnectionBroken } from '../src/monitor/notify';
import { signToken, verifyToken } from '../src/mail/tokens';
import { TenantContext } from '../src/tenancy/context';
import type { MailMessage } from '../src/mail/mailer';
import { DAY, MON_16_NOV, WEEK_9_NOV, WS, lifecycleWorld, recordNamingUs, type RecordSpec, type World } from '../test/lifecycle/email/world';
import { kindOf, log, section, REV } from './lib';
import { COUNTED, iso, setClock, store, subjects, utc, type Rec } from './probes-lib';

const D = 'brightwave-mail.com';
const ok = (count = 100, d = D): RecordSpec => ({ ip: '192.0.2.10', count, spf: ['pass', d], dkim: ['pass', d], org: 'Google Workspace', from: d });
const sg = (count: number, fixed = false): RecordSpec => ({ ip: '198.51.100.7', count, spf: ['pass', 'sendgrid.net'], dkim: ['pass', fixed ? D : 'sendgrid.net'], org: 'SendGrid', rdns: 'o1.email.sendgrid.net', base: 'sendgrid.net' });
const week = (w: World, monday: number, records: RecordSpec[], domain = D) => { for (let i = 0; i < 7; i++) w.addReport({ domain, day: monday + i * DAY, storedAt: monday + i * DAY + 3600, records }); };
const ctxFake = { waitUntil: () => {} } as unknown as ExecutionContext;

beforeAll(() => { writeFileSync(join(REV, 'probes.out'), ''); });
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(MON_16_NOV * 1000); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

// ───────────────────────── B1 ─────────────────────────
describe('B1 the owner state', () => {
  const OWNER = 'readysetmail.com';
  const STORED = utc(2026, 11, 16, 10, 52);
  async function owner(dns: string | null | 'error' = recordNamingUs()) {
    const w = await lifecycleWorld();
    setClock(w, utc(2026, 11, 16, 10, 52));
    const id = w.addDomain({ domain: OWNER, createdAt: utc(2026, 11, 1, 9), connectedAt: utc(2026, 11, 1, 9) });
    const g: RecordSpec = { ip: '192.0.2.10', count: 41, spf: ['pass', OWNER], dkim: ['pass', OWNER], org: 'Google Workspace', from: OWNER };
    w.addReport({ domain: OWNER, day: utc(2026, 11, 8), tier: 'unauthenticated', org: 'test.example', knownAs: null, storedAt: utc(2026, 11, 9, 12), records: [g] });
    w.addReport({ domain: OWNER, day: utc(2026, 11, 10), tier: 'unknown', org: 'test.example', knownAs: null, storedAt: utc(2026, 11, 11, 12), records: [g] });
    w.addReport({ domain: OWNER, day: utc(2026, 11, 15), storedAt: STORED, records: [g] });
    w.dns.set(OWNER, dns);
    return { w, id };
  }
  const day = (n: number, h = 11) => utc(2026, 11, n, h);

  it('daily at 11:00 on Nov 17, 18, 19 (DNS names us / none / read fails)', async () => {
    section('B1 owner: three daily runs');
    log('state: domain readysetmail.com, created 2026-11-01, proven (txt), connected; no domain_milestones row, no lifecycle_sends row; counted Google report stored', iso(STORED), '(date_begin 2026-11-15); earlier uncounted reports stored 2026-11-09 and 11-11');
    for (const dns of [recordNamingUs(), null, 'error'] as const) {
      const { w } = await owner(dns);
      for (const d of [17, 18, 19]) {
        setClock(w, day(d)); const before = w.mailer.sent.length;
        await w.run({ schedule: 'daily' });
        log(`DNS=${dns === null ? 'no record' : dns === 'error' ? 'read fails' : 'names us'} | ${iso(w.clock.now)} daily ->`, subjects(w.mailer.sent.slice(before)), '| lifecycle_sends:', w.sends().map((s) => `${s.kind}/${s.period}/${s.state}`), '| milestones:', w.rows('SELECT live_seen_by, records_live_at FROM domain_milestones'), '| dns reads so far:', w.reads.length);
      }
      const kinds = w.mailer.sent.map((m) => kindOf(m.subject));
      log(`  -> records_live sent: ${kinds.includes('records_live')}, no_reports sent: ${kinds.includes('no_reports')}, first_report count: ${kinds.filter((k) => k === 'first_report').length}`);
    }
  });

  it('only a late run on Nov 19 11:00', async () => {
    section('B1 owner: first run only Nov 19 11:00');
    const { w } = await owner();
    setClock(w, day(19));
    await w.run({ schedule: 'daily' });
    log('sent:', subjects(w.mailer.sent), '| stored', iso(STORED), '+3d =', iso(STORED + 3 * DAY), '| run at', iso(w.clock.now));
    // minute by minute: when does the window close
    for (const [d, h, mi] of [[19, 10, 51], [19, 10, 52], [19, 10, 53]] as const) {
      const x = (await owner()).w; setClock(x, utc(2026, 11, d, h, mi)); await x.run({ schedule: 'daily' });
      log(`  run at ${iso(x.clock.now)} -> first_report emails: ${x.mailer.sent.filter((m) => kindOf(m.subject) === 'first_report').length}`);
    }
  });

  it('two concurrent runs on Nov 17', async () => {
    section('B1 owner: concurrent runs');
    const { w } = await owner();
    setClock(w, day(17));
    await Promise.all([w.run({ schedule: 'daily', budget: newBudget() }), w.run({ schedule: 'daily', budget: newBudget() })]);
    log('first_report emails after Promise.all of 2 runs:', w.mailer.sent.filter((m) => kindOf(m.subject) === 'first_report').length, subjects(w.mailer.sent), '| claims', w.sends().map((s) => `${s.kind}/${s.state}`));
    const x = (await owner()).w; setClock(x, day(17));
    await Promise.all([1, 2, 3, 4, 5].map(() => x.run({ schedule: 'daily', budget: newBudget() })));
    log('with 5 concurrent runs:', x.mailer.sent.length);
    // real time path + daily concurrently
    const y = await owner(); setClock(y.w, day(17));
    const rid = (y.w.rows("SELECT id FROM aggregate_reports WHERE reporter_tier='counted'")[0] as any).id;
    await Promise.all([y.w.run({ schedule: 'daily' }), sendFirstReportNow(y.w.tenant(), y.w.ctx, y.id, rid, y.w.deps)]);
    log('real-time path racing the daily run:', y.w.mailer.sent.length);
  });

  it('a second domain whose first counted report was stored (and mailed by the old #182 path) one day before the run, no claim', async () => {
    section('B1 owner: second domain catch-up');
    for (const withOwner of [false, true]) {
      const w = await lifecycleWorld();
      setClock(w, day(17));
      w.addDomain({ domain: 'second.example', createdAt: utc(2026, 11, 10) });
      w.addReport({ domain: 'second.example', day: utc(2026, 11, 16), storedAt: day(16), records: [ok(30, 'second.example')] });
      w.dns.set('second.example', recordNamingUs());
      if (withOwner) {
        w.addDomain({ domain: OWNER, createdAt: utc(2026, 11, 1, 9), connectedAt: utc(2026, 11, 1, 9) });
        w.addReport({ domain: OWNER, day: utc(2026, 11, 15), storedAt: STORED, records: [ok(41, OWNER)] });
        w.dns.set(OWNER, recordNamingUs());
      }
      await w.run({ schedule: 'daily' });
      log(`withOwnerDomainToo=${withOwner}: emails sent by the Nov 17 11:00 daily run:`, subjects(w.mailer.sent));
      for (const m of w.mailer.sent) log('   to', m.to, '| text first lines:', m.text.split('\n').slice(0, 8).join(' / '));
      log('   -> a first-report email for second.example sent again by catch-up:', w.mailer.sent.some((m) => m.subject.includes('second.example') || m.text.includes('second.example')));
    }
  });

  it('weekly Mon 23 Nov 09:00 for the owner (info)', async () => {
    const { w } = await owner(); setClock(w, utc(2026, 11, 23, 9));
    await w.run({ schedule: 'weekly' });
    log('B1 owner weekly Mon 23 Nov 09:00:', subjects(w.mailer.sent));
  });
});

// ───────────────────────── B2 ─────────────────────────
interface Ev { date: string; kind: string; subject: string; to: string }
async function simulate(o: { fixFrom?: string; raiseOn?: string | null; raiseStored?: boolean; policy?: string; label: string; billing?: boolean }) {
  const w = await lifecycleWorld(o.billing ? { STRIPE_SECRET_KEY: 'rk_test_abc123', STRIPE_WEBHOOK_SECRET: 'whsec_abc123' } : {});
  const d0 = utc(2026, 11, 2);
  setClock(w, d0 + 9 * 3600);
  w.addDomain({ domain: D, createdAt: utc(2026, 11, 1), connectedAt: utc(2026, 11, 1), policy: o.policy ?? 'none' });
  w.dns.set(D, recordNamingUs(o.policy ?? 'none'));
  const events: Ev[] = []; const dupes: string[] = [];
  const fixDay = o.fixFrom ? utc(...(o.fixFrom.split('-').map(Number) as [number, number, number])) : Infinity;
  const raiseDay = o.raiseOn ? utc(...(o.raiseOn.split('-').map(Number) as [number, number, number])) : Infinity;
  let cursor = 0;
  const grab = (label: string) => { for (const m of w.mailer.sent.slice(cursor)) events.push({ date: label, kind: kindOf(m.subject), subject: m.subject, to: m.to }); cursor = w.mailer.sent.length; };
  const twice = async (schedule: 'daily' | 'weekly', label: string) => { await w.run({ schedule }); grab(label); const n = w.mailer.sent.length; await w.run({ schedule }); if (w.mailer.sent.length !== n) dupes.push(`${label} ${schedule}`); grab(`${label} (re-run)`); };
  for (let d = d0; d <= utc(2026, 12, 14); d += DAY) {
    const prev = d - DAY;
    if (prev >= d0) w.addReport({ domain: D, day: prev, storedAt: d + 3600, records: [ok(100), sg(40, d - DAY >= fixDay)] });
    if (d >= raiseDay) { w.dns.set(D, recordNamingUs('quarantine')); if (o.raiseStored) w.sql.prepare("UPDATE domains SET dmarc_policy='quarantine', dmarc_p='quarantine'").run(); }
    const label = iso(d).slice(0, 10);
    const monday = new Date(d * 1000).getUTCDay() === 1;
    if (monday) { setClock(w, d + 9 * 3600); await twice('weekly', `${label} 09:00`); }
    setClock(w, d + 11 * 3600); await twice('daily', `${label} 11:00`);
  }
  return { w, events, dupes };
}

describe('B2 state machine', () => {
  it('six weeks, scenario 2 (SendGrid fails until fixed), several variants', async () => {
    section('B2 timelines');
    const variants = [
      { label: 'V0 SendGrid never fixed, policy stays none', fixFrom: undefined as string | undefined, raiseOn: null },
      { label: 'V1 SendGrid fixed: its rows pass from Mon 2026-11-23; policy stays none', fixFrom: '2026-11-23', raiseOn: null },
      { label: 'V2 as V1, user raises to quarantine on 2026-12-08 (after any p=none tip), stored policy NOT refreshed', fixFrom: '2026-11-23', raiseOn: '2026-12-08', raiseStored: false },
      { label: 'V3 as V1, user raises on 2026-12-08 and stored policy refreshed too', fixFrom: '2026-11-23', raiseOn: '2026-12-08', raiseStored: true },
      { label: 'V4 as V1, user raises to quarantine EARLY on 2026-12-01 (before two clean weeks end), stored policy NOT refreshed', fixFrom: '2026-11-23', raiseOn: '2026-12-01', raiseStored: false },
    ];
    for (const v of variants) {
      const { events, dupes, w } = await simulate(v as any);
      log(`\n-- ${v.label}`);
      for (const e of events.filter((x) => !x.date.includes('re-run'))) log(`   ${e.date}  ${e.kind.padEnd(12)} ${e.subject}`);
      log('   re-run duplicates:', dupes.length ? dupes : 'none');
      log('   re-run sends (should be none):', events.filter((x) => x.date.includes('re-run')).map((e) => `${e.date} ${e.kind}`));
      const tips = events.filter((e) => e.kind.startsWith('tip_') && !e.date.includes('re-run')).map((e) => ({ t: Date.parse(e.date.slice(0, 10)) / 1000, k: e.kind, d: e.date }));
      log('   tips:', tips.map((t) => `${t.d} ${t.k}`), '| min gap days between tips:', tips.length > 1 ? Math.min(...tips.slice(1).map((t, i) => (t.t - tips[i].t) / DAY)) : 'n/a');
      log('   no_reports emails while reports exist:', events.filter((e) => e.kind === 'no_reports').length, '| lifecycle_sends:', w.sends().map((s) => `${s.kind}/${s.period}`));
    }
  });

  it('a week with zero reports: no change vs. change', async () => {
    section('B2 empty weeks');
    const w = await lifecycleWorld();
    setClock(w, utc(2026, 11, 9, 9));
    w.addDomain({ domain: D, createdAt: utc(2026, 10, 1), connectedAt: utc(2026, 10, 1) });
    w.dns.set(D, recordNamingUs());
    week(w, WEEK_9_NOV - 7 * DAY, [ok(100)]); // reports only in the week of 2 Nov
    for (const t of [utc(2026, 11, 9, 9), utc(2026, 11, 16, 9), utc(2026, 11, 23, 9), utc(2026, 11, 30, 9)]) {
      setClock(w, t); const n = w.mailer.sent.length; await w.run({ schedule: 'weekly' });
      log(`weekly ${iso(t)} ->`, subjects(w.mailer.sent.slice(n)));
    }
    const m = w.mailer.sent.find((x) => x.subject.includes('no reports'));
    log('the "no reports" summary text:\n' + (m?.text ?? '(none)'));
    log('no summary at all in the week with zero reports and no change (2026-W48 / Nov 30)?', w.rows("SELECT period FROM lifecycle_sends WHERE kind='summary'").map((r: any) => r.period));
  });

  it('a missed Monday', async () => {
    section('B2 missed Monday');
    for (const mode of ['tuesday-manual then Monday', 'nothing until next Monday'] as const) {
      const w = await lifecycleWorld();
      setClock(w, utc(2026, 11, 9, 9));
      w.addDomain({ domain: D, createdAt: utc(2026, 10, 1), connectedAt: utc(2026, 10, 1) });
      w.dns.set(D, recordNamingUs());
      week(w, WEEK_9_NOV - 7 * DAY, [ok(100)]);
      week(w, WEEK_9_NOV, [ok(120)]);
      const runs = mode.startsWith('tuesday') ? [utc(2026, 11, 10, 9), utc(2026, 11, 16, 9)] : [utc(2026, 11, 16, 9)];
      for (const t of runs) { setClock(w, t); const n = w.mailer.sent.length; await w.run({ schedule: 'weekly' }); log(`[${mode}] weekly at ${iso(t)} (Mon=${new Date(t * 1000).getUTCDay() === 1}) ->`, subjects(w.mailer.sent.slice(n))); }
      log(`[${mode}] summary periods claimed:`, w.rows("SELECT period FROM lifecycle_sends WHERE kind='summary'").map((r: any) => r.period));
    }
  });

  it('caps: 3 per recipient per run, 100 per invocation', async () => {
    section('B2 caps');
    const w = await lifecycleWorld();
    setClock(w, MON_16_NOV);
    w.addDomain({ domain: D });
    w.addDomain({ domain: 'a.example', createdAt: MON_16_NOV - 20 * DAY });
    w.addDomain({ domain: 'b.example', createdAt: MON_16_NOV - 20 * DAY });
    w.dns.set(D, recordNamingUs()); w.dns.set('b.example', recordNamingUs());
    w.addReport({ domain: 'a.example', day: MON_16_NOV - DAY, records: [ok(5, 'a.example')] });
    w.sql.prepare("INSERT INTO domain_milestones (domain_id, workspace_id, records_live_at, live_seen_by) VALUES (3, ?, ?, 'job')").run(WS, MON_16_NOV - 4 * DAY);
    week(w, WEEK_9_NOV, [ok(10)]);
    await w.run();
    log('run 1 (both halves, 4 emails due for one owner):', subjects(w.mailer.sent), '| budget byUser', [...w.budget.byUser.entries()]);
    const n = w.mailer.sent.length; await w.run(); log('run 2:', subjects(w.mailer.sent.slice(n)));
    // 100 per invocation: 120 owners, one domain going live, ONE shared budget
    const b = await lifecycleWorld();
    for (let i = 0; i < 119; i++) b.addUser({ id: `u${i}`, email: `owner${i}@brightwave-mail.com`, name: `Owner ${i}`, role: 'owner' });
    b.addDomain({ domain: D }); b.dns.set(D, recordNamingUs());
    const budget = newBudget();
    await b.run({ budget }); log('120 owners, one invocation budget: emails after first run', b.mailer.sent.length, '| budget.sends left', budget.sends);
    await b.run({ budget }); log('same budget object again (same invocation, second workspace stand-in): total', b.mailer.sent.length);
    await b.run(); log('fresh budget (next invocation): total', b.mailer.sent.length);
  });
});

// ───────────────────────── B3 ─────────────────────────
describe('B3 failure rows', () => {
  const fullText = (ms: MailMessage[]) => ms.forEach((m) => log(`--- ${kindOf(m.subject)} | ${m.subject}\n${m.text}`));
  const grepLines = (ms: MailMessage[], re: RegExp) => ms.flatMap((m) => m.text.split('\n').filter((l) => re.test(l)).map((l) => `[${kindOf(m.subject)}] ${l.trim()}`));

  it('spf aligned pass + dkim fail', async () => {
    section('B3.1 spf pass aligned, dkim fail d=brightwave-mail.com, 50 msgs');
    const w = await lifecycleWorld();
    setClock(w, utc(2026, 11, 16, 9));
    const id = w.addDomain({ domain: D, createdAt: utc(2026, 10, 1), connectedAt: utc(2026, 10, 1) });
    w.dns.set(D, recordNamingUs());
    const row: Rec = { ip: '192.0.2.60', count: 50, spf: [['pass', D]], dkim: [['fail', D]], pe: { spf: 'pass', dkim: 'fail' }, from: D, org: 'Postfix Relay' };
    await store(w, id, { id: 'a', begin: '2026-11-03', records: [row] });
    await store(w, id, { id: 'b', begin: '2026-11-10', records: [row] });
    const rid = (w.rows("SELECT id FROM aggregate_reports ORDER BY id DESC")[0] as any).id;
    log('stored aggregate_reports:', w.rows('SELECT id,total_count,pass_count,fail_count FROM aggregate_reports'), 'report_records:', w.rows('SELECT count,dkim_result,dkim_domain,spf_result,spf_domain FROM report_records'));
    await sendFirstReportNow(w.tenant(), w.ctx, id, rid, w.deps);
    await w.run({ schedule: 'weekly' });
    fullText(w.mailer.sent);
    log('lines mentioning dkim/fail/not pass:', grepLines(w.mailer.sent, /dkim|fail|not pass|did not/i));
  });

  const variant = async (strangerOrg: string | null, strangerCount: number) => {
    const w = await lifecycleWorld();
    setClock(w, utc(2026, 11, 16, 9));
    const id = w.addDomain({ domain: D, createdAt: utc(2026, 10, 1), connectedAt: utc(2026, 10, 1) });
    w.dns.set(D, recordNamingUs());
    const two: Rec = { ip: '198.51.100.7', count: 40, dkim: [['pass', 'sendgrid.net'], ['pass', D]], spf: [['pass', 'sendgrid.net']], pe: { dkim: 'pass', spf: 'fail' }, from: D, org: 'SendGrid', rdns: 'o1.email.sendgrid.net', base: 'sendgrid.net' };
    const stranger: Rec = { ip: '203.0.113.9', count: strangerCount, dkim: [], spf: [['fail', 'mailer.example']], pe: { dkim: 'fail', spf: 'fail' }, from: D, org: strangerOrg };
    const good: Rec = { ip: '192.0.2.10', count: 100, dkim: [['pass', D]], spf: [['pass', D]], pe: { dkim: 'pass', spf: 'pass' }, from: D, org: 'Google Workspace' };
    await store(w, id, { id: 'x', begin: '2026-11-10', records: [good, two, stranger] });
    const rid = (w.rows('SELECT id FROM aggregate_reports')[0] as any).id;
    log('stored report row:', w.rows('SELECT total_count,pass_count,fail_count FROM aggregate_reports'));
    log('stored records:', w.rows('SELECT source_ip,count,dkim_result,dkim_domain,spf_result,spf_domain,org FROM report_records'));
    await sendFirstReportNow(w.tenant(), w.ctx, id, rid, w.deps);
    await w.run({ schedule: 'weekly' });
    return w;
  };

  it('first dkim = sendgrid.net, second = brightwave-mail.com (dkim pass in policy_evaluated), another source genuinely failed 20', async () => {
    section('B3.2 two DKIM signatures; stranger 20 failing');
    for (const [label, org] of [['stranger key = ip 203.0.113.9 (no org)', null], ['stranger org "Zeta Bulk"', 'Zeta Bulk']] as const) {
      const w = await variant(org, 20);
      log(`\n## ${label}`);
      fullText(w.mailer.sent);
      const said = w.mailer.sent.filter((m) => /SendGrid/.test(m.text) && /did not pass|not for brightwave-mail.com|failing/i.test(m.text));
      log(`=> emails that name SendGrid as not passing DMARC: ${said.length}`, said.map((m) => kindOf(m.subject)));
    }
  });
});

// ───────────────────────── B4 ─────────────────────────
describe('B4 unsubscribe and preferences', () => {
  const T = (w: World, path: string, init: RequestInit = {}) => handleApi(new Request(`https://app.readysetmail.com${path}`, init), w.env as never, ctxFake);
  const form = { 'content-type': 'application/x-www-form-urlencoded' };
  const prefRows = (w: World) => w.rows('SELECT user_id, workspace_id, kind, enabled FROM email_preferences ORDER BY user_id, kind');
  const supp = (w: World) => w.rows('SELECT reason FROM suppression');

  it('probes', async () => {
    section('B4');
    const w = await lifecycleWorld();
    w.addUser({ id: 'u_bob', email: 'bob@brightwave-mail.com', name: 'Bob', role: 'admin' });
    w.addUser({ id: 'u_gone', email: 'gone@brightwave-mail.com', name: 'Gone', role: 'admin' });
    w.sql.prepare('DELETE FROM memberships WHERE user_id = ?').run('u_gone'); // left the workspace
    const tok = (p: any) => signToken(w.env as never, p);
    const pref = async (u: string, k: 'summary' | 'tips', ws = WS) => `/api/email-preferences/off?t=${encodeURIComponent(await tok({ p: 'pref', u, w: ws, k }))}`;
    const out = async (res: Response) => ({ status: res.status, body: (await res.text()).slice(0, 200).replace(/\s+/g, ' '), ct: res.headers.get('content-type'), cache: res.headers.get('cache-control') });

    const sum = await pref('u_dana', 'summary');
    log('token length (chars):', decodeURIComponent(sum.split('t=')[1]).length);
    log('token payload readable?', ((): string => { const body = decodeURIComponent(sum.split('t=')[1]).split('.')[0]; const raw = Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64'); const s = raw.toString('latin1'); return `contains "u_dana": ${s.includes('u_dana')}, contains ws id: ${s.includes(WS)}, contains "summary": ${s.includes('summary')} (AES-256-GCM: iv(12) ‖ ciphertext, then HMAC-SHA256)`; })());
    const t0 = decodeURIComponent(sum.split('t=')[1]);
    log('verifyToken at +10 years still valid (non-expiring)?', !!(await verifyToken(w.env as never, t0, Math.floor(Date.now() / 1000) + 10 * 365 * 86400)));
    log('same payload signed twice gives different tokens (random IV)?', (await tok({ p: 'pref', u: 'u_dana', w: WS, k: 'summary' })) !== (await tok({ p: 'pref', u: 'u_dana', w: WS, k: 'summary' })));

    log('1 POST one-click, body List-Unsubscribe=One-Click, NO cookie:', await out(await T(w, sum, { method: 'POST', headers: form, body: 'List-Unsubscribe=One-Click' })), '| rows:', prefRows(w));
    w.sql.prepare('DELETE FROM email_preferences').run();
    log('2 GET same token:', await out(await T(w, sum)), '| rows after (should be none):', prefRows(w));
    log('3 POST without the body:', await out(await T(w, sum, { method: 'POST' })), '| rows:', prefRows(w));
    log('3b POST with other body:', await out(await T(w, sum, { method: 'POST', headers: form, body: 'x=1' })), '| rows:', prefRows(w));
    log('3c POST JSON content-type with right body text:', await out(await T(w, sum, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'List-Unsubscribe=One-Click' })), '| rows:', prefRows(w));
    w.sql.prepare('DELETE FROM email_preferences').run();

    await T(w, sum, { method: 'POST', headers: form, body: 'List-Unsubscribe=One-Click' });
    log('4 summary token turned off tips? rows:', prefRows(w), '| bob untouched:', prefRows(w).filter((r) => r.user_id === 'u_bob').length === 0);
    w.sql.prepare('DELETE FROM email_preferences').run();

    await T(w, await pref('u_dana', 'tips'), { method: 'POST', headers: form, body: 'List-Unsubscribe=One-Click' });
    log('4b tips token -> rows:', prefRows(w));
    w.sql.prepare('DELETE FROM email_preferences').run();

    await T(w, await pref('u_bob', 'summary'), { method: 'POST', headers: form, body: 'List-Unsubscribe=One-Click' });
    log('5 token of bob (B) applied: rows (only bob, dana untouched):', prefRows(w));
    w.sql.prepare('DELETE FROM email_preferences').run();

    const unsub = `/api/unsubscribe?t=${encodeURIComponent(await tok({ p: 'unsub', e: 'dana@brightwave-mail.com' }))}`;
    log('6a unsub token at pref route POST:', await out(await T(w, unsub.replace('/api/unsubscribe', '/api/email-preferences/off'), { method: 'POST', headers: form, body: 'List-Unsubscribe=One-Click' })), '| rows:', prefRows(w));
    log('6b unsub token at pref route GET:', await out(await T(w, unsub.replace('/api/unsubscribe', '/api/email-preferences/off'))));
    log('6c pref token at /api/unsubscribe POST:', await out(await T(w, sum.replace('/api/email-preferences/off', '/api/unsubscribe'), { method: 'POST', headers: form, body: 'List-Unsubscribe=One-Click' })), '| suppression rows:', supp(w));
    log('6d pref token at /api/unsubscribe GET:', await out(await T(w, sum.replace('/api/email-preferences/off', '/api/unsubscribe'))));

    const bad = (s: string) => s.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    const [body, sig] = t0.split('.');
    const tamper: Array<[string, string]> = [['flip last char of signature', `${body}.${bad(sig)}`], ['flip a char of body', `${bad(body)}.${sig}`], ['truncated', t0.slice(0, 20)], ['empty', ''], ['extra part', `${t0}.x`], ['body only', body]];
    for (const [label, t] of tamper) log(`7 tampered (${label}): POST`, (await T(w, `/api/email-preferences/off?t=${encodeURIComponent(t)}`, { method: 'POST', headers: form, body: 'List-Unsubscribe=One-Click' })).status, 'GET', (await T(w, `/api/email-preferences/off?t=${encodeURIComponent(t)}`)).status);
    log('7b no t parameter: GET', (await T(w, '/api/email-preferences/off')).status);

    // enumeration: member vs left the workspace vs unknown user vs other workspace id
    const cases: Array<[string, string]> = [['member dana', await pref('u_dana', 'summary')], ['left workspace (u_gone)', await pref('u_gone', 'summary')], ['unknown user id', await pref('u_nobody', 'summary')], ['other workspace id', await pref('u_dana', 'summary', 'ws_other')]];
    const res: Record<string, any> = {};
    for (const [label, p] of cases) { res[label] = { post: await out(await T(w, p, { method: 'POST', headers: form, body: 'List-Unsubscribe=One-Click' })), get: await out(await T(w, p)) }; }
    for (const [k, v] of Object.entries(res)) log(`8 ${k}:`, v);
    log('8 POST responses identical to the member\'s?', Object.fromEntries(Object.entries(res).map(([k, v]) => [k, JSON.stringify(v.post) === JSON.stringify(res['member dana'].post)])), '| GET identical?', Object.fromEntries(Object.entries(res).map(([k, v]) => [k, JSON.stringify(v.get) === JSON.stringify(res['member dana'].get)])));
    log('8 rows written for the left/unknown users (should be none):', prefRows(w));

    log('9 GET /api/unsubscribe valid unsub token:', await out(await T(w, unsub)), '| suppression rows:', supp(w), '| funnel leads:', w.rows('SELECT COUNT(*) AS n FROM leads'));
    log('9b POST /api/unsubscribe, no body:', await out(await T(w, unsub, { method: 'POST' })), '| suppression rows:', supp(w));
  });
});

// ───────────────────────── B5 ─────────────────────────
describe('B5 injection', () => {
  it('hostile data in reports', async () => {
    section('B5');
    const w = await lifecycleWorld();
    setClock(w, utc(2026, 11, 16, 9));
    const id = w.addDomain({ domain: D, createdAt: utc(2026, 10, 1), connectedAt: utc(2026, 10, 1) });
    w.dns.set(D, recordNamingUs());
    const EVIL = 'Evil <b>Corp</b> "x"\r\nBcc: victim@example.com' + 'A'.repeat(3000);
    const SCRIPT = '<script>alert(1)</script>\r\nBcc: victim@example.com';
    const XD = 'x.example\r\nSubject: hi';
    const bad: Rec = { ip: '198.51.100.77', count: 50, dkim: [['pass', XD]], spf: [['pass', XD]], pe: { dkim: 'fail', spf: 'fail' }, from: D, rdns: SCRIPT, org: `Evil${SCRIPT}`, base: SCRIPT };
    const good: Rec = { ip: '192.0.2.10', count: 100, dkim: [['pass', D]], spf: [['pass', D]], pe: { dkim: 'pass', spf: 'pass' }, from: D, org: 'Google Workspace' };
    // reporter: counted tier, but with no registry label (cannot happen for a counted report: see the tier probe below), so org_name is used
    await store(w, id, { id: 'e1', begin: '2026-11-10', org: EVIL, records: [good, bad], reporter: { ...COUNTED, knownAs: null } });
    await store(w, id, { id: 'e0', begin: '2026-11-03', org: EVIL, records: [good, bad], reporter: { ...COUNTED, knownAs: null } });
    const rid = (w.rows('SELECT id FROM aggregate_reports ORDER BY id')[0] as any).id;
    await sendFirstReportNow(w.tenant(), w.ctx, id, rid, w.deps);
    await w.run({ schedule: 'weekly' });
    const msgs = w.mailer.sent;
    log('emails produced:', subjects(msgs).map((s) => s.slice(0, 200)));
    for (const m of msgs) {
      const k = kindOf(m.subject);
      const hdrs = { from: `${m.from.name}<${m.from.email}>`, to: m.to, replyTo: m.replyTo ?? '', subject: m.subject, ...(m.headers ?? {}) };
      const crlf = Object.entries(hdrs).filter(([, v]) => /[\r\n]/.test(String(v))).map(([n]) => n);
      const rawLt = (m.html ?? '').match(/<script|<b>Corp|<\/b>/gi);
      const lines = (s: string) => s.split(/\r\n|\r|\n/);
      const maxLine = (s: string) => Math.max(...lines(s).map((l) => l.length));
      log(`[${k}] subject len ${m.subject.length}; CR/LF in headers: ${crlf.length ? crlf : 'none'}; raw "<script"/"<b>Corp" in html: ${rawLt ? rawLt : 'none'}; "&lt;script" escaped present: ${/&lt;script/.test(m.html ?? '')}; max text line ${maxLine(m.text)}; max html line ${maxLine(m.html ?? '')}; text contains "Bcc:" at line start: ${/^Bcc:/m.test(m.text)}; html contains "Bcc:" at line start: ${/^Bcc:/m.test(m.html ?? '')}; text has CR/LF from data splitting into a line starting "Subject:": ${/^Subject: hi/m.test(m.text)}`);
      // any '<' in html that is not the start of a tag we wrote: list the distinct tag names
      const tags = new Set([...(m.html ?? '').matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((x) => x[1].toLowerCase()));
      log(`   html tag names: ${[...tags].sort().join(',')}`);
    }
    const first = msgs.find((m) => kindOf(m.subject) === 'first_report');
    log('first report subject:', first?.subject.slice(0, 120), '| reporter shown (first 200 chars of text):', first?.text.slice(0, 200).replace(/\n/g, ' / '));
    const evilLines = msgs.flatMap((m) => m.text.split('\n').filter((l) => /Evil|script|x\.example|Subject: hi|Bcc/.test(l)).map((l) => `[${kindOf(m.subject)}] ${l.slice(0, 160)} (len ${l.length})`));
    log('text lines carrying data:', evilLines);
  });
  it('tier decision', async () => {
    log('reporter-auth: counted = carrier authenticated (topmost Authentication-Results naming AUTHSERV_ID with dkim=pass/dmarc=pass aligned with the From org) AND matching a registry entry (known-reporters.ts) AND report_metadata/email accepted by that entry; knownAs = entry.label; org_name/Submitter/subject decide nothing and org_name only reaches the email when reporter_known_as is empty, which a counted report never has.');
  });
});

// ───────────────────────── B6 ─────────────────────────
describe('B6 switches', () => {
  async function sw(extra: Record<string, unknown>) {
    const w = await lifecycleWorld(extra);
    setClock(w, utc(2026, 11, 16, 11));
    // summary + tip_next due
    w.addDomain({ domain: D, createdAt: utc(2026, 10, 1), connectedAt: utc(2026, 10, 1) });
    w.dns.set(D, recordNamingUs());
    week(w, WEEK_9_NOV - 7 * DAY, [ok(50)]); week(w, WEEK_9_NOV, [ok(50)]);
    // records live
    w.addDomain({ domain: 'live.example', createdAt: utc(2026, 11, 14) }); w.dns.set('live.example', recordNamingUs());
    // first report catch-up
    w.addDomain({ domain: 'first.example', createdAt: utc(2026, 11, 10) }); w.dns.set('first.example', recordNamingUs());
    w.addReport({ domain: 'first.example', day: utc(2026, 11, 15), storedAt: utc(2026, 11, 16, 8), records: [ok(9, 'first.example')] });
    // no reports: seen live 4 days ago
    const qid = w.addDomain({ domain: 'quiet.example', createdAt: utc(2026, 11, 5) }); w.dns.set('quiet.example', recordNamingUs());
    w.sql.prepare("INSERT INTO domain_milestones (domain_id, workspace_id, records_live_at, live_seen_by) VALUES (?, ?, ?, 'job')").run(qid, WS, utc(2026, 11, 12, 11));
    return w;
  }
  const kindsSent = async (extra: Record<string, unknown>, mutate?: (w: World) => void) => {
    const w = await sw(extra); mutate?.(w);
    await w.run({ schedule: 'daily' });
    setClock(w, utc(2026, 11, 16, 9)); await w.run({ schedule: 'weekly' });
    return w.mailer.sent.map((m) => kindOf(m.subject)).sort();
  };

  it('LIFECYCLE_EMAILS_OFF values', async () => {
    section('B6 table');
    const rows: Array<[string, string[]]> = [];
    for (const v of [undefined, 'summary', 'tips', 'all', 'first_report', 'records_live', 'no_reports', 'summary,tips']) rows.push([`LIFECYCLE_EMAILS_OFF=${v ?? '(unset)'}`, await kindsSent({ LIFECYCLE_EMAILS_OFF: v })]);
    rows.push(['LIFECYCLE_TIPS_DEFAULT=off', await kindsSent({ LIFECYCLE_TIPS_DEFAULT: 'off' })]);
    for (const [k, v] of rows) log(k.padEnd(34), '->', v);
  });

  it('first_report off: the real-time path too?', async () => {
    section('B6 first_report real time');
    for (const v of [undefined, 'first_report', 'all']) {
      const w = await lifecycleWorld({ LIFECYCLE_EMAILS_OFF: v });
      const id = w.addDomain({ domain: D, createdAt: MON_16_NOV - 3 * DAY });
      const rid = w.addReport({ domain: D, day: MON_16_NOV - DAY, records: [ok(14)] });
      await sendFirstReportNow(w.tenant(), w.ctx, id, rid, w.deps);
      log(`OFF=${v ?? '(unset)'}: sendFirstReportNow sent ${w.mailer.sent.length}; claims ${w.sends().length}`);
      if (v === 'first_report') {
        (w.env as any).LIFECYCLE_EMAILS_OFF = ''; setClock(w, MON_16_NOV + 5 * 3600);
        await w.run({ schedule: 'daily' }); log('  switch turned back on, next daily run (within 3 days): sent', w.mailer.sent.length);
        const late = await lifecycleWorld({ LIFECYCLE_EMAILS_OFF: 'first_report' });
        late.addDomain({ domain: D, createdAt: MON_16_NOV - 30 * DAY }); late.addReport({ domain: D, day: MON_16_NOV - DAY, records: [ok(14)] });
        await late.run({ schedule: 'daily' }); (late.env as any).LIFECYCLE_EMAILS_OFF = ''; setClock(late, MON_16_NOV + 4 * DAY); await late.run({ schedule: 'daily' });
        log('  switched on again 4 days later: sent', late.mailer.sent.length, '(the report is lost to the catch-up window)');
      }
    }
  });

  it('change alerts and connection alerts defaults', async () => {
    section('B6 alerts');
    const send = async (extra: Record<string, unknown>) => {
      const raw: any[] = [];
      const SEND_EMAIL = { send: async (m: any) => { raw.push(m); return {}; } };
      const w = await lifecycleWorld({ SEND_EMAIL, ...extra });
      w.addDomain({ domain: D });
      await sendChangeNotification('dana@brightwave-mail.com', D, [{ field: 'DMARC policy', was: 'reject', now: 'none', severity: 'degraded' }], w.tenant());
      const change = raw.length;
      await notifyConnectionBroken(w.tenant(), { id: 'c1', label: 'CF', detail: 'revoked' });
      return `change_alert sent: ${change > 0}; connection_alert sent: ${raw.length - change > 0}`;
    };
    log('hosted default                         ->', await send({}));
    log('hosted LIFECYCLE_EMAILS_ON=change_alerts ->', await send({ LIFECYCLE_EMAILS_ON: 'change_alerts' }));
    log('hosted ON=change_alerts + OFF=change_alerts ->', await send({ LIFECYCLE_EMAILS_ON: 'change_alerts', LIFECYCLE_EMAILS_OFF: 'change_alerts' }));
    log('hosted OFF=connection_alerts           ->', await send({ LIFECYCLE_EMAILS_OFF: 'connection_alerts' }));
    log('hosted OFF=all, ON=change_alerts       ->', await send({ LIFECYCLE_EMAILS_ON: 'change_alerts', LIFECYCLE_EMAILS_OFF: 'all' }));
    log('self-host default                      ->', await send({ MODE: 'selfhost', SAAS_ENABLED: undefined }));
    log('self-host OFF=change_alerts            ->', await send({ MODE: 'selfhost', SAAS_ENABLED: undefined, LIFECYCLE_EMAILS_OFF: 'change_alerts' }));
    log('self-host OFF=all                      ->', await send({ MODE: 'selfhost', SAAS_ENABLED: undefined, LIFECYCLE_EMAILS_OFF: 'all' }));
  });
});
