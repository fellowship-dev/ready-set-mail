import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { MailMessage } from '../src/mail/mailer';

export const REV = join(homedir(), 'rev');
export const EMAILS = join(REV, 'emails');
mkdirSync(EMAILS, { recursive: true });

export const kindOf = (subject: string): string =>
  /(is|are) set up: reports are on their way$/.test(subject) ? 'records_live'
  : subject.startsWith('First DMARC report') ? 'first_report'
  : subject.startsWith('No DMARC reports yet') ? 'no_reports'
  : subject.startsWith('Week of') ? 'summary'
  : /every message passed DMARC for two weeks/.test(subject) ? 'tip_next'
  : /nothing to do$/.test(subject) ? 'tip_done'
  : /needs SPF or DKIM/.test(subject) ? 'tip_fix'
  : 'other';

export const logTo = (file: string) => (...a: unknown[]) => appendFileSync(join(REV, file), a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');
export const log = logTo('probes.out');
export const rlog = logTo('render.out');
export const section = (s: string) => log(`\n===== ${s} =====`);

/** Write one captured message as <scenario>__<kind>.{html,txt,json}. */
export function save(name: string, m: MailMessage): void {
  const base = join(EMAILS, name);
  writeFileSync(`${base}.html`, m.html ?? '');
  writeFileSync(`${base}.txt`, m.text);
  writeFileSync(`${base}.json`, JSON.stringify({ from: m.from, to: m.to, replyTo: m.replyTo ?? null, subject: m.subject, headers: m.headers ?? {}, idempotencyKey: m.idempotencyKey ?? null }, null, 2));
}
