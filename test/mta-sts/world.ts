// A hosted instance for the MTA-STS tests: the connections world (two workspaces, OAuth connection, FakeCloudflare) plus the operator's zone,
// the policy-host settings and the intake domain. Domain 1 (a-corp.com) is reached by workspace A's Cloudflare connection (via=cloudflare);
// domain 2 (a-two.org) is not linked to any connection (via=manual); domain 3 belongs to workspace B.
import { vi } from 'vitest';
import { Z, world as connectionsWorld } from '../connections/world';

export const OP_ZONE = 'c0'.repeat(16);
export const OP = { token: 'operator-token', zone: 'readysetmail.com', target: 'mta-sts-host.readysetmail.com' } as const;
export const INTAKE = 'rua.readysetmail.com';
export const POLICY_ENV = {
  INTAKE_DOMAIN: INTAKE, HOSTED_CONNECT_REPORTS: 'all', WORKER_NAME: 'rsm-worker',
  POLICY_HOST_ZONE: OP.zone, POLICY_HOST_TARGET: OP.target, POLICY_HOST_TOKEN: OP.token,
} as const;

export async function mtaWorld(extraEnv: Record<string, unknown> = {}, opts: { connect?: boolean } = {}) {
  const w = await connectionsWorld({ ...POLICY_ENV, ...extraEnv });
  w.db.sqlite.prepare("UPDATE domains SET verified_via = 'txt'").run();
  w.cf.zones[OP.zone] = { id: OP_ZONE, cfAccountId: 'cf-op' };
  w.cf.validTokens!.add(OP.token);
  for (const d of ['a-corp.com', 'a-two.org', 'b-corp.org']) w.cf.mx[d] = [`10 mx.${d}.`];
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
export const quietLogs = () => { vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'log').mockImplementation(() => {}); };
