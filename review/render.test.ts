// PART A: every lifecycle email, rendered from real job runs of the repo's test world, saved under ~/rev/emails.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { storeReport } from '../src/dmarc/store-report';
import { sendFirstReportNow } from '../src/lifecycle/email/run';
import { handlePublicFunnelRoute } from '../src/funnel/routes';
import { sendChangeNotification, notifyConnectionBroken } from '../src/monitor/notify';
import { signToken } from '../src/mail/tokens';
import { TenantContext } from '../src/tenancy/context';
import type { MailMessage } from '../src/mail/mailer';
import { DAY, MON_16_NOV, WEEK_9_NOV, WS, RUA, lifecycleWorld, recordNamingUs, type RecordSpec, type World } from '../test/lifecycle/email/world';
import { writeFileSync as wf, rmSync, mkdirSync } from 'node:fs';
import { EMAILS, kindOf, rlog as log, save, REV } from './lib';

const D = 'brightwave-mail.com';
const SUBD = 'news.brightwave-mail.com';
const OTHER = 'brightwave-news.example';
const ok = (count = 100, d = D): RecordSpec => ({ ip: '192.0.2.10', count, spf: ['pass', d], dkim: ['pass', d], org: 'Google Workspace', rdns: 'mail-sor-f41.google.com', base: 'google.com', from: d });
const sg = (count: number): RecordSpec => ({ ip: '198.51.100.7', count, spf: ['pass', 'sendgrid.net'], dkim: ['pass', 'sendgrid.net'], org: 'SendGrid', rdns: 'o1.email.sendgrid.net', base: 'sendgrid.net' });
const BILLING = { STRIPE_SECRET_KEY: 'rk_test_abc123', STRIPE_WEBHOOK_SECRET: 'whsec_abc123' };

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(MON_16_NOV * 1000); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

/** Saves every message sent since the last take. Names: <scenario>__<kind><suffix>. */
function capture(w: World, scenario: string) {
  let cursor = 0;
  const seen = new Map<string, number>();
  return (suffix = '') => {
    const out: MailMessage[] = [];
    for (const m of w.mailer.sent.slice(cursor)) {
      const k = kindOf(m.subject);
      const n = (seen.get(k + suffix) ?? 0) + 1;
      seen.set(k + suffix, n);
      save(`${scenario}__${k}${suffix}${n > 1 ? `_${n}` : ''}`, m);
      out.push(m);
    }
    cursor = w.mailer.sent.length;
    return out;
  };
}
const week = (w: World, monday: number, records: RecordSpec[], domain = D, storedAt?: number) => { for (let i = 0; i < 7; i++) w.addReport({ domain, day: monday + i * DAY, storedAt: storedAt ?? monday + i * DAY + 3600, records }); };
const sub = (m: MailMessage[]) => m.map((x) => x.subject);
const wireSetup = (w: World, domain: string) => w.dns.set(domain, recordNamingUs());

describe('PART A', () => {
  it('0 clean', () => { rmSync(EMAILS, { recursive: true, force: true }); mkdirSync(EMAILS, { recursive: true }); wf(join(REV, 'render.out'), ''); });

  it('1 allpass', async () => {
    const w = await lifecycleWorld();
    const take = capture(w, 'allpass');
    w.addDomain({ domain: D });
    wireSetup(w, D);
    await w.run({ schedule: 'daily' });
    log('A1 records live', sub(take()));
    // reports: two clean weeks (2 Nov, 9 Nov); the first one is the first report
    week(w, WEEK_9_NOV - 7 * DAY, [ok(120)]);
    week(w, WEEK_9_NOV, [ok(120)]);
    await sendFirstReportNow(w.tenant(), w.ctx, 1, 1, w.deps);
    log('A1 first report', sub(take()));
    w.at(0, 9);
    await w.run({ schedule: 'weekly' });
    log('A1 weekly', sub(take()));
    // tip_done: its own world at p=reject
    const r = await lifecycleWorld();
    r.addDomain({ domain: D, policy: 'reject' });
    wireSetup(r, D); r.dns.set(D, recordNamingUs('reject'));
    week(r, WEEK_9_NOV - 7 * DAY, [ok(120)]); week(r, WEEK_9_NOV, [ok(120)]);
    r.at(0, 9);
    await r.run({ schedule: 'weekly' });
    const got = r.mailer.sent;
    log('A1 reject world', sub(got));
    // rename: keep only the tip_done from the reject world, as allpass__tip_done
    const tip = got.find((m) => kindOf(m.subject) === 'tip_done');
    if (tip) save('allpass__tip_done', tip);
    expect(w.mailer.sent.length).toBeGreaterThan(0);
  });

  const legit = async (extra: Record<string, unknown>, scenario: string, suffix: string, first: boolean) => {
    const w = await lifecycleWorld(extra);
    const take = capture(w, scenario);
    w.addDomain({ domain: D });
    wireSetup(w, D);
    week(w, WEEK_9_NOV, [ok(100), sg(40)]);
    if (extra.STRIPE_SECRET_KEY) w.sql.prepare("INSERT INTO billing_price_cache (lookup_key, price_id, amount, currency, fetched_at) VALUES ('rsm_fix_one_domain', 'price_1', 14900, 'usd', 1)").run();
    if (first) { await sendFirstReportNow(w.tenant(), w.ctx, 1, 1, w.deps); log(`A ${scenario} first`, sub(take())); }
    w.at(0, 9);
    await w.run({ schedule: 'weekly' });
    const got = take(suffix);
    log(`A ${scenario}${suffix} weekly`, sub(got));
    return got;
  };

  it('2 legitfail (billing off / on)', async () => {
    await legit({}, 'legitfail', '_billing_off', true);
    const on = await legit({ ...BILLING }, 'legitfail', '_billing_on', false);
    const tip = on.find((m) => kindOf(m.subject) === 'tip_fix');
    log('A2 billing-on tip has $149', !!tip && tip.text.includes('$149'));
  });

  it('3 spoofonly', async () => {
    const strangers: Record<string, RecordSpec> = {
      a: { ip: '203.0.113.50', count: 30, spf: ['fail', null], dkim: ['none', null] },
      b: { ip: '203.0.113.60', count: 30, spf: ['pass', 'bulkmailer.example'], dkim: ['none', null] },
    };
    for (const [k, s] of Object.entries(strangers)) {
      const w = await lifecycleWorld({ ...BILLING });
      const take = capture(w, `spoofonly_${k}`);
      w.addDomain({ domain: D });
      wireSetup(w, D);
      week(w, WEEK_9_NOV, [ok(100), s]);
      w.sql.prepare("INSERT INTO billing_price_cache (lookup_key, price_id, amount, currency, fetched_at) VALUES ('rsm_fix_one_domain', 'price_1', 14900, 'usd', 1)").run();
      await sendFirstReportNow(w.tenant(), w.ctx, 1, 1, w.deps);
      w.at(0, 9);
      await w.run({ schedule: 'weekly' });
      const got = take();
      log(`A3${k}`, sub(got));
      const tip = got.find((m) => m.subject.startsWith('One service'));
      log(`A3${k} tip_fix sent`, !!tip, 'has $149', !!tip && tip.text.includes('$149'));
    }
  });

  it('4 noreports', async () => {
    const cases: Array<[string, string | null | 'error', string]> = [
      ['names_us', recordNamingUs(), 'names_us'],
      ['does_not', 'v=DMARC1; p=none; rua=mailto:dmarc@brightwave-mail.com', 'does_not'],
      ['read_failed', 'error', 'failed'],
    ];
    for (const [label, dns] of cases.map(([a, b]) => [a, b] as const)) {
      const w = await lifecycleWorld();
      const take = capture(w, 'noreports');
      w.addDomain({ domain: D, createdAt: MON_16_NOV - 20 * DAY });
      w.dns.set(D, recordNamingUs());
      w.at(-3);
      await w.run({ schedule: 'daily' });
      const live = take(`_${label}`);
      w.dns.set(D, dns);
      w.at(0);
      await w.run({ schedule: 'daily' });
      log(`A4 ${label}`, sub(live), sub(take(`_${label}`)));
    }
  });

  it('5 several', async () => {
    const w = await lifecycleWorld();
    const take = capture(w, 'several');
    for (const d of [D, SUBD, OTHER]) { w.addDomain({ domain: d, createdAt: MON_16_NOV - 2 * DAY }); wireSetup(w, d); }
    await w.run({ schedule: 'daily' });
    log('A5 live', sub(take()));
    // first reports: one report per domain, the Sunday, stored now
    const sunday = WEEK_9_NOV + 6 * DAY;
    for (const d of [D, SUBD, OTHER]) w.addReport({ domain: d, day: sunday, storedAt: w.clock.now - 3600, records: [ok(80, d), ...(d === D ? [sg(12)] : [])] });
    await w.run({ schedule: 'daily' });
    log('A5 first', sub(take()));
    for (const d of [D, SUBD, OTHER]) for (let i = 0; i < 6; i++) w.addReport({ domain: d, day: WEEK_9_NOV + i * DAY, storedAt: w.clock.now - 3600, records: [ok(60 + i * 5, d), ...(d === D ? [sg(2)] : [])] });
    w.at(0, 9);
    await w.run({ schedule: 'weekly' });
    log('A5 weekly', sub(take()));
  });

  it('6 subdomain', async () => {
    const w = await lifecycleWorld();
    const take = capture(w, 'subdomain');
    w.addDomain({ domain: SUBD });
    wireSetup(w, SUBD);
    const rec: RecordSpec = { ip: '192.0.2.44', count: 90, spf: ['pass', 'bounce.mailer.example'], dkim: ['pass', D], org: 'Mailer', from: SUBD };
    week(w, WEEK_9_NOV, [rec], SUBD);
    await sendFirstReportNow(w.tenant(), w.ctx, 1, 1, w.deps);
    w.at(0, 9);
    await w.run({ schedule: 'weekly' });
    const got = take();
    log('A6', sub(got));
    for (const m of got) log('A6 line', m.text.split('\n').filter((l) => /passed|messages/.test(l)).slice(0, 4));
  });

  it('7 google-first', async () => {
    const sent: any[] = [];
    const SEND_EMAIL = { send: async (m: any) => { sent.push(m); return { messageId: 'x' }; } };
    const w = await lifecycleWorld({ SEND_EMAIL });
    vi.setSystemTime(w.clock.now * 1000);
    const id = w.addDomain({ domain: D });
    wireSetup(w, D);
    const waited: Promise<unknown>[] = [];
    const rec = (ip: string, n: number) => ({
      source: { ip, reverse_dns: 'mail-sor-f41.google.com', base_domain: 'google.com', country_code: null, country_name: null, subdivision: null, city: null, org: 'Google Workspace' },
      count: n, alignment: { spf: true, dkim: true, dmarc: true },
      policy_evaluated: { disposition: 'none' as const, dkim: 'pass' as const, spf: 'pass' as const, policy_override_reasons: [] },
      identifiers: { header_from: D, envelope_from: null, envelope_to: null },
      auth_results: { dkim: [{ domain: D, selector: 's', result: 'pass' as const }], spf: [{ domain: D, scope: 'mfrom' as const, result: 'pass' as const }] },
    });
    const report = {
      xml_schema: 'draft' as const,
      report_metadata: { org_name: 'google.com', org_email: 'noreply-dmarc-support@google.com', org_extra_contact_info: null, report_id: 'g1', begin_date: '2026-11-15T00:00:00Z', end_date: '2026-11-15T23:59:59Z', errors: [] },
      policy_published: { domain: D, adkim: 'r' as const, aspf: 'r' as const, p: 'none' as const, sp: 'none' as const, pct: 100, fo: '0' },
      records: [rec('192.0.2.10', 64), rec('192.0.2.11', 23)],
    };
    const stored = await storeReport(w.tenant(), id, report as any, null, true, { tier: 'counted', identity: 'google.com', auth: 'dkim', domain: 'google.com', reason: null, knownAs: 'Google' } as any, { waitUntil: (p: Promise<unknown>) => { waited.push(p); } });
    await Promise.all(waited);
    log('A7 stored', stored, 'waitUntil calls', waited.length, 'sent', sent.map((m) => m.subject));
    expect(sent.length).toBe(1);
    const m = sent[0];
    save('google-first__first_report', { from: m.from, to: Array.isArray(m.to) ? m.to[0] : m.to, subject: m.subject, text: m.text, html: m.html, replyTo: m.replyTo, headers: m.headers } as MailMessage);
  });

  it('8 other emails', async () => {
    // change alert + connection alert: hosted with the switch on, and also the self-host default
    const raw: any[] = [];
    const SEND_EMAIL = { send: async (m: any) => { raw.push(m); return { messageId: 'x' }; } };
    const w = await lifecycleWorld({ SEND_EMAIL, LIFECYCLE_EMAILS_ON: 'change_alerts' });
    w.addDomain({ domain: D });
    const degraded = [
      { field: 'DMARC policy', was: 'p=reject', now: 'p=none', severity: 'degraded' as const },
      { field: 'SPF record', was: 'v=spf1 include:_spf.google.com -all', now: 'v=spf1 include:_spf.google.com ~all', severity: 'degraded' as const },
      { field: 'DKIM selector google', was: '(not set)', now: 'v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA…', severity: 'improved' as const },
    ];
    await sendChangeNotification('dana@brightwave-mail.com', D, degraded, w.tenant());
    await sendChangeNotification('dana@brightwave-mail.com', D, [degraded[2]], w.tenant());
    await notifyConnectionBroken(w.tenant(), { id: 'c1', label: 'Brightwave Cloudflare', detail: 'Cloudflare answered 403: the API token was revoked or expired.' });
    log('A8 alert subjects', raw.map((m) => m.subject));
    const names = ['monitor__change_alert_degraded', 'monitor__change_alert_improved', 'monitor__connection_alert'];
    raw.forEach((m, i) => save(names[i] ?? `monitor__extra_${i}`, { from: m.from, to: Array.isArray(m.to) ? m.to[0] : m.to, subject: m.subject, text: m.text, html: m.html, replyTo: m.replyTo, headers: m.headers } as MailMessage));

    // self-host first report: mode selfhost, own sender, no public origin (typical) and with one
    for (const [suffix, extra] of [['', { PUBLIC_BASE_URL: undefined, POSTAL_ADDRESS: undefined, MAIL_REPLY_TO: undefined }], ['_with_origin', { PUBLIC_BASE_URL: 'https://dmarc.brightwave-mail.com', POSTAL_ADDRESS: undefined, MAIL_REPLY_TO: undefined }]] as const) {
      const s = await lifecycleWorld({ MODE: 'selfhost', SAAS_ENABLED: undefined, ...extra });
      const id = s.addDomain({ domain: D });
      week(s, WEEK_9_NOV, [ok(70), sg(5)]);
      const tenant = new TenantContext({ env: s.env, workspaceId: WS, mode: 'selfhost', settings: { fromEmail: 'dmarc@brightwave-mail.com' } });
      await sendFirstReportNow(tenant, s.ctx, id, 1, s.deps);
      const got = capture(s, 'selfhost')(suffix);
      log('A8 selfhost', suffix, got.map((m) => `${m.subject} | to ${m.to} | from ${m.from.email}`));
    }

    // leads/unsubscribe pages
    const env = w.env;
    const unsub = await signToken(env, { p: 'unsub', e: 'dana@brightwave-mail.com' });
    const pref = await signToken(env, { p: 'pref', u: 'u_dana', w: WS, k: 'summary' });
    const pages: Array<[string, string]> = [
      ['leads__unsubscribe_confirm', `/api/unsubscribe?t=${encodeURIComponent(unsub)}`],
      ['prefs__off_confirm', `/api/email-preferences/off?t=${encodeURIComponent(pref)}`],
      ['prefs__off_invalid', `/api/email-preferences/off?t=garbage`],
    ];
    for (const [name, path] of pages) {
      const res = (await handlePublicFunnelRoute(new Request(`https://app.readysetmail.com${path}`), env))!;
      const body = await res.text();
      writeFileSync(join(EMAILS, `${name}.html`), body);
      writeFileSync(join(EMAILS, `${name}.json`), JSON.stringify({ status: res.status, headers: Object.fromEntries(res.headers) }, null, 2));
      log('A8 page', name, res.status);
    }
  });
});
