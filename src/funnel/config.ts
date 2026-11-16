// Configuration of the email funnel, all from the environment.

import type { Env } from '../index';

export type FunnelEnv = Pick<
  Env,
  | 'MODE' | 'SAAS_ENABLED' | 'PUBLIC_BASE_URL' | 'BETTER_AUTH_URL' | 'POSTAL_ADDRESS' | 'BOOKING_URL'
  | 'MAIL_FROM' | 'MAIL_FROM_NAME' | 'MAIL_REPLY_TO' | 'CANARY_DOMAIN' | 'SITE_ORIGINS' | 'SITE_URL'
>;

/** Public origin for links in email, no trailing slash. Null when none is configured. */
export function publicBaseUrl(env: FunnelEnv): string | null {
  const raw = (env.PUBLIC_BASE_URL || env.BETTER_AUTH_URL || '').trim().replace(/\/+$/, '');
  // HTTPS only (Cloudflare and mailbox providers reject a plain-HTTP List-Unsubscribe); http is accepted for localhost development.
  return /^https:\/\/[^\s/]+/i.test(raw) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(raw) ? raw : null;
}

/** The marketing site for links in email (SITE_URL), https only, no trailing slash. Null when unset: never the Worker's origin. */
export function siteUrl(env: FunnelEnv): string | null {
  const raw = (env.SITE_URL ?? '').trim().replace(/\/+$/, '');
  return /^https:\/\/[^\s/]+/i.test(raw) ? raw : null;
}

/** Where replies go (MAIL_REPLY_TO), or null: then no Reply-To is sent. */
export const replyTo = (env: FunnelEnv): string | null => env.MAIL_REPLY_TO?.trim() || null;

export const postalAddress = (env: FunnelEnv): string | null => env.POSTAL_ADDRESS?.trim() || null;
export const bookingUrl = (env: FunnelEnv): string | null => (/^https?:\/\//i.test(env.BOOKING_URL?.trim() ?? '') ? env.BOOKING_URL!.trim() : null);

/**
 * The dashboard's "Talk to Max" link: the same BOOKING_URL, but https only and a parseable URL, because it is
 * rendered as a link on every hosted screen. Null when unset or anything else: the dashboard then shows no link.
 */
export function helpUrl(env: Pick<FunnelEnv, 'BOOKING_URL'>): string | null {
  const raw = env.BOOKING_URL?.trim() ?? '';
  if (!/^https:\/\/[^\s/]+/i.test(raw) || /\s/.test(raw)) return null;
  try {
    return new URL(raw).protocol === 'https:' ? raw : null;
  } catch {
    return null;
  }
}

export function funnelSender(env: FunnelEnv): { name: string; email: string } | null {
  const email = env.MAIL_FROM?.trim() || (env.CANARY_DOMAIN ? `noreply@${env.CANARY_DOMAIN.trim().toLowerCase()}` : '');
  return email ? { name: env.MAIL_FROM_NAME?.trim() || 'Ready Set Mail', email } : null;
}

export function siteOrigins(env: FunnelEnv): string[] {
  return (env.SITE_ORIGINS ?? '').split(',').map((o) => o.trim().replace(/\/+$/, '')).filter((o) => /^https?:\/\/[^*\s]+$/i.test(o));
}
