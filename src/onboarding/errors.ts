// Cloudflare failures as one plain sentence, from the same typed errors as the router's cfFailure.
import {
  CfAuthError, CfConnectionError, CfNotConfiguredError, CfRecordNotAllowedError, CfZoneNotAllowedError, CfZoneNotFoundError, cfErrorText,
} from '../tenancy/cf-client';
import { TokenEnvelopeError, TokenKeyError } from '../connections/crypto';

export function plainCloudflareError(e: unknown): string {
  if (e instanceof CfNotConfiguredError) return 'Cloudflare is not connected for this domain.';
  if (e instanceof CfZoneNotFoundError) return `Cloudflare has no zone for ${e.domain} on this connection.`;
  if (e instanceof TokenKeyError || e instanceof TokenEnvelopeError) return "The server's encryption key is missing or does not match the stored Cloudflare connection. Whoever runs this instance has to fix it.";
  if (e instanceof CfConnectionError) return `The Cloudflare connection ${e.code === 'revoked' ? 'was disconnected' : 'needs to be reconnected'}. Reconnect it in Settings.`;
  if (e instanceof CfZoneNotAllowedError) return `${e.zone} is not one of the zones you let Ready Set Mail manage. Choose it in the Cloudflare settings.`;
  if (e instanceof CfRecordNotAllowedError) return `Ready Set Mail does not write this kind of record: ${e.reason}`;
  if (e instanceof CfAuthError) return `Cloudflare refused the request: the token is invalid or lacks a permission${cfErrorText(e) ? ` (${cfErrorText(e)})` : ''}.`;
  return cfErrorText(e);
}

export function failureCode(e: unknown): string | undefined {
  if (e instanceof CfZoneNotAllowedError) return 'cf_zone_not_allowed';
  if (e instanceof CfConnectionError) return `cf_connection_${e.code}`;
  if (e instanceof CfRecordNotAllowedError) return 'cf_record_not_allowed';
  if (e instanceof TokenKeyError || e instanceof TokenEnvelopeError) return 'encryption';
  return undefined;
}
