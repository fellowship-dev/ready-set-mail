// Workspace naming from the sign-up answers (src/auth/names.ts) and the code email's two parts (src/auth/mail.ts).
import { describe, it, expect, vi } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { defaultWorkspaceName, firstWorkspaceName, NEW_CLIENT_WORKSPACE } from '../../src/auth/names';
import { codeEmailHtml, codeEmailText, codeSubject, sendCodeEmail } from '../../src/auth/mail';
import { makeEnv } from './helpers';
import type { AuthEnv } from '../../src/auth/config';

describe('firstWorkspaceName', () => {
  const org = { organization: 'Brightwave Studio' };
  it('"My company\'s" and "Just looking around": the organization name', () => {
    expect(firstWorkspaceName({ ...org, whose_email: 'company' }, 'Dana', 'dana@brightwave-mail.com')).toBe('Brightwave Studio');
    expect(firstWorkspaceName({ ...org, whose_email: 'looking' }, 'Dana', 'dana@gmail.com')).toBe('Brightwave Studio');
  });
  it('"My clients\'": the agency name is not a workspace name; the first workspace waits for its first client domain', () => {
    expect(firstWorkspaceName({ organization: 'Northside IT', whose_email: 'clients' }, 'Sam', 'sam@northside-it.com')).toBe(NEW_CLIENT_WORKSPACE);
  });
  it('the organization name is cleaned like every name, and an empty one falls back to the old rule', () => {
    expect(firstWorkspaceName({ organization: 'Bright‮wave\n Studio', whose_email: 'company' }, '', 'a@b.com')).toBe('Bright wave Studio');
    expect(firstWorkspaceName({ organization: '​', whose_email: 'company' }, '', 'dana@brightwave-mail.com')).toBe('brightwave-mail.com workspace');
  });
  it('without answers it is today\'s rule (the email\'s domain, "My workspace" for free mail)', () => {
    expect(firstWorkspaceName(null, '', 'dana@brightwave-mail.com')).toBe(defaultWorkspaceName('', 'dana@brightwave-mail.com'));
    expect(firstWorkspaceName(null, '', 'dana@gmail.com')).toBe('My workspace');
  });
});

describe('the code email', () => {
  const origin = 'https://app.readysetmail.com';
  const env = () => makeEnv(createMigratedD1(), { MODE: 'saas', MAIL_REPLY_TO: 'hello@readysetmail.com', SEND_EMAIL: { send: vi.fn(async () => {}) } }) as unknown as AuthEnv;

  it('subject keeps its format: the code first', () => {
    expect(codeSubject('482190')).toBe('482190 is your Ready Set Mail code');
  });

  it('text: one sentence, the code alone on its line, the real lifetime, the ignore line, a way to reach a person', () => {
    const t = codeEmailText('482190', 'signup', origin, null, 'hello@readysetmail.com');
    expect(t.split('\n')[0]).toBe('Enter this code to finish creating your Ready Set Mail account.');
    expect(t).toMatch(/^ {4}482190$/m);
    expect(t).toContain(`It works for 10 minutes, once, in the browser where you asked for it. Enter it only on ${origin}.`);
    expect(t).toContain("If you didn't ask for this, you can ignore this email.");
    expect(t).toContain('Reply to this email and a person will answer.');
    expect(t).not.toMatch(/Hi,|nobody can use it/);
  });

  it('omits the "reply" sentence when the instance has no reply-to mailbox', () => {
    expect(codeEmailText('482190', 'signup', origin, null)).not.toMatch(/Reply to this email/);
    expect(codeEmailText('482190', 'signup', origin, null, null)).not.toMatch(/Reply to this email/);
  });

  it('keeps the approximate place (the phishing-relay cue) for every purpose, as small print, and the password advice for sign-in only', () => {
    for (const purpose of ['signup', 'invite', 'signin', 'reset', 'confirm'] as const) {
      expect(codeEmailText('123456', purpose, origin, 'Santiago, CL')).toContain('Asked for from near Santiago, CL (approximate, from the network address).');
    }
    expect(codeEmailText('123456', 'signin', origin, null)).toContain('Forgot your password?');
    expect(codeEmailText('123456', 'signup', origin, null)).not.toContain('Forgot your password?');
    expect(codeEmailText('123456', 'signup', origin, null)).not.toContain('Asked for from');
  });

  it('html: the wordmark as text, the code in large selectable digits, no image, no link, no remote resource', () => {
    const h = codeEmailHtml(env(), '482190', 'signup', origin, 'Santiago, CL', 'hello@readysetmail.com');
    expect(h).toMatch(/>readysetmail<\/span>/);
    expect(h).toMatch(/font-size:40px[^"]*">482190<\/span>/);
    expect(h).toContain('font-family:\'Courier New\'');
    expect(h).toContain('Enter this code to finish creating your Ready Set Mail account.');
    expect(h).toContain('It works for 10 minutes');
    expect(h).toContain('Asked for from near Santiago, CL');
    expect(h).not.toMatch(/<img|<a\s|<link|<svg|@import|url\(|data:image|src=/i);
  });

  it('html escapes what it is given', () => {
    const h = codeEmailHtml(env(), '1<2>3&4', 'signup', origin, '<b>x</b>, CL', null);
    expect(h).not.toContain('<b>x</b>');
    expect(h).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('is sent as text and html together with Reply-To from MAIL_REPLY_TO, and without one when unset', async () => {
    const withReply = env();
    expect(await sendCodeEmail(withReply, 'a@example.com', '482190', 'signup', origin, null)).toBe(true);
    const sent = (withReply.SEND_EMAIL as unknown as { send: ReturnType<typeof vi.fn> }).send.mock.calls[0]![0];
    expect(sent.subject).toBe('482190 is your Ready Set Mail code');
    expect(sent.replyTo).toBe('hello@readysetmail.com');
    expect(sent.html).toContain('482190');
    expect(sent.text).toContain('482190');

    const bare = makeEnv(createMigratedD1(), { MODE: 'saas', SEND_EMAIL: { send: vi.fn(async () => {}) } }) as unknown as AuthEnv;
    await sendCodeEmail(bare, 'a@example.com', '482190', 'signup', origin, null);
    const sent2 = (bare.SEND_EMAIL as unknown as { send: ReturnType<typeof vi.fn> }).send.mock.calls[0]![0];
    expect(sent2.replyTo).toBeUndefined();
    expect(sent2.text).not.toMatch(/Reply to this email/);
  });
});
