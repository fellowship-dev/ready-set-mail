// Who an analytics event is about, without saying who: a random UUID per workspace, made by the Worker (docs/analytics.md, "Identity").
//
// The id is a row in the existing settings table (key `analytics_id`; no migration), created on first need with crypto.randomUUID().
// It is never derived from anything about the account: not the email, a domain, the user id or the workspace id. Deleting the workspace
// deletes it (the settings rows cascade), and with it the only link between the workspace and its events.
//
// The website's visitor id: a link from readysetmail.com into the sign-up page may carry `vid=<the page's random UUID>` (the website's
// in-memory id, ready-set-mail-website lib/posthog.ts), so the website's steps and the app's join up in one funnel. It is accepted only
// (1) on a hosted sign-up, (2) as a canonical lowercase UUID and nothing else, (3) for the workspace that sign-up creates, before that
// workspace has an id, and (4) only while analytics is on. Anything else gets a fresh random id. The dashboard reads it from the link
// and sends it with the sign-up form, nothing more: no cookie or browser storage is used for analytics.
import { forWorkspace } from '@ready-set-mail/db';

export const ANALYTICS_ID_KEY = 'analytics_id';
/** Prefix of the one-time markers ("first report already counted for domain 7"). Values are unix seconds. */
export const MARKER_PREFIX = 'analytics:';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A website visitor id in the only form accepted: a canonical, lowercase RFC 9562 UUID. */
export function visitorId(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length === 36 && UUID.test(raw) ? raw : null;
}

/** The workspace's analytics id, made (random) on first need. Safe under concurrent first calls: one value wins. */
export async function analyticsIdFor(db: D1Database, workspaceId: string): Promise<string> {
  return forWorkspace(db, workspaceId).settings.setIfAbsent(ANALYTICS_ID_KEY, crypto.randomUUID());
}

/**
 * Give a new workspace the id its sign-up carried (the website visitor id, or the random id the sign-up attempt was given) when it is
 * well-formed and the workspace has none yet; otherwise the workspace keeps (or gets) a random one. Returns the workspace's id.
 *
 * Not checked: whether another workspace already uses the same visitor id (that would be a query across workspaces). Someone who
 * replays one visitor id on several sign-ups only merges those workspaces' analytics; nothing else is keyed by the id.
 */
export async function adoptAnalyticsId(db: D1Database, workspaceId: string, candidate: string | null): Promise<string> {
  const id = visitorId(candidate);
  return id ? forWorkspace(db, workspaceId).settings.setIfAbsent(ANALYTICS_ID_KEY, id) : analyticsIdFor(db, workspaceId);
}

/** Claim a one-time marker for this workspace (value: unix seconds). True only for the call that stored it. */
export function claimMarker(db: D1Database, workspaceId: string, name: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<boolean> {
  return forWorkspace(db, workspaceId).settings.claim(`${MARKER_PREFIX}${name}`, String(nowSeconds));
}

/** When a marker was claimed (unix seconds), or null. */
export async function markerAt(db: D1Database, workspaceId: string, name: string): Promise<number | null> {
  const v = (await forWorkspace(db, workspaceId).settings.get(`${MARKER_PREFIX}${name}`))?.value;
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Set (or move) a marker's time: used for "last applied", which a later Apply moves forward. */
export function setMarker(db: D1Database, workspaceId: string, name: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<unknown> {
  return forWorkspace(db, workspaceId).settings.set(`${MARKER_PREFIX}${name}`, String(nowSeconds));
}

/** How many markers with this name prefix the workspace holds (e.g. `live:` = domains whose records went live). */
export async function markerCount(db: D1Database, workspaceId: string, namePrefix: string): Promise<number> {
  const prefix = `${MARKER_PREFIX}${namePrefix}`;
  const row = await db.prepare('SELECT COUNT(*) AS n FROM settings WHERE workspace_id = ?1 AND substr(key, 1, ?2) = ?3').bind(workspaceId, prefix.length, prefix).first<{ n: number }>();
  return row?.n ?? 0;
}
