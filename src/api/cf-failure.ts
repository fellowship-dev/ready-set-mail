// A Cloudflare failure as an HTTP status and a JSON body: config problems are the caller's, the rest is reported as given.
// Shared by the router (cfFailure) and the route modules it hands off to (src/mta-sts/service.ts).
import { TokenEnvelopeError, TokenKeyError } from '../connections/crypto';
import { CfConnectionError, CfIncompleteListError, CfNotConfiguredError, CfRecordNotAllowedError, CfZoneNotAllowedError, CfZoneNotFoundError, cfErrorText, incompleteListMessage } from '../tenancy/cf-client';

export interface FailureBody { status: number; body: { error: string; code?: string; connection_id?: string } }

export function cfFailureBody(e: unknown, fallbackStatus = 500): FailureBody {
  if (e instanceof CfNotConfiguredError) return { status: 400, body: { error: e.message, code: e.code } };
  if (e instanceof CfZoneNotFoundError) return { status: 400, body: { error: e.message } };
  if (e instanceof TokenKeyError || e instanceof TokenEnvelopeError) return { status: 503, body: { error: 'Cloudflare connections are unavailable: the server\'s encryption key is missing or does not match the stored credentials. This is for the server operator to fix.' } };
  // A connection that needs the owner (reconnect), or a zone the owner did not allow: not the caller's mistake to retry.
  if (e instanceof CfConnectionError) return { status: 409, body: { error: e.message, code: `cf_connection_${e.code}`, connection_id: e.connectionId } };
  if (e instanceof CfZoneNotAllowedError) return { status: 403, body: { error: e.message, code: 'cf_zone_not_allowed', connection_id: e.connectionId } };
  if (e instanceof CfRecordNotAllowedError) return { status: 403, body: { error: e.message, code: 'cf_record_not_allowed' } };
  if (e instanceof CfIncompleteListError) return { status: 502, body: { error: incompleteListMessage(e), code: 'cf_list_incomplete' } };
  return { status: fallbackStatus, body: { error: cfErrorText(e) } };
}
