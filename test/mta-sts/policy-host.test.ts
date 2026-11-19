import { describe, it, expect, vi, afterEach } from 'vitest';
import { FakeCloudflare, stubCloudflare } from '../helpers/cf-fake';
import { OperatorZone, PolicyHostError, operatorPolicy, strategyFor, policyHostname, legacyRoutePattern, POLICY_ROUTE_PATTERN } from '../../src/mta-sts/policy-host';
import { maxPolicyHosts, mtaStsHostedConfigured, policyHostConfig } from '../../src/mta-sts/config';
import { CfRecordNotAllowedError } from '../../src/tenancy/cf-client';

afterEach(() => vi.unstubAllGlobals());

const HOSTED = {
  MODE: 'saas', SAAS_ENABLED: '1', INTAKE_DOMAIN: 'rua.readysetmail.com',
  POLICY_HOST_ZONE: 'readysetmail.com', POLICY_HOST_TARGET: 'mta-sts-host.readysetmail.com', POLICY_HOST_TOKEN: 'operator-token', WORKER_NAME: 'rsm-worker',
} as const;
const ZONE = 'zone-op';

function world() {
  return stubCloudflare(new FakeCloudflare({ 'readysetmail.com': { id: ZONE }, 'customer.com': { id: 'zone-cust' } }));
}

describe('settings', () => {
  it('are configured only with hosted mode, an intake domain and all three POLICY_HOST_* values, the target inside the zone', () => {
    expect(mtaStsHostedConfigured(HOSTED)).toBe(true);
    for (const k of ['INTAKE_DOMAIN', 'POLICY_HOST_ZONE', 'POLICY_HOST_TARGET', 'POLICY_HOST_TOKEN', 'SAAS_ENABLED'] as const) {
      expect(mtaStsHostedConfigured({ ...HOSTED, [k]: '' }), k).toBe(false);
    }
    expect(mtaStsHostedConfigured({ ...HOSTED, POLICY_HOST_TARGET: 'host.elsewhere.example' })).toBe(false);
    expect(mtaStsHostedConfigured({ ...HOSTED, MODE: undefined })).toBe(false);
    expect(policyHostConfig({ ...HOSTED, POLICY_HOST_ZONE: ' ReadySetMail.com. ' })).toMatchObject({ zone: 'readysetmail.com' });
  });

  it('the ceiling is MAX_POLICY_HOSTS, a positive integer, else 100', () => {
    expect(maxPolicyHosts({})).toBe(100);
    expect(maxPolicyHosts({ MAX_POLICY_HOSTS: '250' })).toBe(250);
    for (const bad of ['0', '-1', 'abc', '1.5', '']) expect(maxPolicyHosts({ MAX_POLICY_HOSTS: bad }), bad).toBe(100);
  });
});

describe('strategyFor: which way a domain gets its policy host', () => {
  it('self-host: a proxied CNAME to the Worker, nothing in an operator zone', () => {
    expect(strategyFor({}, 'acme.com')).toEqual({ kind: 'worker_route', customHostname: false, cnameProxied: true });
  });
  it('hosted: a custom hostname with a DNS-only CNAME for every ordinary domain (and no route of its own: the declared one serves them all)', () => {
    expect(strategyFor(HOSTED, 'customer.com')).toEqual({ kind: 'saas_hostname', customHostname: true, cnameProxied: false });
    expect(strategyFor(HOSTED, 'sub.customer.com')).toMatchObject({ kind: 'saas_hostname' });
  });
  it('hosted: the operator\'s own zone apex is a worker_route with no custom hostname', () => {
    expect(strategyFor(HOSTED, 'readysetmail.com')).toEqual({ kind: 'worker_route', customHostname: false, cnameProxied: true });
    expect(strategyFor(HOSTED, 'ReadySetMail.com.')).toMatchObject({ kind: 'worker_route' });
  });
  it('hosted: a name below the operator\'s zone has no way (no certificate, and never a custom hostname inside the zone)', () => {
    expect(strategyFor(HOSTED, 'mail.readysetmail.com')).toBeNull();
  });
  it('hosted but not configured: none', () => {
    expect(strategyFor({ ...HOSTED, POLICY_HOST_TOKEN: '' }, 'customer.com')).toBeNull();
  });
});

describe('the operator client\'s own write policy', () => {
  const policy = operatorPolicy({ name: 'readysetmail.com', id: () => ZONE });
  const req = (m: string, p: string) => () => policy.request(m, p);

  it('allows reading the zone, its custom hostnames and its routes', () => {
    for (const p of ['/zones', `/zones/${ZONE}`, `/zones/${ZONE}/custom_hostnames`, `/zones/${ZONE}/custom_hostnames/ch-1`, `/zones/${ZONE}/workers/routes`, `/zones/${ZONE}/workers/routes/r1`]) {
      expect(req('GET', p), p).not.toThrow();
    }
  });
  it('allows creating, refreshing and deleting exactly a custom hostname, and creating or deleting a route, of this zone', () => {
    expect(req('POST', `/zones/${ZONE}/custom_hostnames`)).not.toThrow();
    expect(req('PATCH', `/zones/${ZONE}/custom_hostnames/ch-1`)).not.toThrow();
    expect(req('POST', `/zones/${ZONE}/workers/routes`)).not.toThrow();
    expect(req('DELETE', `/zones/${ZONE}/custom_hostnames/ch-1`)).not.toThrow();
    expect(req('DELETE', `/zones/${ZONE}/workers/routes/r1`)).not.toThrow();
  });
  it('refuses a DNS record write, another zone, an update, a delete without an id, and any other path', () => {
    for (const [m, p] of [
      ['POST', `/zones/${ZONE}/dns_records`], ['DELETE', `/zones/${ZONE}/dns_records/x`], ['PATCH', `/zones/${ZONE}/dns_records/x`],
      ['POST', '/zones/other-zone/custom_hostnames'], ['DELETE', '/zones/other-zone/workers/routes/r1'],
      ['PATCH', '/zones/other-zone/custom_hostnames/ch-1'], ['PATCH', `/zones/${ZONE}/custom_hostnames`], ['PATCH', `/zones/${ZONE}/workers/routes/r1`], ['PUT', `/zones/${ZONE}/workers/routes/r1`], ['DELETE', `/zones/${ZONE}/custom_hostnames`],
      ['POST', `/zones/${ZONE}/settings`], ['DELETE', `/zones/${ZONE}`], ['GET', `/zones/${ZONE}/dns_records`], ['GET', '/user/tokens/verify'],
    ]) expect(req(m, p), `${m} ${p}`).toThrow(CfRecordNotAllowedError);
  });
  it('refuses every write before the zone is known', () => {
    const early = operatorPolicy({ name: 'readysetmail.com', id: () => undefined });
    expect(() => early.request('POST', `/zones/${ZONE}/custom_hostnames`)).toThrow(CfRecordNotAllowedError);
  });
});

describe('OperatorZone', () => {
  const open = () => OperatorZone.open({ ...HOSTED });

  it('registers a custom hostname with HTTP validation and TLS 1.2, and checks the ONE declared route to this Worker', async () => {
    const cf = world();
    const zone = await open();
    const ch = await zone.createHostname('customer.com');
    const { route, created } = await zone.ensureDeclaredRoute();
    expect(ch).toMatchObject({ hostname: 'mta-sts.customer.com', status: 'pending' });
    expect(cf.calls.find((c) => c.method === 'POST' && c.url.includes('custom_hostnames'))!.body).toEqual({
      hostname: 'mta-sts.customer.com', ssl: { method: 'http', type: 'dv', settings: { min_tls_version: '1.2' } },
    });
    expect(created).toBe(true);
    expect(route).toMatchObject({ pattern: POLICY_ROUTE_PATTERN, script: 'rsm-worker' });
    expect(POLICY_ROUTE_PATTERN).toBe('*/.well-known/mta-sts.txt');
    expect(cf.calls.every((c) => c.auth === 'Bearer operator-token')).toBe(true);
    expect(cf.calls.every((c) => c.zoneId === undefined || c.zoneId === ZONE)).toBe(true);
  });

  it('takes over a leftover hostname or route of the same name instead of failing or duplicating', async () => {
    const cf = world();
    const zone = await open();
    const a = await zone.createHostname('customer.com');
    const b = await zone.createHostname('customer.com');
    const r1 = await zone.ensureDeclaredRoute();
    const r2 = await zone.ensureDeclaredRoute();
    expect(b.id).toBe(a.id);
    expect(r2.route.id).toBe(r1.route.id);
    expect(r2.created).toBe(false);
    expect(cf.customHostnames[ZONE]).toHaveLength(1);
    expect(cf.routes[ZONE]).toHaveLength(1);
  });

  it('never creates a custom hostname inside its own zone, and never sends the request', async () => {
    const cf = world();
    const zone = await open();
    await expect(zone.createHostname('readysetmail.com')).rejects.toThrow(PolicyHostError);
    await expect(zone.createHostname('x.readysetmail.com')).rejects.toThrow(/inside readysetmail\.com/);
    expect(cf.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('refuses a route that is already pointed at another Worker', async () => {
    const cf = world();
    cf.routes[ZONE] = [{ id: 'r9', pattern: POLICY_ROUTE_PATTERN, script: 'someone-else' }];
    const zone = await open();
    await expect(zone.ensureDeclaredRoute()).rejects.toThrow(/already goes to someone-else/);
  });

  it('deletes by id after reading it, and only exactly the hostname or route of that domain', async () => {
    const cf = world();
    const zone = await open();
    const ch = await zone.createHostname('customer.com');
    cf.routes[ZONE] = [{ id: 'old1', pattern: 'mta-sts.customer.com/*', script: 'rsm-worker' }]; // a per-domain route of an earlier build
    await expect(zone.deleteHostname(ch.id, 'other.com')).rejects.toThrow(/it is mta-sts\.customer\.com, not mta-sts\.other\.com/);
    await expect(zone.deleteRoute('old1', 'other.com')).rejects.toThrow(/refusing to delete route/);
    expect(cf.calls.filter((c) => c.method === 'DELETE')).toEqual([]);
    expect(await zone.deleteHostname(ch.id, 'customer.com')).toBe(true);
    expect(await zone.deleteRoute('old1', 'customer.com')).toBe(true);
    expect(cf.customHostnames[ZONE]).toEqual([]);
    expect(cf.routes[ZONE]).toEqual([]);
    // already gone: false, no delete request
    const before = cf.calls.length;
    expect(await zone.deleteHostname(ch.id, 'customer.com')).toBe(false);
    expect(await zone.deleteRoute('old1', 'customer.com')).toBe(false);
    expect(cf.calls.slice(before).filter((c) => c.method === 'DELETE')).toEqual([]);
  });

  it('never deletes the declared route, which every policy host shares', async () => {
    const cf = world();
    cf.routes[ZONE] = [{ id: 'r1', pattern: POLICY_ROUTE_PATTERN, script: 'rsm-worker' }];
    const zone = await open();
    expect(await zone.deleteRoute('r1', 'customer.com')).toBe(false);
    expect(cf.routes[ZONE]).toHaveLength(1);
    expect(cf.calls.filter((c) => c.method === 'DELETE')).toEqual([]);
  });

  it('refreshes a custom hostname by id after reading it, only when it is exactly that domain\'s', async () => {
    const cf = world();
    const zone = await open();
    const ch = await zone.createHostname('customer.com');
    cf.customHostnames[ZONE][0].status = 'moved';
    await expect(zone.refreshHostname(ch.id, 'other.com')).rejects.toThrow(/refusing to refresh/);
    expect((await zone.refreshHostname(ch.id, 'customer.com'))!.status).toBe('pending');
    expect(cf.calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
    expect(await zone.refreshHostname('gone', 'customer.com')).toBeNull();
  });

  it('refuses to delete a route that points at another Worker', async () => {
    const cf = world();
    cf.routes[ZONE] = [{ id: 'r9', pattern: 'mta-sts.customer.com/*', script: 'someone-else' }];
    const zone = await open();
    await expect(zone.deleteRoute('r9', 'customer.com')).rejects.toThrow(PolicyHostError);
    expect(cf.routes[ZONE]).toHaveLength(1);
  });

  it('knows its own routes and the domain a hostname or pattern is for', async () => {
    world();
    const zone = await open();
    expect(zone.ownsRoute({ id: '1', pattern: 'mta-sts.customer.com/*', script: 'rsm-worker' })).toBe(true);
    expect(zone.ownsRoute({ id: '1', pattern: 'mta-sts.customer.com/*', script: 'other' })).toBe(false);
    expect(zone.ownsRoute({ id: '1', pattern: '*.readysetmail.com/*', script: 'rsm-worker' })).toBe(false);
    expect(OperatorZone.domainOf('mta-sts.customer.com/*')).toBe('customer.com');
    expect(OperatorZone.domainOf('mta-sts.customer.com')).toBe('customer.com');
    expect(OperatorZone.domainOf('www.customer.com')).toBeNull();
    expect(policyHostname('Customer.COM.')).toBe('mta-sts.customer.com');
    expect(legacyRoutePattern('customer.com')).toBe('mta-sts.customer.com/*');
  });

  it('cannot be opened without the settings', async () => {
    await expect(OperatorZone.open({ ...HOSTED, POLICY_HOST_TOKEN: '' })).rejects.toThrow(/not configured/);
  });
});
