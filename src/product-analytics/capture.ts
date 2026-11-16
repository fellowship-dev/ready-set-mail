// Server-side product analytics for the hosted dashboard: the one place that talks to PostHog (docs/analytics.md).
//
// Off unless the hosted service sets both POSTHOG_KEY (the PUBLIC project key, `phc_…`, which can only send events) and
// POSTHOG_HOST, on MODE=saas. A self-hosted installation never sends anything, whatever it sets: MODE alone never turns it on, and
// the installer (npm run setup) sets neither variable.
//
// How an event is sent, and why (PostHog's docs, read 2026-11-15):
//  - POST `${POSTHOG_HOST}/batch/` with `{ api_key, batch: [{ event, distinct_id, properties, timestamp }] }`: "The `/i/v0/e` and
//    `/batch` endpoints are the main way to send events to PostHog", both "POST-only public endpoints that use your project token";
//    `historical_migration` "can be left out" for realtime events (https://posthog.com/docs/api/capture).
//  - Personless: `$process_person_profile: false` ("To capture anonymous events, add the `$process_person_profile` property to the
//    event and set it to `false`") with a random distinct id ("Use a random distinct ID that isn't linked to a person profile, such as a
//    UUID"), same page. No person profile, no identify, no alias.
//  - Inside ctx.waitUntil: "Batched data is sent asynchronously and Cloudflare Workers can terminate before it's sent causing data
//    loss"; "Use `ctx.waitUntil()` to flush after the response is sent" (https://posthog.com/docs/libraries/cloudflare-workers).
//    So a slow or failing PostHog never delays or fails the request: the send runs after the response, with a timeout and at most
//    one retry, and every error is swallowed.
//  - No client IP: the request is made by the Worker with only a Content-Type header. Nothing of the visitor's request (IP,
//    CF-Connecting-IP, X-Forwarded-For, User-Agent, cookies) is copied onto it, and no `$ip` property is ever set (the allow-list has
//    none). PostHog therefore only sees Cloudflare's egress address, and `$geoip_disable: true` ("To skip it for a single event, set
//    the `$geoip_disable` property to `true`", https://posthog.com/docs/privacy/data-collection) keeps it from being geolocated. The
//    project additionally discards IP data in its settings.
//  - A 200 from PostHog "does not imply that events are valid" (the capture page: PostHog answers 200 even for an event without a
//    distinct id), so tests check the payload, never the status.
import { getMode } from '../tenancy/mode';
import { allowed, type EventName, type PropsOf } from './events';
import { analyticsIdFor } from './identity';

export interface AnalyticsEnv {
  DB?: D1Database;
  MODE?: string;
  POSTHOG_KEY?: string;
  POSTHOG_HOST?: string;
}

export interface AnalyticsConfig { key: string; batchUrl: string }

/** Longest wait for PostHog per attempt. */
export const SEND_TIMEOUT_MS = 3000;
/** Wait before the single retry. */
export const RETRY_DELAY_MS = 250;

/**
 * The PostHog destination, or null when analytics is off. On only for MODE=saas with both POSTHOG_KEY (a `phc_` project key) and
 * POSTHOG_HOST (an https origin; http://127.0.0.1:<port> or http://localhost:<port> is accepted for a local fake in tests).
 */
export function analyticsConfig(env: AnalyticsEnv): AnalyticsConfig | null {
  if (getMode(env) !== 'saas') return null;
  const key = env.POSTHOG_KEY?.trim();
  const host = env.POSTHOG_HOST?.trim().replace(/\/+$/, '');
  if (!key || !/^phc_[A-Za-z0-9_-]{8,}$/.test(key) || !host) return null;
  let url: URL;
  try { url = new URL(host); } catch { return null; }
  const local = url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  if ((url.protocol !== 'https:' && !local) || url.username || url.password || url.search || url.hash) return null;
  return { key, batchUrl: `${url.origin}${url.pathname.replace(/\/+$/, '')}/batch/` };
}

export const analyticsEnabled = (env: AnalyticsEnv): boolean => analyticsConfig(env) !== null;

/** Who an event is about: a workspace (its analytics id is looked up or made), or an analytics id already known. */
export type Subject = { workspaceId: string } | { analyticsId: string };

export interface Captured { event: EventName; props: Record<string, unknown> }

/** The JSON body of one send: what tests and the fake PostHog inspect. */
export function batchBody(cfg: AnalyticsConfig, distinctId: string, events: { event: string; props: Record<string, string | boolean> }[], now = Date.now()) {
  return {
    api_key: cfg.key,
    batch: events.map(({ event, props }) => ({
      event,
      distinct_id: distinctId,
      timestamp: new Date(now).toISOString(),
      properties: { ...props, surface: 'app', $process_person_profile: false, $geoip_disable: true, $lib: 'ready-set-mail-worker' },
    })),
  };
}

async function post(url: string, body: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
    // Only a server-side failure is worth the one retry; a 4xx will not change.
    return res.status < 500 && res.status !== 429;
  } catch {
    return false;
  }
}

/** Send now (awaited): the background half of capture(). Never throws. */
export async function send(env: AnalyticsEnv, subject: Subject, events: readonly Captured[]): Promise<void> {
  try {
    const cfg = analyticsConfig(env);
    if (!cfg || events.length === 0) return;
    const filtered = events.flatMap(({ event, props }) => {
      const p = allowed(event, props);
      return p ? [{ event, props: p }] : [];
    });
    if (filtered.length === 0) return;
    const distinctId = 'analyticsId' in subject ? subject.analyticsId : env.DB ? await analyticsIdFor(env.DB, subject.workspaceId) : null;
    if (!distinctId) return;
    const body = JSON.stringify(batchBody(cfg, distinctId, filtered));
    if (await post(cfg.batchUrl, body)) return;
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    await post(cfg.batchUrl, body);
  } catch {
    // Analytics must never affect the product.
  }
}

/**
 * Count one or more steps for a workspace (or a known analytics id), after the response: returns at once, never throws, never
 * awaits PostHog. With no ctx (a caller with no request lifetime to extend) the send still starts, unawaited.
 */
export function captureMany(env: AnalyticsEnv, ctx: Pick<ExecutionContext, 'waitUntil'> | undefined, subject: Subject, events: readonly Captured[]): void {
  if (!analyticsEnabled(env) || events.length === 0) return;
  const p = send(env, subject, events);
  try { ctx?.waitUntil(p); } catch { /* a context that cannot extend: the promise still runs */ }
}

export function capture<E extends EventName>(env: AnalyticsEnv, ctx: Pick<ExecutionContext, 'waitUntil'> | undefined, subject: Subject, event: E, props: PropsOf<E> = {} as PropsOf<E>): void {
  captureMany(env, ctx, subject, [{ event, props: props as Record<string, unknown> }]);
}

/** What background work decided to count: about whom, and which events (none: nothing is sent). */
export interface Batch { subject: Subject; events: readonly Captured[] }

/**
 * Background work that decides what to count (a marker to claim, a count to read, whose workspace it is) and then counts it: runs
 * only when analytics is on, inside waitUntil, with every error swallowed. `work` returns the batch, or null for nothing.
 */
export function captureLater(env: AnalyticsEnv, ctx: Pick<ExecutionContext, 'waitUntil'> | undefined, work: () => Promise<Batch | null>): void {
  if (!analyticsEnabled(env)) return;
  const p = (async () => {
    try {
      const b = await work();
      if (b) await send(env, b.subject, b.events);
    } catch { /* never affects the product */ }
  })();
  try { ctx?.waitUntil(p); } catch { /* see captureMany */ }
}

/** One event, typed, for captureLater's result lists. */
export const ev = <E extends EventName>(event: E, props: PropsOf<E> = {} as PropsOf<E>): Captured => ({ event, props: props as Record<string, unknown> });
