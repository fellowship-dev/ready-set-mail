// CORS for the marketing site: the free-check endpoints and the public reports, and only for the origins in SITE_ORIGINS.
// CORS only decides which web pages may read these answers in a browser; it is not access control (any other client can call the
// routes directly), so every limit lives in the routes themselves. Cookies are never allowed on these calls (no credentials header).

import { siteOrigins, type FunnelEnv } from '../funnel/config';

const CORS_PATHS: readonly RegExp[] = [
  /^\/api\/check-sessions$/,
  /^\/api\/check-sessions\/[^/]+$/,
  /^\/api\/public\/reports$/,
  /^\/api\/public\/reports\/[^/]+$/,
];

/** The methods a preflight allows: create on the collections, read on a session, read or delete (with its token) on a report. */
function allowedMethods(path: string): string {
  if (path === '/api/check-sessions' || path === '/api/public/reports') return 'POST';
  if (path.startsWith('/api/public/reports/')) return 'GET, DELETE';
  return 'GET';
}

export const isCorsPath = (path: string): boolean => CORS_PATHS.some((re) => re.test(path));

function allowedOrigin(request: Request, env: FunnelEnv): string | null {
  const origin = request.headers.get('origin');
  return origin && siteOrigins(env).includes(origin.replace(/\/+$/, '')) ? origin : null;
}

/** Answer a preflight for a CORS path: 204 with the allow headers for an allowed origin, 403 otherwise. */
export function preflight(request: Request, env: FunnelEnv): Response {
  const origin = allowedOrigin(request, env);
  if (!origin) return new Response(null, { status: 403, headers: { Vary: 'Origin' } });
  const path = new URL(request.url).pathname;
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': `${allowedMethods(path)}, OPTIONS`,
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    },
  });
}

/** The response with CORS headers when the caller's origin is allowed (and Vary: Origin either way). */
export function withCors(request: Request, env: FunnelEnv, response: Response): Response {
  const headers = new Headers(response.headers);
  headers.append('Vary', 'Origin');
  const origin = allowedOrigin(request, env);
  if (origin) headers.set('Access-Control-Allow-Origin', origin);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
