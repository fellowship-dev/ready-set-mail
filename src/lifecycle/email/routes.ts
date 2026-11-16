// HTTP routes of the lifecycle emails.
//
//   GET  /api/email-preferences/off?t=<token>   shows "Turn off the weekly summary for <workspace>?" with a button. Changes nothing: mail
//                                               scanners open links.
//   POST /api/email-preferences/off?t=<token>   RFC 8058 one-click (body `List-Unsubscribe=One-Click`) or the button of that page: turns that one
//                                               preference off. No session, no cookie: the signed token is the credential, and it names one
//                                               person, one workspace and one preference.
//   GET  /api/email-preferences                 the signed-in person's own choices in the current workspace (hosted; 404 elsewhere)
//   PUT  /api/email-preferences                 {kind: 'summary'|'tips', enabled: boolean}
// Mounted without touching src/api/router.ts (a protected-flow file): the off link next to /api/unsubscribe in src/funnel/routes.ts, the
// signed-in routes in src/hosted/routes.ts.
import { forWorkspace, workspaceLifecycle, EMAIL_PREFERENCE_KINDS, type EmailPreferenceKind, type MembershipRole } from '@ready-set-mail/db';
import { page } from '../../funnel/page';
import { hostedEnabled } from '../../hosted/config';
import type { BoundEnv } from '../../index';
import { verifyToken } from '../../mail/tokens';
import type { TenantContext } from '../../tenancy/context';
import { KIND_WORDS, offered, preferenceOn } from './preferences';

export const PREFERENCES_PATH = '/api/email-preferences';
export const OFF_PATH = '/api/email-preferences/off';

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function offRoute(request: Request, env: BoundEnv, url: URL): Promise<Response> {
  const method = request.method.toUpperCase();
  const p = await verifyToken(env, url.searchParams.get('t') ?? '');
  if (!p || p.p !== 'pref') {
    return method === 'POST' ? new Response('invalid token', { status: 400 }) : page('This link is not valid', 'The link is incomplete or has been altered. You can change your emails in Settings in the dashboard.', 400);
  }
  const words = KIND_WORDS[p.k];
  if (method === 'GET') {
    const ws = await workspaceLifecycle(env.DB).get(p.w);
    const name = ws?.name ?? 'your workspace';
    const form = `<form method="post" action="${esc(`${OFF_PATH}?t=${encodeURIComponent(url.searchParams.get('t') ?? '')}`)}"><input type="hidden" name="List-Unsubscribe" value="One-Click"><button type="submit" style="padding:10px 18px;border-radius:4px;border:0;background:#0647FF;color:#fff;font-size:15px;font-weight:600;">${esc(words.off)}</button></form>`;
    return page(`Turn off ${words.title} for ${name}?`, 'Nothing changes until you press the button. You can turn it back on in Settings in the dashboard.', 200, form);
  }
  // POST: the one-click body of RFC 8058, which the button above also sends.
  const form = new URLSearchParams(await request.text().catch(() => ''));
  if (form.get('List-Unsubscribe') !== 'One-Click') return new Response('expected List-Unsubscribe=One-Click', { status: 400 });
  const scope = forWorkspace(env.DB, p.w);
  // Someone who is no longer a member has nothing to turn off; the answer is the same.
  if (await scope.team.roleOf(p.u)) await scope.lifecycleEmail.preferences.set(p.u, p.k, false, Math.floor(Date.now() / 1000));
  return page(`${words.title.charAt(0).toUpperCase()}${words.title.slice(1)} is off`, 'You will not get this email any more. You can turn it back on in Settings in the dashboard.');
}

async function viewFor(env: BoundEnv, workspaceId: string, userId: string, role: MembershipRole) {
  const rows = await forWorkspace(env.DB, workspaceId).lifecycleEmail.preferences.all();
  const mine = (kind: EmailPreferenceKind) => rows.find((r) => r.user_id === userId && r.kind === kind);
  const one = (kind: EmailPreferenceKind) => ({ offered: offered(role), enabled: preferenceOn(role, kind, mine(kind), env) });
  return { role, summary: one('summary'), tips: one('tips') };
}

/**
 * GET and PUT /api/email-preferences, for the signed-in person in the open workspace (mounted in src/hosted/routes.ts, after the router's own
 * sign-in and its read-only rule for members, so a member can read but never change). Null when the request is not for it.
 */
export async function handleEmailPreferences(request: Request, tenant: TenantContext, actor: { id?: string | null }): Promise<Response | null> {
  if (new URL(request.url).pathname !== PREFERENCES_PATH) return null;
  const env = tenant.env;
  if (!hostedEnabled(env)) return json({ error: 'not found' }, 404);
  const role = tenant.role as MembershipRole | undefined;
  if (!actor.id || !role) return json({ error: 'Email settings need a signed-in person.' }, 403);
  const method = request.method.toUpperCase();
  if (method === 'GET') return json(await viewFor(env, tenant.workspaceId, actor.id, role));
  if (method !== 'PUT') return json({ error: 'method not allowed' }, 405);
  if (!offered(role)) return json({ error: 'These emails are for owners and admins.' }, 403);
  const body = (await request.json().catch(() => null)) as { kind?: unknown; enabled?: unknown } | null;
  if (!body || !(EMAIL_PREFERENCE_KINDS as readonly unknown[]).includes(body.kind) || typeof body.enabled !== 'boolean') return json({ error: 'send {kind: "summary" | "tips", enabled: boolean}' }, 400);
  await tenant.scope.lifecycleEmail.preferences.set(actor.id, body.kind as EmailPreferenceKind, body.enabled, Math.floor(Date.now() / 1000));
  return json(await viewFor(env, tenant.workspaceId, actor.id, role));
}

/** Null when the request is not for the one-click off link. */
export async function handleEmailPreferenceOff(request: Request, env: BoundEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== OFF_PATH) return null;
  const method = request.method.toUpperCase();
  return method === 'GET' || method === 'POST' ? offRoute(request, env, url) : json({ error: 'method not allowed' }, 405);
}
