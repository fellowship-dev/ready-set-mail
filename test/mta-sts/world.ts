// A hosted instance for the MTA-STS tests: the connections world (two workspaces, OAuth connection, FakeCloudflare) plus the operator's zone,
// the policy-host settings and the intake domain. Domain 1 (a-corp.com) is reached by workspace A's Cloudflare connection (via=cloudflare);
// domain 2 (a-two.org) is not linked to any connection (via=manual); domain 3 belongs to workspace B.
import { vi } from 'vitest';
import { Z, world as connectionsWorld } from '../connections/world';
import worker from '../../src/index';
import { POLICY_ROUTE_PATTERN } from '../../src/mta-sts/policy-host';

export const OP_ZONE = 'c0'.repeat(16);
export const OP = { token: 'operator-token', zone: 'readysetmail.com', target: 'mta-sts-host.readysetmail.com' } as const;
export const INTAKE = 'rua.readysetmail.com';
export const POLICY_ENV = {
  INTAKE_DOMAIN: INTAKE, HOSTED_CONNECT_REPORTS: 'all', WORKER_NAME: 'rsm-worker',
  POLICY_HOST_ZONE: OP.zone, POLICY_HOST_TARGET: OP.target, POLICY_HOST_TOKEN: OP.token,
  /** The receiving server whose Authentication-Results are trusted (the test mail says it was received by this one). */
  AUTHSERV_ID: 'mx.cloudflare.net', AUTHSERV_HEADER: 'ar',
  /** The instance owner (a@example.com is workspace A's owner): who may trigger the reconcile after a deploy. */
  OWNER_EMAIL: 'a@example.com',
} as const;

export async function mtaWorld(extraEnv: Record<string, unknown> = {}, opts: { connect?: boolean } = {}) {
  const w = await connectionsWorld({ ...POLICY_ENV, ...extraEnv });
  w.db.sqlite.prepare("UPDATE domains SET verified_via = 'txt'").run();
  w.cf.zones[OP.zone] = { id: OP_ZONE, cfAccountId: 'cf-op' };
  w.cf.validTokens!.add(OP.token);
  for (const d of ['a-corp.com', 'a-two.org', 'b-corp.org']) w.cf.mx[d] = [`10 mx.${d}.`];
  // The hosted deploy config declares ONE route for every policy host (docs/hosted.md): wrangler keeps it on every deploy.
  w.cf.routes[OP_ZONE] = [{ id: 'route-declared', pattern: POLICY_ROUTE_PATTERN, script: 'rsm-worker' }];
  // A policy URL is answered by this very Worker, as it is in production. A custom hostname without an active certificate fails the TLS handshake first.
  const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
  w.cf.policyServer = async (url, init) => {
    const hostname = url.hostname;
    const ch = (w.cf.customHostnames[OP_ZONE] ?? []).find((h) => h.hostname === hostname);
    const saas = (w.db.sqlite.prepare("SELECT 1 AS n FROM mta_sts_config m JOIN domains d ON d.id = m.domain_id WHERE 'mta-sts.' || d.domain = ? AND m.policy_host = 'saas_hostname'").get(hostname) as any) ?? null;
    if ((ch && (ch.status !== 'active' || ch.ssl.status !== 'active')) || (!ch && saas)) throw new TypeError(`fetch failed: no valid certificate for ${hostname}`);
    return worker.fetch(new Request(url, { method: init?.method ?? 'GET', redirect: 'manual' }), { ...w.env, ASSETS: { fetch: async () => new Response('the dashboard') } } as any, ctx);
  };
  let connection = '';
  if (opts.connect !== false) {
    const { res } = await w.connectOAuth(w.A.token);
    connection = w.connectionId(res);
    await w.api(w.A.token, 'PUT', `/api/cloudflare/connections/${connection}/zones`, { zone_ids: [Z.a1] });
    await w.api(w.A.token, 'PUT', '/api/domains/1/connection', { connection_id: connection });
  }
  const mta = (token: string, method: string, id: number, body?: unknown, sub = '') => w.api(token, method, `/api/domains/${id}/mta-sts${sub}`, body);
  const json = async (r: Response) => await r.json() as any;
  const row = (id: number) => w.rows('SELECT * FROM mta_sts_config WHERE domain_id = ?', id)[0];
  /** Calls to the operator's zone / to a customer zone, in order. */
  const calls = (zoneId: string) => w.cf.calls.filter((c) => c.zoneId === zoneId);
  const writes = (zoneId: string) => calls(zoneId).filter((c) => c.method !== 'GET');
  return { ...w, connection, mta, json, row, calls, writes, Z };
}

export type MtaWorld = Awaited<ReturnType<typeof mtaWorld>>;
/** The operator's zone holds the ONE declared route and nothing per domain. */
export const onlyDeclaredRoute = (w: MtaWorld) => w.cf.routes[OP_ZONE]?.map((r) => r.pattern);
export const quietLogs = () => { vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'log').mockImplementation(() => {}); };
