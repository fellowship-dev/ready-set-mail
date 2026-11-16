// Who an analytics event is about, without saying who: a random UUID per workspace, made by the Worker (docs/analytics.md, "Identity").
//
// The id is a row in the existing settings table (key `analytics_id`; no migration), created on first need with crypto.randomUUID().
// It is never derived from anything about the account: not the email, a domain, the user id or the workspace id. Deleting the workspace
// deletes it (the settings rows cascade), and with it the only link between the workspace and its events.
//
// The id is always minted here, by the Worker: nothing a browser or a link sends can choose it or reuse it. A sign-up attempt gets one
// (src/product-analytics/auth.ts, kept server-side in the attempt's row and never sent to the browser), and the workspace that sign-up
// creates adopts it, so the steps before the workspace existed and the ones after share one distinct id.
import { forWorkspace } from '@ready-set-mail/db';

export const ANALYTICS_ID_KEY = 'analytics_id';
/** Prefix of the one-time markers ("first report already counted for domain 7"). Values are unix seconds. */
export const MARKER_PREFIX = 'analytics:';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** An id this Worker minted (crypto.randomUUID(): a lowercase version-4 UUID), or null for anything else. */
export function mintedId(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length === 36 && UUID.test(raw) ? raw : null;
}

/** The workspace's analytics id, made (random) on first need. Safe under concurrent first calls: one value wins. */
export async function analyticsIdFor(db: D1Database, workspaceId: string): Promise<string> {
  return forWorkspace(db, workspaceId).settings.setIfAbsent(ANALYTICS_ID_KEY, crypto.randomUUID());
}

/**
 * Give a new workspace the id its sign-up attempt was minted with (server-side, see auth.ts) when the workspace has none yet;
 * otherwise the workspace keeps (or gets) a random one. Returns the workspace's id.
 */
export async function adoptAnalyticsId(db: D1Database, workspaceId: string, minted: string | null): Promise<string> {
  const id = mintedId(minted);
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
