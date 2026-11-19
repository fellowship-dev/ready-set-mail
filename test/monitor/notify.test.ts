import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { notifyConnectionBroken, sendChangeNotification } from '../../src/monitor/notify';
import { makeTenant, seedSettings } from '../helpers/tenant';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import type { DomainChange } from '../../src/monitor/check';

const degraded: DomainChange = { field: 'DMARC policy', was: 'reject', now: 'none', severity: 'degraded' };
const improved: DomainChange = { field: 'DMARC policy', was: 'none', now: 'reject', severity: 'improved' };

function makeSendEmail() {
  return { send: vi.fn().mockResolvedValue(undefined) };
}

function makeEnv(sendEmail?: { send: ReturnType<typeof vi.fn> }, env: Record<string, string> = {}) {
  return makeTenant({
    env: { SEND_EMAIL: sendEmail as any, PUBLIC_BASE_URL: 'https://app.readysetmail.com', ...env },
    settings: { reportsDomain: 'reports.readysetmail.com', fromEmail: 'check@reports.readysetmail.com' },
  });
}

describe('sendChangeNotification', () => {
  it('calls SEND_EMAIL.send when binding is configured', async () => {
    const sendEmail = makeSendEmail();
    const env = makeEnv(sendEmail);
    await sendChangeNotification('user@example.com', 'acme.com', [improved], env);
    expect(sendEmail.send).toHaveBeenCalledOnce();
  });

  it('sends correct from/to fields', async () => {
    const sendEmail = makeSendEmail();
    const env = makeEnv(sendEmail);
    await sendChangeNotification('user@example.com', 'acme.com', [improved], env);
    const arg = sendEmail.send.mock.calls[0][0];
    expect(arg.from.email).toBe('check@reports.readysetmail.com');
    expect(arg.to).toContain('user@example.com');
  });

  it('uses degraded subject line when change is degraded', async () => {
    const sendEmail = makeSendEmail();
    const env = makeEnv(sendEmail);
    await sendChangeNotification('user@example.com', 'acme.com', [degraded], env);
    const arg = sendEmail.send.mock.calls[0][0];
    expect(arg.subject).toContain('degraded');
  });

  it('uses neutral subject line when all changes are improved', async () => {
    const sendEmail = makeSendEmail();
    const env = makeEnv(sendEmail);
    await sendChangeNotification('user@example.com', 'acme.com', [improved], env);
    const arg = sendEmail.send.mock.calls[0][0];
    expect(arg.subject).not.toContain('degraded');
  });

  it('includes domain name in email body', async () => {
    const sendEmail = makeSendEmail();
    const env = makeEnv(sendEmail);
    await sendChangeNotification('user@example.com', 'acme.com', [degraded], env);
    const arg = sendEmail.send.mock.calls[0][0];
    expect(arg.text).toContain('acme.com');
  });

  it('degraded: links to the dashboard (public origin), never to the reports domain; says nothing it cannot back', async () => {
    const sendEmail = makeSendEmail();
    const env = makeEnv(sendEmail);
    await sendChangeNotification('user@example.com', 'acme.com', [degraded], env);
    const arg = sendEmail.send.mock.calls[0][0];
    expect(arg.text).toContain('Open acme.com in Ready Set Mail: https://app.readysetmail.com/#/w/ws_default/');
    expect(arg.html).toContain('href="https://app.readysetmail.com/#/w/ws_default/');
    for (const part of [arg.subject, arg.text, arg.html]) expect(part).not.toMatch(/spoof|exposed|Sign up|sign up|reports\.readysetmail|\p{Extended_Pictographic}/u);
    // No Reply-To configured: no line that tells the reader to reply, and no Reply-To header.
    expect(arg.text).not.toMatch(/Reply to this email/i);
    expect(arg.html).not.toMatch(/Reply to this email/i);
    expect(arg.replyTo).toBeUndefined();
  });

  it('links to the domain page when the workspace has the domain', async () => {
    const db = createMigratedD1();
    db.sqlite.prepare("INSERT INTO domains (id, domain, rua_address) VALUES (7, 'acme.com', 'rua@reports.acme.com')").run();
    const sendEmail = makeSendEmail();
    const tenant = makeTenant({ db, env: { SEND_EMAIL: sendEmail as any, PUBLIC_BASE_URL: 'https://app.readysetmail.com' } });
    await sendChangeNotification('user@example.com', 'acme.com', [degraded], tenant);
    expect(sendEmail.send.mock.calls[0][0].text).toContain('https://app.readysetmail.com/#/w/ws_default/domains/7');
  });

  it('with MAIL_REPLY_TO set, the reply line is true: the header carries it', async () => {
    const sendEmail = makeSendEmail();
    const env = makeEnv(sendEmail, { MAIL_REPLY_TO: 'max@example.org' });
    await sendChangeNotification('user@example.com', 'acme.com', [degraded], env);
    const arg = sendEmail.send.mock.calls[0][0];
    expect(arg.text).toContain('Reply to this email');
    expect(arg.html).toContain('Reply to this email');
    expect(arg.replyTo).toBe('max@example.org');
  });

  it('with no public origin there is no link and no reports-domain link either', async () => {
    const sendEmail = makeSendEmail();
    const env = makeEnv(sendEmail, { PUBLIC_BASE_URL: '' });
    await sendChangeNotification('user@example.com', 'acme.com', [degraded], env);
    const arg = sendEmail.send.mock.calls[0][0];
    expect(arg.text).not.toMatch(/https?:\/\//);
    expect(arg.html).not.toMatch(/href="https?:\/\/(?!app)/);
  });

  it('does not call SEND_EMAIL when binding is absent', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const env = makeEnv(undefined);
    await sendChangeNotification('user@example.com', 'acme.com', [improved], env);
    consoleSpy.mockRestore();
    // No throw, just logs
  });

  it('does not throw when SEND_EMAIL.send fails', async () => {
    const sendEmail = { send: vi.fn().mockRejectedValue(new Error('send failed')) };
    const env = makeEnv(sendEmail);
    await expect(
      sendChangeNotification('user@example.com', 'acme.com', [degraded], env)
    ).resolves.toBeUndefined();
  });
});

// ── Hosted: the platform sender, off until switched on ────────

const HOSTED = { MODE: 'saas', SAAS_ENABLED: '1', BETTER_AUTH_URL: 'https://app.readysetmail.com', PUBLIC_BASE_URL: '' };
function hostedTenant(sendEmail: { send: ReturnType<typeof vi.fn> }, env: Record<string, string> = {}) {
  const db = createMigratedD1();
  seedSettings(db, { from_email: 'noreply@app.readysetmail.com' });
  db.sqlite.prepare("INSERT INTO users (id, email, name, role) VALUES ('u1', 'dana@brightwave-mail.com', 'Dana Reyes', 'admin')").run();
  db.sqlite.prepare("INSERT INTO memberships (workspace_id, user_id, role) VALUES ('ws_default', 'u1', 'owner')").run();
  return makeTenant({ db, env: { SEND_EMAIL: sendEmail as any, ...HOSTED, ...env }, settings: { fromEmail: 'workspace-setting@example.org' } });
}

describe('change alerts on the hosted service', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('are off by default: nothing is sent', async () => {
    const send = makeSendEmail();
    await sendChangeNotification('user@example.com', 'acme.com', [degraded], hostedTenant(send));
    expect(send.send).not.toHaveBeenCalled();
  });

  it('LIFECYCLE_EMAILS_ON=change_alerts turns them on: sent from the platform sender (never the workspace setting), links on the public origin', async () => {
    const send = makeSendEmail();
    await sendChangeNotification('user@example.com', 'acme.com', [degraded], hostedTenant(send, { LIFECYCLE_EMAILS_ON: 'change_alerts', POSTAL_ADDRESS: '1 Example St, Wilmington, DE' }));
    expect(send.send).toHaveBeenCalledOnce();
    const arg = send.send.mock.calls[0][0];
    expect(arg.from).toEqual({ name: 'Ready Set Mail', email: 'noreply@app.readysetmail.com' });
    expect(arg.text).toContain('https://app.readysetmail.com/#/w/ws_default/');
    expect(arg.text).not.toMatch(/Reply to this email|workers\.dev|reports\./);
  });

  it('LIFECYCLE_EMAILS_OFF wins over LIFECYCLE_EMAILS_ON, and `all` stops them too', async () => {
    for (const off of ['change_alerts', 'all']) {
      const send = makeSendEmail();
      await sendChangeNotification('user@example.com', 'acme.com', [degraded], hostedTenant(send, { LIFECYCLE_EMAILS_ON: 'change_alerts', LIFECYCLE_EMAILS_OFF: off }));
      expect(send.send).not.toHaveBeenCalled();
    }
  });

  it('self-host: on by default, stopped by LIFECYCLE_EMAILS_OFF=change_alerts, and LIFECYCLE_EMAILS_ON changes nothing', async () => {
    const on = makeSendEmail();
    await sendChangeNotification('user@example.com', 'acme.com', [degraded], makeEnv(on));
    expect(on.send).toHaveBeenCalledOnce();
    const off = makeSendEmail();
    await sendChangeNotification('user@example.com', 'acme.com', [degraded], makeEnv(off, { LIFECYCLE_EMAILS_OFF: 'change_alerts' }));
    expect(off.send).not.toHaveBeenCalled();
  });
});

describe('connection broken', () => {
  const info = { id: 'c1', label: 'Main', detail: 'Cloudflare answered 403.' };
  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('hosted: platform sender, on by default, with a link to Settings on the public origin', async () => {
    const send = makeSendEmail();
    await notifyConnectionBroken(hostedTenant(send), info);
    expect(send.send).toHaveBeenCalledOnce();
    const arg = send.send.mock.calls[0][0];
    expect(arg.from).toEqual({ name: 'Ready Set Mail', email: 'noreply@app.readysetmail.com' });
    expect(arg.to).toEqual(['dana@brightwave-mail.com']);
    expect(arg.text).toContain('https://app.readysetmail.com/#/w/ws_default/settings');
  });

  it('LIFECYCLE_EMAILS_OFF=connection_alerts stops it (self-host too)', async () => {
    const send = makeSendEmail();
    await notifyConnectionBroken(hostedTenant(send, { LIFECYCLE_EMAILS_OFF: 'connection_alerts' }), info);
    expect(send.send).not.toHaveBeenCalled();
  });

  it('self-host: the workspace\'s own sender takes precedence', async () => {
    const db = createMigratedD1();
    db.sqlite.prepare("INSERT INTO users (id, email, name, role) VALUES ('u1', 'a@acme.com', 'A', 'admin')").run();
    db.sqlite.prepare("INSERT INTO memberships (workspace_id, user_id, role) VALUES ('ws_default', 'u1', 'owner')").run();
    const send = makeSendEmail();
    await notifyConnectionBroken(makeTenant({ db, env: { SEND_EMAIL: send as any }, settings: { fromEmail: 'noreply@reports.acme.com' } }), info);
    expect(send.send.mock.calls[0][0].from.email).toBe('noreply@reports.acme.com');
  });
});
