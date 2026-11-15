// Public, dated free-check reports. No login: the link is the access.
//   POST   /api/public/reports      {domain, source?}  run the check here, store it, return {id, url, path, delete_token, report}
//   GET    /api/public/reports/:id                     the stored report (immutable, cacheable)
//   DELETE /api/public/reports/:id  {delete_token}     remove it
//   GET    /api/public/reports/status                  {enabled}: whether POST makes reports here, so the site says "saved" only then
// The marketing site's browser calls POST and DELETE directly, so the client IP Cloudflare sees (cf-connecting-ip) is the visitor's
// own: that is what the limits count. X-Forwarded-For is never trusted here. CORS (src/api/cors.ts) only lets the site's pages read
// the answers; it limits nothing, since any other client can call these routes directly. The site's server only reads (GET) to render
// /r/<id>.
//
// Abuse controls (numbers in limits.ts): POST answers only with PUBLIC_REPORTS_ENABLED=1. In order, before anything is written: the
// instance's daily report cap and its daily and total storage budgets (read only), then the per-minute limiter binding. Then the
// D1 counters: per client (one IPv4 address or one IPv6 /64) an hour, and per network (IPv4 /24, IPv6 /48) an hour and a day, keyed
// by a hash whose key changes every UTC day. The same domain from the same client within 60 seconds returns the report already made.
// Only a complete check is stored, at most maxReportBytes, and its bytes are reserved atomically against the budgets. Nothing the
// visitor sends is stored except the domain (after validation). Unknown, malformed and deleted ids all get the same 404. No id,
// domain or hash is ever logged: storage errors are logged as a fixed sentence.

import type { BoundEnv as Env } from '../index';
import { globalQueries, publicReportQueries, type PublicReportUsage } from '@ready-set-mail/db';
import { keyedHash } from '../mail/tokens';
import { siteUrl } from '../funnel/config';
import { sweepExpiredRateLimits } from '../auth/rate-limit';
import { reportDomain } from './domain';
import { REPORT_SCHEMA_VERSION, REPORT_TOOLS, buildReport, type ReportTool } from './report';
import { PUBLIC_REPORT_LIMITS, clientNetwork, storageBudget, utcDay, type PublicReportEnv, type StorageBudget } from './limits';

export { PUBLIC_REPORT_LIMITS } from './limits';

/** Readers may cache a report this long; short, so a deleted report does not linger in caches. */
export const REPORT_MAX_AGE_SECONDS = 300;

const ID = /^[A-Za-z0-9_-]{22}$/;
const TOKEN = /^[A-Za-z0-9_-]{22}$/;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** As src/auth/rate-limit.ts: about one counted request in 16 also deletes expired counter rows. */
const SWEEP_CHANCE = 1 / 16;
const enc = new TextEncoder();

type ReportEnv = Env & PublicReportEnv;

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', ...headers },
  });

/** Every miss looks the same: unknown, malformed, deleted, or a wrong delete token. */
const notFound = () => json({ error: 'not found' }, 404);
const BAD_BODY = 'Send {"domain": "example.com"} as JSON.';
/** The storage could not be reached. Logged as this fixed sentence only: a D1 error carries the statement's bound values. */
const unavailable = (what: string) => {
  console.error(`[public-reports] storage error while ${what}`);
  return json({ error: 'Reports are not available right now. Try again later.' }, 503, { 'Retry-After': '60' });
};

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

/**
 * A small JSON object, or 'too-large', or null. A declared Content-Length over the cap is refused unread, and the body is read only up
 * to the cap: a long or endless body is cut off, never buffered.
 */
async function readBody(request: Request): Promise<Record<string, unknown> | 'too-large' | null> {
  const max = PUBLIC_REPORT_LIMITS.maxBodyBytes;
  const declared = request.headers.get('content-length');
  if (declared !== null && !(Number(declared) <= max)) return 'too-large';
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => undefined);
        return 'too-large';
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
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
  if (path === '/api/public/reports/status') {
    return method === 'GET' || method === 'HEAD'
      ? json({ enabled: env.PUBLIC_REPORTS_ENABLED === '1' }, 200, { 'Cache-Control': 'public, max-age=60' })
      : json({ error: 'method not allowed' }, 405, { Allow: 'GET' });
  }
  const m = path.match(/^\/api\/public\/reports\/([^/]+)$/);
  if (!m) return null;
  const id = m[1]!;
  if (method === 'GET' || method === 'HEAD') return readReport(env, id);
  if (method === 'DELETE') return deleteReport(request, env, id);
  return json({ error: 'method not allowed' }, 405, { Allow: 'GET, DELETE' });
}

const secondsToNextDay = (nowSeconds: number) => String(Math.floor(nowSeconds / 86_400) * 86_400 + 86_400 - nowSeconds);

/**
 * The answer when the instance's budgets cannot take `bytes` more (1 for the check before a report is made), or null when they can.
 * The total budget is a 503: no report can be made until some are deleted, while every existing report keeps working.
 */
function budgetRefusal(usage: PublicReportUsage | null, b: StorageBudget, day: string, nowSeconds: number, bytes = 1): Response | null {
  if (!usage) return null;
  if (usage.total_bytes + bytes > b.totalBytes) {
    return json({ error: 'We cannot save more reports at the moment. Try again later.' }, 503, { 'Retry-After': '3600' });
  }
  if (usage.day === day && (usage.day_reports >= b.dailyCap || usage.day_bytes + bytes > b.dailyBytes)) {
    return json({ error: 'We cannot make more reports today. Try again later.' }, 429, { 'Retry-After': secondsToNextDay(nowSeconds) });
  }
  return null;
}

async function createReport(request: Request, env: ReportEnv): Promise<Response> {
  if (env.PUBLIC_REPORTS_ENABLED !== '1') return notFound();
  const body = await readBody(request);
  if (body === 'too-large') return json({ error: BAD_BODY }, 413);
  if (!body) return json({ error: BAD_BODY }, 400);
  const target = reportDomain(body.domain);
  if (!target.ok) return json({ error: target.error }, 400);
  const source: ReportTool = (REPORT_TOOLS as readonly unknown[]).includes(body.source) ? (body.source as ReportTool) : 'dmarc';
  // Counted by the address Cloudflare saw. Without one the request is refused: pooling such requests would let one client use up a
  // bucket that others share.
  const who = clientNetwork(request.headers.get('cf-connecting-ip'));
  if (!who) return json({ error: 'This request has no client address, so we cannot make a report for it.' }, 400);
  try {
    return await createChecked(env, target.domain, source, who);
  } catch {
    return unavailable('making a report');
  }
}

async function createChecked(env: ReportEnv, domain: string, source: ReportTool, who: { client: string; network: string }): Promise<Response> {
  const budget = storageBudget(env);
  const nowMs = Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);
  const day = utcDay(nowMs);
  const reports = publicReportQueries(env.DB);

  // 1. The instance's cap and budgets, read only: once they are used up, a request writes nothing at all.
  const early = budgetRefusal(await reports.usage(), budget, day, nowSeconds);
  if (early) return early;

  // 2. Per minute, in Cloudflare's limiter (no D1 write).
  if (env.DNS_PREVIEW_LIMITER && !(await env.DNS_PREVIEW_LIMITER.limit({ key: `public-report:${who.client}` })).success) {
    return json({ error: 'You are making reports quickly. Wait a minute and try again.' }, 429, { 'Retry-After': '60' });
  }

  // 3. Per client an hour, then per network an hour and a day. The keys are keyed hashes whose key changes every UTC day, so a
  //    stored counter cannot be linked to an address, nor to the same address on another day.
  const keyOf = (scope: string, value: string) => keyedHash(env, `public-report-${scope}:${day}`, value);
  const counters = globalQueries(env.DB).rateLimit;
  const clientHits = await counters.hit(`public-report:${await keyOf('client', who.client)}`, nowMs, HOUR_MS);
  if (Math.random() < SWEEP_CHANCE) await sweepExpiredRateLimits(env.DB, nowMs).catch(() => 0);
  if (clientHits.count > PUBLIC_REPORT_LIMITS.perClientPerHour) {
    return json({ error: 'You have made many reports in the last hour. Try again later.' }, 429, { 'Retry-After': '3600' });
  }
  const networkKey = await keyOf('network', who.network);
  const networkHour = await counters.hit(`public-report-net-h:${networkKey}`, nowMs, HOUR_MS);
  const networkDay = await counters.hit(`public-report-net-d:${networkKey}`, nowMs, DAY_MS);
  if (networkHour.count > PUBLIC_REPORT_LIMITS.perNetworkPerHour || networkDay.count > PUBLIC_REPORT_LIMITS.perNetworkPerDay) {
    const retry = networkDay.count > PUBLIC_REPORT_LIMITS.perNetworkPerDay ? '86400' : '3600';
    return json({ error: 'Many reports have come from your network recently. Try again later.' }, 429, { 'Retry-After': retry });
  }

  // 4. The same domain from the same client within the window: the report already made.
  const dedupeKey = await keyOf('dedupe', `${who.client}|${domain}`);
  const recent = await reports.recentFor(dedupeKey, nowSeconds - PUBLIC_REPORT_LIMITS.dedupeSeconds);
  if (recent) {
    return json({ id: recent.id, url: reportUrl(env, recent.id), path: reportPath(recent.id), created: false, report: JSON.parse(recent.result_json) }, 200);
  }

  // 5. The check. Only a complete answer is stored: a partial one would stay public for good. The site then shows its own result.
  const { report, complete } = await buildReport(domain, source, new Date(nowMs));
  if (!complete) {
    return json({ error: 'Public DNS did not answer every lookup, so no report was saved. Try again in a moment.' }, 503, { 'Retry-After': '60' });
  }
  const resultJson = JSON.stringify(report);
  const bytes = enc.encode(resultJson).length;
  if (bytes > budget.maxReportBytes) {
    return json({ error: 'This domain publishes more DNS data than a report can hold.' }, 413);
  }

  // 6. Reserve its bytes against the cap and the budgets in one conditional statement, so concurrent requests cannot overshoot.
  const after = await reports.reserve(bytes, { day, dailyReports: budget.dailyCap, dailyBytes: budget.dailyBytes, totalBytes: budget.totalBytes });
  if (!after) {
    return budgetRefusal(await reports.usage(), budget, day, nowSeconds, bytes)
      ?? json({ error: 'We cannot make more reports today. Try again later.' }, 429, { 'Retry-After': secondsToNextDay(nowSeconds) });
  }
  if (after.total_bytes >= budget.warnBytes && after.total_bytes - bytes < budget.warnBytes) {
    console.warn('[public-reports] stored reports have reached 80% of PUBLIC_REPORTS_TOTAL_BYTES; new reports stop at 100%');
  }

  const id = randomId();
  const deleteToken = randomId();
  try {
    await reports.insert({
      id,
      domain,
      created_at: nowSeconds,
      schema_version: REPORT_SCHEMA_VERSION,
      source,
      result_json: resultJson,
      result_bytes: bytes,
      delete_token_hash: await sha256Hex(deleteToken),
      dedupe_key: dedupeKey,
    });
  } catch (e) {
    await reports.release(bytes).catch(() => undefined);
    throw e;
  }
  // Dedupe keys only answer a repeat within the window; forget the old ones (cheap, indexed on created_at).
  await reports.clearDedupeBefore(nowSeconds - PUBLIC_REPORT_LIMITS.dedupeSeconds).catch(() => undefined);
  return json({ id, url: reportUrl(env, id), path: reportPath(id), created: true, delete_token: deleteToken, report }, 201);
}

async function readReport(env: ReportEnv, id: string): Promise<Response> {
  if (!ID.test(id)) return notFound();
  let row: Awaited<ReturnType<ReturnType<typeof publicReportQueries>['byId']>>;
  try {
    row = await publicReportQueries(env.DB).byId(id);
  } catch {
    return unavailable('reading a report');
  }
  if (!row) return notFound();
  return json(
    { id: row.id, domain: row.domain, created_at: new Date(row.created_at * 1000).toISOString(), schema_version: row.schema_version, source: row.source, report: JSON.parse(row.result_json) },
    200,
    { 'Cache-Control': `public, max-age=${REPORT_MAX_AGE_SECONDS}, immutable` },
  );
}

async function deleteReport(request: Request, env: ReportEnv, id: string): Promise<Response> {
  const body = await readBody(request);
  const token = body && body !== 'too-large' ? body.delete_token : undefined;
  if (!ID.test(id) || typeof token !== 'string' || !TOKEN.test(token)) return notFound();
  let deleted: number | null;
  try {
    deleted = await publicReportQueries(env.DB).deleteWithToken(id, await sha256Hex(token));
  } catch {
    return unavailable('deleting a report');
  }
  return deleted !== null ? new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } }) : notFound();
}
