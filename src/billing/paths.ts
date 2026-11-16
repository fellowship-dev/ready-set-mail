// Where the browser lands after Stripe's hosted pages. A return path is an app route (the dashboard is a hash router with the workspace in
// the URL: #/w/<workspace>/<route>), validated against the routes the app really has. The server builds the full URL from the workspace it
// stored itself, so nothing in a request can name a host, a scheme or another workspace.

/** Where an unusable return path falls back to: the Billing section of Settings. */
export const BILLING_PATH = '/settings';

// The app's routes Stripe's hosted page may return to: Settings (`?plan=start` is the start button), a domain page (`?order=fix-one-domain` the order confirm), the
// Add domain page with the typed name (`/add?domain=<name>`: the paid-domain confirm), and the domains list (`/?zones=confirm`: the Cloudflare zones' confirm).
const ALLOWED = /^\/(?:settings(?:\?plan=start)?|domains\/[1-9][0-9]{0,8}(?:\?order=fix-one-domain)?|add(?:\?domain=[a-z0-9][a-z0-9.-]{0,251}[a-z0-9])?|(?:\?zones=confirm)?)$/;

/** The path if it is one of the app's own, else null. Same-origin relative only: one leading slash, no `//`, backslash, scheme or control characters. */
export function safeReturnPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 300) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(raw) || raw.includes('//') || !raw.startsWith('/') || raw.startsWith('//')) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(raw); } catch { return null; }
  // Percent-encoding must not smuggle anything the literal check rejects.
  // eslint-disable-next-line no-control-regex
  if (decoded !== raw || /[\u0000-\u001f\u007f\\]/.test(decoded)) return null;
  return ALLOWED.test(raw) ? raw : null;
}

/** `/#/w/<workspace>/<path>` with extra query parameters appended inside the route's own query string. */
export function appUrl(origin: string, workspaceId: string, path: string, extra: Record<string, string> = {}): string {
  const [route, query = ''] = path.split('?');
  const params = new URLSearchParams(query);
  for (const [k, v] of Object.entries(extra)) params.set(k, v);
  const qs = params.toString();
  return `${origin}/#/w/${encodeURIComponent(workspaceId)}${route}${qs ? `?${qs}` : ''}`;
}

/** Same, relative to the site (for a Location header on our own origin). */
export const appLocation = (workspaceId: string, path: string, extra: Record<string, string> = {}): string => appUrl('', workspaceId, path, extra);
