// The policy host: how `mta-sts.<customer domain>` reaches this Worker with a certificate a sender trusts (RFC 8461 §3.3).
//
// Two ways, one seam (`strategyFor`):
//   worker_route   a PROXIED CNAME `mta-sts.<d>` → a target in the same Cloudflare account as the Worker; Universal SSL covers `mta-sts.<d>`.
//                  Self-host: the target is the Worker's own host (getWorkerRoute). The operator's own zone apex on the hosted service:
//                  the target is POLICY_HOST_TARGET and a Worker route `mta-sts.<d>/*` is created in POLICY_HOST_ZONE.
//   saas_hostname  every other hosted domain: a DNS-ONLY CNAME `mta-sts.<d>` → POLICY_HOST_TARGET in the customer's zone, plus, in the
//                  operator's zone, a Cloudflare for SaaS custom hostname `mta-sts.<d>` (HTTP validation, TLS 1.2 minimum) and a Worker route
//                  `mta-sts.<d>/*` to this Worker. A custom hostname is NEVER created inside POLICY_HOST_ZONE (Cloudflare refuses a name that
//                  matches the zone, and the operator's own names do not need one).
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
  /** A Worker route is created in the operator's zone. */
  route: boolean;
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
  if (getMode(env) !== 'saas') return { kind: 'worker_route', customHostname: false, route: false, cnameProxied: true };
  const cfg = policyHostConfig(env);
  if (!cfg) return null;
  if (norm(domain) === cfg.zone) return { kind: 'worker_route', customHostname: false, route: true, cnameProxied: true };
  if (inOperatorZone(domain, cfg)) return null;
  return { kind: 'saas_hostname', customHostname: true, route: true, cnameProxied: false };
}

export const policyHostname = (domain: string): string => `mta-sts.${norm(domain)}`;
export const routePattern = (domain: string): string => `${policyHostname(domain)}/*`;

// ── The operator client's policy ─────────────────────────────

const ID = '[A-Za-z0-9_-]+';

/**
 * What the operator token may ask Cloudflare, before anything leaves the Worker: reads of the zone, its custom hostnames and routes; writes
 * only to create or delete one custom hostname or one Worker route of the configured zone. No DNS record write, no other zone, no other path.
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
      if ((method === 'POST' && create.test(p)) || (method === 'DELETE' && remove.test(p))) return;
      return refuse(method, p, `the policy-host token may not ${method} ${p}`);
    },
    lookup: (name) => norm(name) === norm(zone.name),
    blocked: () => undefined,
    zoneName: () => norm(zone.name),
    zone: (z) => { if (norm(z.name) !== norm(zone.name)) refuse('GET', `/zones/${z.id}`, `zone ${z.name} is not the policy-host zone`); },
  };
}

// ── The operator's zone ──────────────────────────────────────

export interface CustomHostname { id: string; hostname: string; status: string; sslStatus: string | null }
export interface WorkerRoute { id: string; pattern: string; script: string | null }

interface RawHostname { id: string; hostname: string; status?: string; ssl?: { status?: string } }
interface RawRoute { id: string; pattern: string; script?: string | null }

const toHostname = (r: RawHostname): CustomHostname => ({ id: r.id, hostname: norm(r.hostname), status: r.status ?? 'unknown', sslStatus: r.ssl?.status ?? null });
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
    const cf = new CfClient(cfg.token, { fetch: opts.fetch, mode: 'saas', policy });
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

  #assertPattern(domain: string): string {
    const pattern = routePattern(domain);
    if (!/^mta-sts\.[a-z0-9_.-]+\/\*$/.test(pattern) || pattern.includes('*.')) throw new PolicyHostError(`refusing route pattern ${JSON.stringify(pattern)}`);
    return pattern;
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

  /** Every custom hostname of the zone (read-only, bounded), for the daily reconcile. */
  async listHostnames(): Promise<CustomHostname[]> {
    return (await this.#cf.listAll<RawHostname>(`/zones/${this.zone.id}/custom_hostnames`, {}, { maxPages: 20, maxItems: 1000 })).map(toHostname);
  }

  // ── Worker routes ─────────────────────────────────────────

  async listRoutes(): Promise<WorkerRoute[]> {
    return ((await this.#cf.request<RawRoute[]>('GET', `/zones/${this.zone.id}/workers/routes`)) ?? []).map(toRoute);
  }

  /** Route `mta-sts.<domain>/*` to this Worker. An identical route that is already there is reused. */
  async createRoute(domain: string): Promise<WorkerRoute> {
    const pattern = this.#assertPattern(domain);
    const have = (await this.listRoutes()).find((r) => r.pattern === pattern);
    if (have) {
      if (have.script !== this.#script) throw new PolicyHostError(`route ${pattern} already goes to ${have.script ?? 'no Worker'}`);
      return have;
    }
    return toRoute(await this.#cf.request<RawRoute>('POST', `/zones/${this.zone.id}/workers/routes`, { body: { pattern, script: this.#script } }));
  }

  /** Delete route `id`, after reading it: it must be exactly this domain's pattern and go to this Worker. True when deleted. */
  async deleteRoute(id: string, domain: string): Promise<boolean> {
    const pattern = this.#assertPattern(domain);
    const found = (await this.listRoutes()).find((r) => r.id === id);
    if (!found) return false;
    if (found.pattern !== pattern || found.script !== this.#script) throw new PolicyHostError(`refusing to delete route ${id}: it is ${found.pattern} → ${found.script ?? 'none'}, not ${pattern} → ${this.#script}`);
    await this.#cf.request('DELETE', `/zones/${this.zone.id}/workers/routes/${id}`);
    return true;
  }

  /** Is this route one this product created (an mta-sts pattern to this Worker)? */
  ownsRoute(r: WorkerRoute): boolean {
    return r.script === this.#script && /^mta-sts\.[a-z0-9_.-]+\/\*$/.test(r.pattern);
  }

  /** The domain a product route or hostname is for (`mta-sts.<d>[/*]` → `<d>`), or null. */
  static domainOf(hostOrPattern: string): string | null {
    const m = hostOrPattern.toLowerCase().match(/^mta-sts\.([a-z0-9_.-]+?)(?:\/\*)?$/);
    return m ? m[1] : null;
  }
}
