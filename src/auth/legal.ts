// Who operates this instance, and where its terms and privacy policy are, for the sign-up form, the auth screens' footer,
// Settings and the footer line of the mail this module sends.
//
// Hosted (MODE=saas): the terms and privacy pages are on the marketing site (SITE_URL, else HOSTED_SITE_URL), unless
// TERMS_URL / PRIVACY_URL name them; the operator is OPERATOR_NAME, else HOSTED_OPERATOR_NAME.
// Self-host: nothing unless the operator configured it. The sign-up line needs both TERMS_URL and PRIVACY_URL; the operator
// name is OPERATOR_NAME or nothing. Nothing here ever points a self-hosted instance at the hosted service's pages.
import type { AuthEnv } from './config';
import { isSaas } from './config';

export const HOSTED_SITE_URL = 'https://readysetmail.com';
export const HOSTED_OPERATOR_NAME = 'Fellowship.dev, Inc.';

export interface Legal {
  termsUrl: string | null;
  privacyUrl: string | null;
  operatorName: string | null;
  /** What a sign-up records as accepted: TERMS_VERSION, else the terms URL. Null when no terms are shown. */
  termsVersion: string | null;
  postalAddress: string | null;
}

type LegalEnv = AuthEnv & { SITE_URL?: string; TERMS_URL?: string; PRIVACY_URL?: string; OPERATOR_NAME?: string; TERMS_VERSION?: string; POSTAL_ADDRESS?: string };

/** An https URL without a trailing slash, or null. */
function https(raw: string | undefined): string | null {
  const v = (raw ?? '').trim().replace(/\/+$/, '');
  try {
    return v && new URL(v).protocol === 'https:' ? v : null;
  } catch {
    return null;
  }
}

export function legal(env: AuthEnv): Legal {
  const e = env as LegalEnv;
  const saas = isSaas(env);
  const site = saas ? (https(e.SITE_URL) ?? HOSTED_SITE_URL) : null;
  let termsUrl = https(e.TERMS_URL) ?? (site ? `${site}/terms` : null);
  let privacyUrl = https(e.PRIVACY_URL) ?? (site ? `${site}/privacy` : null);
  // Self-host shows the agreement only when both pages are configured.
  if (!saas && !(termsUrl && privacyUrl)) termsUrl = privacyUrl = null;
  const operatorName = e.OPERATOR_NAME?.trim() || (saas ? HOSTED_OPERATOR_NAME : null);
  return {
    termsUrl,
    privacyUrl,
    operatorName,
    termsVersion: termsUrl ? (e.TERMS_VERSION?.trim() || termsUrl) : null,
    postalAddress: e.POSTAL_ADDRESS?.trim() || null,
  };
}

/** The status route's public view. */
export function legalStatus(env: AuthEnv): { terms_url: string | null; privacy_url: string | null; operator_name: string | null } {
  const l = legal(env);
  return { terms_url: l.termsUrl, privacy_url: l.privacyUrl, operator_name: l.operatorName };
}

/**
 * The one small footer line of every email sent from here: who operates the service (and its postal address when set), and
 * the privacy policy. Empty when nothing is configured (a self-hosted instance that set none of it).
 */
export function mailFooter(env: AuthEnv): string {
  const l = legal(env);
  const named = l.operatorName ? `Ready Set Mail is operated by ${l.operatorName}${l.postalAddress ? `, ${l.postalAddress}` : ''}` : '';
  const who = named && !named.endsWith('.') ? `${named}.` : named;
  const privacy = l.privacyUrl ? `Privacy: ${l.privacyUrl}` : '';
  return [who, privacy].filter(Boolean).join(' ');
}
