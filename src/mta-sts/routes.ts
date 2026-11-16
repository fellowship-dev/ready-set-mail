// /api/domains/:id/mta-sts (the router hands these off; members are read-only by the router's gate before it gets here):
//   GET     status: availability, the exact records, the MX hosts now, the policy host, TLS reports, what enforce and disable need
//   POST    turn on (testing)                           → 201 status
//   PATCH   { mode: "testing" | "enforce" }             enforce needs the evidence (422 with `reasons`)
//           { refresh_mx: true }                        read the MX hosts now; a new list is a new policy id
//           { dismiss_notice: true }                    clear the notice
//   DELETE  turn off (only in testing; 409 says when)   → { ok, kept, operator, message }
//   POST    …/verify                                    read DNS and the policy host now, and move setup forward
//   GET     …/policy                                    the policy file this domain publishes (for the dashboard)

import { cfFailureBody } from '../api/cf-failure';
import type { TenantContext } from '../tenancy/context';
import { disableMtaSts, dismissNotice, changeMode, enableMtaSts, mtaStsView, refreshMx, verifyMtaSts, type Actor, type Result } from './service';
import { policyText } from './serve';

const json = (data: unknown, status = 200) => Response.json(data, { status });
const send = (r: Result): Response => (r.status === 204 ? new Response(null, { status: 204 }) : json(r.body, r.status));

export interface MtaStsRouteDeps { actor?: Actor; ctx?: ExecutionContext }

/** The response for an MTA-STS API request, or null when the path is not one. */
export async function handleMtaStsRoutes(request: Request, tenant: TenantContext, deps: MtaStsRouteDeps = {}): Promise<Response | null> {
  const match = new URL(request.url).pathname.match(/^\/api\/domains\/([^/]+)\/mta-sts(\/verify|\/policy)?$/);
  if (!match) return null;
  const method = request.method.toUpperCase();
  const sub = match[2];
  const id = parseInt(match[1], 10);
  if (isNaN(id)) return json({ error: 'invalid domain id' }, 400);
  const domain = await tenant.scope.domains.getById(id);
  if (!domain) return json({ error: 'domain not found' }, 404);
  const c = { tenant, domain, actor: deps.actor, ec: deps.ctx };

  try {
    if (sub === '/policy') {
      if (method !== 'GET') return null;
      const config = await tenant.scope.mtaSts.get(id);
      if (!config?.enabled) return json({ error: 'MTA-STS not enabled' }, 404);
      return new Response(policyText(config), { headers: { 'Content-Type': 'text/plain' } });
    }
    if (sub === '/verify') return method === 'POST' ? send(await verifyMtaSts(c)) : json({ error: 'method not allowed' }, 405);
    if (method === 'GET') return send(await mtaStsView(tenant, domain));
    if (method === 'POST') return send(await enableMtaSts(c));
    if (method === 'DELETE') return send(await disableMtaSts(c));
    if (method === 'PATCH') {
      const body = await request.json().catch(() => ({})) as { mode?: unknown; refresh_mx?: unknown; dismiss_notice?: unknown };
      if (body.mode === 'testing' || body.mode === 'enforce') return send(await changeMode(c, body.mode));
      if (body.refresh_mx) return send(await refreshMx(c));
      if (body.dismiss_notice) return send(await dismissNotice(c));
      return json({ error: 'nothing to update' }, 400);
    }
    return json({ error: 'method not allowed' }, 405);
  } catch (e) {
    const f = cfFailureBody(e, 502);
    console.warn(`[mta-sts] ${method} ${domain.domain}:`, e instanceof Error ? e.message : e);
    return json(f.body, f.status);
  }
}
