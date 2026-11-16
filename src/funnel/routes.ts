// HTTP routes of the email funnel.
//
// Public (no login; the signed token is the credential):
//   GET  /api/unsubscribe?t=<token>         a confirm page with a button (changes nothing: link scanners open links)
//   POST /api/unsubscribe?t=<token>         unsubscribe the address (the button; RFC 8058 one-click, with or without its body)
//   GET|POST /api/monitor/confirm?t=<token> confirm a change-alert subscription (double opt-in; GET shows a button, POST confirms)

import type { BoundEnv } from '../index';
import { getMode } from '../tenancy/mode';
import { IMPLICIT_WORKSPACE_ID } from '@ready-set-mail/db';
import { verifyToken } from '../mail/tokens';
import { unsubscribeEmail } from './unsubscribe';
import { confirmMonitorSubscription } from './monitor-optin';
import { page } from './page';
import { handleEmailPreferenceOff } from '../lifecycle/email/routes';

/** Is the caller the person who runs this instance? OWNER_EMAIL if set; else (self-host only) the owner of the one workspace. */
export function isInstanceOwner(env: Pick<BoundEnv, 'MODE' | 'OWNER_EMAIL'>, who: { kind?: string; email?: string | null; role?: string; workspaceId: string }): boolean {
  const owner = env.OWNER_EMAIL?.trim().toLowerCase();
  if (owner) return !!who.email && who.email.toLowerCase() === owner;
  if (getMode(env) === 'saas') return false;
  return who.kind === 'instance' || (who.workspaceId === IMPLICIT_WORKSPACE_ID && who.role === 'owner');
}

export async function handlePublicFunnelRoute(request: Request, env: BoundEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  // Turn off one lifecycle email (hosted): the token names one person, one workspace and one preference (src/lifecycle/email/routes.ts).
  const preference = await handleEmailPreferenceOff(request, env);
  if (preference) return preference;

  if (url.pathname === '/api/unsubscribe' && (method === 'GET' || method === 'POST')) {
    const p = await verifyToken(env, url.searchParams.get('t') ?? '');
    if (!p || p.p !== 'unsub') return method === 'POST' ? new Response('invalid token', { status: 400 }) : page('This link is not valid', 'The unsubscribe link is incomplete or has been altered. Reply to the email you received and we will remove you by hand.', 400);
    // A GET only shows a button. Mail security scanners open links in emails; they must not be able to unsubscribe someone. The POST (the button, or
    // the RFC 8058 one-click with or without its `List-Unsubscribe=One-Click` body) is what unsubscribes.
    if (method === 'GET') {
      const t = encodeURIComponent(url.searchParams.get('t') ?? '');
      return page('Unsubscribe?', 'Nothing changes until you press the button. You will not get any more emails of this kind from Ready Set Mail, and any change alerts for this address are removed.', 200, `<form method="post" action="/api/unsubscribe?t=${t}"><button type="submit" style="padding:10px 18px;font-size:15px;cursor:pointer;">Unsubscribe</button></form>`);
    }
    await unsubscribeEmail(env, p.e);
    return new Response('unsubscribed', { status: 200 });
  }

  if (url.pathname === '/api/monitor/confirm' && (method === 'GET' || method === 'POST')) {
    const token = url.searchParams.get('t') ?? '';
    const p = await verifyToken(env, token);
    if (!p || p.p !== 'confirm') return page('This link is not valid', 'The confirmation link is incomplete, altered or has expired. Request the alerts again from the email check page.', 400);
    // A GET only shows a button. Mail security scanners open links in emails; they must not be able to confirm for the owner.
    if (method === 'GET') {
      return page('Confirm email alerts', 'Press the button to start change alerts for your domain. If you did not ask for them, close this page and nothing will be sent.', 200, `<form method="post" action="/api/monitor/confirm?t=${encodeURIComponent(token)}"><button type="submit" style="padding:10px 18px;font-size:15px;cursor:pointer;">Confirm alerts</button></form>`);
    }
    const ok = await confirmMonitorSubscription(env, p);
    return ok ? page('Alerts confirmed', 'We will email you when the email security settings of your domain change. Every alert has an unsubscribe link.') : page('This request has expired', 'Unconfirmed requests are deleted after 7 days. Request the alerts again from the email check page.', 410);
  }
  return null;
}
