// Taking a published MTA-STS policy down without hurting mail (RFC 8461 section 8.3, "Removing MTA-STS"):
//
//   1. Publish a new policy with "mode" equal to "none" and a small "max_age" (e.g., one day).
//   2. Publish a new TXT record to trigger fetching of the new policy.
//   3. When all previously served policies have expired -- normally this is the time the previously published policy was last served plus that policy's "max_age" ... --
//      safely remove the TXT record and HTTPS endpoint.
//
// Why it matters: a sender that fetched an ENFORCE policy refuses to deliver to a mail server that is not in it, for up to its max_age (a week, src/mta-sts/config.ts). Taking the
// policy host down at once would not stop those senders: they would keep refusing, and nothing would tell them otherwise.
//
// So a lost proof, a removed domain and an eviction (src/domains/remove.ts) retire the policy instead of tearing it down: its config row is replaced by an entry in
// `mta_sts_retiring` (a removed domain's row is deleted with the domain; an evicted one is renamed), which serves `mode: none` (one day) by NAME and needs no proof
// (a `none` policy can only stop senders from refusing), publishes a new id where we can write it (a Cloudflare connection), and waits until `retire_after`:
// the last served policy's max_age after the change (a week after an enforce policy or a recent one, a day after a testing policy). Then `finishRetirements` (the
// daily job) deletes the custom hostname and the records, and the entry. Turning MTA-STS on again for the name takes the policy host back (`dropRetiring`).
// A policy nobody ever fetched (setup unfinished, never published) has nothing to wait for and goes at once.

import { intakeLookups, type MtaStsRetiringRow } from '@ready-set-mail/db';
import { logAudit } from '../audit/log';
import type { KeptRecord } from '../dns/removal';
import { nextPolicyId, updateMtaStsTxtRecord } from '../email/mta-sts';
import type { BoundEnv } from '../index';
import { loadTenant } from '../tenancy/load';
import type { TenantContext } from '../tenancy/context';
import { maxAgeFor, MAX_AGE_ENFORCE } from './config';
import { maxAgeWords, splitHosts } from './evidence';
import { removeMtaStsResources, teardownMtaSts, type Ctx } from './service';

export type RetireReason = 'lost_proof' | 'removed' | 'evicted';

/** What the page and the removal answer say about a policy that is being retired. */
export interface RetiringView { retiring: true; reason: RetireReason; enforced: boolean; until: number; message: string }

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** The one plain sentence: what senders may still do meanwhile, and for how long. */
export function retiringMessage(enforced: boolean): string {
  if (enforced) return `MTA-STS is being switched off. Senders that already fetched the enforce policy may refuse to deliver to mail servers that are not in it for up to ${maxAgeWords(MAX_AGE_ENFORCE)}.`;
  return `MTA-STS is being switched off. Senders that already fetched the policy may keep it for up to ${maxAgeWords(maxAgeFor('testing'))}.`;
}

export const retiringView = (e: Pick<MtaStsRetiringRow, 'reason' | 'mode_before' | 'retire_after'>): RetiringView => ({
  retiring: true, reason: e.reason, enforced: e.mode_before === 'enforce', until: e.retire_after, message: retiringMessage(e.mode_before === 'enforce'),
});

/**
 * Start taking this domain's MTA-STS down. Best effort; never throws. Returns what was removed now (`kept`: customer records left in place, said so) and what is retiring,
 * or null when there was nothing (no row).
 */
export async function retireMtaSts(c: Ctx, reason: RetireReason): Promise<{ kept: KeptRecord[]; retiring: RetiringView | null } | null> {
  const { tenant, domain } = c;
  const row = await tenant.scope.mtaSts.get(domain.id);
  if (!row) return null;
  const now = nowSeconds();
  // Nothing for senders to hold: the policy was never published (setup unfinished, or switched off), so there is nothing to wait for.
  if (!row.enabled || row.state === 'creating' || row.policy_published_at === null) return { kept: (await teardownMtaSts(c, row)).kept, retiring: null };

  // Senders may hold an ENFORCE policy while it is the mode, and for a week after it left enforce.
  const enforced = row.mode === 'enforce' || (row.left_enforce_at !== null && row.left_enforce_at + MAX_AGE_ENFORCE > now);
  // The last served policy's max_age after the change, and a week from the day it left enforce (an enforce policy may still be cached).
  const retireAfter = Math.max(now + maxAgeFor(row.mode), row.left_enforce_at ? row.left_enforce_at + MAX_AGE_ENFORCE : 0);
  const newId = nextPolicyId(row.policy_id);
  const d = domain.domain.toLowerCase();
  // The entry first: from now on `mode: none` is what is served (the stored policy before the id, RFC 8461 section 8.1).
  await tenant.scope.mtaStsRetiring.put({
    domain: d, reason, mode_before: enforced ? 'enforce' : 'testing', mx_hosts: row.mx_hosts, policy_id: newId, via: row.via, policy_host: row.policy_host,
    ch_id: row.ch_id, mta_sts_record_id: row.mta_sts_record_id, tls_rpt_record_id: row.tls_rpt_record_id, cname_record_id: row.cname_record_id, cf_connection_id: domain.cf_connection_id ?? null, retire_after: retireAfter, last_error: null,
  });
  await tenant.scope.mtaSts.delete(domain.id);
  // Then the new id, where a connection of this workspace can write it. Failing is not fatal: senders refetch when their cached policy expires, which the wait already covers.
  if (row.via !== 'manual' && row.mta_sts_record_id) {
    try {
      await updateMtaStsTxtRecord(tenant, d, row.mta_sts_record_id, newId, { domain_name: d, actor_id: c.actor?.id, actor_email: c.actor?.email, actor_type: c.actor ? 'user' : 'system', ctx: c.ec, oldPolicyId: row.policy_id });
    } catch (e) {
      const text = `The new id could not be published: ${e instanceof Error ? e.message : String(e)}`;
      console.warn(`[mta-sts] ${d}: ${text}`);
      await tenant.scope.mtaStsRetiring.update(d, { last_error: text }).catch(() => undefined);
    }
  }
  const view = retiringView({ reason, mode_before: enforced ? 'enforce' : 'testing', retire_after: retireAfter });
  logAudit(tenant, {
    actor_id: c.actor?.id ?? null, actor_email: c.actor?.email ?? null, actor_type: c.actor ? 'user' : 'system',
    action: 'mta_sts.retire', resource_type: 'domain', resource_id: String(domain.id), resource_name: d,
    before_value: { mode: row.mode, mx_hosts: splitHosts(row.mx_hosts), policy_id: row.policy_id }, after_value: { reason, retire_after: retireAfter, policy_id: newId },
  }, c.ec);
  return { kept: [], retiring: view };
}

/** The policies (of every workspace, or one) whose time is up: delete the operator's custom hostname and the records, then the entry. A failure keeps the entry for tomorrow. */
export async function finishRetirements(env: BoundEnv, opts: { tenant?: TenantContext; limit?: number } = {}): Promise<number> {
  const now = nowSeconds();
  const due = opts.tenant ? await opts.tenant.scope.mtaStsRetiring.due(now, opts.limit ?? 20) : await intakeLookups(env.DB).dueRetiring(now, opts.limit ?? 20);
  let finished = 0;
  for (const e of due) {
    try {
      const tenant = opts.tenant ?? await loadTenant(env, { workspaceId: e.workspace_id });
      // A name that has an MTA-STS row again (turned on after it retired) keeps its policy host: only the entry goes.
      const takenOver = (await intakeLookups(env.DB).mtaStsDomainNames({ retiring: false })).has(e.domain);
      const ids = takenOver
        ? { mta_sts_record_id: null, tls_rpt_record_id: null, cname_record_id: null, ch_id: null, route_id: null }
        : { mta_sts_record_id: e.mta_sts_record_id, tls_rpt_record_id: e.tls_rpt_record_id, cname_record_id: e.cname_record_id, ch_id: e.ch_id, route_id: null };
      if (e.cf_connection_id) await tenant.useConnectionFor(e.domain, e.cf_connection_id); // the domain row that linked it may be gone
      const t = await removeMtaStsResources(tenant, e.domain, ids, e.policy_id, { actor_id: null, actor_email: null, actor_type: 'system' });
      if (t.operator === 'pending') {
        await tenant.scope.mtaStsRetiring.update(e.domain, { last_error: 'The custom hostname could not be deleted yet; it is tried again tomorrow.' });
        continue;
      }
      await tenant.scope.mtaStsRetiring.delete(e.domain);
      logAudit(tenant, { actor_type: 'system', action: 'mta_sts.retired', resource_type: 'domain', resource_id: e.domain, resource_name: e.domain, ...(t.kept.length ? { after_value: { kept: t.kept } } : {}) });
      finished++;
    } catch (err) {
      console.warn(`[mta-sts] finishing the retired policy of ${e.domain}:`, err instanceof Error ? err.message : err);
    }
  }
  return finished;
}
