import { PlanLimitError, ProofIncompleteError, claimLookups, type DomainRow } from '@ready-set-mail/db';
import { authorizeResource } from '../access/resolve';
import type { TenantContext } from '../tenancy/context';
import { EVICTED_KEEP_DAYS, admitDomain, claimLimitBody, claimView, domainCap, freeingFor, proofColumns, refusedInsertBody, restoreInPlace, roomRefusal, settleClaims, type VerifiedVia } from './ownership';
import { logAudit } from '../audit/log';
import { ownershipVerified } from '../product-analytics/steps';
import { lookupSpf, lookupDmarc } from '../email/dns-check';
import { isClaimProof, recordFirstDnsCheck } from './first-check';
import { planRefusalStatus, type DomainUse } from '../hosted/plan-limits';
import { syncPlanSoon } from '../billing/plan';
import type { BoundEnv } from '../index';
import { INVALID_DOMAIN_MESSAGE, normalizeDomainName, specialUseMessage, type DomainNameResult } from '@ready-set-mail/dns-checks';

export class DomainServiceError extends Error {
  /** `body`, when set, is the whole JSON answer (e.g. a plan_limit with its `code`, `limit` and `help_url`). */
  constructor(message: string, readonly status: number, readonly body?: Record<string, unknown>) { super(message); }
}

/** The 400 body for a refused domain name: `invalid domain format`, or the special-use sentence with its code. */
export function domainRefusal(refused: Exclude<DomainNameResult, { ok: true }>): { error: string; code?: 'special_use_domain' } {
  return refused.reason === 'special_use' ? { error: specialUseMessage(refused.name), code: 'special_use_domain' } : { error: INVALID_DOMAIN_MESSAGE };
}

/** The domain, normalised, or a DomainServiceError (400) saying why it cannot be monitored. */
export function requireDomainName(raw: string): string {
  const n = normalizeDomainName(raw);
  if (n.ok) return n.domain;
  const body = domainRefusal(n);
  throw new DomainServiceError(body.error, 400, body.code ? body : undefined);
}

// Hosted plan cap on domains per workspace (src/hosted/plan-limits.ts). Margin: the INSERT itself is conditional on the count
// (scope.domains.insert / baseDomain.apply with maxDomains), one statement in one D1 transaction, and D1 serialises writes, so the
// cap holds exactly (margin 0) for direct inserts. The check before a claim is created is advisory only: it keeps people from
// publishing a TXT record for a domain that cannot be added, but two requests may both pass it; the INSERT is what enforces.

/** The cap in force for this tenant (hosted only), or undefined: `domainCap` in ownership.ts, the one cap (it asks for a card under the hosted plan). */
export { domainCap };

/** The refusal for an insert the database turned down at the domain cap, as an error the callers turn into the 403 body (it names the claims waiting for proof, like `assertDomainRoom`). */
export async function planLimitError(tenant: TenantContext, max: number): Promise<DomainServiceError> {
  const body = await refusedInsertBody(tenant, max);
  return new DomainServiceError(body.error, planRefusalStatus(body), body);
}

/** Early, non-atomic: has the workspace room for `name` (the one room rule, `domainRoom`)? Throws the refusal when not. A name it already holds, or has a claim for, needs none. */
export async function assertDomainRoom(tenant: TenantContext, name: string, use?: DomainUse): Promise<void> {
  const refusal = await roomRefusal(tenant, name, use);
  if (refusal) throw new DomainServiceError(refusal.error, planRefusalStatus(refusal), refusal);
}

/** What the holder of a name that another workspace proved is told (by the email, and by "prove again" on the old row): the new holder keeps it, the history stays read-only. */
export const EVICTED_NOTICE = (domain: string, evictedAtSeconds: number) =>
  `${domain} now belongs to another workspace that proved it controls it, and it keeps it. Your report history for ${domain} stays here, read-only and available to export, until ${new Date((evictedAtSeconds + EVICTED_KEEP_DAYS * 86400) * 1000).toISOString().slice(0, 10)}, then it is deleted.`;

/** The Cloudflare proof could not be kept whole (no zone or name servers recorded): the add fails and the TXT record is the way. */
export const proofIncomplete = (domain: string) => new DomainServiceError(`Cloudflare could not confirm ${domain} well enough to keep the proof (its zone and name servers). Add it with the DNS record instead.`, 409, { error: `Cloudflare could not confirm ${domain} well enough to keep the proof (its zone and name servers). Add it with the DNS record instead.`, code: 'proof_incomplete' });

/** `analyticsCtx`: where a caller with no request lifetime of its own for the other side effects (an agent tool call) lets the analytics event run. */
export interface EnrollmentOptions { productId?: string; analyticsCtx?: ExecutionContext }

/** Delegated enrollment cannot authorize the legacy transfer's DNS writes or owner email. */
export async function assertAgentEnrollmentSafe(tenant: TenantContext, domain: string): Promise<void> {
  if (tenant.access && !tenant.access.session && await claimLookups(tenant.db).findLegacyHolder(domain, tenant.workspaceId)) {
    throw new DomainServiceError('legacy domain transfer requires a signed-in operator', 409);
  }
}

async function authorizeProductEnrollment(tenant: TenantContext, domain: string, options: EnrollmentOptions): Promise<void> {
  if (options.productId === undefined) return;
  if (!tenant.access || !options.productId) throw new DomainServiceError('explicit product enrollment authority required', 403);
  await authorizeResource(tenant.db, tenant.access, 'domains:manage', { workspaceId: tenant.workspaceId, productId: options.productId, domain });
  if (!await tenant.scope.access.products.get(options.productId)) throw new DomainServiceError('product not authorized', 403);
}

async function assertExistingProductMapping(tenant: TenantContext, domain: DomainRow, options: EnrollmentOptions): Promise<void> {
  if (options.productId !== undefined && !(await tenant.scope.access.products.mappings(options.productId)).some(m => m.domain_id === domain.id)) {
    throw new DomainServiceError('existing domain requires an owner-approved product mapping', 403);
  }
}

export function enrollmentView(domain: DomainRow, reportsDomain?: string) {
  const ready = !!reportsDomain;
  const rua = ready ? `rua@${reportsDomain}` : null;
  const auth = ready ? `${domain.domain}._report._dmarc.${reportsDomain}` : null;
  return {
    domain,
    intake: ready ? { status: 'configured' as const, address: rua } : { status: 'unavailable' as const, reason: 'not_configured' as const },
    rua_hint: rua ? `Add rua=mailto:${rua} to your DMARC record` : null,
    auth_record: auth,
    dns_instructions: auth ? `Add this TXT record to authorize DMARC reports:\n  ${auth}  TXT  "v=DMARC1;"` : null,
  };
}

/** Proof and monitoring are independent of the optional report intake hub. No DNS writes. */
export async function enrollDomain(tenant: TenantContext, input: string, userEmail?: string, ctx?: ExecutionContext, actorId?: string, options: EnrollmentOptions = {}) {
  const domain = requireDomainName(input);
  await authorizeProductEnrollment(tenant, domain, options);
  await assertAgentEnrollmentSafe(tenant, domain);
  const existing = await tenant.scope.domains.getByName(domain);
  if (existing) await assertExistingProductMapping(tenant, existing, options);
  await assertDomainRoom(tenant, domain); // before a claim exists, or anything is verified or evicted: nobody publishes a TXT record for a domain that can never be added
  const admission = await admitDomain(tenant, domain);
  if (admission.kind === 'taken') throw new DomainServiceError('domain already registered in another workspace', 409);
  if (admission.kind === 'limit') {
    const body = claimLimitBody(tenant, admission);
    throw new DomainServiceError(body.error, planRefusalStatus(body), body);
  }
  if (admission.kind === 'pending') return { pending: true as const, claim: claimView(admission.claim), domain: null };
  return commitVerifiedDomain(tenant, domain, admission.via, userEmail, ctx, actorId, options);
}

/** The domain, when this workspace already has it live: the answer for a repeat of something that already worked. Null otherwise. */
export async function resumeExistingDomain(tenant: TenantContext, domain: string, options: EnrollmentOptions = {}) {
  const existing = await tenant.scope.domains.getByName(domain);
  if (!existing || existing.verified_via === 'legacy') return null; // an unproven row is not "already worked": it still has to be proven (restoreInPlace)
  await assertExistingProductMapping(tenant, existing, options);
  return { ...enrollmentView(existing, tenant.settings.reportsDomain), resumed: true as const };
}

/** Inserts a domain whose ownership is established, with the side effects of adding one. */
export async function commitVerifiedDomain(tenant: TenantContext, domain: string, via: VerifiedVia, userEmail?: string, ctx?: ExecutionContext, actorId?: string, options: EnrollmentOptions = {}) {
  await authorizeProductEnrollment(tenant, domain, options);
  await assertAgentEnrollmentSafe(tenant, domain);
  // Hosted: never a reports domain, so never an rua@reports.<domain> address (report intake is not connected).
  const rdomain = tenant.mode === 'saas' ? undefined : tenant.settings.reportsDomain;
  const existing = await tenant.scope.domains.getByName(domain);
  if (existing) {
    await assertExistingProductMapping(tenant, existing, options);
    // Unproven and now proven again: restored in place, its report history intact (not a new row, not a plain "already added").
    const restored = existing.verified_via === 'legacy' ? await restoreInPlace(tenant, existing, via, { id: actorId, email: userEmail }).catch((e) => { throw e instanceof ProofIncompleteError ? proofIncomplete(domain) : e; }) : null;
    if (restored) await syncPlanSoon(tenant.env as BoundEnv, tenant.workspaceId, ctx ?? options.analyticsCtx); // proven again: billed from now (docs/billing.md)
    return { ...enrollmentView(restored ?? existing, rdomain), resumed: true, ...(restored ? { restored: true } : {}) };
  }

  // Fixed rua address — routing is by XML policy_domain, not by address encoding
  const ruaAddress = rdomain ? `rua@${rdomain}` : '';

  // Insert domain row — no DNS writes here; all DNS changes require explicit user action
  let domainId: number;
  try {
    const result = await tenant.scope.domains.insert({ domain, rua_address: ruaAddress, verified_via: via, proof: proofColumns(tenant, domain, via) }, options.productId, { maxDomains: await domainCap(tenant), freeing: freeingFor(tenant, domain) });
    domainId = result.meta.last_row_id as number;
  } catch (e: any) {
    if (e instanceof PlanLimitError) {
      // A concurrent verify of the same domain may have taken the last place: that is this domain being added, not a cap.
      const raced = await resumeExistingDomain(tenant, domain, options);
      if (raced) return raced;
      throw await planLimitError(tenant, e.max);
    }
    if (e instanceof ProofIncompleteError) throw proofIncomplete(domain);
    if (e?.message?.includes('UNIQUE')) {
      // Concurrent replay may have won the insert; only resume a row in this workspace.
      const raced = await tenant.scope.domains.getByName(domain);
      if (raced) {
        await assertExistingProductMapping(tenant, raced, options);
        return { ...enrollmentView(raced, rdomain), resumed: true };
      }
      throw new DomainServiceError('domain already registered in another workspace', 409);
    }
    throw e;
  }
  await settleClaims(tenant, domain);
  await syncPlanSoon(tenant.env as BoundEnv, tenant.workspaceId, ctx ?? options.analyticsCtx); // a proven domain: the plan's quantity follows (never blocks the add)

  ownershipVerified(tenant, ctx ?? options.analyticsCtx, domain, via); // docs/analytics.md

  logAudit(tenant, {
    actor_id: actorId ?? null, actor_email: userEmail ?? null, actor_type: 'user',
    action: 'domain.add',
    resource_type: 'domain', resource_id: String(domainId), resource_name: domain,
    after_value: { domain, rua_address: ruaAddress },
  }, ctx);

  // Auto-subscribe the adding user to monitoring alerts
  const email = userEmail;
  if (email) {
    await tenant.scope.monitor.insert({
      email: email.toLowerCase().trim(),
      domain,
      session_token: null,
      confirmed_at: Math.floor(Date.now() / 1000), // a signed-in account holder adding their own domain: no confirmation needed
      spf_record: null,
      dmarc_policy: null,
      dmarc_pct: null,
      dmarc_record: null,
    }).catch(e => console.warn('[domain.add] monitor sub insert failed (non-fatal):', e));
  }

  // A claim just proven: store its first DNS read now (one snapshot at most, which also counts the SPF lookups), so the overview
  // shows its real level at once instead of "not checked yet".
  if (isClaimProof(via)) await recordFirstDnsCheck(tenant, domainId, domain);
  // Background SPF lookup — fire-and-forget, doesn't block response
  else if (ctx) {
    ctx.waitUntil(
      lookupSpf(domain)
        .then(spf => {
          if (spf?.lookup_count !== undefined) {
            return tenant.scope.domains.updateSpfLookupCount(domainId, spf.lookup_count);
          }
        })
        .catch(e => console.warn('[domain.add] background SPF walk failed (non-fatal):', e))
    );
  }

  // Return the full domain row so the frontend has the ID
  const domainRow = await tenant.scope.domains.getById(domainId);

  // If subdomain, fetch parent context for the inheritance-aware wizard
  let parent_context: { domain: string; dmarc_policy: string | null; dmarc_sp: string | null; has_dmarc: boolean } | null = null;
  if (domainRow?.parent_id) {
    const parentRow = await tenant.scope.domains.getById(domainRow.parent_id);
    if (parentRow) {
      // A failed lookup leaves parent_context unset: "unknown" must not be reported as "parent has no DMARC".
      const parentDmarc = await lookupDmarc(parentRow.domain).then(r => ({ ok: true as const, r }), () => ({ ok: false as const, r: null }));
      if (parentDmarc.ok) {
        const pd = parentDmarc.r;
        parent_context = {
          domain: parentRow.domain,
          dmarc_policy: pd?.policy ?? null,
          // sp= tag: null means not explicitly set (frontend distinguishes sp=none vs absent)
          dmarc_sp: pd ? (pd.subdomainPolicy ?? null) : null,
          has_dmarc: pd !== null,
        };
      }
    }
  }

  return {
    ...enrollmentView(domainRow!, rdomain), resumed: false,
    ...(parent_context !== null ? { parent_context } : {}),
  };
}

