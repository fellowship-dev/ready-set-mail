// Sign-in code emails and account notices, over the same outbound path as every other Ready Set Mail email
// (the SEND_EMAIL binding).
//
// Self-host limitation: Cloudflare's send_email delivers only to addresses verified as Email Routing destinations on the
// account, so a configured binding and sender address do not mean a code reaches anyone. That is why a self-hosted instance
// asks a person for a code only after that person has once entered one (codeProven in codes.ts), and why every send reports
// whether the provider accepted it. Sign-in, sign-up, invite and test codes are sent before the answer, so a refused send is
// never answered as "code sent"; a reset code is sent after it (an address with no account is mailed nothing, so the answer
// must not wait on a send).
//
// Mail to an address without an account: only the sign-up code (to the address just typed, behind the bot check) and the
// hosted invite code (to the invited address, by the holder of a valid invite). Nothing else.
// Without SEND_EMAIL (or a sender address) nothing is sent and the Worker log records only a static reason: the code, the
// recipient and provider errors are never logged.
import { forWorkspace, IMPLICIT_WORKSPACE_ID } from '@ready-set-mail/db';
import type { AuthEnv } from './config';
import { CODE_MINUTES, type CodePurpose } from './codes';
import { mailFooter } from './legal';
import { buildCodeEmailHtml, buildHandoffEmailHtml } from '../email/html-templates';
import { cleanName } from './names';

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

/** Hands the message to the provider. True when it accepted it; false when it refused or nothing could be sent. */
async function send(env: AuthEnv, operation: string, to: string, subject: string, body: string, extra: { html?: string; replyTo?: string } = {}): Promise<boolean> {
  const footer = mailFooter(env);
  const text = `${body}\n\nReady Set Mail${footer ? `\n${footer}` : ''}`;
  const from = await senderAddress(env);
  if (env.SEND_EMAIL && from) {
    try {
      await env.SEND_EMAIL.send({ from: { name: 'Ready Set Mail', email: from }, to: [to], subject, text, ...(extra.html ? { html: extra.html } : {}), ...(extra.replyTo ? { replyTo: extra.replyTo } : {}) });
      return true;
    } catch {
      console.error(`[auth] ${operation} email send failed (provider error not logged)`);
      return false;
    }
  }
  unsent(operation, env);
  return false;
}

export const codeSubject = (code: string): string => `${code} is your Ready Set Mail code`;

/** The one sentence of the code email: what entering the code does. */
const WHAT_FOR: Readonly<Record<CodePurpose, string>> = Object.freeze({
  signup: 'Enter this code to finish creating your Ready Set Mail account.',
  invite: 'Enter this code to join the workspace you were invited to on Ready Set Mail.',
  signin: 'Enter this code to finish signing in to Ready Set Mail.',
  reset: 'Enter this code to reset your Ready Set Mail password.',
  confirm: 'Enter this code to confirm that Ready Set Mail sign-in codes reach you. Once it is entered, every sign-in asks for a code.',
});

/** Where the code was asked for, when Cloudflare knows it: an approximate place, from the network address. */
export function requestedFrom(request: Request): string | null {
  const cf = (request as Request & { cf?: { city?: unknown; country?: unknown } }).cf;
  const city = typeof cf?.city === 'string' ? cf.city.trim() : '';
  const country = typeof cf?.country === 'string' ? cf.country.trim() : '';
  if (!country) return null;
  return city ? `${city}, ${country}` : country;
}

/** Where replies to a code email go: MAIL_REPLY_TO, the same mailbox the free-check report and funnel mail use (src/funnel/config.ts). Null: no Reply-To. */
export const codeReplyTo = (env: AuthEnv): string | null => (env as AuthEnv & { MAIL_REPLY_TO?: string }).MAIL_REPLY_TO?.trim() || null;

interface CodeEmailParts { sentence: string; validity: string; notes: string[]; fine: string[] }

/**
 * What the code email says, once, for both its parts. Short on purpose: what the code does, how long it works and where it is
 * entered (the anti-phishing line: only on this service's own address), what to do if nobody asked, and a way to reach a person
 * (only when the instance has a Reply-To mailbox). The approximate place stays in the small print for every purpose: it is
 * the cue that exposes a page relaying a code from somewhere else (docs/hosted.md, "Phishing relay").
 */
function codeEmailParts(purpose: CodePurpose, origin: string, from: string | null, replyTo: string | null): CodeEmailParts {
  const notes = ["If you didn't ask for this, you can ignore this email."];
  if (replyTo) notes.push('Something look wrong? Reply to this email and a person will answer.');
  const fine: string[] = [];
  if (from) fine.push(`Asked for from near ${from} (approximate, from the network address).`);
  if (purpose === 'signin') fine.push('A sign-in code is sent only after the right password. If you did not just sign in, change your password: "Forgot your password?" on the sign-in page.');
  return {
    sentence: WHAT_FOR[purpose],
    validity: `It works for ${CODE_MINUTES} minutes, once, in the browser where you asked for it. Enter it only on ${origin}.`,
    notes, fine,
  };
}

/** The code email's body as plain text (without the closing and footer). */
export function codeEmailText(code: string, purpose: CodePurpose, origin: string, from: string | null, replyTo: string | null = null): string {
  const p = codeEmailParts(purpose, origin, from, replyTo);
  return [p.sentence, '', `    ${code}`, '', p.validity, '', ...p.notes.flatMap((n) => [n, '']), ...p.fine.flatMap((n) => [n, ''])].join('\n').trimEnd();
}

/** The same email as HTML: the wordmark as text, the code very large and selectable (no images, no links). */
export function codeEmailHtml(env: AuthEnv, code: string, purpose: CodePurpose, origin: string, from: string | null, replyTo: string | null): string {
  return buildCodeEmailHtml({ code, ...codeEmailParts(purpose, origin, from, replyTo), footer: mailFooter(env) });
}

export async function sendCodeEmail(env: AuthEnv, to: string, code: string, purpose: CodePurpose, origin: string, from: string | null): Promise<boolean> {
  const replyTo = codeReplyTo(env);
  return send(env, 'code', to, codeSubject(code), codeEmailText(code, purpose, origin, from, replyTo), { html: codeEmailHtml(env, code, purpose, origin, from, replyTo), ...(replyTo ? { replyTo } : {}) });
}

/** The hand-off invitation's fixed words (spec H1). Names are cleaned; nothing else the inviter typed can reach it. */
export function handoffEmail(p: { inviterName: string; inviterEmail: string; workspaceName: string; domain: string | null; url: string }, footer = ''): { subject: string; text: string; html: string } {
  // The sender is named by their VERIFIED address. The name they typed is free text: it appears only in the body, once, as what they call
  // themselves, cut short. The domain and the workspace name appear only when the domain is proven in that workspace (the caller passes null).
  const calls = cleanName(p.inviterName, 40);
  const callsLine = calls && calls.toLowerCase() !== p.inviterEmail.toLowerCase() ? ` They call themselves "${calls}".` : '';
  const what = p.domain ? `for ${p.domain}` : 'for a domain';
  const workspace = p.domain ? cleanName(p.workspaceName, 80) || 'a workspace' : 'a workspace';
  const paragraph = `${p.inviterEmail} invited you to ${workspace} on Ready Set Mail as an admin, to finish setting up SPF, DKIM and DMARC ${what}.${callsLine}`;
  const validity = 'The link works for 7 days. If you do not know them, ignore this email.';
  return {
    subject: `${p.inviterEmail} asked you to finish setting up email ${what}`,
    text: `${paragraph}\n\n${p.url}\n\n${validity}`,
    html: buildHandoffEmailHtml({ paragraph, validity, url: p.url, footer }),
  };
}

export async function sendHandoffEmail(env: AuthEnv, to: string, p: Parameters<typeof handoffEmail>[0]): Promise<boolean> {
  const m = handoffEmail(p, mailFooter(env));
  return send(env, 'hand-off', to, m.subject, m.text, { html: m.html, ...(codeReplyTo(env) ? { replyTo: codeReplyTo(env)! } : {}) });
}

export const SIGNUP_NOTICE_SUBJECT = 'Someone tried to create a Ready Set Mail account with your email';

/** To a verified account's owner, when someone used the sign-up form with their address. Nothing was changed. */
export function signupNoticeText(origin: string): string {
  return `Hi,\n\nSomeone tried to create a new Ready Set Mail account with this email address. You already have an account, so no new account was created and nothing about yours was changed.\n\nIf it was you, sign in at ${origin} instead. If you forgot your password, use "Forgot your password?" on the sign-in page. If it wasn't you, you can ignore this email.`;
}

export async function sendSignupNotice(env: AuthEnv, to: string, origin: string): Promise<boolean> {
  return send(env, 'signup notice', to, SIGNUP_NOTICE_SUBJECT, signupNoticeText(origin));
}

export const SIGNIN_ALERT_SUBJECT = 'Someone entered your Ready Set Mail password';

/** To an account's owner, once a day at most, after several wrong sign-in codes: whoever typed them knew the password. */
export function signinAlertText(origin: string): string {
  return `Hi,\n\nSomeone entered your Ready Set Mail password and then several wrong sign-in codes today. A sign-in code is only sent after the right password, so whoever it was knows your password. Change your password: use "Forgot your password?" on the sign-in page at ${origin}.\n\nIf it was you mistyping codes, changing your password is still a good idea.`;
}

export async function sendSigninAlert(env: AuthEnv, to: string, origin: string): Promise<boolean> {
  return send(env, 'sign-in alert', to, SIGNIN_ALERT_SUBJECT, signinAlertText(origin));
}

/** Static diagnostic for an email that could not be sent: names the operation and the missing piece, never the code, recipient or provider error. */
function unsent(operation: string, env: AuthEnv): void {
  const reason = !env.SEND_EMAIL ? 'SEND_EMAIL binding not configured' : 'no sender address (set from_email or base_domain)';
  console.warn(`[auth] ${operation} email not sent: ${reason}`);
}

/** Tells a workspace's owners that a domain was taken from it because another workspace proved it controls the domain. */
export async function sendEvictionNotice(env: AuthEnv, to: string[], domain: string, keepDays: number): Promise<void> {
  if (to.length === 0) return;
  const body = `Hi,\n\n${domain} was registered in your Ready Set Mail workspace before domain ownership was verified. Another workspace has now proven that it controls ${domain} (by a DNS record or through its Cloudflare zone), so ${domain} has been removed from yours: monitoring, hosted records and alerts for it have stopped.\n\nYour report history for ${domain} stays available to export for ${keepDays} days, then it is deleted.\n\n${domain} now belongs to that workspace and it keeps it. If ${domain} really is yours, reply to this email and we will look into it.`;
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

/** Tells a workspace's owners that a domain's Cloudflare proof no longer holds, so it is not accepted as theirs until proven again. */
export async function sendProofLostNotice(env: AuthEnv, to: string[], domain: string, why: 'delegation' | 'cloudflare', keepDays = 30): Promise<void> {
  if (to.length === 0) return;
  const reason = why === 'delegation'
    ? `${domain} no longer points to the Cloudflare name servers it pointed to when you proved it (in Cloudflare, or by Cloudflare's own nameserver records). It may have moved to another DNS provider or another Cloudflare account.`
    : `Cloudflare no longer serves the zone of ${domain} as an active, full zone in the account that proved it.`;
  const body = `Hi,\n\n${reason}\n\nSo Ready Set Mail can no longer treat ${domain} as proven to be yours: DMARC reports sent to Ready Set Mail for it are not accepted until it is proven again. Reports already stored stay, and nothing is removed.\n\nIf ${domain} is still yours, open it in Ready Set Mail (on the overview and on its own page it says "Proof lost: prove it is still yours") and choose "Prove again". That re-checks every Cloudflare connection of your workspace, or the TXT record Ready Set Mail shows you at _readysetmail.${domain}, and restores the domain as it was, with its report history. Please do not remove it first.\n\nIf another workspace proves it controls ${domain} before you do, ${domain} moves to that workspace and it keeps it; your report history for ${domain} stays with you, read-only, to export for ${keepDays} days.`;
  const footer = mailFooter(env);
  const text = `${body}\n\nReady Set Mail${footer ? `\n${footer}` : ''}`;
  const from = await senderAddress(env);
  if (env.SEND_EMAIL && from) {
    for (const address of to) {
      try {
        await env.SEND_EMAIL.send({ from: { name: 'Ready Set Mail', email: from }, to: [address], subject: `${domain} is no longer proven in your Ready Set Mail workspace`, text });
      } catch (e) {
        console.error('[auth] proof-lost notice send failed:', e);
      }
    }
  } else {
    console.log(`[auth] proof-lost notice for ${domain} to ${to.join(', ')}`);
  }
}
