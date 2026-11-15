// What became of a DNS record Ready Set Mail meant to delete when a domain was removed or a feature switched off.
// A delete is only ever done on a record that is still the one the product wrote (cf-client deleteDnsRecord); a record the
// customer changed is kept, and the caller says so instead of reporting a removal.
import { CfRecordChangedError } from '../tenancy/cf-client';
import { plainCloudflareError } from '../onboarding/errors';

export type DnsRemoval =
  | { state: 'deleted' }
  /** The record was already gone (Cloudflare answered 404 to the read before the delete). Nothing was deleted by us. */
  | { state: 'already_gone' }
  /** Not deleted, still in the zone. `reason` is a sentence for the customer. */
  | { state: 'kept'; reason: string };

/** A record that was left in place, as the DELETE responses and the notice after removal show it. */
export interface KeptRecord { type: string; name: string; reason: string }

export const CHANGED_REASON = 'its content no longer matches what Ready Set Mail wrote';

/** Why a delete did not happen: the record was changed, or Cloudflare would not do it. */
export function keptFromError(e: unknown): DnsRemoval & { state: 'kept' } {
  if (e instanceof CfRecordChangedError) return { state: 'kept', reason: CHANGED_REASON };
  return { state: 'kept', reason: `Cloudflare could not delete it: ${plainCloudflareError(e)}` };
}

/** The result of cf.deleteDnsRecord (true = deleted, false = it was not there). */
export const fromDeleted = (deleted: boolean): DnsRemoval => (deleted ? { state: 'deleted' } : { state: 'already_gone' });

/** The audit action for an outcome. A kept or already-gone record is never audited as a deletion. */
export const removalAction = (r: DnsRemoval): 'dns.delete' | 'dns.already_gone' | 'dns.kept' =>
  r.state === 'deleted' ? 'dns.delete' : r.state === 'already_gone' ? 'dns.already_gone' : 'dns.kept';
