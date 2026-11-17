// /api/domains/:id/report-address — connect a domain's DMARC reports on the hosted service (MODE=saas only; see
// src/hosted/report-address.ts). Tenant-scoped like every other route: the domain is looked up through the caller's
// workspace, so another workspace's id is a 404. Writes need an owner or admin (the router refuses members first).
//
//   GET    /api/domains/:id/report-address          status: { available: false }, or the address, its state and what to publish
//   POST   /api/domains/:id/report-address          connect (201; 200 with the current status when already connected)
//   DELETE /api/domains/:id/report-address          disconnect at once
//   GET    /api/domains/:id/report-address/review   the live DMARC record and what Apply would do about it, with the hash the apply carries
//   POST   /api/domains/:id/report-address/apply    { reviewed, choice }: connect, then write the record as reviewed (ONE function, ADR 0020);
//                                                   409 `record_changed` with the fresh review when the live record is not the reviewed one

import type { TenantContext } from '../tenancy/context';
import { hostedEnabled } from './config';
import { applyClicked, applyDone } from '../product-analytics/steps';
import { failureCode, plainCloudflareError } from '../onboarding/errors';
import {
  applyReportRecord, connectReports, disconnectReports, reportAddressStatus, reviewReportRecord, ReportAddressError, ReportRecordChanged,
  type ReportAddressDeps, type ReportChoice,
} from './report-address';

const json = (data: unknown, status = 200) => Response.json(data, { status });
const err = (message: string, status: number) => json({ error: message }, status);

const ROUTE = /^\/api\/domains\/([^/]+)\/report-address(?:\/(review|apply))?$/;

export async function handleReportAddressRoutes(
  request: Request,
  tenant: TenantContext,
  ctx: ExecutionContext,
  actor: { id?: string | null; email?: string | null },
  deps: ReportAddressDeps = {},
): Promise<Response | null> {
  const m = new URL(request.url).pathname.match(ROUTE);
  if (!m) return null;
  // Self-host keeps its own reports address (rua@reports.<base>): this API does not exist there.
  if (!hostedEnabled(tenant.env)) return err('not found', 404);
  const method = request.method.toUpperCase();
  const id = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : NaN;
  if (isNaN(id)) return err('invalid domain id', 400);
  // Live domains of this workspace only: never another workspace's, never a pending or lost claim, never an evicted row.
  const domain = await tenant.scope.domains.getById(id);
  if (!domain) return err('domain not found', 404);

  const choiceOf = (v: unknown): ReportChoice | null => {
    const c = v as { kind?: unknown; address?: unknown } | null;
    if (c?.kind === 'add') return { kind: 'add' };
    return c?.kind === 'replace' && typeof c.address === 'string' && c.address ? { kind: 'replace', address: c.address } : null;
  };

  try {
    if (m[2] === 'review') {
      if (method !== 'GET') return err('method not allowed', 405);
      return json(await reviewReportRecord(tenant, domain, deps));
    }
    if (m[2] === 'apply') {
      if (method !== 'POST') return err('method not allowed', 405);
      let body: { reviewed?: unknown; choice?: unknown };
      try { body = await request.json() as typeof body; } catch { return err('Invalid JSON body', 400); }
      const choice = choiceOf(body.choice);
      if (typeof body.reviewed !== 'string' || !body.reviewed || !choice) return err('reviewed (the hash of the review you saw) and choice ({ kind: "add" } or { kind: "replace", address }) are required', 400);
      applyClicked(tenant, ctx, 'dmarc_record', 1);
      try {
        const out = await applyReportRecord(tenant, domain, { reviewed: body.reviewed, choice }, deps, actor, ctx);
        applyDone(tenant, ctx, { step: 'dmarc_record', changes: out.wrote ? 1 : 0, failed: 0, reports: 'connected', domainIds: [domain.id] });
        const fresh = (await tenant.scope.domains.getById(domain.id)) ?? domain;
        return json({ ok: true, wrote: out.wrote, status: await reportAddressStatus(tenant, fresh, deps) });
      } catch (e) {
        applyDone(tenant, ctx, { step: 'dmarc_record', changes: 1, failed: 1, reports: 'none', domainIds: [] });
        if (e instanceof ReportRecordChanged) return json({ error: e.message, code: 'record_changed', review: e.review }, 409);
        if (e instanceof ReportAddressError) throw e;
        // A Cloudflare failure after the domain was connected: the domain stays connected, the status says what is true, and Apply can be tried again.
        const code = failureCode(e);
        return json({ error: plainCloudflareError(e), ...(code ? { code } : {}) }, 502);
      }
    }
    if (method === 'GET') return json(await reportAddressStatus(tenant, domain, deps));
    if (method === 'POST') {
      const { created, status } = await connectReports(tenant, domain, deps, actor, ctx);
      return json(status, created ? 201 : 200);
    }
    if (method === 'DELETE') return json(await disconnectReports(tenant, domain, deps, actor, ctx));
    return err('method not allowed', 405);
  } catch (e) {
    if (e instanceof ReportAddressError) return err(e.message, e.status);
    throw e;
  }
}
