import { vi } from 'vitest';

export interface FakeZone {
  id: string;
  cfAccountId?: string;
  cfAccountName?: string;
  /** Default 'active'. */
  status?: string;
  /** Default 'full'. */
  type?: string;
  /** What Cloudflare returns for the token on this zone (GET /zones/:id). Default: DNS edit. */
  permissions?: string[];
  /** The zone's own Cloudflare name servers (GET /zones/:id). Public DNS answers the same unless `ns` says otherwise. */
  nameServers?: string[];
}
export const CF_NS = ['a.ns.cloudflare.com', 'b.ns.cloudflare.com'];
export interface FakeRecord { id: string; type: string; name: string; content: string }

export interface FakeCall {
  method: string;
  url: string;
  /** `/zones/{id}/...` calls: the zone id; zone lookups: undefined. */
  zoneId?: string;
  body?: any;
  auth?: string | null;
}

/**
 * A small in-memory Cloudflare: zones by name, DNS records per zone. Install it with
 * `stubCloudflare(fake)`; every call is recorded in `fake.calls`.
 */
export class FakeCloudflare {
  readonly calls: FakeCall[] = [];
  readonly records = new Map<string, FakeRecord[]>();
  /** MX answers for DNS-over-HTTPS lookups: name -> `10 mx.host.` strings. */
  readonly mx: Record<string, string[]> = {};
  /** CNAME answers for DNS-over-HTTPS lookups: name -> target. */
  readonly cname: Record<string, string> = {};
  /** Worker routes per zone id, served at /zones/:id/workers/routes. */
  readonly routes: Record<string, { pattern: string; script: string }[]> = {};
  /** Email Routing rules per zone id, served (paged) at /zones/:id/email/routing/rules. */
  readonly rules: Record<string, unknown[]> = {};
  /** When set, that page of the rules list answers 500. */
  ruleFailPage?: number;
  /** When set, a request whose bearer token is not in the set is answered 401 (a revoked / expired token). */
  validTokens?: Set<string>;
  /** Cloudflare accounts the token can see (GET /accounts). */
  accounts: { id: string; name: string }[] = [];
  /** Names that are a CNAME to another name: an NS question about them is answered with the target's NS records, as a recursive resolver does. */
  nsViaCname: Record<string, string> = {};
  /** NS answers for DNS-over-HTTPS lookups: name -> hosts. A zone name not listed answers with its zone's own name servers. */
  readonly ns: Record<string, string[]> = {};
  #nextId = 1;

  constructor(
    readonly zones: Record<string, FakeZone>,
    /** Fail every request with this status (e.g. 403) before touching state. */
    public failWith?: { status: number; message: string },
    /** Fail only calls for this zone id. */
    public failZone?: { zoneId: string; status: number; message: string },
    /** TXT answers for DNS-over-HTTPS lookups: name -> records. Unknown names are NXDOMAIN. */
    public doh: Record<string, string[]> = {},
  ) {}

  /** Hostname of every DNS-over-HTTPS lookup, in order (cloudflare-dns.com, dns.google). */
  readonly dohHosts: string[] = [];

  seed(zoneId: string, rec: Omit<FakeRecord, 'id'> & { id?: string }): FakeRecord {
    const r = { id: rec.id ?? `seed-${this.#nextId++}`, ...rec };
    this.records.set(zoneId, [...(this.records.get(zoneId) ?? []), r]);
    return r;
  }

  forZone(zoneId: string): FakeCall[] {
    return this.calls.filter(c => c.zoneId === zoneId);
  }

  readonly fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    if (url.hostname === 'cloudflare-dns.com' || url.hostname === 'dns.google') {
      this.dohHosts.push(url.hostname);
      const name = url.searchParams.get('name') ?? '';
      const qtype = (url.searchParams.get('type') ?? '').toUpperCase();
      const isMx = qtype === 'MX';
      if (qtype === 'NS') {
        // Real DoH answers carry the owner name of each record. A CNAME at the queried name is followed by a recursive resolver: the NS records
        // that come back are the target's, owned by the target (`nsViaCname`).
        const target = this.nsViaCname[name];
        if (target) {
          const hosts = this.ns[target] ?? (this.zones[target] ? (this.zones[target].nameServers ?? CF_NS) : []);
          return new Response(JSON.stringify({ Status: 0, Answer: [{ name: `${name}.`, type: 5, data: `${target}.` }, ...hosts.map(h => ({ name: `${target}.`, type: 2, data: `${h}.` }))] }), { status: 200 });
        }
        const hosts = this.ns[name] ?? (this.zones[name] ? (this.zones[name].nameServers ?? CF_NS) : undefined);
        return new Response(JSON.stringify(hosts ? { Status: 0, Answer: hosts.map(h => ({ name: `${name}.`, type: 2, data: `${h}.` })) } : { Status: 3 }), { status: 200 });
      }
      const answers = qtype === 'CNAME' ? (this.cname[name] ? [this.cname[name]] : undefined) : isMx ? this.mx[name] : this.doh[name];
      const payload = answers
        ? { Status: 0, Answer: answers.map(data => (isMx ? { type: 15, data } : qtype === 'CNAME' ? { type: 5, data: `${data}.` } : { type: 16, data: `"${data}"` })) }
        : { Status: 3 };
      return new Response(JSON.stringify(payload), { status: 200 });
    }
    const m = url.pathname.match(/^\/client\/v4\/zones\/([^/]+)(\/.*)?$/);
    const call: FakeCall = { method, url: url.toString(), zoneId: m?.[1], body, auth: headers.get('authorization') };
    this.calls.push(call);

    const reply = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status });
    const ok = (result: unknown, result_info?: unknown) => reply(200, { success: true, result, ...(result_info ? { result_info } : {}) });
    // Cloudflare's list paging: 20 per page unless per_page is given (up to 50; DNS records 5000), with result_info.
    const paged = (all: unknown[], max = 50) => {
      const per = Math.max(1, Math.min(max, Number(url.searchParams.get('per_page')) || 20));
      const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
      const slice = all.slice((page - 1) * per, page * per);
      return ok(slice, { page, per_page: per, count: slice.length, total_count: all.length, total_pages: Math.max(1, Math.ceil(all.length / per)) });
    };
    const fail = (status: number, message: string) => reply(status, { success: false, errors: [{ message }] });

    const bearer = headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
    if (this.validTokens && !this.validTokens.has(bearer)) return fail(401, 'Invalid access token');
    if (url.pathname === '/client/v4/user/tokens/verify') return ok({ id: 'tok-id', status: 'active' });
    if (url.pathname === '/client/v4/accounts' && method === 'GET') return paged(this.accounts);

    if (this.failWith) return fail(this.failWith.status, this.failWith.message);
    if (this.failZone && call.zoneId === this.failZone.zoneId) return fail(this.failZone.status, this.failZone.message);

    if (url.pathname === '/client/v4/zones' && method === 'GET') {
      const name = url.searchParams.get('name');
      if (name) {
        const z = this.zones[name];
        return ok(z ? [{ id: z.id, name, account: z.cfAccountId ? { id: z.cfAccountId, name: z.cfAccountName } : undefined }] : []);
      }
      const wantStatus = url.searchParams.get('status');
      return paged(Object.entries(this.zones)
        .map(([n, z]) => ({ id: z.id, name: n, status: z.status ?? 'active', account: z.cfAccountId ? { id: z.cfAccountId, name: z.cfAccountName } : undefined }))
        .filter(z => !wantStatus || z.status === wantStatus));
    }

    if (m) {
      const zoneId = m[1];
      const rest = m[2] ?? '';
      const list = this.records.get(zoneId) ?? [];
      if (rest === '' && method === 'GET') {
        const hit = Object.entries(this.zones).find(([, z]) => z.id === zoneId);
        if (!hit) return fail(404, 'Zone not found');
        const [n, z] = hit;
        return ok({ id: z.id, name: n, status: z.status ?? 'active', type: z.type ?? 'full', name_servers: z.nameServers ?? CF_NS, account: z.cfAccountId ? { id: z.cfAccountId, name: z.cfAccountName } : undefined, permissions: z.permissions ?? ['#zone:read', '#dns_records:edit'] });
      }
      if (rest === '/workers/routes' && method === 'GET') return ok(this.routes[zoneId] ?? []);
      if (rest === '/email/routing/rules' && method === 'GET') {
        if (this.ruleFailPage && Number(url.searchParams.get('page') || 1) === this.ruleFailPage) return fail(500, 'Internal error');
        return paged(this.rules[zoneId] ?? []);
      }
      if (rest === '/dns_records' && method === 'GET') {
        const type = url.searchParams.get('type');
        const name = url.searchParams.get('name');
        const matching = list.filter(r => (!type || r.type === type) && (!name || r.name === name));
        return paged(matching, 5000);
      }
      if (rest === '/dns_records' && method === 'POST') {
        const r = { id: String(this.#nextId++).padStart(32, "0"), type: body.type, name: body.name, content: body.content };
        this.records.set(zoneId, [...list, r]);
        return ok(r);
      }
      if (rest === '/email/routing/rules' && method === 'POST') {
        const rule = { id: `rule-${this.#nextId++}`, ...body };
        this.rules[zoneId] = [...(this.rules[zoneId] ?? []), rule];
        return ok(rule);
      }
      const one = rest.match(/^\/dns_records\/([^/]+)$/);
      if (one && method === 'GET') {
        const rec = list.find(r => r.id === one[1]);
        return rec ? ok(rec) : fail(404, 'record not found');
      }
      if (one && method === 'PATCH') {
        const rec = list.find(r => r.id === one[1]);
        if (!rec) return fail(404, 'record not found');
        Object.assign(rec, body);
        return ok(rec);
      }
      if (one && method === 'DELETE') {
        if (!list.some(r => r.id === one[1])) return fail(404, 'record not found');
        this.records.set(zoneId, list.filter(r => r.id !== one[1]));
        return ok({ id: one[1] });
      }
    }
    return fail(404, `unhandled ${method} ${url.pathname}`);
  });
}

/** Route global fetch to the fake. Pair with vi.unstubAllGlobals() in afterEach. */
export function stubCloudflare(fake: FakeCloudflare): FakeCloudflare {
  vi.stubGlobal('fetch', fake.fetch);
  return fake;
}

/**
 * Wrap a sequential fetch mock so zone-by-name lookups answer "no such zone" without consuming
 * the mock's queued responses (a subdomain is checked for a zone of its own before the stored parent).
 */
export function skipZoneLookups(inner: (...a: Parameters<typeof fetch>) => Promise<Response>): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    if (url.pathname === '/client/v4/zones' && url.searchParams.has('name')) {
      return new Response(JSON.stringify({ success: true, result: [] }), { status: 200 });
    }
    return inner(input, init);
  }) as typeof fetch;
}
