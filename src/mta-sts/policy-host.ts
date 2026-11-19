// The policy host: how `mta-sts.<customer domain>` reaches this Worker with a certificate a sender trusts (RFC 8461 section 3.3).
//
// Two ways, one seam (`strategyFor`):
//   worker_route   a PROXIED CNAME `mta-sts.<d>` → a target in the same Cloudflare account as the Worker; Universal SSL covers `mta-sts.<d>`.
//                  Self-host: the target is the Worker's own host (getWorkerRoute). The operator's own zone apex on the hosted service:
//                  the target is POLICY_HOST_TARGET.
//   saas_hostname  every other hosted domain: a DNS-ONLY CNAME `mta-sts.<d>` → POLICY_HOST_TARGET in the customer's zone, plus, in the
//                  operator's zone, a Cloudflare for SaaS custom hostname `mta-sts.<d>` (HTTP validation, TLS 1.2 minimum). A custom hostname is
//                  NEVER created inside POLICY_HOST_ZONE (Cloudflare refuses a name that matches the zone, and the operator's own names do not need one).
//
// ONE Worker route serves every policy host on the hosted service: POLICY_ROUTE_PATTERN in POLICY_HOST_ZONE, DECLARED in the hosted deploy config
// (`routes: [{ "pattern": "*/.well-known/mta-sts.txt", "zone_name": "<POLICY_HOST_ZONE>" }]`, docs/hosted.md). Cloudflare: "Cloudflare dashboard-defined routes will
// not be added alongside Wrangler-defined routes. If both are defined, only routes defined in wrangler.toml will be valid"
// (developers.cloudflare.com/workers/wrangler/deprecations/), so a route made through the API is gone at the next `wrangler deploy` of a config that
// declares routes. Custom hostnames enter that zone and "The `*/*` route pattern matches all traffic entering your zone" (cloudflare-for-platforms,
// worker-as-origin). This product therefore makes no route per domain; the reconcile (src/mta-sts/reconcile.ts) only CHECKS that the declared one exists and
// re-creates that exact pattern, loudly, when a deploy lost it.
//
// Everything that touches the operator's zone goes through OperatorZone, whose client carries its own exact-path policy (below): custom
// hostnames and Worker routes of that one zone, nothing else, and never a DNS record. Deletes read the object first and refuse anything that
// is not exactly the hostname or pattern this product would have created for the domain.

import { CfClient, CfNotFoundError, CfRecordNotAllowedError, type CfPolicy, type CfZone } from '../tenancy/cf-client';
import { getMode } from '../tenancy/mode';
import { workerName } from '../tenancy/context';
import { policyHostConfig, type PolicyHostConfig, type PolicyHostEnv } from './config';

export type PolicyHostKind = 'worker_route' | 'saas_hostname';

export interface PolicyHostStrategy {
  kind: PolicyHostKind;
  /** A custom hostname is registered in the operator's zone. */
  customHostname: boolean;
  /** The customer's `mta-sts.<d>` CNAME goes through Cloudflare's proxy (orange cloud). */
  cnameProxied: boolean;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\.$/, '');

/** Is `domain` the operator's zone or a name below it? */
export function inOperatorZone(domain: string, cfg: Pick<PolicyHostConfig, 'zone'>): boolean {
  const d = norm(domain);
  return d === cfg.zone || d.endsWith(`.${cfg.zone}`);
}

/**
 * Which way `domain` gets its policy host. Self-host: worker_route, no operator zone. Hosted: the operator's own zone apex is a worker_route
 * (its Universal certificate covers `mta-sts.<zone>`); another name inside the operator's zone has no certificate that way and may not be a custom
 * hostname either: null (the caller says so). Everything else: saas_hostname.
 */
export function strategyFor(env: PolicyHostEnv, domain: string): PolicyHostStrategy | null {
  if (getMode(env) !== 'saas') return { kind: 'worker_route', customHostname: false, cnameProxied: true };
  const cfg = policyHostConfig(env);
  if (!cfg) return null;
  if (norm(domain) === cfg.zone) return { kind: 'worker_route', customHostname: false, cnameProxied: true };
  if (inOperatorZone(domain, cfg)) return null;
  return { kind: 'saas_hostname', customHostname: true, cnameProxied: false };
}

export const policyHostname = (domain: string): string => `mta-sts.${norm(domain)}`;
/** The ONE route every policy host of the hosted service is served through (declared in the hosted deploy config; see the header). */
export const POLICY_ROUTE_PATTERN = '*/.well-known/mta-sts.txt';
/** The route an earlier build made for one domain (`mta-sts.<d>/*`): no longer made, still recognised so the reconcile can take it away. */
export const legacyRoutePattern = (domain: string): string => `${policyHostname(domain)}/*`;

// ── The operator client's policy ─────────────────────────────

const ID = '[A-Za-z0-9_-]+';

/**
 * What the operator token may ask Cloudflare, before anything leaves the Worker: reads of the zone, its custom hostnames and routes; writes
 * only to create, refresh (PATCH) or delete one custom hostname, and to create or delete one Worker route of the configured zone. No DNS record write,
 * no other zone, no other path.
 */
export function operatorPolicy(zone: { name: string; id?: () => string | undefined }): CfPolicy {
  const refuse = (method: string, path: string, why: string): never => { throw new CfRecordNotAllowedError(why, { method, path }); };
  return {
    request(method, path) {
      const p = path.split('?')[0];
      if (method === 'GET' || method === 'HEAD') {
        if (p === '/zones' || /^\/zones\/[A-Za-z0-9_-]+(\/(custom_hostnames|workers\/routes)(\/[A-Za-z0-9_-]+)?)?$/.test(p)) return;
        return refuse(method, p, 'the policy-host token may only read its zone, custom hostnames and Worker routes');
      }
      const zoneId = zone.id?.();
      if (!zoneId) return refuse(method, p, 'the policy-host zone is not resolved yet');
      const create = new RegExp(`^/zones/${zoneId}/(custom_hostnames|workers/routes)$`);
      const remove = new RegExp(`^/zones/${zoneId}/(custom_hostnames|workers/routes)/${ID}$`);
      const refresh = new RegExp(`^/zones/${zoneId}/custom_hostnames/${ID}$`);
      if ((method === 'POST' && create.test(p)) || (method === 'DELETE' && remove.test(p)) || (method === 'PATCH' && refresh.test(p))) return;
      return refuse(method, p, `the policy-host token may not ${method} ${p}`);
    },
    lookup: (name) => norm(name) === norm(zone.name),
    blocked: () => undefined,
    zoneName: () => norm(zone.name),
    zone: (z) => { if (norm(z.name) !== norm(zone.name)) refuse('GET', `/zones/${z.id}`, `zone ${z.name} is not the policy-host zone`); },
  };
}

// ── The operator's zone ──────────────────────────────────────

export interface CustomHostname { id: string; hostname: string; status: string; sslStatus: string | null; /** Cloudflare's own reasons the certificate is not issued (ssl.validation_errors), joined; empty when there are none. */ sslErrors: string }
/** Does a Cloudflare route pattern (`*` matches anything, no scheme) match `hostAndPath`? */
export function patternReaches(pattern: string, hostAndPath: string): boolean {
  const re = new RegExp(`^${pattern.toLowerCase().split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(hostAndPath.toLowerCase());
}

export interface WorkerRoute { id: string; pattern: string; script: string | null }

interface RawHostname { id: string; hostname: string; status?: string; ssl?: { status?: string; validation_errors?: Array<{ message?: string }> } }
interface RawRoute { id: string; pattern: string; script?: string | null }

const toHostname = (r: RawHostname): CustomHostname => ({ id: r.id, hostname: norm(r.hostname), status: r.status ?? 'unknown', sslStatus: r.ssl?.status ?? null, sslErrors: (r.ssl?.validation_errors ?? []).map((e) => e.message ?? '').join(' ') });
const toRoute = (r: RawRoute): WorkerRoute => ({ id: r.id, pattern: r.pattern.toLowerCase(), script: r.script ?? null });

export class PolicyHostError extends Error {
  constructor(message: string) { super(message); this.name = 'PolicyHostError'; }
}

export class OperatorZone {
  readonly #cf: CfClient;
  readonly zone: CfZone;
  readonly #script: string;

  constructor(cf: CfClient, zone: CfZone, script: string) {
    this.#cf = cf;
    this.zone = zone;
    this.#script = script;
  }

  /** Open the operator's zone with POLICY_HOST_TOKEN, which is separate from every tenant credential and from HOSTED_RECORDS_TOKEN. */
  static async open(env: PolicyHostEnv, opts: { fetch?: typeof fetch } = {}): Promise<OperatorZone> {
    const cfg = policyHostConfig(env);
    if (!cfg) throw new PolicyHostError('MTA-STS policy hosting is not configured');
    let zoneId: string | undefined;
    const policy = operatorPolicy({ name: cfg.zone, id: () => zoneId });
    const cf = new CfClient(cfg.token, { fetch: opts.fetch, mode: 'saas', policy, apiBaseUrl: env.CLOUDFLARE_API_BASE_URL });
    const zone = await cf.zoneFor(cfg.zone);
    zoneId = zone.id;
    return new OperatorZone(cf, zone, workerName(env));
  }

  /** The hostname this product registers for `domain`, refusing a name inside the operator's zone. */
  #assertHostname(domain: string): string {
    const host = policyHostname(domain);
    if (host === this.zone.name || host.endsWith(`.${this.zone.name}`)) throw new PolicyHostError(`refusing a custom hostname inside ${this.zone.name}: ${host}`);
    if (!/^mta-sts\.[a-z0-9_.-]+$/.test(host) || host.length > 253) throw new PolicyHostError(`refusing custom hostname ${JSON.stringify(host)}`);
    return host;
  }

  // ── custom hostnames ──────────────────────────────────────

  /** The custom hostname of `domain`, if one exists in the zone. */
  async findHostname(domain: string): Promise<CustomHostname | null> {
    const host = this.#assertHostname(domain);
    const list = await this.#cf.request<RawHostname[]>('GET', `/zones/${this.zone.id}/custom_hostnames`, { query: { hostname: host } });
    const hit = (list ?? []).find((h) => norm(h.hostname) === host);
    return hit ? toHostname(hit) : null;
  }

  /** Register `mta-sts.<domain>` (HTTP validation, TLS 1.2 minimum). One that is already there for the same name is taken over: names are globally unique, so it is a leftover of this product. */
  async createHostname(domain: string): Promise<CustomHostname> {
    const host = this.#assertHostname(domain);
    const existing = await this.findHostname(domain);
    if (existing) return existing;
    const made = await this.#cf.request<RawHostname>('POST', `/zones/${this.zone.id}/custom_hostnames`, {
      body: { hostname: host, ssl: { method: 'http', type: 'dv', settings: { min_tls_version: '1.2' } } },
    });
    return toHostname(made);
  }

  async getHostname(id: string): Promise<CustomHostname | null> {
    try {
      return toHostname(await this.#cf.request<RawHostname>('GET', `/zones/${this.zone.id}/custom_hostnames/${id}`));
    } catch (e) {
      if (e instanceof CfNotFoundError) return null;
      throw e;
    }
  }

  /** Delete custom hostname `id`, after reading it: it must be exactly `mta-sts.<domain>`. True when deleted, false when it was already gone. */
  async deleteHostname(id: string, domain: string): Promise<boolean> {
    const host = this.#assertHostname(domain);
    const found = await this.getHostname(id);
    if (!found) return false;
    if (found.hostname !== host) throw new PolicyHostError(`refusing to delete custom hostname ${id}: it is ${found.hostname}, not ${host}`);
    await this.#cf.request('DELETE', `/zones/${this.zone.id}/custom_hostnames/${id}`);
    return true;
  }

  /** Refresh custom hostname `id`: Cloudflare validates it again (a hostname that gave up, status "moved", goes back to pending). */
  async refreshHostname(id: string, domain: string): Promise<CustomHostname | null> {
    const host = this.#assertHostname(domain);
    const found = await this.getHostname(id);
    if (!found) return null;
    if (found.hostname !== host) throw new PolicyHostError(`refusing to refresh custom hostname ${id}: it is ${found.hostname}, not ${host}`);
    await this.#cf.request('PATCH', `/zones/${this.zone.id}/custom_hostnames/${id}`, { body: { ssl: { method: 'http', type: 'dv', settings: { min_tls_version: '1.2' } } } });
    return this.getHostname(id);
  }

  /** Every custom hostname of the zone (read-only, bounded), for the daily reconcile. */
  async listHostnames(): Promise<CustomHostname[]> {
    return (await this.#cf.listAll<RawHostname>(`/zones/${this.zone.id}/custom_hostnames`, {}, { maxPages: 20, maxItems: 1000 })).map(toHostname);
  }

  // ── Worker routes ─────────────────────────────────────────

  async listRoutes(): Promise<WorkerRoute[]> {
    return ((await this.#cf.request<RawRoute[]>('GET', `/zones/${this.zone.id}/workers/routes`)) ?? []).map(toRoute);
  }

  /** The declared route (POLICY_ROUTE_PATTERN) in the zone, or null when a deploy lost it. A route with that pattern that goes to another Worker is an error. */
  async findDeclaredRoute(): Promise<WorkerRoute | null> {
    const have = (await this.listRoutes()).find((r) => r.pattern === POLICY_ROUTE_PATTERN);
    if (have && have.script !== this.#script) throw new PolicyHostError(`route ${POLICY_ROUTE_PATTERN} already goes to ${have.script ?? 'no Worker'}`);
    return have ?? null;
  }

  /** Make the declared route (the one pattern, nothing else) when it is missing. `created` tells the caller to say so loudly: a deploy without it. */
  async ensureDeclaredRoute(): Promise<{ route: WorkerRoute; created: boolean }> {
    const have = await this.findDeclaredRoute();
    if (have) return { route: have, created: false };
    return { route: toRoute(await this.#cf.request<RawRoute>('POST', `/zones/${this.zone.id}/workers/routes`, { body: { pattern: POLICY_ROUTE_PATTERN, script: this.#script } })), created: true };
  }

  /** Delete a per-domain route an earlier build made, after reading it: it must be exactly `mta-sts.<domain>/*` and go to this Worker (never the declared route). True when deleted. */
  async deleteRoute(id: string, domain: string): Promise<boolean> {
    const pattern = legacyRoutePattern(domain);
    if (!/^mta-sts\.[a-z0-9_.-]+\/\*$/.test(pattern) || pattern.includes('*.')) throw new PolicyHostError(`refusing route pattern ${JSON.stringify(pattern)}`);
    const found = (await this.listRoutes()).find((r) => r.id === id);
    if (!found || found.pattern === POLICY_ROUTE_PATTERN) return false; // the declared route is shared by every policy host: never taken away here
    if (found.pattern !== pattern || found.script !== this.#script) throw new PolicyHostError(`refusing to delete route ${id}: it is ${found.pattern} → ${found.script ?? 'none'}, not ${pattern} → ${this.#script}`);
    await this.#cf.request('DELETE', `/zones/${this.zone.id}/workers/routes/${id}`);
    return true;
  }

  /**
   * Routes to this Worker, other than the declared one, that would also reach a policy host's OTHER paths (`*\/*`, `*mta-sts.*`, `mta-sts.<d>/*`). The Worker
   * answers those with a 404 (withPolicyHostFirst) only when the request is in `run_worker_first`; any other path is answered by the static assets first, so
   * a wider route would put the dashboard on a customer's name. Nothing in this product makes one; the reconcile says so loudly when someone else did.
   */
  async widerRoutes(): Promise<WorkerRoute[]> {
    const sample = 'mta-sts.policy-host-check.example/assets/index.js';
    return (await this.listRoutes()).filter((r) => r.script === this.#script && r.pattern !== POLICY_ROUTE_PATTERN && patternReaches(r.pattern, sample));
  }

  /** Is this a per-domain route an earlier build created (an `mta-sts.<d>/*` pattern to this Worker)? */
  ownsRoute(r: WorkerRoute): boolean {
    return r.script === this.#script && /^mta-sts\.[a-z0-9_.-]+\/\*$/.test(r.pattern);
  }

  /** The domain a product route or hostname is for (`mta-sts.<d>[/*]` → `<d>`), or null. */
  static domainOf(hostOrPattern: string): string | null {
    const m = hostOrPattern.toLowerCase().match(/^mta-sts\.([a-z0-9_.-]+?)(?:\/\*)?$/);
    return m ? m[1] : null;
  }
}
