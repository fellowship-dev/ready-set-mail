// The reconcile: ONE function that makes the policy host true and PROVES the policy by fetching it. The daily job (src/mta-sts/refresh.ts), "Check now"
// (`verifyMtaSts`), the owner's POST /api/instance/mta-sts/reconcile (after a deploy) and every id change (src/mta-sts/service.ts) go through it.
//
// For one enabled row:
//   (a) hosted, custom hostname (policy_host saas_hostname): it exists (by the stored id, else by name) and is not "moved" or deleted. Missing: created (looked up
//       first, never a second one). "moved" (Cloudflare gave up validating, or the CNAME no longer points at the fallback origin; a moved hostname is deleted after 7 days,
//       developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/hostname-validation/validation-status/): refreshed, which sends it back to pending.
//   (b) hosted: the ONE declared route (POLICY_ROUTE_PATTERN) is in the zone. Missing: that exact pattern is created again and the log says so loudly (a deploy without it).
//       A per-domain route an earlier build made is deleted once the declared one is there.
//   (c) the FETCH of https://mta-sts.<domain>/.well-known/mta-sts.txt, no redirects, a short timeout, no cache: the proof is status 200, Content-Type text/plain, a body equal byte
//       for byte to the policy we publish, and the HTTPS request succeeding (Workers' fetch fails on an invalid certificate, so success is the certificate proof;
//       `global_fetch_strictly_public` in wrangler.jsonc sends it through Cloudflare's front door like an Internet request, so it also proves the route).
// The result (time, outcome, one reason code) is stored on the row; the page's "served" is that and nothing else, and the `_mta-sts` id is not published while it fails.
// Self-host: the Worker's own host serves the policy through the customer's proxied CNAME (no operator zone), so (a) and (b) do not apply and (c) is the whole proof.

import type { MtaStsPatch, MtaStsRow } from '@ready-set-mail/db';
import { getMode } from '../tenancy/mode';
import { CAA_BLOCKS_SENTENCE, mtaStsHostedConfigured } from './config';
import { OperatorZone, policyHostname, POLICY_ROUTE_PATTERN, type CustomHostname, type WorkerRoute } from './policy-host';
import { policyText } from './serve';
import type { Ctx } from './service';

/** Why a fetch is not a proof: one code per cause (stored on the row, shown through `servedStatus`). */
export type FetchReason = 'not_found' | 'unexpected_status' | 'redirect' | 'wrong_content_type' | 'wrong_body' | 'certificate' | 'unreachable' | 'timeout';
export interface PolicyProof { ok: boolean; reason: FetchReason | null }

export const FETCH_TIMEOUT_MS = 8000;
export const policyUrl = (domain: string): string => `https://${policyHostname(domain)}/.well-known/mta-sts.txt`;

/**
 * Where the fetch goes. Always the policy address, except on a local run: POLICY_FETCH_BASE_URL set to a localhost origin (like CLOUDFLARE_API_BASE_URL, anything else is
 * ignored) sends it to `<origin>/policy-fetch/<policy hostname>/.well-known/mta-sts.txt`, where a local stand-in answers as the internet would (the walks and e2e of this
 * repository: no certificate and no route exist on a laptop).
 */
export function policyFetchUrl(domain: string, env?: object): string {
  const base = (env as { POLICY_FETCH_BASE_URL?: string } | undefined)?.POLICY_FETCH_BASE_URL?.trim();
  return base && /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(base) ? `${base}/policy-fetch/${policyHostname(domain)}/.well-known/mta-sts.txt` : policyUrl(domain);
}

/** An error from fetch(): a timeout, a certificate or TLS failure (Workers refuse an invalid certificate), or any other way of not getting an answer. */
function classify(e: unknown): FetchReason {
  const text = `${e instanceof Error ? `${e.name} ${e.message}` : String(e)}`;
  if (/abort|timeout|timed out/i.test(text)) return 'timeout';
  if (/certificate|\btls\b|\bssl\b|handshake|self[- ]signed|untrusted|expired/i.test(text)) return 'certificate';
  return 'unreachable';
}

/** Fetch the policy URL of `domain` and compare it with `expected` (the exact text we publish). Never throws. */
export async function fetchPolicyProof(domain: string, expected: string, env?: object, fetcher: typeof fetch = (...a) => fetch(...a), timeoutMs: number = FETCH_TIMEOUT_MS): Promise<PolicyProof> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetcher(policyFetchUrl(domain, env), { method: 'GET', redirect: 'manual', signal: abort.signal, headers: { 'Cache-Control': 'no-cache', Accept: 'text/plain' } });
    const status = res.status;
    if (status >= 300 && status < 400) { await res.body?.cancel().catch(() => undefined); return { ok: false, reason: 'redirect' }; }
    if (status === 404) { await res.body?.cancel().catch(() => undefined); return { ok: false, reason: 'not_found' }; }
    if (status !== 200) { await res.body?.cancel().catch(() => undefined); return { ok: false, reason: 'unexpected_status' }; }
    if ((res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() !== 'text/plain') { await res.body?.cancel().catch(() => undefined); return { ok: false, reason: 'wrong_content_type' }; }
    const body = await res.text();
    return body === expected ? { ok: true, reason: null } : { ok: false, reason: 'wrong_body' };
  } catch (e) {
    return { ok: false, reason: classify(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** What the page says when the policy cannot be reached: one plain sentence and the one action. Null when it can. */
export function servedMessage(domain: string, reason: FetchReason | null): { message: string; action: 'check_now' | 'fix_record' } | null {
  if (!reason) return null;
  const url = policyUrl(domain);
  if (reason === 'certificate' || reason === 'unreachable' || reason === 'timeout') {
    return { message: `The policy at ${url} cannot be reached yet. A new certificate takes a few minutes after the CNAME resolves; choose Check now to look again.`, action: 'check_now' };
  }
  return { message: `${url} does not answer with the policy yet. Check that the CNAME mta-sts.${domain} points where it should, then choose Check now.`, action: 'fix_record' };
}

/** What several rows of one run share: the operator zone is opened once, and the declared route is looked up once. */
export interface ReconcileShared { zone?: Promise<OperatorZone>; route?: Promise<{ route: WorkerRoute; created: boolean }>; wider?: Promise<WorkerRoute[]> }

export interface Reconciled {
  row: MtaStsRow;
  proof: PolicyProof;
  /** The custom hostname after the reconcile (hosted, saas_hostname), null when there is none or it could not be read. */
  hostname: CustomHostname | null;
  /** What was wrong on the operator side and could not be fixed, in a sentence; null when all is well. */
  operatorError: string | null;
  /** What it changed at Cloudflare: 'hostname_created' | 'hostname_refreshed' | 'route_created' | 'legacy_route_deleted' | 'wide_route'. */
  actions: string[];
}

const hostedHere = (c: Ctx) => getMode(c.tenant.env) === 'saas' && mtaStsHostedConfigured(c.tenant.env);

export async function reconcileMtaSts(c: Ctx, row: MtaStsRow, shared: ReconcileShared = {}): Promise<Reconciled> {
  const { tenant, domain } = c;
  const patch: MtaStsPatch = {};
  const actions: string[] = [];
  let hostname: CustomHostname | null = null;
  let operatorError: string | null = null;

  if (hostedHere(c)) {
    try {
      const zone = await (shared.zone ??= OperatorZone.open(tenant.env));
      if (row.policy_host === 'saas_hostname') {
        let ch = row.ch_id ? await zone.getHostname(row.ch_id) : null;
        ch ??= await zone.findHostname(domain.domain);
        if (!ch || ch.status === 'deleted') { ch = await zone.createHostname(domain.domain); actions.push('hostname_created'); }
        else if (ch.status === 'moved') { ch = (await zone.refreshHostname(ch.id, domain.domain)) ?? ch; actions.push('hostname_refreshed'); }
        hostname = ch;
        if (row.ch_id !== ch.id) patch.ch_id = ch.id;
        if (row.ch_status !== ch.status) patch.ch_status = ch.status;
        if (row.ch_ssl_status !== ch.sslStatus) patch.ch_ssl_status = ch.sslStatus;
        // A CAA record on the customer's domain can stop the certificate (Cloudflare says so in the hostname's validation errors): say it, once, until it is gone.
        const caa = ch.sslStatus !== 'active' && /\bcaa\b/i.test(ch.sslErrors);
        if (caa && row.last_error !== CAA_BLOCKS_SENTENCE) patch.last_error = CAA_BLOCKS_SENTENCE;
        if (!caa && row.last_error === CAA_BLOCKS_SENTENCE) patch.last_error = null;
      }
      const declared = await (shared.route ??= zone.ensureDeclaredRoute());
      if (declared.created && !actions.includes('route_created')) {
        actions.push('route_created');
        console.error(`[mta-sts] the declared route ${POLICY_ROUTE_PATTERN} was missing from ${zone.zone.name} and was created again: a deploy without it? Declare it in the hosted deploy config (docs/hosted.md), or the next deploy removes it.`);
      }
      // A wider route to this Worker would let the dashboard's static files answer on a customer's name (the Worker only runs first for the paths in wrangler.jsonc).
      for (const wide of await (shared.wider ??= zone.widerRoutes()).catch(() => [] as WorkerRoute[])) {
        if (row.route_id === wide.id) continue; // an earlier build's per-domain route: deleted just below
        if (!actions.includes('wide_route')) actions.push('wide_route');
        console.error(`[mta-sts] route ${wide.pattern} in ${zone.zone.name} reaches policy hosts for more than ${POLICY_ROUTE_PATTERN}: the dashboard's files could answer on a customer's name. Remove it.`);
      }
      if (row.route_id && row.route_id !== declared.route.id) {
        // An earlier build made a route for this one domain. It is redundant with the declared one and, made through the API, not safe across a deploy.
        if (await zone.deleteRoute(row.route_id, domain.domain).catch(() => false)) actions.push('legacy_route_deleted');
      }
      if (row.route_id !== declared.route.id) patch.route_id = declared.route.id;
    } catch (e) {
      operatorError = `The policy host could not be checked: ${e instanceof Error ? e.message : String(e)}`;
      console.warn(`[mta-sts] ${domain.domain}: ${operatorError}`);
    }
  }

  const proof = await fetchPolicyProof(domain.domain, policyText(row), tenant.env);
  const okNow = proof.ok ? 1 : 0;
  patch.fetch_checked_at = Math.floor(Date.now() / 1000);
  if (row.fetch_ok !== okNow) patch.fetch_ok = okNow;
  if (row.fetch_reason !== proof.reason) patch.fetch_reason = proof.reason;

  await tenant.scope.mtaSts.update(domain.id, patch);
  return { row: { ...row, ...patch }, proof, hostname, operatorError, actions };
}
