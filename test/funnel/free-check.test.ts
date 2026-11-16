// The free check keeps no lead and sends one thing: the reply. The retired follow-up sequence left rows behind; only retention and unsubscribe touch them.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import { hashEmail } from '@ready-set-mail/db';

vi.mock('cloudflare:email', () => ({ EmailMessage: class { constructor(public from: string, public to: string, public raw: string) {} } }));

import { handleHostedEmail } from '../../src/hosted/intake';
import { runFunnelCron, LEAD_RETENTION_SECONDS } from '../../src/funnel/cron';
import { unsubscribeEmail } from '../../src/funnel/unsubscribe';
import { call, makeEnv, setupOwner } from '../auth/helpers';
import { fakeMessage } from '../helpers/mail';
import { nxdomain } from '../hosted/world';
import { DAY, FUNNEL_ENV, T0, fakeMailer, funnelWorld, quietLogs, rawWithAuth } from './world';

const authFor = (d: string) => `mx.cloudflare.net; dkim=pass header.d=${d} header.s=s1; spf=pass smtp.mailfrom=u@${d}; dmarc=pass header.from=${d}`;

beforeEach(() => { quietLogs(); nxdomain(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function hosted(extra: Record<string, unknown> = {}) {
  const db = createMigratedD1();
  const env = makeEnv(db, { ...FUNNEL_ENV, ...extra }) as any;
  const rows = (sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[];
  const check = async (from = 'user@example.com', auth = authFor('example.com')) => {
    const s = await (await call(env, 'POST', '/api/check-sessions')).json() as { email: string };
    const m = fakeMessage(s.email, rawWithAuth(auth), { from, headers: { 'authentication-results': auth, from, 'message-id': '<m1@example.com>' } });
    await handleHostedEmail(m, env);
    return m;
  };
  return { db, env, rows, check };
}

/** The reply's decoded text: mimetext base64-encodes the bodies. */
const replyText = (m: any) => {
  const raw = (m.reply.mock.calls[0][0] as { raw: string }).raw;
  return raw + '\n' + [...raw.matchAll(/\r\n\r\n([A-Za-z0-9+/=\r\n]{20,})/g)].map(x => Buffer.from(x[1].replace(/\s/g, ''), 'base64').toString()).join('\n');
};

describe('a free check with an address', () => {
  it('writes no lead and sends only the reply: no unsubscribe header, no follow-up line, the 30-day retention sentence', async () => {
    const t = hosted();
    const m = await t.check();
    expect(m.reply).toHaveBeenCalledOnce();
    expect(t.rows('SELECT * FROM leads')).toEqual([]);
    const text = replyText(m);
    expect(text).not.toMatch(/List-Unsubscribe/i);
    expect(text).not.toMatch(/follow-up|few short emails/i);
    expect(text).toContain('for 30 days, then delete them');
    expect(t.rows('SELECT from_email FROM check_results')).toEqual([{ from_email: 'user@example.com' }]);
  });

  it('a second check, a suppressed address and an unauthenticated sender all get the same reply and no lead', async () => {
    const t = hosted();
    t.db.sqlite.prepare('INSERT INTO suppression (email_hash, reason) VALUES (?, ?)').run(await hashEmail('sup@example.com'), 'unsubscribe');
    for (const [from, auth] of [['user@example.com', authFor('example.com')], ['user@example.com', authFor('example.com')], ['sup@example.com', authFor('example.com')], ['victim@bank.com', authFor('attacker.net')]] as const) {
      const m = await t.check(from, auth);
      expect(m.reply).toHaveBeenCalledOnce();
      expect(replyText(m)).toContain('for 30 days, then delete them');
    }
    expect(t.rows('SELECT * FROM leads')).toEqual([]);
  });

  it('the SEND_EMAIL fallback sends the one report with no unsubscribe header', async () => {
    const sent: unknown[] = [];
    const t = hosted({ SEND_EMAIL: { send: vi.fn(async (msg: unknown) => { sent.push(msg); return { messageId: 'm-1' }; }) } });
    const s = await (await call(t.env, 'POST', '/api/check-sessions')).json() as { email: string };
    const auth = authFor('example.com');
    const m = fakeMessage(s.email, rawWithAuth(auth), { from: 'user@example.com', headers: { 'authentication-results': auth, from: 'user@example.com', 'message-id': '<m1@example.com>' } });
    (m.reply as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('original email is not repliable'));
    await handleHostedEmail(m, t.env);
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0])).not.toMatch(/List-Unsubscribe|unsubscribe\?t=/i);
    expect(t.rows('SELECT * FROM leads')).toEqual([]);
  });
});

describe('legacy lead rows (left by the retired follow-up sequence)', () => {
  it('runFunnelCron at the daily tick deletes leads inactive for 12 months, keeps newer ones, and sends nothing', async () => {
    const w = funnelWorld();
    const mailer = fakeMailer();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no network expected'); }));
    const now = T0 + 400 * DAY;
    w.seedLead('stale@acme.com', now - LEAD_RETENTION_SECONDS - 1);
    w.seedLead('fresh@acme.com', now - LEAD_RETENTION_SECONDS + 60);
    await runFunnelCron({ cron: '0 9 * * 1' }, w.env, now);
    expect(w.rows('SELECT * FROM leads')).toHaveLength(2);
    await runFunnelCron({ cron: '0 8 * * *' }, w.env, now);
    expect(w.rows('SELECT email FROM leads')).toEqual([{ email: 'fresh@acme.com' }]);
    expect(LEAD_RETENTION_SECONDS).toBe(365 * DAY);
    expect(mailer.sent).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('unsubscribeEmail still suppresses the address and deletes its legacy lead row and change-alert subscriptions', async () => {
    const w = funnelWorld();
    w.seedLead('a@acme.com');
    w.db.sqlite.prepare("INSERT INTO monitor_subscriptions (email, domain, workspace_id) VALUES ('a@acme.com', 'acme.com', 'ws_default')").run();
    await unsubscribeEmail(w.env, ' A@Acme.com ');
    await unsubscribeEmail(w.env, 'a@acme.com'); // idempotent
    expect(w.rows('SELECT * FROM leads')).toEqual([]);
    expect(w.rows('SELECT * FROM monitor_subscriptions')).toEqual([]);
    expect(w.rows('SELECT email_hash FROM suppression')).toEqual([{ email_hash: await hashEmail('a@acme.com') }]);
  });

  it('/api/leads is not a route any more: it falls through, for the instance owner too', async () => {
    const db = createMigratedD1();
    const env = makeEnv(db, {}) as any;
    const owner = await setupOwner(env);
    for (const [method, path] of [['GET', '/api/leads'], ['POST', '/api/leads/1/stop']] as const) {
      const res = await call(env, method, path, { key: owner, body: method === 'POST' ? { reason: 'booked' } : undefined });
      expect(res.status, path).toBe(404);
    }
  });
});
