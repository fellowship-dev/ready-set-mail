// Sign-in code emails and account notices, over the same outbound path as every other Ready Set Mail email
// (the SEND_EMAIL binding).
//
// Self-host limitation: Cloudflare Email Routing only delivers to destination addresses verified on the account, so a code
// reaches the owner (verified during setup) but maybe not an arbitrary teammate (docs/hosted.md, "Sign-in codes").
// Without SEND_EMAIL (or a sender address) nothing is sent and the Worker log records only a static reason: the code, the
// recipient and provider errors are never logged.
import { forWorkspace, IMPLICIT_WORKSPACE_ID } from '@ready-set-mail/db';
import type { AuthEnv } from './config';
import { CODE_MINUTES, type CodePurpose } from './codes';
import { mailFooter } from './legal';

/** The platform's sender: the implicit workspace's from_email (set by the setup wizard), else derived from its base domain. */
export async function senderAddress(env: AuthEnv): Promise<string | undefined> {
  const q = forWorkspace(env.DB as D1Database, IMPLICIT_WORKSPACE_ID).settings;
  const s = await q.getMany(['from_email', 'base_domain']);
  return s.get('from_email') || (s.get('base_domain') ? `noreply@reports.${s.get('base_domain')}` : undefined);
}

/** Can this instance send mail at all (a binding and a sender address)? */
export async function mailReady(env: AuthEnv): Promise<boolean> {
  return !!env.SEND_EMAIL && !!(await senderAddress(env));
}

async function send(env: AuthEnv, operation: string, to: string, subject: string, body: string): Promise<void> {
  const footer = mailFooter(env);
  const text = `${body}\n\nReady Set Mail${footer ? `\n${footer}` : ''}`;
  const from = await senderAddress(env);
  if (env.SEND_EMAIL && from) {
    try {
      await env.SEND_EMAIL.send({ from: { name: 'Ready Set Mail', email: from }, to: [to], subject, text });
    } catch {
      console.error(`[auth] ${operation} email send failed (provider error not logged)`);
    }
  } else {
    unsent(operation, env);
  }
}

export const codeSubject = (code: string): string => `${code} is your Ready Set Mail code`;

const WHAT_FOR: Readonly<Record<CodePurpose, string>> = Object.freeze({
  signup: 'confirm your email address and finish creating your Ready Set Mail account',
  invite: 'confirm your email address and join the workspace you were invited to on Ready Set Mail',
  signin: 'finish signing in to Ready Set Mail',
  reset: 'reset your Ready Set Mail password',
});

/** Where the code was asked for, when Cloudflare knows it: an approximate place, from the network address. */
export function requestedFrom(request: Request): string | null {
  const cf = (request as Request & { cf?: { city?: unknown; country?: unknown } }).cf;
  const city = typeof cf?.city === 'string' ? cf.city.trim() : '';
  const country = typeof cf?.country === 'string' ? cf.country.trim() : '';
  if (!country) return null;
  return city ? `${city}, ${country}` : country;
}

/** The code email's body (without the closing and footer). */
export function codeEmailText(code: string, purpose: CodePurpose, origin: string, from: string | null): string {
  const lines = [
    'Hi,',
    '',
    `Use this code to ${WHAT_FOR[purpose]}:`,
    '',
    `    ${code}`,
    '',
    `It expires in ${CODE_MINUTES} minutes and works once, in the browser where you asked for it. Enter it only on ${origin}.`,
  ];
  if (from) lines.push('', `Asked for from near ${from} (approximate, from the network address).`);
  lines.push('', "If you didn't ask for this, you can ignore this email; nobody can use it without the code.");
  if (purpose === 'signin') lines.push('', 'A sign-in code is sent only after the right password. If you did not just sign in, change your password: "Forgot your password?" on the sign-in page.');
  return lines.join('\n');
}

export async function sendCodeEmail(env: AuthEnv, to: string, code: string, purpose: CodePurpose, origin: string, from: string | null): Promise<void> {
  await send(env, 'code', to, codeSubject(code), codeEmailText(code, purpose, origin, from));
}

export const SIGNUP_NOTICE_SUBJECT = 'Someone tried to create a Ready Set Mail account with your email';

/** To a verified account's owner, when someone used the sign-up form with their address. Nothing was changed. */
export function signupNoticeText(origin: string): string {
  return `Hi,\n\nSomeone tried to create a new Ready Set Mail account with this email address. You already have an account, so no new account was created and nothing about yours was changed.\n\nIf it was you, sign in at ${origin} instead. If you forgot your password, use "Forgot your password?" on the sign-in page. If it wasn't you, you can ignore this email.`;
}

export async function sendSignupNotice(env: AuthEnv, to: string, origin: string): Promise<void> {
  await send(env, 'signup notice', to, SIGNUP_NOTICE_SUBJECT, signupNoticeText(origin));
}

/** Static diagnostic for an email that could not be sent: names the operation and the missing piece, never the code, recipient or provider error. */
function unsent(operation: string, env: AuthEnv): void {
  const reason = !env.SEND_EMAIL ? 'SEND_EMAIL binding not configured' : 'no sender address (set from_email or base_domain)';
  console.warn(`[auth] ${operation} email not sent: ${reason}`);
}

/** Tells a workspace's owners that a domain was taken from it because another workspace proved it controls the domain. */
export async function sendEvictionNotice(env: AuthEnv, to: string[], domain: string, keepDays: number): Promise<void> {
  if (to.length === 0) return;
  const body = `Hi,\n\n${domain} was registered in your Ready Set Mail workspace before domain ownership was verified. Another workspace has now proven that it controls ${domain} (by a DNS record or through its Cloudflare zone), so ${domain} has been removed from yours: monitoring, hosted records and alerts for it have stopped.\n\nYour report history for ${domain} stays available to export for ${keepDays} days, then it is deleted.\n\nIf ${domain} really is yours, add it again and publish the TXT record Ready Set Mail shows you at _readysetmail.${domain}; if you believe this is a mistake, reply to this email.`;
  const footer = mailFooter(env);
  const text = `${body}\n\nReady Set Mail${footer ? `\n${footer}` : ''}`;
  const from = await senderAddress(env);
  if (env.SEND_EMAIL && from) {
    for (const address of to) {
      try {
        await env.SEND_EMAIL.send({ from: { name: 'Ready Set Mail', email: from }, to: [address], subject: `${domain} was removed from your Ready Set Mail workspace`, text });
      } catch (e) {
        console.error('[auth] eviction notice send failed:', e);
      }
    }
  } else {
    console.log(`[auth] eviction notice for ${domain} to ${to.join(', ')}`);
  }
}
