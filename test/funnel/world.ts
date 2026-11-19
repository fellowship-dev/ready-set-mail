// Shared setup for the email-funnel tests.
import { vi } from 'vitest';
import { createMigratedD1 } from '@ready-set-mail/db/testing';
import type { BoundEnv } from '../../src/index';
import type { Mailer, MailMessage, SendResult } from '../../src/mail/mailer';
import type { CheckSummary } from '../../src/email/report-formatter';
import { HOSTED_ENV } from '../hosted/world';

export const T0 = 1_800_000_000;
export const DAY = 86400;

/** A hosted environment with the mail settings the funnel pieces (monitor confirmation, unsubscribe) need. */
export const FUNNEL_ENV = {
  ...HOSTED_ENV,
  BETTER_AUTH_SECRET: 'test-secret-for-funnel',
  AUTHSERV_ID: 'mx.cloudflare.net',
  AUTHSERV_HEADER: 'ar',
  RESEND_API_KEY: 're_test',
  MAIL_FROM: 'max@readysetmail.com',
  MAIL_REPLY_TO: 'max@readysetmail.com',
  PUBLIC_BASE_URL: 'https://app.readysetmail.com',
  POSTAL_ADDRESS: '1 Example Street\nWilmington, DE 19801, USA',
  BOOKING_URL: 'https://cal.example.com/max/30min',
} as const;

export const summary = (over: Partial<CheckSummary> = {}): CheckSummary => ({
  status: 'exposed', domain: 'acme.com', spfPass: true, dkimPass: true, dmarcPass: true, dmarcPolicy: 'none', dkimPresent: true, ...over,
});

/** A raw message whose header block starts with the given Authentication-Results headers (topmost first). */
export const rawWithAuth = (...authResults: string[]) => `${authResults.map(a => `Authentication-Results: ${a}`).join('\r\n')}${authResults.length ? '\r\n' : ''}Subject: hi\r\n\r\nhi`;

export function quietLogs() {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
}

export interface FakeMailer extends Mailer { sent: MailMessage[]; next: SendResult[] }

/** A mailer that records what it is given. Push to `next` to make the following sends fail. */
export function fakeMailer(provider: Mailer['provider'] = 'resend', arbitraryRecipients = true): FakeMailer {
  const m: FakeMailer = {
    provider, arbitraryRecipients, sent: [], next: [],
    async send(msg) { m.sent.push(msg); return m.next.shift() ?? { ok: true, id: `id-${m.sent.length}` }; },
  };
  return m;
}

export function funnelWorld(extra: Record<string, unknown> = {}) {
  const db = createMigratedD1();
  const env = { DB: db as unknown as D1Database, ...FUNNEL_ENV, ...extra } as unknown as BoundEnv;
  const rows = (sql: string, ...p: unknown[]) => db.sqlite.prepare(sql).all(...p) as any[];
  /** A lead row as the retired follow-up sequence left it: nothing writes these any more, so tests seed one by SQL. */
  const seedLead = (email: string, lastActivityAt = T0, domain = 'acme.com') =>
    db.sqlite.prepare('INSERT INTO leads (email, domain, created_at, last_activity_at) VALUES (?, ?, ?, ?)').run(email, domain, lastActivityAt, lastActivityAt);
  return { db, env, rows, seedLead, mailer: fakeMailer() };
}
