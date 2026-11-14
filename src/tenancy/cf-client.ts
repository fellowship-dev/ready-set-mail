// The only place the Worker talks to api.cloudflare.com.
//
// One CfClient is bound to one API token. It resolves the zone of each domain on
// demand (by the domain's registrable name) and remembers the answers for its own
// lifetime, which is one request or one cron workspace. Nothing is cached at module
// level, so two tenants in one isolate can never see each other's zones.
//
// The token lives in a private field: it never appears in errors, logs, JSON or
// util.inspect output.

import { assertDnsWriteAllowed, type DnsWrite } from '../dns/write-policy';
import type { Mode } from './mode';

const CF_API = 'https://api.cloudflare.com/client/v4';

/**
 * Testing only: CLOUDFLARE_API_BASE_URL points the client at a local fake Cloudflare (e2e/support/fake-cloudflare.mjs).
 * It is honoured ONLY for `http://127.0.0.1:<port>` or `http://localhost:<port>` (strict parse: no userinfo, path,
 * query or fragment), so a stray or malicious value can never send a real token to a remote host. Anything else is
 * ignored and the real Cloudflare API is used.
 */
export function cfApiBase(override?: string | null): string {
  if (!override) return CF_API;
  const raw = override.trim();
  if (!/^http:\/\/(127\.0\.0\.1|localhost):[0-9]{1,5}\/?$/.test(raw)) return CF_API;
  try {
    const u = new URL(raw);
    if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && Number(u.port) > 0) return `http://${u.hostname}:${u.port}/client/v4`;
  } catch { /* not a URL: ignored */ }
  return CF_API;
}

export interface CfErrorDetail { code?: number; message: string }

/** Base class for every failure talking to Cloudflare. */
export class CfError extends Error {
  constructor(
    message: string,
    readonly method: string,
    readonly path: string,
    readonly status?: number,
    readonly details: CfErrorDetail[] = [],
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** The request never produced a response (DNS, TLS, timeout). */
export class CfNetworkError extends CfError {}
/** 401 / 403: the token is invalid, expired, or lacks the permission. */
export class CfAuthError extends CfError {}
/** 404 from Cloudflare. */
export class CfNotFoundError extends CfError {}
/** Any other non-success answer. */
export class CfApiError extends CfError {}
/** No API token is available for this tenant. */
export class CfNotConfiguredError extends Error {
  /** Stable code for clients: the workspace has to connect Cloudflare (a token or OAuth) first. */
  readonly code = 'cloudflare_not_connected';
  constructor(message = 'Cloudflare is not configured for this workspace: connect Cloudflare first') {
    super(message);
    this.name = 'CfNotConfiguredError';
  }
}
/** The connection's owner did not allow Ready Set Mail to manage this zone (or Cloudflare account). */
export class CfZoneNotAllowedError extends Error {
  /**
   * kind 'shadow': `domain` falls inside `zone`, a child zone of an allowed zone that is not on the list. Writing it
   * to the allowed parent would be shadowed by the delegation (it would "succeed" and do nothing), so it is refused.
   */
  constructor(readonly zone: string, readonly connectionId?: string, readonly kind: 'zone' | 'account' | 'shadow' = 'zone', readonly domain?: string) {
    super(kind === 'shadow'
      ? `${domain ?? 'this name'} belongs to zone ${zone}, which isn't on this Cloudflare connection's allow-list (writing it to the parent zone would have no effect): allow ${zone} too`
      : kind === 'zone'
        ? `Zone ${zone} is not in this Cloudflare connection's allow-list`
        : `Cloudflare account ${zone} is not the one this connection belongs to`);
    this.name = 'CfZoneNotAllowedError';
  }
}
/** A DNS write (or other write) that is not one Ready Set Mail makes: wrong type, name, content, path or method. Refused before sending. */
export class CfRecordNotAllowedError extends Error {
  readonly code = 'cf_record_not_allowed';
  constructor(readonly reason: string, readonly request?: { method?: string; type?: string; name?: string; path?: string }) {
    super(`Refused Cloudflare write: ${reason}`);
    this.name = 'CfRecordNotAllowedError';
  }
}
/** None of the domain's candidate zones exists on the token's Cloudflare account. */
export class CfZoneNotFoundError extends Error {
  constructor(readonly domain: string) {
    super(`No Cloudflare zone found for ${domain}`);
    this.name = 'CfZoneNotFoundError';
  }
}

/** The domain's Cloudflare connection cannot be used: it needs reconnecting (`broken`), was disconnected (`revoked`), or is gone (`missing`). */
export class CfConnectionError extends Error {
  constructor(
    readonly code: 'broken' | 'revoked' | 'missing',
    readonly connectionId: string,
    readonly label?: string,
  ) {
    super(code === 'missing'
      ? 'Cloudflare connection not found'
      : `Cloudflare connection "${label ?? connectionId}" is ${code}: ${code === 'broken' ? 'reconnect it' : 'it was disconnected'}`);
    this.name = 'CfConnectionError';
  }
}

export interface CfZone { id: string; name: string; cfAccountId?: string }

export interface CfDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl?: number;
  priority?: number;
  proxied?: boolean;
}

export type CfDnsRecordInput = {
  type: string;
  name: string;
  content: string;
  ttl?: number;
  priority?: number;
  proxied?: boolean;
  comment?: string;
};

/**
 * What a client may touch. A client built for a stored connection carries the owner's allow-list: it
 * refuses (before any request leaves the Worker) everything under a zone that is not on the list,
 * whatever the token itself could do.
 */
export interface CfPolicy {
  /** Throws to refuse `method path` (the path as passed to request(), without the API prefix, and its query). */
  request(method: string, path: string, query?: CfRequestOptions['query']): void;
  /** May zoneFor() ask Cloudflare whether this zone name exists? (False: it is skipped, nothing is sent.) */
  lookup(zoneName: string): boolean;
  /** Throws to refuse a name that falls inside a known child zone that is not allowed. */
  blocked(name: string): void;
  /** The name of an allowed zone id, so DNS writes can be required to stay inside it. */
  zoneName?(zoneId: string): string | undefined;
  /** Throws to refuse a zone that zoneFor() found for `domain`. */
  zone(zone: CfZone, domain: string): void;
}

export interface CfClientOptions {
  fetch?: typeof fetch;
  policy?: CfPolicy;
  /** Deployment mode, for the DNS write policy (self-host-only record types). Default 'selfhost'. */
  mode?: Mode;
  /** Replaces the default DNS write policy (the hosted-records writer has its own, narrower one). */
  dnsWritePolicy?: (w: Pick<DnsWrite, 'method' | 'zoneName' | 'type' | 'name' | 'content' | 'patchKeys'>) => void;
  /**
   * Called once when Cloudflare answers 401 to the current token; returns a fresh token to retry the
   * request with, or null. (OAuth access tokens: refresh once, then retry.)
   */
  onUnauthorized?: () => Promise<string | null>;
  /** The CLOUDFLARE_API_BASE_URL env value; see cfApiBase (localhost only, otherwise ignored). */
  apiBaseUrl?: string | null;
}

export interface CfRequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Context the caller vouches for, for the DNS write policy (MTA-STS CNAME target, SPF apex names). */
  dns?: DnsWriteContext;
}

/** What a DNS record must be for a delete to go ahead; the record stored under the id is read first and must match. */
export interface DnsDeleteExpect {
  type: string;
  name: string;
  /** When known: the content it must have (a string compares ignoring quotes, case and a trailing dot; a RegExp is tested on the raw content). */
  content?: string | RegExp;
}

export interface DnsWriteContext {
  cnameTargets?: string[];
  allowedApexes?: string[];
  /** DELETE only: the record being removed. The write policy decides on this, so a delete is as constrained as a create. */
  expect?: DnsDeleteExpect;
}

/** Cloudflare's paging block of a list answer. */
export interface CfResultInfo { page?: number; per_page?: number; count?: number; total_count?: number; total_pages?: number }

interface CfEnvelope<T> { success?: boolean; result?: T; errors?: CfErrorDetail[]; result_info?: CfResultInfo }

/** A list that could not be read completely: an error, a missing or inconsistent page, or more pages than the cap. */
export class CfIncompleteListError extends Error {
  constructor(readonly path: string, readonly why: string) {
    super(`Cloudflare list ${path} could not be read completely: ${why}`);
    this.name = 'CfIncompleteListError';
  }
}

export const LIST_PER_PAGE = 50;
export const LIST_MAX_PAGES = 20;
export const LIST_MAX_ITEMS = 1000;

/**
 * Reads every page of a list through `getPage`, trusting only what `result_info` proves: each page must be the page asked
 * for and hold exactly the rows its place in `total_count` implies, the total must not change, and the whole must fit
 * the caps. Anything else throws CfIncompleteListError, so a caller never decides on a partial list.
 */
export async function readAllPages<T>(
  path: string,
  getPage: (page: number, perPage: number) => Promise<{ result: T[] | null | undefined; info?: CfResultInfo }>,
  caps: { perPage?: number; maxPages?: number; maxItems?: number } = {},
): Promise<T[]> {
  const perPage = caps.perPage ?? LIST_PER_PAGE;
  const maxPages = caps.maxPages ?? LIST_MAX_PAGES;
  const maxItems = caps.maxItems ?? LIST_MAX_ITEMS;
  const bad = (why: string) => new CfIncompleteListError(path, why);
  const out: T[] = [];
  let total: number | null = null;
  let size = perPage;
  for (let page = 1; ; page++) {
    if (page > maxPages) throw bad(`more than ${maxPages} pages`);
    const { result, info } = await getPage(page, perPage);
    if (!Array.isArray(result)) throw bad(`page ${page} has no list`);
    if (!info || !Number.isInteger(info.total_count) || (info.total_count as number) < 0) throw bad(`page ${page} has no total count`);
    if (info.page !== page) throw bad(`asked for page ${page}, got ${info.page ?? 'none'}`);
    const t = info.total_count as number;
    if (total !== null && t !== total) throw bad('the total changed while reading');
    if (page === 1) {
      if (!Number.isInteger(info.per_page) || (info.per_page as number) < 1 || (info.per_page as number) > perPage) throw bad('implausible page size');
      size = info.per_page as number;
      total = t;
      if (t > maxItems || Math.ceil(t / size) > maxPages) throw bad(`${t} entries is more than ${maxItems} entries or ${maxPages} pages`);
    } else if (info.per_page !== size) throw bad('the page size changed while reading');
    const expected = Math.min(size, (total as number) - (page - 1) * size);
    if (result.length !== expected) throw bad(`page ${page} has ${result.length} entries, expected ${expected}`);
    out.push(...result);
    if (out.length >= (total as number)) return out;
  }
}

/**
 * Candidate zone names for a domain, longest first, never below two labels:
 * `a.b.acme.com` -> `a.b.acme.com`, `b.acme.com`, `acme.com`. Zones can nest
 * (`example.com` and a delegated `sub.example.com`), and the most specific zone is the one
 * that serves the name, so the longest candidate that exists on the account wins. Names
 * Cloudflare doesn't know (`co.uk`, `b.acme.com` when it isn't a zone) simply don't match.
 */
export function zoneCandidates(domain: string): string[] {
  const labels = domain.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join('.'));
  return out;
}

/** Dot segments, encoded separators and backslashes never belong in an API path built from ids. */
function assertSafePath(path: string): void {
  const p = path.split('?')[0];
  if (p.split('/').some(seg => seg === '.' || seg === '..') || /%|\\|\/\//.test(p)) {
    throw new CfApiError('Cloudflare request refused: unsafe path', 'REQUEST', '[invalid]');
  }
}

export class CfClient {
  #token: string | (() => Promise<string>);
  readonly #fetch: typeof fetch;
  readonly #policy?: CfPolicy;
  readonly #onUnauthorized?: () => Promise<string | null>;
  readonly #zones = new Map<string, Promise<CfZone | null>>();
  readonly #zoneNames = new Map<string, string>();
  readonly #mode: Mode;
  readonly #base: string;
  readonly #dnsWritePolicy?: CfClientOptions['dnsWritePolicy'];

  /** `token` may be a function, called for every request (so an expiring token is refreshed lazily). */
  constructor(token: string | (() => Promise<string>), opts: CfClientOptions = {}) {
    if (!token) throw new CfNotConfiguredError();
    this.#token = token;
    this.#policy = opts.policy;
    this.#onUnauthorized = opts.onUnauthorized;
    this.#mode = opts.mode ?? 'selfhost';
    this.#base = cfApiBase(opts.apiBaseUrl);
    this.#dnsWritePolicy = opts.dnsWritePolicy;
    // Looked up per call (not captured) so stubbing globalThis.fetch in tests works.
    this.#fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  toJSON(): { redacted: true } { return { redacted: true }; }
  [Symbol.for('nodejs.util.inspect.custom')](): string { return 'CfClient { token: [redacted] }'; }

  // ── Raw requests ────────────────────────────────────────────

  /**
   * Call the API and return `result`. Throws a typed CfError on network failure,
   * auth failure, 404 or any `success: false`. A body without a `success` field
   * counts as success when the HTTP status is ok.
   */
  async request<T = unknown>(method: string, path: string, opts: CfRequestOptions = {}): Promise<T> {
    assertSafePath(path);
    this.#policy?.request(method.toUpperCase(), path, opts.query);
    this.#checkDnsWrite(method.toUpperCase(), path, opts.body, opts.dns);
    return (await this.#send<T>(method, path, opts, false)).result as T;
  }

  /** Like request(), with the answer's paging block. */
  async requestPage<T = unknown>(method: string, path: string, opts: CfRequestOptions = {}): Promise<{ result: T; info?: CfResultInfo }> {
    assertSafePath(path);
    this.#policy?.request(method.toUpperCase(), path, opts.query);
    this.#checkDnsWrite(method.toUpperCase(), path, opts.body, opts.dns);
    return this.#send<T>(method, path, opts, false);
  }

  /** Every entry of a list, 50 per page, following result_info; throws CfIncompleteListError rather than return part of it. */
  listAll<T>(path: string, query: CfRequestOptions['query'] = {}): Promise<T[]> {
    return readAllPages<T>(path, (page, perPage) => this.requestPage<T[]>('GET', path, { query: { ...query, per_page: perPage, page } }));
  }

  /** Every non-GET request touching dns_records passes the write policy here, the one choke point. */
  #checkDnsWrite(method: string, path: string, body: unknown, ctx?: DnsWriteContext): void {
    if (method === 'GET' || method === 'HEAD') return;
    const p = path.split('?')[0];
    if (!p.includes('/dns_records')) return;
    const m = p.match(/^\/zones\/([^/]+)\/dns_records(?:\/([A-Za-z0-9_-]+))?$/);
    if (!m) throw new CfRecordNotAllowedError('unrecognised DNS records path', { method, path: p });
    const [, zoneId, recordId] = m;
    if (method === 'POST' ? recordId !== undefined : recordId === undefined) {
      throw new CfRecordNotAllowedError(`${method} on this DNS records path is not allowed`, { method, path: p });
    }
    const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    const w = {
      method,
      zoneName: this.#zoneNames.get(zoneId) ?? this.#policy?.zoneName?.(zoneId),
      type: method === 'DELETE' ? ctx?.expect?.type : (b.type as string | undefined),
      name: method === 'DELETE' ? ctx?.expect?.name : (b.name as string | undefined),
      content: b.content as string | undefined,
      patchKeys: Object.keys(b),
      cnameTargets: ctx?.cnameTargets,
      allowedApexes: ctx?.allowedApexes,
    };
    if (this.#dnsWritePolicy) this.#dnsWritePolicy(w);
    else assertDnsWriteAllowed({ ...w, mode: this.#mode });
  }

  async #send<T>(method: string, path: string, opts: CfRequestOptions, retried: boolean): Promise<{ result: T; info?: CfResultInfo }> {
    const url = new URL(this.#base + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const shown = url.pathname.slice(new URL(this.#base).pathname.length) + url.search;

    // Resolved first: a token that cannot be produced (broken connection) is its own error, not a network failure.
    const bearer = await this.#bearer();
    let res: Response;
    try {
      res = await this.#fetch(url.toString(), {
        method,
        headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
    } catch (e) {
      throw new CfNetworkError(`Cloudflare ${method} ${shown} failed: ${e instanceof Error ? e.name : 'network error'}`, method, shown);
    }

    let data: CfEnvelope<T> = {};
    try { data = await res.json() as CfEnvelope<T>; } catch { /* non-JSON body */ }

    if (res.ok && data.success !== false) return { result: data.result as T, info: data.result_info };

    const details = data.errors ?? [];
    const reason = details.map(e => e.message).join(', ') || `HTTP ${res.status}`;
    const message = `Cloudflare ${method} ${shown}: ${reason}`;
    if (res.status === 401 && !retried && this.#onUnauthorized) {
      const fresh = await this.#onUnauthorized();
      if (fresh) {
        this.#token = fresh;
        return this.#send<T>(method, path, opts, true);
      }
    }
    if (res.status === 401 || res.status === 403) throw new CfAuthError(message, method, shown, res.status, details);
    if (res.status === 404) throw new CfNotFoundError(message, method, shown, res.status, details);
    throw new CfApiError(message, method, shown, res.status, details);
  }

  async #bearer(): Promise<string> {
    return typeof this.#token === 'function' ? this.#token() : this.#token;
  }

  // ── Zones ───────────────────────────────────────────────────

  /**
   * Pre-load a zone we already know (e.g. from stored settings). It answers for its own name; a
   * longer candidate (a nested zone) is still looked up first, so the seed never shadows it.
   */
  seedZone(zone: CfZone): void {
    this.#zones.set(zone.name.toLowerCase(), Promise.resolve(zone));
    this.#zoneNames.set(zone.id, zone.name.toLowerCase());
  }

  /** The zone a domain lives in. Throws CfZoneNotFoundError when the account has none. */
  async zoneFor(domain: string): Promise<CfZone> {
    let skipped = false;
    for (const name of zoneCandidates(domain)) {
      // A name inside a known, non-allowed child zone must not fall through to the parent.
      this.#policy?.blocked(name);
      // A restricted client asks only about allowed zones and about names below them (a child zone created
      // since the list was saved is found here, and refused by zone() below).
      if (this.#policy && !this.#policy.lookup(name)) { skipped = true; continue; }
      const zone = await this.#lookupZone(name);
      if (zone) {
        this.#policy?.zone(zone, domain);
        return zone;
      }
    }
    // Nothing allowed matched, and names were skipped: say "not allowed", not "does not exist".
    if (skipped) throw new CfZoneNotAllowedError(domain);
    throw new CfZoneNotFoundError(domain);
  }

  #lookupZone(name: string): Promise<CfZone | null> {
    let hit = this.#zones.get(name);
    if (!hit) {
      hit = this.request<{ id: string; name: string; account?: { id: string } }[]>('GET', '/zones', { query: { name } })
        .then(list => {
          const z = list?.[0];
          if (z) this.#zoneNames.set(z.id, z.name.toLowerCase());
          return z ? { id: z.id, name: z.name.toLowerCase(), cfAccountId: z.account?.id } : null;
        });
      this.#zones.set(name, hit);
      // A failed lookup must not stay cached: the next caller retries.
      hit.catch(() => { if (this.#zones.get(name) === hit) this.#zones.delete(name); });
    }
    return hit;
  }

  getZone(zoneId: string): Promise<{ id: string; name: string; status?: string; type?: string; name_servers?: string[]; account?: { id: string } }> {
    return this.request('GET', `/zones/${zoneId}`);
  }

  /** Every active zone the token can see (50 a page, following result_info; an unreadable or oversized list throws rather than return part of it). */
  listZones(): Promise<{ id: string; name: string; status: string; account?: { id: string } }[]> {
    return readAllPages<{ id: string; name: string; status: string; account?: { id: string } }>(
      '/zones',
      (page, perPage) => this.requestPage('GET', '/zones', { query: { per_page: perPage, page, status: 'active' } }),
      { maxPages: 100, maxItems: 5000 },
    );
  }

  // ── DNS records ─────────────────────────────────────────────

  /**
   * Every record matching the filters (all pages; CfIncompleteListError when the list cannot be read in full).
   * `per_page` is the older single-page read: one page of that size, for callers that only look at a name's first records.
   */
  listDnsRecords(zoneId: string, query: { type?: string; name?: string; per_page?: number }): Promise<CfDnsRecord[]> {
    if (query.per_page !== undefined) return this.request<CfDnsRecord[]>('GET', `/zones/${zoneId}/dns_records`, { query }).then(r => r ?? []);
    return this.listAll<CfDnsRecord>(`/zones/${zoneId}/dns_records`, query);
  }

  createDnsRecord(zoneId: string, record: CfDnsRecordInput, dns?: DnsWriteContext): Promise<CfDnsRecord> {
    return this.request('POST', `/zones/${zoneId}/dns_records`, { body: record, dns });
  }

  patchDnsRecord(zoneId: string, recordId: string, patch: Partial<CfDnsRecordInput>, dns?: DnsWriteContext): Promise<CfDnsRecord> {
    return this.request('PATCH', `/zones/${zoneId}/dns_records/${recordId}`, { body: patch, dns });
  }

  /**
   * Idempotent: a record that is already gone is not an error. Returns whether something was deleted.
   * The write policy judges the type and name the caller claims, so the record stored under `recordId` is read first and
   * must be that record (type, name and, when given, content); otherwise nothing is deleted.
   */
  async deleteDnsRecord(zoneId: string, recordId: string, expect: DnsDeleteExpect): Promise<boolean> {
    const path = `/zones/${zoneId}/dns_records/${recordId}`;
    // Refused before any request leaves the Worker (zone, id shape, managed type and name).
    assertSafePath(path);
    this.#policy?.request('DELETE', path);
    this.#checkDnsWrite('DELETE', path, undefined, { expect });
    try {
      const stored = await this.request<Pick<CfDnsRecord, 'type' | 'name' | 'content'>>('GET', path);
      const norm = (v: string) => String(v ?? '').trim().replace(/^"|"$/g, '').toLowerCase().replace(/\.$/, '');
      const same = norm(stored?.type) === norm(expect.type) && norm(stored?.name) === norm(expect.name)
        && (expect.content === undefined || (typeof expect.content === 'string' ? norm(stored?.content) === norm(expect.content) : expect.content.test(String(stored?.content ?? ''))));
      if (!same) throw new CfRecordNotAllowedError(`the record ${recordId} is not the ${expect.type} record ${expect.name} that was meant to be removed`, { method: 'DELETE', type: stored?.type, name: stored?.name, path });
      await this.request('DELETE', path, { dns: { expect } });
      return true;
    } catch (e) {
      if (!(e instanceof CfNotFoundError)) throw e;
      return false;
    }
  }

  // ── Cloudflare-account-level ───────────────────────────────────────────

  /** API tokens only: is this token valid (`status: active`)? */
  verifyToken(): Promise<{ id?: string; status: string; expires_on?: string }> {
    return this.request('GET', '/user/tokens/verify');
  }

  /** Cloudflare accounts the token can see. */
  listAccounts(): Promise<{ id: string; name: string }[]> {
    return this.listAll<{ id: string; name: string }>('/accounts');
  }

  workersSubdomain(cfAccountId: string): Promise<{ subdomain: string } | null> {
    return this.request('GET', `/accounts/${cfAccountId}/workers/subdomain`);
  }
}

/** Cloudflare's own message(s) for a failure, without the request line: what a user should read. */
export function cfErrorText(e: unknown): string {
  if (e instanceof CfError) return e.details.map(d => d.message).join(', ') || (e.status ? `HTTP ${e.status}` : e.message);
  return e instanceof Error ? e.message : String(e);
}
