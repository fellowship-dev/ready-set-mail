import { describe, expect, it } from 'vitest';
import { render } from '../../../src/lifecycle/email/copy';
import { greeting } from '../../../src/lifecycle/email/preferences';
import { allVariants, DOMAIN_URL, type Variant } from './fixtures';

const variants = allVariants();
const byName = (name: string): Variant => {
  const v = variants.find((x) => x.name === name);
  if (!v) throw new Error(`no variant ${name}`);
  return v;
};
const rendered = (name: string) => render(byName(name).mail);

/** The part of the HTML between the brand header and the layout footer. */
const bodyOf = (html: string): string => html.split('<tr><td style="padding:20px 16px;word-wrap:break-word;overflow-wrap:break-word;">')[1].split('<tr><td style="padding:12px 24px;')[0];
const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&middot;/g, '·').replace(/&amp;/g, '&');
const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
/** Every visible piece of text of the body, one per element. */
const pieces = (html: string): string[] => decode(bodyOf(html).replace(/<[^>]+>/g, '\n')).split('\n').map((x) => x.trim()).filter((x) => x && x !== '·');
const hrefs = (html: string): string[] => [...html.matchAll(/href="([^"]+)"/g)].map((m) => decode(m[1]));

describe('snapshots: every lifecycle email, text and HTML', () => {
  it.each(variants.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    const r = render(v.mail);
    expect(r.subject).toMatchSnapshot('subject');
    expect(r.text).toMatchSnapshot('text');
    expect(r.html).toMatchSnapshot('html');
  });
});

describe('subject lines', () => {
  const expected: Record<string, string> = {
    'records live: one domain': 'brightwave-mail.com is set up: reports are on their way',
    'records live: several domains': '2 domains are set up: reports are on their way',
    'first report: all passed': 'First DMARC report for brightwave-mail.com: 14 messages, all passed',
    'first report: failing, passed DKIM for another domain': 'First DMARC report for brightwave-mail.com: 14 messages, 3 passed',
    'first report: failing, no nameable source': 'First DMARC report for brightwave-mail.com: 14 messages, 13 passed',
    'first report: one message did not pass, one source': 'First DMARC report for brightwave-mail.com: 1 message, 0 passed',
    'first report: several domains': 'First DMARC reports for 2 domains',
    'no reports: still names us': 'No DMARC reports yet for brightwave-mail.com',
    'no reports: no longer names us, with record': 'No DMARC reports yet for brightwave-mail.com',
    'no reports: read failed': 'No DMARC reports yet for brightwave-mail.com',
    'no reports: several domains, email check': 'No DMARC reports yet for 3 domains',
    'summary: one domain, owner, started failing': 'Week of 9–15 Nov: brightwave-mail.com, 1,240 messages, 97% passed',
    'summary: several domains, subdomain nested, new failing source': 'Week of 9–15 Nov: 3 domains, 4,120 messages, 98% passed',
    'summary: one domain, no reports this week but a change': 'Week of 9–15 Nov: brightwave-mail.com, no reports',
    'tip fix: without offer': 'One service sending as brightwave-mail.com needs SPF or DKIM',
    'tip fix: with offer': 'One service sending as brightwave-mail.com needs SPF or DKIM',
    'tip next: none to quarantine': 'brightwave-mail.com: every message passed DMARC for two weeks',
    'tip next: quarantine to reject': 'brightwave-mail.com: every message passed DMARC for two weeks',
    'tip done': 'brightwave-mail.com: nothing to do',
  };
  it.each(Object.entries(expected))('%s', (name, subject) => {
    expect(rendered(name).subject).toBe(subject);
  });
  it('is also the HTML title', () => {
    for (const v of variants) {
      const r = render(v.mail);
      expect(r.html).toContain(`<title>${r.subject}</title>`);
    }
  });
  it('has no subject with a leading or double space, or a newline', () => {
    for (const v of variants) expect(v.mail.subject).toMatch(/^\S+( \S+)*$/);
  });
});

describe('greeting', () => {
  it('uses the first name when the name is a real name', () => {
    expect(greeting('Dana Reyes')).toBe('Hi Dana,');
    expect(greeting('  Dana   Reyes ')).toBe('Hi Dana,');
    expect(rendered('records live: one domain').text).toMatch(/^Hi Dana,\n/m);
  });
  it('is just "Hi," when the name is an email address, empty or missing', () => {
    expect(greeting('dana@brightwave-mail.com')).toBe('Hi,');
    expect(greeting('')).toBe('Hi,');
    expect(greeting(null)).toBe('Hi,');
    expect(greeting(undefined)).toBe('Hi,');
    const r = rendered('records live: nameless recipient');
    expect(r.text.startsWith('Hi,\n')).toBe(true);
    expect(r.html).toContain('>Hi,</p>');
    expect(r.html).not.toContain('Hi Dana');
    expect(r.text).not.toContain('dana@');
  });
  it('is the first paragraph of every email, and says Hi Dana for all of them but the nameless one', () => {
    for (const v of variants) {
      const first = v.mail.blocks[0];
      expect(first).toBe(v.name.includes('nameless') ? 'Hi,' : 'Hi Dana,');
    }
  });
});

describe('dates are UTC and written like "Mon 16 Nov"', () => {
  it('records live names the day, the time and UTC', () => {
    expect(rendered('records live: one domain').text).toContain('We saw it in public DNS on Mon 16 Nov at 11:00 UTC.');
    expect(rendered('records live: several domains').text).toContain('- brightwave-news.example: Mon 16 Nov at 10:00 UTC');
  });
  it('first report names the report day, or the span, with (UTC)', () => {
    expect(rendered('first report: all passed').text).toContain('on Sun 15 Nov (UTC).');
    expect(rendered('first report: report spanning two days').text).toContain('on Sat 14 Nov – Sun 15 Nov (UTC).');
  });
  it('no reports names the day the record went live', () => {
    expect(rendered('no reports: still names us').text).toContain('since Fri 13 Nov (UTC), and no report');
    expect(rendered('no reports: several domains, email check').text).toContain('- brightwave-news.example, since Thu 12 Nov');
  });
  it('the summary writes the week with weekdays and UTC once, and the short range in the subject', () => {
    const r = rendered('summary: one domain, owner, started failing');
    expect(r.text).toContain('(Mon 9 – Sun 15 Nov, UTC)');
    expect(r.text.match(/UTC/g)).toHaveLength(1);
    expect(r.subject).toContain('Week of 9–15 Nov');
  });
  it('the next-step tip writes the two weeks as a range', () => {
    expect(rendered('tip next: none to quarantine').text).toContain('For the last two weeks (2–15 Nov, UTC)');
  });
  it('every date in every email is "<Day> <d> <Mon>"', () => {
    for (const v of variants) {
      for (const m of render(v.mail).text.matchAll(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b ?(\S*)/g)) expect(m[2]).toMatch(/^\d{1,2}$/);
    }
  });
});

describe('fits a 375 px phone: no fixed width, wrapping text (checked in Chromium for the gallery)', () => {
  it.each(variants.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    const html = render(v.mail).html;
    expect(html).not.toMatch(/\swidth="(?!100%)[^"]*"/); // no width attribute but 100%
    expect(html).not.toMatch(/(?<![-\w])(?:min-)?width:\s*(?!100%|0)\d+(?:px)?/); // no fixed or minimum pixel width (max-width is the cap)
    expect(html).toContain('width:100%;max-width:600px');
    for (const pre of html.match(/<pre [^>]*>/g) ?? []) expect(pre).toMatch(/white-space:pre-wrap;word-break:break-all/);
  });
});

describe('one button per email', () => {
  it.each(variants.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    const html = render(v.mail).html;
    expect(html.match(/display:inline-block;padding:10px 18px/g)).toHaveLength(1);
    // footer links and the offer link are text links, never buttons
    const links = hrefs(html);
    expect(links.length).toBeGreaterThanOrEqual(1);
    expect(html.match(/<a /g)!.length).toBe(links.length);
  });
  it('the button is the first link, and goes to the domain page (or the app for several domains)', () => {
    expect(hrefs(rendered('records live: one domain').html)[0]).toBe(DOMAIN_URL);
    expect(hrefs(rendered('records live: several domains').html)[0]).toBe('https://app.example.test');
  });
});

describe('the plain-text part says what the HTML says', () => {
  it.each(variants.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    const r = render(v.mail);
    const text = norm(r.text);
    for (const piece of pieces(r.html)) expect(text, `missing from text: ${piece}`).toContain(norm(piece));
    for (const url of hrefs(r.html)) expect(r.text).toContain(url);
  });

  it('carries the numbers, the domain and the URLs of the first report', () => {
    const r = rendered('first report: failing, passed DKIM for another domain');
    for (const needle of ['14', '3', '11', 'o1.email.sendgrid.net (198.51.100.7)', 'sendgrid.net', 'brightwave-mail.com', DOMAIN_URL]) {
      expect(r.text).toContain(needle);
      expect(decode(r.html)).toContain(needle);
    }
  });
  it('carries the offer, its price and its link in both parts', () => {
    const r = rendered('tip fix: with offer');
    for (const needle of ['Fix one domain, $149 per domain', 'ask for the full fee back', `${DOMAIN_URL}?order=1`]) {
      expect(r.text).toContain(needle);
      expect(decode(r.html)).toContain(needle.replace(/&/g, '&'));
    }
  });
  it('a domain name is never upper-cased in the text part (the several-domains email names each as a paragraph, not a heading)', () => {
    const r = rendered('no reports: several domains, email check');
    expect(r.html).not.toContain('<h2');
    expect(r.text).toContain('brightwave.example:');
    expect(r.text).not.toMatch(/BRIGHTWAVE/);
  });

  it('no reports: the "no mail has reached a large provider" reason is not given when the record no longer names us', () => {
    expect(rendered('no reports: no longer names us, with record').text).not.toContain('That usually means');
    expect(rendered('no reports: no longer names us, no record').text).not.toContain('That usually means');
    expect(rendered('no reports: still names us').text).toContain('That usually means no mail from brightwave-mail.com has reached a large mail provider');
    expect(rendered('no reports: read failed').text).toContain('That usually means');
  });
});

describe('what each email says is true for its data', () => {
  it('records live: one domain, the exact email', () => {
    expect(byName('records live: one domain').mail.blocks.slice(0, 4)).toEqual([
      'Hi Dana,',
      'The DMARC record of brightwave-mail.com now sends its reports to Ready Set Mail. We saw it in public DNS on Mon 16 Nov at 11:00 UTC.',
      'Mail providers send these reports about once a day, for the days they received mail from brightwave-mail.com. First reports usually arrive within a day or two. We will email you when the first one arrives.',
      { cta: { label: 'Open brightwave-mail.com', url: DOMAIN_URL } },
    ]);
  });
  it('records live: several domains list each with the time it was seen, in plural', () => {
    const t = rendered('records live: several domains').text;
    expect(t).toContain('The DMARC records of these domains now send their reports to Ready Set Mail.');
    expect(t).toContain('received mail from these domains.');
    expect(t).not.toContain('brightwave-mail.com now sends');
  });
  it('records live is transactional: its footer has no off link', () => {
    const r = rendered('records live: one domain');
    expect(r.text).toContain('You get this because you added brightwave-mail.com to Brightwave Studio on Ready Set Mail.');
    expect(r.text).toContain('Email settings: https://app.example.test/#/w/ws_brightwave/settings');
    expect(r.text).not.toMatch(/Turn off/);
  });

  it('first report: all passed says nothing about a failing source', () => {
    const t = rendered('first report: all passed').text;
    expect(t).toContain("Every message passed DMARC: each one was sent by a service that brightwave-mail.com's SPF or DKIM records cover.");
    expect(t).not.toContain('Worth a look');
    expect(t).toMatch(/Messages +Passed DMARC +Did not pass +Sending sources\n14 +14 +0 +2/);
  });
  it('first report: the failing source is named with its count and what it passed elsewhere', () => {
    const dkim = rendered('first report: failing, passed DKIM for another domain').text;
    expect(dkim).toContain('Worth a look: 11 messages from o1.email.sendgrid.net (198.51.100.7) did not pass DMARC. They passed DKIM for sendgrid.net, but not for brightwave-mail.com. If you use that service, it needs SPF or DKIM set up for brightwave-mail.com.');
    expect(dkim).not.toContain('p=none');
    expect(rendered('first report: failing, passed SPF for another domain').text).toContain('They passed SPF for mailer.example, but not for brightwave-mail.com.');
  });
  it('first report: the p=none sentence only when nothing else passed and the stored policy is none', () => {
    const none = rendered('first report: failing, no other pass, policy none').text;
    expect(none).toContain("If you use that service, it needs SPF or DKIM set up for brightwave-mail.com. If you don't recognise it, there is nothing to do while the policy is p=none.");
    expect(none).not.toContain('They passed');
    const quarantine = rendered('first report: failing, no other pass, policy quarantine').text;
    expect(quarantine).toContain('Worth a look: 11 messages from 203.0.113.5 did not pass DMARC. If you use that service, it needs SPF or DKIM set up for brightwave-mail.com.');
    expect(quarantine).not.toContain('p=none');
    expect(rendered('first report: failing, passed DKIM for another domain').text).not.toContain('p=none');
  });
  it('first report: with no nameable source it says how many did not pass and where to look', () => {
    const t = rendered('first report: failing, no nameable source').text;
    expect(t).toContain('Worth a look: 1 message did not pass DMARC. The domain page lists each source with its numbers.');
    expect(t).not.toContain('did not pass DMARC. If you use');
  });
  it('first report: one message is singular', () => {
    const t = rendered('first report: one message did not pass, one source').text;
    expect(t).toContain('1 message from Example Mailer (203.0.113.9) did not pass DMARC');
    expect(t).not.toContain('1 messages');
  });
  it('first report: several domains is one table with a row each', () => {
    const t = rendered('first report: several domains').text;
    expect(t).toContain('The first DMARC report has arrived for each of these domains:');
    expect(t).toMatch(/brightwave-mail\.com +Google +14 +14/);
    expect(t).toMatch(/news\.brightwave-mail\.com +Microsoft +1,240 +1,200/);
  });

  it('no reports: the three live-check outcomes', () => {
    const names = rendered('no reports: still names us').text;
    expect(names).toContain('It still names Ready Set Mail. Nothing needs changing: the first report will come after the domain sends mail to one of these providers.');
    expect(names).not.toContain('Add rua=');
    const does = rendered('no reports: no longer names us, with record').text;
    expect(does).toContain('It no longer names Ready Set Mail. Today it reads:\n\n    v=DMARC1; p=none; rua=mailto:dmarc@brightwave-mail.com\n\nAdd rua=mailto:rua@rua.readysetmail.com back to it');
    expect(does).toContain('Add rua=mailto:rua@rua.readysetmail.com back to it, or set it again from the domain page.');
    const none = rendered('no reports: no longer names us, no record').text;
    expect(none).toContain('It no longer names Ready Set Mail: public DNS shows no DMARC record for brightwave-mail.com.');
    expect(none).not.toContain('Today it reads');
    const failed = rendered('no reports: read failed').text;
    expect(failed).toContain('We could not read it just now. The domain page checks it again when you open it.');
    expect(failed).not.toContain('Add rua=');
  });
  it('no reports: the email-check sentence only with the email check', () => {
    expect(rendered('no reports: still names us').text).not.toContain('email check');
    expect(rendered('no reports: still names us, email check').text).toContain('To see a result now, send any email from brightwave-mail.com to the email check on the dashboard.');
    expect(rendered('no reports: several domains, email check').text).toContain('send any email from one of these domains to the email check');
  });
  it('no reports: several domains have their own heading and outcome', () => {
    const t = rendered('no reports: several domains, email check').text;
    expect(t).toContain('have named Ready Set Mail as their report address for at least three days');
    expect(t).toContain('We checked each record again just now:');
    expect(t).toContain('brightwave-mail.com:\n\nIt still names Ready Set Mail.');
    expect(t).toContain('brightwave-news.example:\n\nIt no longer names Ready Set Mail. Today it reads:\n\n    v=DMARC1; p=none\n\nAdd rua=mailto:rua@rua.readysetmail.com');
    expect(t).toContain('brightwave.example:\n\nWe could not read it just now.');
  });

  it('weekly summary: owner and admin footers, with the one-click link and the settings link', () => {
    const owner = rendered('summary: one domain, owner, started failing');
    expect(owner.text).toContain('Why am I getting this? You are the owner of Brightwave Studio on Ready Set Mail, and the weekly summary is on for you.');
    expect(owner.text).toContain('Turn off the weekly summary: https://app.example.test/api/email-preferences/off?t=TOKEN');
    expect(owner.text).toContain('Email settings: https://app.example.test/#/w/ws_brightwave/settings');
    expect(owner.html).toContain('Turn off the weekly summary</a> &middot; <a');
    const admin = rendered('summary: one domain, admin, new source failing, uncounted reports');
    expect(admin.text).toContain('You are an admin of Brightwave Studio on Ready Set Mail, and you turned the weekly summary on.');
    expect(admin.text).not.toContain('the owner of');
  });
  it('weekly summary: the uncounted line only when reports were not counted, singular and plural', () => {
    expect(rendered('summary: one domain, admin, new source failing, uncounted reports').text).toContain('3 reports from senders we do not recognise are not counted.');
    expect(rendered('summary: one domain, nothing changed').text).toContain('1 report from a sender we do not recognise is not counted.');
    expect(rendered('summary: one domain, owner, started failing').text).not.toContain('not counted');
  });
  it('weekly summary: nothing changed vs changes', () => {
    const quiet = rendered('summary: one domain, nothing changed').text;
    expect(quiet).toContain('Nothing changed since the week before.');
    expect(quiet).not.toContain('What changed since the week before:');
    expect(rendered('summary: one domain, owner, started failing').text).toContain('What changed since the week before:\n\n- ');
  });
  it('weekly summary: each "one thing to do" line', () => {
    expect(rendered('summary: one domain, owner, started failing').text).toContain('The one thing to do:\n\nLook at o1.email.sendgrid.net on brightwave-mail.com: 11 of its messages did not pass DMARC this week.');
    expect(rendered('summary: several domains, subdomain nested, new failing source').text).toContain('Look at 203.0.113.5 on brightwave-mail.com (new this week): 11 of its messages did not pass DMARC this week.');
    expect(rendered('summary: one domain, no reports this week but a change').text).toContain('brightwave-mail.com got no reports this week. Check that its DMARC record still names Ready Set Mail.');
    expect(rendered('summary: one domain, nothing changed').text).toContain('The one thing to do:\n\nNothing to do this week.');
  });
  it('weekly summary: a new source that passes is news but not a thing to do', () => {
    const t = rendered('summary: new source, all passed, nothing to do').text;
    expect(t).toContain('- New source on brightwave-mail.com: Mailchimp sent 5 messages, all passed.');
    expect(t).toContain('Nothing to do this week.');
  });
  it('weekly summary: the change list is capped at 8 with a count of the rest', () => {
    const t = rendered('summary: one new source with one failing message, nine changes').text;
    expect(t.match(/^- /gm)).toHaveLength(9);
    expect(t).toContain('- and 2 more.');
    expect(t).toContain('Service 0 sent 1 message, 1 did not pass DMARC.');
    expect(rendered('summary: one new source with one failing message, nine changes').subject).toBe('Week of 9–15 Nov: brightwave-mail.com, 1 message, 0% passed');
  });
  it('weekly summary: the subdomain row is indented under its registrable domain, and an empty domain says "-" and "not read"', () => {
    const r = rendered('summary: several domains, subdomain nested, new failing source');
    expect(r.text).toMatch(/^brightwave-mail\.com +1,240 +1,203 +97% +p=none$/m);
    expect(r.text).toMatch(/^ {2}news\.brightwave-mail\.com +2,880 +2,820 +98% +p=quarantine$/m);
    expect(r.text).toMatch(/^brightwave-news\.example +0 +0 +- +not read$/m);
    expect(r.html).toContain('padding-left:16px;">news.brightwave-mail.com</td>');
    expect(r.html.match(/padding-left:16px;/g)).toHaveLength(1);
  });
  it('weekly summary: the button names the domain only for one domain', () => {
    expect(rendered('summary: one domain, owner, started failing').text).toContain('Open brightwave-mail.com: ');
    expect(rendered('summary: several domains, subdomain nested, new failing source').text).toContain('Open Ready Set Mail: https://app.example.test');
  });

  it('tip fix: the source, its count, and what it passed', () => {
    const t = rendered('tip fix: without offer').text;
    expect(t).toContain('Last week 38 messages came from o1.email.sendgrid.net (198.51.100.7 and 2 more). They passed DKIM for sendgrid.net, but not for brightwave-mail.com, so they did not pass DMARC.');
    expect(t).not.toContain('Prefer we do it?');
    expect(rendered('tip fix: SPF, one address').text).toContain('Last week 12 messages came from 198.51.100.20. They passed SPF for mailer.example');
  });
  it('tip fix: the offer paragraph reads its words from the offer module, with a text link, not a second button', () => {
    const r = rendered('tip fix: with offer');
    expect(r.text).toContain('Prefer we do it? Fix one domain, $149 per domain: We find every service that sends email as your domain');
    expect(r.text).toContain('Moving to reject is a separate follow-on. Until we send the written note that the domain is done, you can ask for the full fee back.');
    expect(r.html.match(/display:inline-block;padding:10px 18px/g)).toHaveLength(1);
    expect(r.html).toContain('>See it on the domain page</a>');
  });
  it('tip next: none to quarantine', () => {
    const t = rendered('tip next: none to quarantine').text;
    expect(t).toContain("2,480 messages from 3 sources. Its policy is p=none, so mail from brightwave-mail.com that fails DMARC is still delivered.");
    expect(t).toContain("The next step, when you're ready: approve moving DMARC to p=quarantine. The record, to publish at _dmarc.brightwave-mail.com:\n\n    v=DMARC1; p=quarantine; rua=mailto:rua@rua.readysetmail.com");
    expect(t).toContain('Mail that passes DMARC is not affected by this change.');
    expect(t).not.toContain('Moving to p=reject is done in stages');
  });
  it('tip next: quarantine to reject adds the staging sentence', () => {
    const t = rendered('tip next: quarantine to reject').text;
    expect(t).toContain('Its policy is p=quarantine, so mail from brightwave-mail.com that fails DMARC is quarantined, usually to spam.');
    expect(t).toContain('is quarantined, usually to spam.');
    expect(t).toContain('approve moving DMARC to p=reject');
    expect(t).toContain('    v=DMARC1; p=reject; rua=mailto:rua@rua.readysetmail.com');
    expect(t).toContain('Moving to p=reject is done in stages; the domain page shows each step when the reports support it.');
  });
  it('tip done: one sentence, then nothing to do', () => {
    expect(rendered('tip done').text).toContain('brightwave-mail.com is at p=reject, and every message in its reports passed DMARC for the last two weeks (2,480 messages from 3 sources). There is nothing to do. Your weekly summary will say if a source starts failing.');
    expect(rendered('tip done: one message, one source').text).toContain('(1 message from 1 source)');
  });
  it('tips carry the off link and the reason; no tip has a second call to action besides the offer link', () => {
    for (const n of ['tip fix: without offer', 'tip next: none to quarantine', 'tip done']) {
      const t = rendered(n).text;
      expect(t).toContain('tips about your domains are on for you.');
      expect(t).toContain('Turn off tips about your domains: https://app.example.test/api/email-preferences/off?t=TOKEN');
    }
  });
});
