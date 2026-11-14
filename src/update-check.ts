// Update check: has a newer PUBLISHED release of Ready Set Mail come out than the version this installation runs?
// Used by GET /api/version (the dashboard's "New version available" notice and the Settings page) and by the weekly digest.
//
// Source: the latest published GitHub release of fellowship-dev/ready-set-mail, never the main branch. First the
// releases API (`/repos/<repo>/releases/latest`, which already skips drafts and pre-releases); when that answers
// 403 or 429 (GitHub's unauthenticated rate limit), the `github.com/<repo>/releases/latest` redirect instead. Each is
// a plain unauthenticated GET with a fixed User-Agent: no token, no cookie, no instance identifier, not even the
// running version. Tags are compared as semantic versions (newer / same / older); a pre-release or a tag that is not
// a version is ignored.
//
// Cached so page views and per-workspace digests never each make a call: in memory per isolate and, when the
// installation has its OAUTH_KV namespace, in KV under `update-check:v1` (6 hours after an answer, 1 hour after a
// failure). Each request times out after 5 seconds. Failing quiet: when GitHub cannot be reached the status is
// "unknown" (shown as "could not check"), never "same".
//
// Off: UPDATE_CHECK=off (or 0, false, no) makes no outbound call at all; MODE=saas (the hosted service) is always off,
// because its customers do not upgrade it.

import { PRODUCT_VERSION } from './version';
import { getMode } from './tenancy/mode';

export const RELEASE_REPO = 'fellowship-dev/ready-set-mail';
export const RELEASES_API_URL = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;
export const RELEASES_LATEST_URL = `https://github.com/${RELEASE_REPO}/releases/latest`;
export const UPDATE_CHECK_KV_KEY = 'update-check:v1';
export const ANSWER_TTL_S = 6 * 3600;
export const FAILURE_TTL_S = 3600;
const TIMEOUT_MS = 5000;
const USER_AGENT = 'ready-set-mail-update-check';

/** newer: a newer release than the running version is published. older: the running version is ahead of the latest release. */
export type UpdateStatus = 'newer' | 'same' | 'older' | 'unknown' | 'off';

export interface UpdateInfo {
  current: string;
  /** The latest published release's version (no "v"), or null when unknown or off. */
  latest: string | null;
  status: UpdateStatus;
  update_available: boolean;
  /** That release's notes when known, else the releases/latest page. */
  release_url: string;
  /** How to upgrade (packages/db/UPGRADING.md), at that release's tag when known. */
  upgrade_url: string;
  /** When GitHub was asked (unix seconds), or null. */
  checked_at: number | null;
}

export interface UpdateCheckEnv {
  MODE?: string;
  UPDATE_CHECK?: string;
  OAUTH_KV?: KVNamespace;
}

// ── Semantic versions ─────────────────────────────────────────

export interface SemVer { major: number; minor: number; patch: number; pre: string[] }

const NUM = '(0|[1-9]\\d*)';
const PRE_ID = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const SEMVER = new RegExp(`^v?${NUM}\\.${NUM}\\.${NUM}(?:-(${PRE_ID}(?:\\.${PRE_ID})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);

/** Parses "1.2.3", "v1.2.3", "1.2.3-rc.1+build"; null for anything else. */
export function parseSemver(input: string): SemVer | null {
  if (typeof input !== 'string' || input.length > 64) return null;
  const m = SEMVER.exec(input.trim());
  if (!m) return null;
  const [major, minor, patch] = [m[1], m[2], m[3]].map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return { major, minor, patch, pre: m[4] ? m[4].split('.') : [] };
}

/** Semantic-version precedence: -1 when a < b, 0 when equal (build metadata ignored), 1 when a > b. */
export function compareSemver(a: SemVer, b: SemVer): -1 | 0 | 1 {
  for (const k of ['major', 'minor', 'patch'] as const) {
    if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  }
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

// ── The check ────────────────────────────────────────────────

/** release: a usable release tag was found. unusable: GitHub answered, but with no release, a pre-release or a tag that is not a version. failed: no answer. */
interface Checked { outcome: 'release' | 'unusable' | 'failed'; tag: string | null; checked_at: number }

let memo: Checked | null = null;
let inflight: Promise<Checked> | null = null;

/** Tests only. */
export function resetUpdateCheckCache(): void {
  memo = null;
  inflight = null;
}

export function updateCheckEnabled(env: UpdateCheckEnv): boolean {
  if (getMode(env) === 'saas') return false;
  return !['off', '0', 'false', 'no'].includes((env.UPDATE_CHECK ?? '').trim().toLowerCase());
}

const ttl = (c: Checked) => (c.outcome === 'failed' ? FAILURE_TTL_S : ANSWER_TTL_S);
const fresh = (c: Checked | null, nowS: number): c is Checked => !!c && nowS - c.checked_at >= 0 && nowS - c.checked_at < ttl(c);

/** A release tag we accept: a version without a pre-release part. */
function releaseTag(tag: unknown): string | null {
  if (typeof tag !== 'string') return null;
  const v = parseSemver(tag);
  return v && v.pre.length === 0 ? tag.trim() : null;
}

function parseChecked(raw: string | null): Checked | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as Checked;
    if (!['release', 'unusable', 'failed'].includes(c.outcome) || typeof c.checked_at !== 'number') return null;
    if (c.outcome === 'release' && !releaseTag(c.tag)) return null;
    return { outcome: c.outcome, tag: c.outcome === 'release' ? c.tag : null, checked_at: c.checked_at };
  } catch {
    return null;
  }
}

async function askGitHub(fetcher: typeof fetch, nowS: number): Promise<Checked> {
  const headers = { 'User-Agent': USER_AGENT };
  const done = (outcome: Checked['outcome'], tag: string | null = null): Checked => ({ outcome, tag, checked_at: nowS });
  let rateLimited = false;
  try {
    const res = await fetcher(RELEASES_API_URL, {
      headers: { ...headers, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 200) {
      const body = await res.json().catch(() => null) as { tag_name?: unknown; draft?: unknown; prerelease?: unknown } | null;
      if (!body || typeof body !== 'object') return done('failed');
      const tag = body.draft === true || body.prerelease === true ? null : releaseTag(body.tag_name);
      return tag ? done('release', tag) : done('unusable');
    }
    if (res.status === 404) return done('unusable'); // no published release
    if (res.status !== 403 && res.status !== 429) return done('failed');
    rateLimited = true;
  } catch {
    return done('failed');
  }
  if (!rateLimited) return done('failed');
  // Rate-limited API: the releases/latest page redirects to /releases/tag/<tag> (or to /releases when there is none).
  try {
    const res = await fetcher(RELEASES_LATEST_URL, { headers, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!location) return done('failed');
    const path = new URL(location, RELEASES_LATEST_URL).pathname;
    const m = /\/releases\/tag\/([^/]+)$/.exec(path);
    if (m) {
      let tag: string | null = null;
      try { tag = releaseTag(decodeURIComponent(m[1])); } catch { tag = null; }
      return tag ? done('release', tag) : done('unusable');
    }
    return /\/releases\/?$/.test(path) ? done('unusable') : done('failed');
  } catch {
    return done('failed');
  }
}

async function latestRelease(env: UpdateCheckEnv, fetcher: typeof fetch, nowS: number): Promise<Checked> {
  if (fresh(memo, nowS)) return memo;
  const kv = env.OAUTH_KV;
  if (kv) {
    let stored: Checked | null = null;
    try { stored = parseChecked(await kv.get(UPDATE_CHECK_KV_KEY)); } catch { stored = null; }
    if (fresh(stored, nowS)) return (memo = stored);
  }
  if (!inflight) {
    inflight = (async () => {
      const checked = await askGitHub(fetcher, nowS);
      memo = checked;
      if (kv) {
        try { await kv.put(UPDATE_CHECK_KV_KEY, JSON.stringify(checked), { expirationTtl: ttl(checked) }); } catch { /* cache only */ }
      }
      return checked;
    })().finally(() => { inflight = null; });
  }
  return inflight;
}

export function updateInfo(current: string, checked: Checked | null, enabled: boolean): UpdateInfo {
  const tag = enabled && checked?.outcome === 'release' ? checked.tag : null;
  const latest = tag ? tag.replace(/^v/, '') : null;
  let status: UpdateStatus = enabled ? 'unknown' : 'off';
  const cur = parseSemver(current);
  const rel = latest ? parseSemver(latest) : null;
  if (enabled && cur && rel) {
    const order = compareSemver(cur, rel);
    status = order < 0 ? 'newer' : order === 0 ? 'same' : 'older';
  }
  // Without a known release the upgrade link can only point at the current guide on main (a link, not a version source).
  const ref = tag ? encodeURIComponent(tag) : 'main';
  return {
    current,
    latest,
    status,
    update_available: status === 'newer',
    release_url: tag ? `https://github.com/${RELEASE_REPO}/releases/tag/${encodeURIComponent(tag)}` : RELEASES_LATEST_URL,
    upgrade_url: `https://github.com/${RELEASE_REPO}/blob/${ref}/packages/db/UPGRADING.md`,
    checked_at: enabled ? checked?.checked_at ?? null : null,
  };
}

/** The running version against the latest published release. Never throws. */
export async function checkForUpdate(
  env: UpdateCheckEnv,
  opts: { fetch?: typeof fetch; now?: number; current?: string } = {},
): Promise<UpdateInfo> {
  const current = opts.current ?? PRODUCT_VERSION;
  if (!updateCheckEnabled(env)) return updateInfo(current, null, false);
  const nowS = Math.floor((opts.now ?? Date.now()) / 1000);
  try {
    return updateInfo(current, await latestRelease(env, opts.fetch ?? ((input, init) => fetch(input, init)), nowS), true);
  } catch {
    return updateInfo(current, null, true);
  }
}
