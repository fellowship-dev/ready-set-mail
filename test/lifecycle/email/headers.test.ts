// Header requirements of the lifecycle emails (spec test category 5): List-Unsubscribe on summary and tips only, From and Reply-To for every kind.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleApi } from '../../../src/api/router';
import type { MailMessage } from '../../../src/mail/mailer';
import { BASE, DAY, REPLY_TO, SENDER, WEEK_9_NOV, WS, lifecycleWorld, recordNamingUs, type World } from './world';

afterEach(() => vi.restoreAllMocks());

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
const DOMAIN = 'brightwave-mail.com';
const SENDGRID = { ip: '192.0.2.50', count: 20, spf: ['pass', 'sendgrid.net'] as [string, string], dkim: ['pass', 'sendgrid.net'] as [string, string], org: 'SendGrid' };
const GOOD = { ip: '192.0.2.10', count: 30, spf: ['pass', DOMAIN] as [string, string], dkim: ['pass', DOMAIN] as [string, string], org: 'Google Workspace' };

/** A domain whose last two complete weeks (2-15 Nov) had reports with one failing third-party source in the later week: a summary and a tip are due on Mon 16 Nov. */
async function weeklyWorld(extra: Record<string, unknown> = {}) {
  const w = await lifecycleWorld(extra);
  vi.restoreAllMocks();
  w.addDomain({ domain: DOMAIN });
  w.addReport({ domain: DOMAIN, day: WEEK_9_NOV, total: 50, passed: 30, records: [GOOD, SENDGRID] });
  return w;
}

const isSummary = (m: MailMessage) => /^Week of /.test(m.subject);
const isTip = (m: MailMessage) => /needs SPF or DKIM|every message passed DMARC|nothing to do/.test(m.subject);

function expectOneClick(m: MailMessage) {
  const h = m.headers ?? {};
  const lu = h['List-Unsubscribe'];
  expect(lu).toMatch(/^<https:\/\/[^<>,\s]+>$/);
  expect(lu!.match(/https?:\/\//g)).toHaveLength(1);
  const url = lu!.slice(1, -1);
  expect(url.startsWith(`${BASE}/api/email-preferences/off?t=`)).toBe(true);
  expect(h['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  expect(m.html).toContain(`href="${url}"`);
  expect(m.html).toMatch(/Unsubscribe|Turn off/);
  expect(m.text).toContain(url);
  expect(m.text + m.html).toContain('1 Example Street');
  return url;
}

describe('summary and tips emails', () => {
  it('carry one https List-Unsubscribe URL, the one-click post header, a visible link in HTML and text, and the postal footer', async () => {
    const w = await weeklyWorld();
    await w.run();
    const summaries = w.mailer.sent.filter(isSummary);
    const tips = w.mailer.sent.filter(isTip);
    expect(summaries).toHaveLength(1);
    expect(tips).toHaveLength(1);
    const urls = [...summaries, ...tips].map(expectOneClick);
    // a link per kind: the summary link turns off the summary, the tip link the tips
    expect(new Set(urls).size).toBe(2);
    for (const m of [...summaries, ...tips]) expect(m.to).toBe('dana@brightwave-mail.com');
  });

  it('send from the platform sender with Reply-To = MAIL_REPLY_TO, for every kind', async () => {
    const w = await weeklyWorld();
    w.addDomain({ domain: 'new-site.example' });
    w.dns.set('new-site.example', recordNamingUs());
    await w.run();
    expect(w.mailer.sent.length).toBeGreaterThanOrEqual(3);
    for (const m of w.mailer.sent) {
      expect(m.from.email).toBe(SENDER);
      expect(m.from.email).toBe('noreply@app.readysetmail.com');
      expect(m.replyTo).toBe(REPLY_TO);
    }
  });

  it('have no Reply-To when MAIL_REPLY_TO is not set', async () => {
    const w = await weeklyWorld({ MAIL_REPLY_TO: undefined });
    w.addDomain({ domain: 'new-site.example' });
    w.dns.set('new-site.example', recordNamingUs());
    await w.run();
    expect(w.mailer.sent.length).toBeGreaterThanOrEqual(3);
    for (const m of w.mailer.sent) {
      expect(m.replyTo).toBeUndefined();
      expect(Object.keys(m)).not.toContain('replyTo');
      expect(m.from.email).toBe(SENDER);
    }
  });
});

describe('milestone emails', () => {
  it('records live: no List-Unsubscribe headers, a reason line and a link to the email settings', async () => {
    const w = await lifecycleWorld(); vi.restoreAllMocks();
    w.addDomain({ domain: DOMAIN });
    w.dns.set(DOMAIN, recordNamingUs());
    await w.run();
    expect(w.mailer.sent).toHaveLength(1);
    const m = w.mailer.sent[0]!;
    expect(m.subject).toBe('brightwave-mail.com is set up: reports are on their way');
    expectTransactional(m);
  });

  it('first report: no List-Unsubscribe headers, a reason line and a link to the email settings', async () => {
    const w = await lifecycleWorld(); vi.restoreAllMocks();
    w.addDomain({ domain: DOMAIN });
    w.addReport({ domain: DOMAIN, day: w.clock.now - DAY - (w.clock.now % DAY) });
    await w.run();
    const m = w.mailer.sent.find((x) => /^First DMARC report/.test(x.subject));
    expect(m).toBeDefined();
    expectTransactional(m!);
  });

  it('no reports yet: no List-Unsubscribe headers, a reason line and a link to the email settings', async () => {
    const w = await lifecycleWorld(); vi.restoreAllMocks();
    w.addDomain({ domain: DOMAIN });
    w.dns.set(DOMAIN, recordNamingUs());
    await w.run(); // records live (job saw it)
    w.mailer.sent.length = 0;
    w.at(4);
    await w.run();
    const m = w.mailer.sent.find((x) => /^No DMARC reports yet/.test(x.subject));
    expect(m).toBeDefined();
    expectTransactional(m!);
  });
});

function expectTransactional(m: MailMessage) {
  expect(m.headers?.['List-Unsubscribe']).toBeUndefined();
  expect(m.headers?.['List-Unsubscribe-Post']).toBeUndefined();
  expect(Object.keys(m.headers ?? {}).map((k) => k.toLowerCase())).not.toContain('list-unsubscribe');
  expect(m.text).toContain('You get this because you added brightwave-mail.com to Brightwave Studio on Ready Set Mail.');
  expect(m.html).toContain('You get this because you added brightwave-mail.com to Brightwave Studio on Ready Set Mail.');
  expect(m.text).toContain(`${BASE}/#/w/${WS}/settings`);
  expect(m.html).toContain(`${BASE}/#/w/${WS}/settings`);
  expect(m.text + m.html).toContain('1 Example Street');
  expect(m.html).not.toMatch(/api\/email-preferences\/off|api\/unsubscribe/);
  expect(m.from.email).toBe(SENDER);
  expect(m.replyTo).toBe(REPLY_TO);
}

describe('the one-click URL of the header', () => {
  it('works end to end: POST it, and the next week sends no summary', async () => {
    const w = await weeklyWorld();
    await w.run();
    const first = w.mailer.sent.find(isSummary)!;
    const url = first.headers!['List-Unsubscribe']!.slice(1, -1);
    expect(w.rows('SELECT * FROM email_preferences')).toEqual([]);

    const res = await handleApi(new Request(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' }), w.env as never, ctx);
    expect(res.status).toBe(200);
    expect(w.rows('SELECT user_id, workspace_id, kind, enabled FROM email_preferences')).toEqual([{ user_id: w.dana, workspace_id: WS, kind: 'summary', enabled: 0 }]);

    // The following week there are reports again (16-22 Nov): without the opt-out a summary would be due on Mon 23 Nov.
    w.addReport({ domain: DOMAIN, day: WEEK_9_NOV + 7 * DAY, total: 40, passed: 40 });
    w.at(7);
    w.mailer.sent.length = 0;
    await w.run();
    expect(w.mailer.sent.filter(isSummary)).toEqual([]);
  });

  it('control: without the opt-out the next week does send a summary', async () => {
    const w = await weeklyWorld();
    await w.run();
    w.addReport({ domain: DOMAIN, day: WEEK_9_NOV + 7 * DAY, total: 40, passed: 40 });
    w.at(7);
    w.mailer.sent.length = 0;
    await w.run();
    expect(w.mailer.sent.filter(isSummary)).toHaveLength(1);
  });
});
