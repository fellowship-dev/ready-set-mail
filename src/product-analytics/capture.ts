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
//  - Straight to PostHog, never through a proxy on our own domain: POSTHOG_HOST must be one of PostHog's own ingestion origins
//    (ALLOWED_HOSTS: "https://us.i.posthog.com for US Cloud", "https://eu.i.posthog.com for EU Cloud", https://posthog.com/docs/api/capture),
//    the origin only, no path. Anything else leaves analytics off, and the owner's setup check says why. The reason: a Worker's
//    request to a host on its own Cloudflare zone carries the visitor's address ("In same-zone Worker subrequests, the value of
//    `CF-Connecting-IP` reflects the value of `x-real-ip` (the client's IP)", https://developers.cloudflare.com/fundamentals/reference/http-headers/),
//    so a first-party reverse proxy (right for the website's BROWSER events) would hand PostHog every visitor's IP here.
//  - No client IP otherwise: the request is made by the Worker with only a Content-Type header. Nothing of the visitor's request (IP,
//    CF-Connecting-IP, X-Forwarded-For, Forwarded, User-Agent, cookies) is copied onto it, and no `$ip` property is ever set (the
//    allow-list has none). PostHog therefore only sees Cloudflare's egress address, and `$geoip_disable: true` ("To skip it for a
//    single event, set the `$geoip_disable` property to `true`", https://posthog.com/docs/privacy/data-collection) keeps it from
//    being geolocated. The project additionally discards IP data in its settings.
//  - Timestamps: the moment the step happened (taken when the hook is called, not when the batch leaves), to the whole second
//    (`2026-11-15T12:00:07Z`). Events of one hook keep their order; two steps in the same second tie, and an ordered funnel still
//    counts them: PostHog's funnel function takes "different events with the same timestamp" and processes them sorted by step
//    (funnel-udf/src/steps.rs in PostHog/posthog), so a tie never breaks a funnel and no artificial offset is needed.
//  - A 200 from PostHog "does not imply that events are valid" (the capture page: PostHog answers 200 even for an event without a
//    distinct id), so tests check the payload, never the status.
//  - Never harms the product: config is read with typeof checks, and capture, captureMany and captureLater catch everything at their
//    boundary (each drop logged as one `[product-analytics] dropped: <stage>` line, no details), so no setting, event or hook can throw into the request, webhook, email or cron it rides on.
import { getMode } from '../tenancy/mode';
import { allowed, type EventName, type PropsOf } from './events';
import { analyticsIdFor } from './identity';

export interface AnalyticsEnv {
  DB?: D1Database;
  MODE?: unknown;
  POSTHOG_KEY?: unknown;
  POSTHOG_HOST?: unknown;
}

export interface AnalyticsConfig { key: string; batchUrl: string }

/** Longest wait for PostHog per attempt. */
export const SEND_TIMEOUT_MS = 3000;
/** Wait before the single retry. */
export const RETRY_DELAY_MS = 250;

/** PostHog's own ingestion origins (US and EU Cloud): the only places events are sent. Never a proxy on our own domain. */
export const ALLOWED_HOSTS = ['https://us.i.posthog.com', 'https://eu.i.posthog.com'] as const;

/** A swallowed failure, counted as one log line naming only the stage (never the error, which could carry a value). */
export function dropped(stage: 'capture' | 'later' | 'send' | 'post'): void {
  try { console.warn(`[product-analytics] dropped: ${stage}`); } catch { /* nothing */ }
}

/** A local fake PostHog for tests and e2e only: plain http on the loopback with a port, the origin only. */
function localFake(url: URL): boolean {
  return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost') && url.port !== '';
}

/**
 * Whether analytics is on, and if a setting is present but wrong, why not (for the owner's setup check; never a value).
 * `off`: not hosted, or neither setting is set. On only for MODE=saas with POSTHOG_KEY a `phc_` project key and POSTHOG_HOST exactly
 * one of ALLOWED_HOSTS (an http://127.0.0.1:<port> or http://localhost:<port> fake is accepted for tests). Never throws.
 */
export function analyticsState(env: AnalyticsEnv): { state: 'on'; config: AnalyticsConfig } | { state: 'off' } | { state: 'misconfigured'; setting: string; reason: string } {
  try {
    if (getMode(env as { MODE?: string }) !== 'saas') return { state: 'off' };
    const rawKey = env.POSTHOG_KEY;
    const rawHost = env.POSTHOG_HOST;
    if (rawKey === undefined && rawHost === undefined) return { state: 'off' };
    if (typeof rawKey !== 'string' || !rawKey.trim()) return { state: 'misconfigured', setting: 'POSTHOG_KEY', reason: 'POSTHOG_HOST is set but POSTHOG_KEY is not (a text setting), so product analytics is off.' };
    if (typeof rawHost !== 'string' || !rawHost.trim()) return { state: 'misconfigured', setting: 'POSTHOG_HOST', reason: 'POSTHOG_KEY is set but POSTHOG_HOST is not (a text setting), so product analytics is off.' };
    const key = rawKey.trim();
    if (!/^phc_[A-Za-z0-9_-]{8,}$/.test(key)) return { state: 'misconfigured', setting: 'POSTHOG_KEY', reason: 'POSTHOG_KEY is not a PostHog project key (phc_…), so product analytics is off. A personal API key (phx_…) must never be used here.' };
    let url: URL | null = null;
    try { url = new URL(rawHost.trim()); } catch { url = null; }
    const origin = url && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/' ? url.origin : null;
    if (!url || !origin || (!(ALLOWED_HOSTS as readonly string[]).includes(origin) && !localFake(url))) {
      return { state: 'misconfigured', setting: 'POSTHOG_HOST', reason: `POSTHOG_HOST must be exactly ${ALLOWED_HOSTS.join(' or ')} (PostHog's own ingestion host, no path), so product analytics is off. Server-side events go straight to PostHog, never through a proxy on our own domain, which would forward each visitor's IP address.` };
    }
    return { state: 'on', config: { key, batchUrl: `${origin}/batch/` } };
  } catch {
    return { state: 'off' };
  }
}

/** The PostHog destination, or null when analytics is off (see analyticsState). Never throws. */
export function analyticsConfig(env: AnalyticsEnv): AnalyticsConfig | null {
  const s = analyticsState(env);
  return s.state === 'on' ? s.config : null;
}

export const analyticsEnabled = (env: AnalyticsEnv): boolean => analyticsConfig(env) !== null;

/** Who an event is about: a workspace (its analytics id is looked up or made), or an analytics id already known. */
export type Subject = { workspaceId: string } | { analyticsId: string };

/** One step: what, with which properties, and when it happened (ms; stamped by capture/captureLater when absent). */
export interface Captured { event: EventName; props: Record<string, unknown>; at?: number }

/** An ISO 8601 UTC time to the whole second: `2026-11-15T12:00:07Z`. */
export const toSecond = (ms: number): string => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');

/** The JSON body of one send: what tests and the fake PostHog inspect. Times never go backwards inside one batch. */
export function batchBody(cfg: AnalyticsConfig, distinctId: string, events: { event: string; props: Record<string, string | boolean>; at?: number }[], now = Date.now()) {
  let last = -Infinity;
  return {
    api_key: cfg.key,
    batch: events.map(({ event, props, at }) => {
      last = Math.max(last, at ?? now);
      return {
        event,
        distinct_id: distinctId,
        timestamp: toSecond(last),
        properties: { ...props, surface: 'app', $process_person_profile: false, $geoip_disable: true, $lib: 'ready-set-mail-worker' },
      };
    }),
  };
}

async function post(url: string, body: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
    // Only a server-side failure is worth the one retry; a 4xx will not change.
    return res.status < 500 && res.status !== 429;
  } catch {
    dropped('post');
    return false;
  }
}

/** Send now (awaited): the background half of capture(). Never throws. */
export async function send(env: AnalyticsEnv, subject: Subject, events: readonly Captured[]): Promise<void> {
  try {
    const cfg = analyticsConfig(env);
    if (!cfg || events.length === 0) return;
    const filtered = events.flatMap(({ event, props, at }) => {
      const p = allowed(event, props);
      return p ? [{ event, props: p, at }] : [];
    });
    if (filtered.length === 0) return;
    const distinctId = 'analyticsId' in subject ? subject.analyticsId : env.DB ? await analyticsIdFor(env.DB, subject.workspaceId) : null;
    if (!distinctId) return;
    const body = JSON.stringify(batchBody(cfg, distinctId, filtered));
    if (await post(cfg.batchUrl, body)) return;
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    await post(cfg.batchUrl, body);
  } catch {
    dropped('send'); // analytics must never affect the product
  }
}

/** Run a background send under the caller's waitUntil; with no ctx (or one that cannot extend) the promise still runs. */
function extend(ctx: Pick<ExecutionContext, 'waitUntil'> | undefined, p: Promise<void>): void {
  try { ctx?.waitUntil(p); } catch { /* a context that cannot extend: the promise still runs */ }
}

/**
 * Count one or more steps for a workspace (or a known analytics id), after the response: returns at once, never throws, never
 * awaits PostHog. Each event is stamped with the time of this call (the moment it happened) unless it carries its own.
 */
export function captureMany(env: AnalyticsEnv, ctx: Pick<ExecutionContext, 'waitUntil'> | undefined, subject: Subject, events: readonly Captured[]): void {
  try {
    if (!analyticsEnabled(env) || events.length === 0) return;
    const at = Date.now();
    extend(ctx, send(env, subject, events.map((e) => ({ ...e, at: e.at ?? at }))));
  } catch {
    dropped('capture');
  }
}

export function capture<E extends EventName>(env: AnalyticsEnv, ctx: Pick<ExecutionContext, 'waitUntil'> | undefined, subject: Subject, event: E, props: PropsOf<E> = {} as PropsOf<E>): void {
  captureMany(env, ctx, subject, [{ event, props: props as Record<string, unknown> }]);
}

/** What background work decided to count: about whom, and which events (none: nothing is sent). */
export interface Batch { subject: Subject; events: readonly Captured[] }

/**
 * Background work that decides what to count (a marker to claim, a count to read, whose workspace it is) and then counts it: runs
 * only when analytics is on, inside waitUntil, with every error swallowed. `work` returns the batch, or null for nothing. Its events
 * are stamped with the time of THIS call (when the step happened), not the time the background work finishes.
 */
export function captureLater(env: AnalyticsEnv, ctx: Pick<ExecutionContext, 'waitUntil'> | undefined, work: () => Promise<Batch | null>): void {
  try {
    if (!analyticsEnabled(env)) return;
    const at = Date.now();
    extend(ctx, (async () => {
      try {
        const b = await work();
        if (b) await send(env, b.subject, b.events.map((e) => ({ ...e, at: e.at ?? at })));
      } catch {
        dropped('later');
      }
    })());
  } catch {
    dropped('later');
  }
}

/** One event, typed, for captureLater's result lists. */
export const ev = <E extends EventName>(event: E, props: PropsOf<E> = {} as PropsOf<E>): Captured => ({ event, props: props as Record<string, unknown> });
