// Public, dated free-check reports. No login: the link is the access.
//   POST   /api/public/reports      {domain, source?}  run the check here, store it, return {id, url, path, delete_token, report}
//   GET    /api/public/reports/:id                     the stored report (immutable, cacheable)
//   DELETE /api/public/reports/:id  {delete_token}     remove it
// The marketing site's browser calls POST and DELETE directly (CORS for SITE_ORIGINS only, src/api/cors.ts), so the client IP Cloudflare
// sees (cf-connecting-ip) is the visitor's own: that is what the limits count. X-Forwarded-For is never trusted here. The site's server
// only reads (GET) to render /r/<id>.
//
// Abuse controls: POST answers only with PUBLIC_REPORTS_ENABLED=1; per client IP 10 a minute (the DNS_PREVIEW_LIMITER binding, own
// key prefix) and 30 an hour (D1, keyed hash of the IP); 2,000 new reports a UTC day for the whole instance (PUBLIC_REPORTS_DAILY_CAP);
// the same domain from the same client within 60 seconds returns the report already made; the stored JSON is at most 64 KiB; nothing
// the visitor sends is stored except the domain (after validation). Unknown, malformed and deleted ids all get the same 404. No id is
// ever logged.

import type { BoundEnv as Env } from '../index';
import { globalQueries, publicReportQueries } from '@ready-set-mail/db';
import { keyedHash } from '../mail/tokens';
import { siteUrl } from '../funnel/config';
import { reportDomain } from './domain';
import { REPORT_SCHEMA_VERSION, REPORT_TOOLS, buildReport, nothingAnswered, type ReportTool } from './report';

export const PUBLIC_REPORT_LIMITS = {
  perIpPerHour: 30,
  dailyCap: 2000,
  dedupeSeconds: 60,
  maxJsonBytes: 64 * 1024,
  maxBodyBytes: 2048,
} as const;

/** Readers may cache a report this long; short, so a deleted report does not linger in caches. */
export const REPORT_MAX_AGE_SECONDS = 300;

const ID = /^[A-Za-z0-9_-]{22}$/;
const TOKEN = /^[A-Za-z0-9_-]{22}$/;
const HOUR_MS = 3_600_000;
const enc = new TextEncoder();

type ReportEnv = Env & { PUBLIC_REPORTS_ENABLED?: string; PUBLIC_REPORTS_DAILY_CAP?: string };

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', ...headers },
  });

/** Every miss looks the same: unknown, malformed, deleted, or a wrong delete token. */
const notFound = () => json({ error: 'not found' }, 404);

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 128 random bits, URL-safe: 22 characters. */
export const randomId = (): string => base64url(crypto.getRandomValues(new Uint8Array(16)));

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(value)));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The client as Cloudflare saw it. Not X-Forwarded-For: anyone can write that. */
const clientIp = (request: Request) => request.headers.get('cf-connecting-ip') ?? 'unknown';

function dailyCap(env: ReportEnv): number {
  const n = Number(env.PUBLIC_REPORTS_DAILY_CAP);
  return Number.isInteger(n) && n > 0 ? n : PUBLIC_REPORT_LIMITS.dailyCap;
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const text = await request.text().catch(() => '');
  if (!text || enc.encode(text).length > PUBLIC_REPORT_LIMITS.maxBodyBytes) return null;
  try {
    const body = JSON.parse(text) as unknown;
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const reportPath = (id: string) => `/r/${id}`;
const reportUrl = (env: ReportEnv, id: string) => {
  const site = siteUrl(env);
  return site ? `${site}${reportPath(id)}` : null;
};

export async function handlePublicReportRoute(request: Request, env: ReportEnv): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const method = request.method.toUpperCase();
  if (path === '/api/public/reports') {
    return method === 'POST' ? createReport(request, env) : json({ error: 'method not allowed' }, 405, { Allow: 'POST' });
  }
  const m = path.match(/^\/api\/public\/reports\/([^/]+)$/);
  if (!m) return null;
  const id = m[1]!;
  if (method === 'GET' || method === 'HEAD') return readReport(env, id);
  if (method === 'DELETE') return deleteReport(request, env, id);
  return json({ error: 'method not allowed' }, 405, { Allow: 'GET, DELETE' });
}

async function createReport(request: Request, env: ReportEnv): Promise<Response> {
  if (env.PUBLIC_REPORTS_ENABLED !== '1') return notFound();
  const body = await readBody(request);
  if (!body) return json({ error: 'Send {"domain": "example.com"} as JSON.' }, 400);
  const target = reportDomain(body.domain);
  if (!target.ok) return json({ error: target.error }, 400);
  const source: ReportTool = body.source === undefined ? 'dmarc' : (REPORT_TOOLS as readonly unknown[]).includes(body.source) ? (body.source as ReportTool) : 'dmarc';
  const domain = target.domain;

  const ip = clientIp(request);
  if (env.DNS_PREVIEW_LIMITER && !(await env.DNS_PREVIEW_LIMITER.limit({ key: `public-report:${ip}` })).success) {
    return json({ error: 'You are making reports quickly. Wait a minute and try again.' }, 429, { 'Retry-After': '60' });
  }
  const ipKey = await keyedHash(env, 'public-report-ip', ip);
  const nowMs = Date.now();
  const hit = await globalQueries(env.DB).rateLimit.hit(`public-report:${ipKey}`, nowMs, HOUR_MS);
  if (hit.count > PUBLIC_REPORT_LIMITS.perIpPerHour) {
    return json({ error: 'You have made many reports in the last hour. Try again later.' }, 429, { 'Retry-After': '3600' });
  }

  const reports = publicReportQueries(env.DB);
  const nowSeconds = Math.floor(nowMs / 1000);
  const dedupeKey = await keyedHash(env, 'public-report-dedupe', `${ip}|${domain}`);
  const recent = await reports.recentFor(dedupeKey, nowSeconds - PUBLIC_REPORT_LIMITS.dedupeSeconds);
  if (recent) {
    return json({ id: recent.id, url: reportUrl(env, recent.id), path: reportPath(recent.id), created: false, report: JSON.parse(recent.result_json) }, 200);
  }

  const dayStart = Math.floor(nowSeconds / 86_400) * 86_400;
  if ((await reports.createdSince(dayStart)) >= dailyCap(env)) {
    return json({ error: 'We cannot make more reports today. Try again later.' }, 429, { 'Retry-After': String(dayStart + 86_400 - nowSeconds) });
  }

  const report = await buildReport(domain, source, new Date(nowMs));
  if (nothingAnswered(report)) return json({ error: 'Public DNS did not answer. Try again in a moment.' }, 502);
  const resultJson = JSON.stringify(report);
  if (enc.encode(resultJson).length > PUBLIC_REPORT_LIMITS.maxJsonBytes) {
    return json({ error: 'This domain publishes more DNS data than a report can hold.' }, 413);
  }

  const id = randomId();
  const deleteToken = randomId();
  await reports.insert({
    id,
    domain,
    created_at: nowSeconds,
    schema_version: REPORT_SCHEMA_VERSION,
    source,
    result_json: resultJson,
    delete_token_hash: await sha256Hex(deleteToken),
    dedupe_key: dedupeKey,
  });
  // Dedupe keys only answer a repeat within the window; forget the old ones (cheap, indexed on created_at).
  await reports.clearDedupeBefore(nowSeconds - PUBLIC_REPORT_LIMITS.dedupeSeconds).catch(() => undefined);
  return json({ id, url: reportUrl(env, id), path: reportPath(id), created: true, delete_token: deleteToken, report }, 201);
}

async function readReport(env: ReportEnv, id: string): Promise<Response> {
  if (!ID.test(id)) return notFound();
  const row = await publicReportQueries(env.DB).byId(id);
  if (!row) return notFound();
  return json(
    { id: row.id, domain: row.domain, created_at: new Date(row.created_at * 1000).toISOString(), schema_version: row.schema_version, source: row.source, report: JSON.parse(row.result_json) },
    200,
    { 'Cache-Control': `public, max-age=${REPORT_MAX_AGE_SECONDS}, immutable` },
  );
}

async function deleteReport(request: Request, env: ReportEnv, id: string): Promise<Response> {
  const body = await readBody(request);
  const token = body?.delete_token;
  if (!ID.test(id) || typeof token !== 'string' || !TOKEN.test(token)) return notFound();
  const deleted = await publicReportQueries(env.DB).deleteWithToken(id, await sha256Hex(token));
  return deleted ? new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } }) : notFound();
}
