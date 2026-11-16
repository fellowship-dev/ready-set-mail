// Handing one lifecycle email to the mail provider, and what the result means for its claim (state.ts).
//
//   milestone emails (records live, first report, no reports) are transactional: no List-Unsubscribe, a footer that says why the person gets it.
//   summary and tips go through `sendNonTransactional` (src/mail/compliance.ts), so the suppression check, the postal footer and List-Unsubscribe
//   with List-Unsubscribe-Post (one https link, the preference link of that person) are the same ones every other non-transactional email has.
// Reply-To is MAIL_REPLY_TO (src/funnel/config.ts `replyTo`); with none set there is no Reply-To.

import { postalAddress, replyTo } from '../../funnel/config';
import type { BoundEnv } from '../../index';
import { footerHtml, footerText, isSuppressed, sendNonTransactional } from '../../mail/compliance';
import type { Mailer, MailMessage } from '../../mail/mailer';
import type { Rendered } from './copy';

/** What to do with the claim: `sent`, `failed` (outcome unknown or refused: never tried again), `release` (nothing was sent and a later run may try again). */
export type Delivery = { state: 'sent' | 'failed' | 'release'; why?: string };

export interface DeliverOpts {
  /** The preference link of summary and tips; its presence makes the email non-transactional. */
  offUrl?: string;
  idempotencyKey?: string;
}

export async function deliver(env: BoundEnv, mailer: Mailer | null, from: string | undefined, to: string, mail: Rendered, opts: DeliverOpts = {}): Promise<Delivery> {
  if (!mailer) return { state: 'release', why: 'no mail provider' };
  if (!from) return { state: 'release', why: 'no sender address' };
  const message = {
    from: { name: 'Ready Set Mail', email: from },
    to,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    ...(replyTo(env) ? { replyTo: replyTo(env)! } : {}),
    ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
  } satisfies MailMessage;

  if (opts.offUrl) {
    const r = await sendNonTransactional(env, mailer, message, { requireLink: true, unsubscribeUrl: opts.offUrl });
    if (r.ok) return { state: 'sent' };
    return r.kind === 'transient' || r.kind === 'recipient' ? { state: 'failed', why: r.kind } : { state: 'release', why: r.kind };
  }

  // Transactional: still never to an address on the suppression list (a person who asked for no mail at all).
  try {
    if (await isSuppressed(env, to.trim().toLowerCase())) return { state: 'release', why: 'suppressed' };
  } catch {
    return { state: 'release', why: 'config' };
  }
  const address = postalAddress(env);
  const out = { ...message, text: mail.text + footerText(null, address), html: mail.html.replace(/<\/body>/i, `${footerHtml(null, address)}</body>`) };
  try {
    const r = await mailer.send(out);
    if (r.ok) return { state: 'sent' };
    return r.kind === 'config' ? { state: 'release', why: 'config' } : { state: 'failed', why: r.kind };
  } catch {
    return { state: 'failed', why: 'transient' };
  }
}
